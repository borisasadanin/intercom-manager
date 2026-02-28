/**
 * Tests for M2 P2P call REST endpoints.
 * Covers: POST /call, PATCH /call/:callId, POST /call/:callId/join,
 *         PATCH /call/:callId/answer, DELETE /call/:callId, GET /call/active
 *
 * Uses a minimal Fastify server with getApiClients() + getApiCalls(),
 * a fully mocked DbManager, a real CallManager backed by a mock ISmbProtocol,
 * and a real ConnectionManager with spied methods.
 */

jest.mock('./log', () => ({
  Log: () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn()
  })
}));

import Fastify, { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { initJwt, generateToken } from './auth/jwt';
import { ConnectionManager } from './connection_manager';
import { CallManager } from './call_manager';
import { getApiClients } from './api_clients';
import { getApiCalls } from './api_calls';
import { CallDocument, ClientDocument } from './models';
import { DbManager } from './db/interface';
import { ISmbProtocol } from './smb';

const TEST_SECRET = 'test-secret-for-api-calls';

// ── Mock SMB endpoint description ──────────────────────────────────────────

const mockSmbEndpointDescription = {
  'bundle-transport': {
    'rtcp-mux': true,
    ice: {
      ufrag: 'testufrag',
      pwd: 'testpwd',
      candidates: [
        {
          generation: 0,
          component: 1,
          protocol: 'udp',
          port: 10000,
          ip: '127.0.0.1',
          foundation: '1',
          priority: 2130706431,
          type: 'host',
          network: 1
        }
      ]
    },
    dtls: {
      setup: 'actpass',
      type: 'sha-256',
      hash: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
    }
  },
  audio: {
    ssrcs: [12345678],
    'payload-type': {
      id: 111,
      name: 'opus',
      clockrate: 48000,
      channels: 2,
      parameters: { minptime: '10', useinbandfec: '1' },
      'rtcp-fbs': []
    },
    'rtp-hdrexts': [
      { id: 1, uri: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level' }
    ]
  },
  video: {
    ssrcs: [],
    'payload-type': {
      id: 100,
      name: 'VP8',
      clockrate: 90000,
      parameters: {},
      'rtcp-fbs': []
    },
    'rtp-hdrexts': []
  },
  data: { port: 5000 }
};

// A minimal valid SDP answer for configureEndpoint processing
const mockSdpAnswer =
  'v=0\r\n' +
  'o=- 123456 2 IN IP4 127.0.0.1\r\n' +
  's=-\r\n' +
  't=0 0\r\n' +
  'a=group:BUNDLE 0 1\r\n' +
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' +
  'c=IN IP4 0.0.0.0\r\n' +
  'a=ice-ufrag:clientufrag\r\n' +
  'a=ice-pwd:clientpwd\r\n' +
  'a=fingerprint:sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00\r\n' +
  'a=setup:active\r\n' +
  'a=mid:0\r\n' +
  'a=sctp-port:5000\r\n' +
  'm=audio 9 RTP/SAVPF 111\r\n' +
  'c=IN IP4 0.0.0.0\r\n' +
  'a=rtcp:9 IN IP4 0.0.0.0\r\n' +
  'a=ice-ufrag:clientufrag\r\n' +
  'a=ice-pwd:clientpwd\r\n' +
  'a=fingerprint:sha-256 11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00\r\n' +
  'a=setup:active\r\n' +
  'a=mid:1\r\n' +
  'a=sendrecv\r\n' +
  'a=rtcp-mux\r\n' +
  'a=rtpmap:111 opus/48000/2\r\n' +
  'a=fmtp:111 minptime=10;useinbandfec=1\r\n' +
  'a=ssrc:87654321 msid:stream1 audio1\r\n' +
  'a=ssrc:87654321 cname:testcname\r\n';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeClientDoc(overrides: Partial<ClientDocument> = {}): ClientDocument {
  return {
    _id: 'caller-uuid-001',
    docType: 'client',
    name: 'Caller Studio',
    role: 'producer',
    location: 'Stockholm',
    isOnline: true,
    createdAt: '2026-02-28T10:00:00.000Z',
    lastSeenAt: '2026-02-28T10:00:00.000Z',
    ...overrides
  };
}

function makeCallDoc(overrides: Partial<CallDocument> = {}): CallDocument {
  return {
    _id: 'call-uuid-001',
    docType: 'call',
    callerId: 'caller-uuid-001',
    calleeId: 'callee-uuid-002',
    callerName: 'Caller Studio',
    calleeName: 'Callee Reporter',
    smbConferenceId: 'conf-123',
    smbUrl: 'http://localhost:8080/',
    state: 'pending',
    callerEndpointId: 'ep-caller-001',
    calleeEndpointId: null,
    callerEndpointDescription: mockSmbEndpointDescription as any,
    calleeEndpointDescription: null,
    callerConnected: false,
    calleeConnected: false,
    createdAt: '2026-02-28T10:00:00.000Z',
    endedAt: null,
    endedBy: null,
    ...overrides
  };
}

function makeMockDbManager(overrides: Partial<DbManager> = {}): DbManager {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    getProduction: jest.fn().mockResolvedValue(undefined),
    getProductions: jest.fn().mockResolvedValue([]),
    getProductionsLength: jest.fn().mockResolvedValue(0),
    updateProduction: jest.fn().mockResolvedValue(undefined),
    addProduction: jest.fn().mockResolvedValue({}),
    deleteProduction: jest.fn().mockResolvedValue(true),
    setLineConferenceId: jest.fn().mockResolvedValue(undefined),
    addIngest: jest.fn().mockResolvedValue({}),
    getIngest: jest.fn().mockResolvedValue(undefined),
    getIngestsLength: jest.fn().mockResolvedValue(0),
    getIngests: jest.fn().mockResolvedValue([]),
    updateIngest: jest.fn().mockResolvedValue(undefined),
    deleteIngest: jest.fn().mockResolvedValue(true),
    saveUserSession: jest.fn().mockResolvedValue(undefined),
    getSession: jest.fn().mockResolvedValue(null),
    deleteUserSession: jest.fn().mockResolvedValue(true),
    updateSession: jest.fn().mockResolvedValue(true),
    getSessionsByQuery: jest.fn().mockResolvedValue([]),
    saveClient: jest.fn().mockResolvedValue(undefined),
    getClient: jest.fn().mockResolvedValue(null),
    updateClient: jest.fn().mockResolvedValue(undefined),
    getOnlineClients: jest.fn().mockResolvedValue([]),
    saveCall: jest.fn().mockResolvedValue(undefined),
    getCall: jest.fn().mockResolvedValue(null),
    updateCall: jest.fn().mockResolvedValue(undefined),
    getActiveCallsForClient: jest.fn().mockResolvedValue([]),
    getActiveCallCount: jest.fn().mockResolvedValue(0),
    ...overrides
  } as DbManager;
}

function makeMockSmb(): ISmbProtocol {
  return {
    allocateConference: jest.fn().mockResolvedValue('conf-123'),
    allocateEndpoint: jest
      .fn()
      .mockResolvedValue(mockSmbEndpointDescription),
    allocateAudioEndpoint: jest.fn(),
    configureEndpoint: jest.fn().mockResolvedValue(undefined),
    getConferences: jest.fn().mockResolvedValue([]),
    getConferencesWithUsers: jest.fn().mockResolvedValue([]),
    getConference: jest.fn().mockResolvedValue([])
  };
}

interface ServerBundle {
  app: FastifyInstance;
  db: DbManager;
  smb: ISmbProtocol;
  connectionManager: ConnectionManager;
  callManager: CallManager;
}

async function buildServer(): Promise<ServerBundle> {
  const db = makeMockDbManager();
  const smb = makeMockSmb();
  const connectionManager = new ConnectionManager();

  const callManager = new CallManager({
    dbManager: db,
    connectionManager,
    smb,
    smbInstances: [
      {
        url: 'http://localhost:8080/',
        apiKey: 'test-smb-key',
        maxConferences: 80
      }
    ],
    endpointIdleTimeout: 60
  });

  const app = Fastify();
  await app.register(websocket);
  app.register(getApiClients(), {
    prefix: 'api/v1',
    dbManager: db,
    connectionManager,
    callManager
  });
  app.register(getApiCalls(), {
    prefix: 'api/v1',
    dbManager: db,
    connectionManager,
    callManager
  });
  await app.ready();

  return { app, db, smb, connectionManager, callManager };
}

function makeCallerToken(clientId = 'caller-uuid-001'): string {
  return generateToken({
    clientId,
    name: 'Caller Studio',
    role: 'producer',
    location: 'Stockholm'
  });
}

function makeCalleeToken(clientId = 'callee-uuid-002'): string {
  return generateToken({
    clientId,
    name: 'Callee Reporter',
    role: 'reporter',
    location: 'Gothenburg'
  });
}

// ===========================================================================
// POST /api/v1/call — Initiate a call
// ===========================================================================

describe('POST /api/v1/call — call initiation', () => {
  let bundle: ServerBundle;

  beforeAll(async () => {
    initJwt(TEST_SECRET);
    bundle = await buildServer();
  });

  afterAll(async () => {
    await bundle.app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // 1. Happy path: initiate call returns 200 with callId, sdpOffer, callerId, calleeId
  it('returns 200 with callId, sdpOffer, callerId, calleeId on valid request', async () => {
    const calleeDoc = makeClientDoc({
      _id: 'callee-uuid-002',
      name: 'Callee Reporter',
      role: 'reporter',
      location: 'Gothenburg',
      isOnline: true
    });
    // getClient called twice: once for callee validation, once for caller name
    (bundle.db.getClient as jest.Mock)
      .mockResolvedValueOnce(calleeDoc) // callee validation
      .mockResolvedValueOnce(makeClientDoc()); // caller info

    const response = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/call',
      headers: { authorization: `Bearer ${makeCallerToken()}` },
      payload: { calleeId: 'callee-uuid-002' }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(typeof body.callId).toBe('string');
    expect(body.callerId).toBe('caller-uuid-001');
    expect(body.calleeId).toBe('callee-uuid-002');
    expect(typeof body.sdpOffer).toBe('string');
  });

  // 2. SDP offer starts with "v=0"
  it('returns an SDP offer starting with v=0', async () => {
    const calleeDoc = makeClientDoc({
      _id: 'callee-uuid-002',
      isOnline: true
    });
    (bundle.db.getClient as jest.Mock)
      .mockResolvedValueOnce(calleeDoc)
      .mockResolvedValueOnce(makeClientDoc());

    const response = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/call',
      headers: { authorization: `Bearer ${makeCallerToken()}` },
      payload: { calleeId: 'callee-uuid-002' }
    });

    expect(response.statusCode).toBe(200);
    const { sdpOffer } = response.json();
    expect(sdpOffer).toMatch(/^v=0/);
  });

  // 3. Call document saved in DB with state: 'pending'
  it('saves call document to DB with state pending', async () => {
    const calleeDoc = makeClientDoc({
      _id: 'callee-uuid-002',
      isOnline: true
    });
    (bundle.db.getClient as jest.Mock)
      .mockResolvedValueOnce(calleeDoc)
      .mockResolvedValueOnce(makeClientDoc());

    const response = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/call',
      headers: { authorization: `Bearer ${makeCallerToken()}` },
      payload: { calleeId: 'callee-uuid-002' }
    });

    expect(response.statusCode).toBe(200);
    expect(bundle.db.saveCall).toHaveBeenCalledTimes(1);
    const savedCall = (bundle.db.saveCall as jest.Mock).mock
      .calls[0][0] as CallDocument;
    expect(savedCall.state).toBe('pending');
    expect(savedCall.callerId).toBe('caller-uuid-001');
    expect(savedCall.calleeId).toBe('callee-uuid-002');
    expect(savedCall.callerConnected).toBe(false);
    expect(savedCall.calleeConnected).toBe(false);
    expect(savedCall.docType).toBe('call');
  });

  // 4. call_incoming WebSocket event sent to callee via connectionManager.sendTo
  it('sends call_incoming event to callee via connectionManager.sendTo', async () => {
    const calleeDoc = makeClientDoc({
      _id: 'callee-uuid-002',
      name: 'Callee Reporter',
      role: 'reporter',
      location: 'Gothenburg',
      isOnline: true
    });
    (bundle.db.getClient as jest.Mock)
      .mockResolvedValueOnce(calleeDoc)
      .mockResolvedValueOnce(makeClientDoc());

    const sendToSpy = jest.spyOn(bundle.connectionManager, 'sendTo');

    const response = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/call',
      headers: { authorization: `Bearer ${makeCallerToken()}` },
      payload: { calleeId: 'callee-uuid-002' }
    });

    expect(response.statusCode).toBe(200);
    expect(sendToSpy).toHaveBeenCalledTimes(1);
    const [targetId, event] = sendToSpy.mock.calls[0];
    expect(targetId).toBe('callee-uuid-002');
    expect(event.type).toBe('call_incoming');
    if (event.type === 'call_incoming') {
      expect(typeof event.callId).toBe('string');
      expect(event.caller.clientId).toBe('caller-uuid-001');
    }
  });

  // 5. Cannot call yourself — returns 400
  it('returns 400 when calleeId equals callerId', async () => {
    const response = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/call',
      headers: { authorization: `Bearer ${makeCallerToken()}` },
      payload: { calleeId: 'caller-uuid-001' } // same as caller
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'Cannot call yourself' });
  });

  // 6. Callee not found — returns 404
  it('returns 404 when callee does not exist', async () => {
    (bundle.db.getClient as jest.Mock).mockResolvedValueOnce(null);

    const response = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/call',
      headers: { authorization: `Bearer ${makeCallerToken()}` },
      payload: { calleeId: 'nonexistent-callee' }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'Callee not found' });
  });

  // 7. Callee is offline — returns 422
  it('returns 422 when callee is offline', async () => {
    const offlineCallee = makeClientDoc({
      _id: 'callee-uuid-002',
      isOnline: false
    });
    (bundle.db.getClient as jest.Mock).mockResolvedValueOnce(offlineCallee);

    const response = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/call',
      headers: { authorization: `Bearer ${makeCallerToken()}` },
      payload: { calleeId: 'callee-uuid-002' }
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ error: 'Callee is offline' });
  });

  // 8. Missing calleeId — returns 400
  it('returns 400 when calleeId is missing from body', async () => {
    const response = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/call',
      headers: { authorization: `Bearer ${makeCallerToken()}` },
      payload: {}
    });

    expect(response.statusCode).toBe(400);
  });

  // 9. Duplicate active call — returns 409
  it('returns 409 when an active call from caller to callee already exists', async () => {
    const calleeDoc = makeClientDoc({
      _id: 'callee-uuid-002',
      isOnline: true
    });
    const existingCall = makeCallDoc({
      _id: 'existing-call-id',
      callerId: 'caller-uuid-001',
      calleeId: 'callee-uuid-002'
    });
    (bundle.db.getClient as jest.Mock).mockResolvedValueOnce(calleeDoc);
    (bundle.db.getActiveCallsForClient as jest.Mock).mockResolvedValueOnce([
      existingCall
    ]);

    const response = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/call',
      headers: { authorization: `Bearer ${makeCallerToken()}` },
      payload: { calleeId: 'callee-uuid-002' }
    });

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.error).toBe('Active call already exists');
    expect(body.callId).toBe('existing-call-id');
  });

  // No auth — returns 401
  it('returns 401 when Authorization header is missing', async () => {
    const response = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/call',
      payload: { calleeId: 'callee-uuid-002' }
    });

    expect(response.statusCode).toBe(401);
  });
});

// ===========================================================================
// PATCH /api/v1/call/:callId — Caller SDP answer
// ===========================================================================

describe('PATCH /api/v1/call/:callId — caller SDP answer', () => {
  let bundle: ServerBundle;

  beforeAll(async () => {
    initJwt(TEST_SECRET);
    bundle = await buildServer();
  });

  afterAll(async () => {
    await bundle.app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // 10. Caller sends SDP answer — returns 200 with status "caller_connected"
  it('returns 200 with status caller_connected when caller sends valid SDP answer', async () => {
    const pendingCall = makeCallDoc({ callerConnected: false });
    const updatedCall = makeCallDoc({ callerConnected: true });

    (bundle.db.getCall as jest.Mock)
      .mockResolvedValueOnce(pendingCall) // route fetch
      .mockResolvedValueOnce(pendingCall) // callManager.processAnswer internal fetch
      .mockResolvedValueOnce(updatedCall); // callManager.processAnswer final fetch

    const response = await bundle.app.inject({
      method: 'PATCH',
      url: '/api/v1/call/call-uuid-001',
      headers: { authorization: `Bearer ${makeCallerToken()}` },
      payload: { sdpAnswer: mockSdpAnswer }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.callId).toBe('call-uuid-001');
    expect(body.status).toBe('caller_connected');
  });

  // 11. Not the caller — returns 403
  it('returns 403 when the authenticated client is not the caller', async () => {
    const call = makeCallDoc({ callerId: 'someone-else' });
    (bundle.db.getCall as jest.Mock).mockResolvedValueOnce(call);

    const response = await bundle.app.inject({
      method: 'PATCH',
      url: '/api/v1/call/call-uuid-001',
      headers: { authorization: `Bearer ${makeCallerToken()}` },
      payload: { sdpAnswer: mockSdpAnswer }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'Not the caller of this call' });
  });

  // 12. Call not found — returns 404
  it('returns 404 when call does not exist', async () => {
    (bundle.db.getCall as jest.Mock).mockResolvedValueOnce(null);

    const response = await bundle.app.inject({
      method: 'PATCH',
      url: '/api/v1/call/nonexistent-call',
      headers: { authorization: `Bearer ${makeCallerToken()}` },
      payload: { sdpAnswer: mockSdpAnswer }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'Call not found' });
  });

  // 12b. Ended call — also returns 404
  it('returns 404 when call state is ended', async () => {
    const endedCall = makeCallDoc({ state: 'ended' });
    (bundle.db.getCall as jest.Mock).mockResolvedValueOnce(endedCall);

    const response = await bundle.app.inject({
      method: 'PATCH',
      url: '/api/v1/call/call-uuid-001',
      headers: { authorization: `Bearer ${makeCallerToken()}` },
      payload: { sdpAnswer: mockSdpAnswer }
    });

    expect(response.statusCode).toBe(404);
  });

  // 13. Caller already connected — returns 409
  it('returns 409 when caller is already connected', async () => {
    const alreadyConnected = makeCallDoc({ callerConnected: true });
    (bundle.db.getCall as jest.Mock).mockResolvedValueOnce(alreadyConnected);

    const response = await bundle.app.inject({
      method: 'PATCH',
      url: '/api/v1/call/call-uuid-001',
      headers: { authorization: `Bearer ${makeCallerToken()}` },
      payload: { sdpAnswer: mockSdpAnswer }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'Caller already connected' });
  });
});

// ===========================================================================
// POST /api/v1/call/:callId/join — Callee join
// ===========================================================================

describe('POST /api/v1/call/:callId/join — callee join', () => {
  let bundle: ServerBundle;

  beforeAll(async () => {
    initJwt(TEST_SECRET);
    bundle = await buildServer();
  });

  afterAll(async () => {
    await bundle.app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // 14. Callee joins — returns 200 with sdpOffer
  it('returns 200 with sdpOffer when callee joins', async () => {
    const pendingCall = makeCallDoc({ calleeEndpointId: null });
    const updatedCall = makeCallDoc({
      calleeEndpointId: 'ep-callee-001',
      calleeEndpointDescription: mockSmbEndpointDescription as any
    });

    // Route fetch -> internal CallManager fetch -> internal re-fetch after update
    (bundle.db.getCall as jest.Mock)
      .mockResolvedValueOnce(pendingCall) // route auth check
      .mockResolvedValueOnce(pendingCall) // joinCall internal check
      .mockResolvedValueOnce(updatedCall); // joinCall final re-fetch

    const response = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/call/call-uuid-001/join',
      headers: { authorization: `Bearer ${makeCalleeToken()}` }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.callId).toBe('call-uuid-001');
    expect(typeof body.sdpOffer).toBe('string');
    expect(body.sdpOffer).toMatch(/^v=0/);
    expect(body.callerId).toBe('caller-uuid-001');
    expect(body.calleeId).toBe('callee-uuid-002');
  });

  // 15. Not the callee — returns 403
  it('returns 403 when the authenticated client is not the callee', async () => {
    const call = makeCallDoc({ calleeId: 'someone-else' });
    (bundle.db.getCall as jest.Mock).mockResolvedValueOnce(call);

    const response = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/call/call-uuid-001/join',
      headers: { authorization: `Bearer ${makeCalleeToken()}` }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'Not the callee of this call' });
  });

  // 16. Call not found — returns 404
  it('returns 404 when call does not exist', async () => {
    (bundle.db.getCall as jest.Mock).mockResolvedValueOnce(null);

    const response = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/call/nonexistent-call/join',
      headers: { authorization: `Bearer ${makeCalleeToken()}` }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'Call not found' });
  });

  // 17. Callee already joined — returns 409
  it('returns 409 when callee has already joined (calleeEndpointId set)', async () => {
    const alreadyJoined = makeCallDoc({ calleeEndpointId: 'ep-callee-existing' });
    (bundle.db.getCall as jest.Mock).mockResolvedValueOnce(alreadyJoined);

    const response = await bundle.app.inject({
      method: 'POST',
      url: '/api/v1/call/call-uuid-001/join',
      headers: { authorization: `Bearer ${makeCalleeToken()}` }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'Callee already joined' });
  });
});

// ===========================================================================
// PATCH /api/v1/call/:callId/answer — Callee SDP answer
// ===========================================================================

describe('PATCH /api/v1/call/:callId/answer — callee SDP answer', () => {
  let bundle: ServerBundle;

  beforeAll(async () => {
    initJwt(TEST_SECRET);
    bundle = await buildServer();
  });

  afterAll(async () => {
    await bundle.app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // 18. Callee sends SDP answer — returns 200 with status "callee_connected"
  it('returns 200 with status callee_connected when callee sends valid SDP answer', async () => {
    const pendingCall = makeCallDoc({
      calleeEndpointId: 'ep-callee-001',
      calleeEndpointDescription: mockSmbEndpointDescription as any,
      calleeConnected: false,
      callerConnected: false
    });
    const updatedCall = makeCallDoc({
      calleeEndpointId: 'ep-callee-001',
      calleeEndpointDescription: mockSmbEndpointDescription as any,
      calleeConnected: true,
      callerConnected: false
    });

    (bundle.db.getCall as jest.Mock)
      .mockResolvedValueOnce(pendingCall) // route fetch
      .mockResolvedValueOnce(pendingCall) // processAnswer internal
      .mockResolvedValueOnce(updatedCall); // processAnswer final re-fetch

    const response = await bundle.app.inject({
      method: 'PATCH',
      url: '/api/v1/call/call-uuid-001/answer',
      headers: { authorization: `Bearer ${makeCalleeToken()}` },
      payload: { sdpAnswer: mockSdpAnswer }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.callId).toBe('call-uuid-001');
    expect(body.status).toBe('callee_connected');
  });

  // 19. Both connected → state transitions to 'active', call_started broadcast
  it('broadcasts call_started when both caller and callee are connected', async () => {
    const pendingCall = makeCallDoc({
      calleeEndpointId: 'ep-callee-001',
      calleeEndpointDescription: mockSmbEndpointDescription as any,
      calleeConnected: false,
      callerConnected: true // caller already connected
    });
    const activeCall = makeCallDoc({
      calleeEndpointId: 'ep-callee-001',
      calleeEndpointDescription: mockSmbEndpointDescription as any,
      calleeConnected: true,
      callerConnected: true,
      state: 'active'
    });

    (bundle.db.getCall as jest.Mock)
      .mockResolvedValueOnce(pendingCall)
      .mockResolvedValueOnce(pendingCall)
      .mockResolvedValueOnce(activeCall);

    const broadcastSpy = jest.spyOn(bundle.connectionManager, 'broadcast');

    const response = await bundle.app.inject({
      method: 'PATCH',
      url: '/api/v1/call/call-uuid-001/answer',
      headers: { authorization: `Bearer ${makeCalleeToken()}` },
      payload: { sdpAnswer: mockSdpAnswer }
    });

    expect(response.statusCode).toBe(200);
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    const [event] = broadcastSpy.mock.calls[0];
    expect(event.type).toBe('call_started');
    if (event.type === 'call_started') {
      expect(event.callId).toBe('call-uuid-001');
      expect(event.callerId).toBe('caller-uuid-001');
      expect(event.calleeId).toBe('callee-uuid-002');
    }
  });

  // 20. Not the callee — returns 403
  it('returns 403 when authenticated client is not the callee', async () => {
    const call = makeCallDoc({ calleeId: 'someone-else' });
    (bundle.db.getCall as jest.Mock).mockResolvedValueOnce(call);

    const response = await bundle.app.inject({
      method: 'PATCH',
      url: '/api/v1/call/call-uuid-001/answer',
      headers: { authorization: `Bearer ${makeCalleeToken()}` },
      payload: { sdpAnswer: mockSdpAnswer }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'Not the callee of this call' });
  });

  // Callee already connected — returns 409
  it('returns 409 when callee is already connected', async () => {
    const alreadyConnected = makeCallDoc({
      calleeEndpointId: 'ep-callee-001',
      calleeConnected: true
    });
    (bundle.db.getCall as jest.Mock).mockResolvedValueOnce(alreadyConnected);

    const response = await bundle.app.inject({
      method: 'PATCH',
      url: '/api/v1/call/call-uuid-001/answer',
      headers: { authorization: `Bearer ${makeCalleeToken()}` },
      payload: { sdpAnswer: mockSdpAnswer }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'Callee already connected' });
  });
});

// ===========================================================================
// DELETE /api/v1/call/:callId — End call
// ===========================================================================

describe('DELETE /api/v1/call/:callId — end call', () => {
  let bundle: ServerBundle;

  beforeAll(async () => {
    initJwt(TEST_SECRET);
    bundle = await buildServer();
  });

  afterAll(async () => {
    await bundle.app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // 21. Caller ends call — returns 200, state: 'ended'
  it('returns 200 with status ended when caller ends the call', async () => {
    const activeCall = makeCallDoc({ state: 'active' });
    const endedCall = makeCallDoc({ state: 'ended', endedBy: 'caller-uuid-001' });

    (bundle.db.getCall as jest.Mock)
      .mockResolvedValueOnce(activeCall) // route fetch
      .mockResolvedValueOnce(activeCall) // callManager.endCall internal fetch
      .mockResolvedValueOnce(endedCall); // callManager.endCall final re-fetch

    const response = await bundle.app.inject({
      method: 'DELETE',
      url: '/api/v1/call/call-uuid-001',
      headers: { authorization: `Bearer ${makeCallerToken()}` }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.callId).toBe('call-uuid-001');
    expect(body.status).toBe('ended');
  });

  // 22. Callee ends call — returns 200
  it('returns 200 when the callee ends the call', async () => {
    const activeCall = makeCallDoc({ state: 'active' });
    const endedCall = makeCallDoc({ state: 'ended', endedBy: 'callee-uuid-002' });

    (bundle.db.getCall as jest.Mock)
      .mockResolvedValueOnce(activeCall)
      .mockResolvedValueOnce(activeCall)
      .mockResolvedValueOnce(endedCall);

    const response = await bundle.app.inject({
      method: 'DELETE',
      url: '/api/v1/call/call-uuid-001',
      headers: { authorization: `Bearer ${makeCalleeToken()}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ended');
  });

  // 23. Not a participant — returns 403
  it('returns 403 when client is not caller or callee', async () => {
    const call = makeCallDoc({
      callerId: 'someone-else',
      calleeId: 'another-person'
    });
    (bundle.db.getCall as jest.Mock).mockResolvedValueOnce(call);

    const response = await bundle.app.inject({
      method: 'DELETE',
      url: '/api/v1/call/call-uuid-001',
      headers: { authorization: `Bearer ${makeCallerToken()}` }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'Not a participant of this call' });
  });

  // 24. Call not found — returns 404
  it('returns 404 when call does not exist', async () => {
    (bundle.db.getCall as jest.Mock).mockResolvedValueOnce(null);

    const response = await bundle.app.inject({
      method: 'DELETE',
      url: '/api/v1/call/nonexistent-call',
      headers: { authorization: `Bearer ${makeCallerToken()}` }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'Call not found' });
  });

  // 25. Call already ended — returns 409
  it('returns 409 when call is already ended', async () => {
    const endedCall = makeCallDoc({ state: 'ended' });
    (bundle.db.getCall as jest.Mock).mockResolvedValueOnce(endedCall);

    const response = await bundle.app.inject({
      method: 'DELETE',
      url: '/api/v1/call/call-uuid-001',
      headers: { authorization: `Bearer ${makeCallerToken()}` }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'Call already ended' });
  });

  // 26. call_ended WebSocket event broadcast
  it('broadcasts call_ended event after ending call', async () => {
    const activeCall = makeCallDoc({ state: 'active' });
    const endedCall = makeCallDoc({
      state: 'ended',
      endedBy: 'caller-uuid-001',
      endedAt: '2026-02-28T11:00:00.000Z'
    });

    (bundle.db.getCall as jest.Mock)
      .mockResolvedValueOnce(activeCall)
      .mockResolvedValueOnce(activeCall)
      .mockResolvedValueOnce(endedCall);

    const broadcastSpy = jest.spyOn(bundle.connectionManager, 'broadcast');

    const response = await bundle.app.inject({
      method: 'DELETE',
      url: '/api/v1/call/call-uuid-001',
      headers: { authorization: `Bearer ${makeCallerToken()}` }
    });

    expect(response.statusCode).toBe(200);
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    const [event] = broadcastSpy.mock.calls[0];
    expect(event.type).toBe('call_ended');
    if (event.type === 'call_ended') {
      expect(event.callId).toBe('call-uuid-001');
      expect(event.callerId).toBe('caller-uuid-001');
      expect(event.calleeId).toBe('callee-uuid-002');
      expect(event.endedBy).toBe('caller-uuid-001');
    }
  });
});

// ===========================================================================
// GET /api/v1/call/active — List active calls
// ===========================================================================

describe('GET /api/v1/call/active — list active calls', () => {
  let bundle: ServerBundle;

  beforeAll(async () => {
    initJwt(TEST_SECRET);
    bundle = await buildServer();
  });

  afterAll(async () => {
    await bundle.app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // 27. Returns active calls with direction
  it('returns active calls with correct direction for caller', async () => {
    const outgoingCall = makeCallDoc({
      _id: 'call-outgoing-001',
      callerId: 'caller-uuid-001',
      calleeId: 'callee-uuid-002',
      state: 'active'
    });
    const incomingCall = makeCallDoc({
      _id: 'call-incoming-001',
      callerId: 'some-other-client',
      calleeId: 'caller-uuid-001', // caller is the callee here
      calleeName: 'Caller Studio',
      state: 'active'
    });

    (bundle.db.getActiveCallsForClient as jest.Mock).mockResolvedValueOnce([
      outgoingCall,
      incomingCall
    ]);

    const response = await bundle.app.inject({
      method: 'GET',
      url: '/api/v1/call/active',
      headers: { authorization: `Bearer ${makeCallerToken()}` }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body.calls)).toBe(true);
    expect(body.calls).toHaveLength(2);

    const outgoing = body.calls.find(
      (c: { callId: string }) => c.callId === 'call-outgoing-001'
    );
    const incoming = body.calls.find(
      (c: { callId: string }) => c.callId === 'call-incoming-001'
    );
    expect(outgoing.direction).toBe('outgoing');
    expect(incoming.direction).toBe('incoming');
  });

  // 28. Returns empty array when no active calls
  it('returns { calls: [] } when there are no active calls', async () => {
    (bundle.db.getActiveCallsForClient as jest.Mock).mockResolvedValueOnce([]);

    const response = await bundle.app.inject({
      method: 'GET',
      url: '/api/v1/call/active',
      headers: { authorization: `Bearer ${makeCallerToken()}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ calls: [] });
  });

  // 29. Without auth — returns 401
  it('returns 401 when Authorization header is missing', async () => {
    const response = await bundle.app.inject({
      method: 'GET',
      url: '/api/v1/call/active'
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized' });
  });

  // Active calls response includes all expected fields
  it('returns call items with all required fields', async () => {
    const call = makeCallDoc({ state: 'pending' });
    (bundle.db.getActiveCallsForClient as jest.Mock).mockResolvedValueOnce([call]);

    const response = await bundle.app.inject({
      method: 'GET',
      url: '/api/v1/call/active',
      headers: { authorization: `Bearer ${makeCallerToken()}` }
    });

    expect(response.statusCode).toBe(200);
    const { calls } = response.json();
    expect(calls).toHaveLength(1);
    const item = calls[0];
    expect(item.callId).toBe('call-uuid-001');
    expect(item.callerId).toBe('caller-uuid-001');
    expect(item.calleeId).toBe('callee-uuid-002');
    expect(item.callerName).toBe('Caller Studio');
    expect(item.calleeName).toBe('Callee Reporter');
    expect(item.state).toBe('pending');
    expect(item.direction).toBe('outgoing');
    expect(typeof item.createdAt).toBe('string');
  });
});
