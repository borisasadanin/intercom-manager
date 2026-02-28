/**
 * Tests for M3 status REST endpoints.
 * Covers: GET /status/talks, GET /health
 *
 * Uses a minimal Fastify server with the getApiStatus() plugin,
 * a mock DbManager, a mock ConnectionManager, and a real TalkManager.
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
import { initJwt, generateToken } from './auth/jwt';
import { TalkManager } from './talk_manager';
import { ConnectionManager } from './connection_manager';
import { getApiStatus } from './api_status';
import { DbManager } from './db/interface';
import { ClientDocument } from './models';

const TEST_SECRET = 'test-secret-for-api-status';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeClientDoc(overrides: Partial<ClientDocument> = {}): ClientDocument {
  return {
    _id: 'client-uuid-001',
    docType: 'client',
    name: 'Studio A',
    role: 'producer',
    location: 'Stockholm',
    isOnline: true,
    createdAt: '2026-02-28T10:00:00.000Z',
    lastSeenAt: '2026-02-28T10:00:00.000Z',
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

interface ServerBundle {
  app: FastifyInstance;
  db: DbManager;
  connectionManager: ConnectionManager;
  talkManager: TalkManager;
}

async function buildServer(
  db?: DbManager,
  connectionManager?: ConnectionManager,
  talkManager?: TalkManager
): Promise<ServerBundle> {
  const resolvedDb = db ?? makeMockDbManager();
  const resolvedCm = connectionManager ?? new ConnectionManager();
  const resolvedTm = talkManager ?? new TalkManager();

  const app = Fastify();
  app.register(getApiStatus(), {
    prefix: 'api/v1',
    dbManager: resolvedDb,
    connectionManager: resolvedCm,
    talkManager: resolvedTm
  });
  await app.ready();

  return {
    app,
    db: resolvedDb,
    connectionManager: resolvedCm,
    talkManager: resolvedTm
  };
}

function makeToken(clientId = 'client-uuid-001'): string {
  return generateToken({
    clientId,
    name: 'Studio A',
    role: 'producer',
    location: 'Stockholm'
  });
}

// ===========================================================================
// GET /api/v1/status/talks
// ===========================================================================

describe('GET /api/v1/status/talks', () => {
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
    // Reset talk manager state between tests
    bundle.talkManager.stopTalking('client-A');
    bundle.talkManager.stopTalking('client-B');
  });

  // 1. Returns empty when nobody talking
  it('returns 200 with { talks: [] } when nobody is talking', async () => {
    const response = await bundle.app.inject({
      method: 'GET',
      url: '/api/v1/status/talks',
      headers: { authorization: `Bearer ${makeToken()}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ talks: [] });
  });

  // 2. Returns active talkers with client names
  it('returns active talker with resolved client name', async () => {
    bundle.talkManager.startTalking('client-A', ['call-001']);

    const clientDoc = makeClientDoc({ _id: 'client-A', name: 'Alice Producer' });
    (bundle.db.getClient as jest.Mock).mockResolvedValueOnce(clientDoc);

    const response = await bundle.app.inject({
      method: 'GET',
      url: '/api/v1/status/talks',
      headers: { authorization: `Bearer ${makeToken()}` }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.talks).toHaveLength(1);
    expect(body.talks[0].clientId).toBe('client-A');
    expect(body.talks[0].clientName).toBe('Alice Producer');
    expect(body.talks[0].callIds).toEqual(['call-001']);
  });

  // 3. Returns multiple talkers
  it('returns all active talkers when multiple clients are talking', async () => {
    bundle.talkManager.startTalking('client-A', ['call-AB']);
    bundle.talkManager.startTalking('client-B', ['call-BC']);

    const docA = makeClientDoc({ _id: 'client-A', name: 'Alice' });
    const docB = makeClientDoc({ _id: 'client-B', name: 'Bob' });
    (bundle.db.getClient as jest.Mock)
      .mockResolvedValueOnce(docA)
      .mockResolvedValueOnce(docB);

    const response = await bundle.app.inject({
      method: 'GET',
      url: '/api/v1/status/talks',
      headers: { authorization: `Bearer ${makeToken()}` }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.talks).toHaveLength(2);

    const clientIds = body.talks.map((t: { clientId: string }) => t.clientId);
    expect(clientIds).toContain('client-A');
    expect(clientIds).toContain('client-B');

    const alice = body.talks.find(
      (t: { clientId: string }) => t.clientId === 'client-A'
    );
    const bob = body.talks.find(
      (t: { clientId: string }) => t.clientId === 'client-B'
    );
    expect(alice.clientName).toBe('Alice');
    expect(bob.clientName).toBe('Bob');
  });

  // 4. Requires auth — no Authorization header returns 401
  it('returns 401 when Authorization header is missing', async () => {
    const response = await bundle.app.inject({
      method: 'GET',
      url: '/api/v1/status/talks'
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized' });
  });

  // 5. Falls back to 'Unknown' if client not found in DB
  it("uses 'Unknown' as clientName when getClient returns null", async () => {
    bundle.talkManager.startTalking('client-ghost', ['call-ghost']);

    // getClient returns null for an unknown client
    (bundle.db.getClient as jest.Mock).mockResolvedValueOnce(null);

    const response = await bundle.app.inject({
      method: 'GET',
      url: '/api/v1/status/talks',
      headers: { authorization: `Bearer ${makeToken()}` }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.talks).toHaveLength(1);
    expect(body.talks[0].clientId).toBe('client-ghost');
    expect(body.talks[0].clientName).toBe('Unknown');
  });
});

// ===========================================================================
// GET /api/v1/health
// ===========================================================================

describe('GET /api/v1/health', () => {
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

  // 1. Returns ok status with all required metric fields
  it('returns 200 with status ok and all required metrics', async () => {
    (bundle.db.getActiveCallCount as jest.Mock).mockResolvedValueOnce(5);

    const response = await bundle.app.inject({
      method: 'GET',
      url: '/api/v1/health'
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
    expect(typeof body.clients).toBe('number');
    expect(typeof body.activeCalls).toBe('number');
    expect(typeof body.activeTalkers).toBe('number');
  });

  // 2. Uptime is positive number
  it('returns a positive uptime value', async () => {
    const response = await bundle.app.inject({
      method: 'GET',
      url: '/api/v1/health'
    });

    expect(response.statusCode).toBe(200);
    const { uptime } = response.json();
    expect(uptime).toBeGreaterThanOrEqual(0);
  });

  // 3. Clients count matches getConnectedClientIds().length
  it('returns clients count equal to number of connections in ConnectionManager', async () => {
    // Spy on getConnectedClientIds to return a fixed set
    const spy = jest
      .spyOn(bundle.connectionManager, 'getConnectedClientIds')
      .mockReturnValueOnce(['id-1', 'id-2', 'id-3']);

    const response = await bundle.app.inject({
      method: 'GET',
      url: '/api/v1/health'
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().clients).toBe(3);
    spy.mockRestore();
  });

  // 4. Active calls count matches getActiveCallCount()
  it('returns activeCalls equal to DB getActiveCallCount result', async () => {
    (bundle.db.getActiveCallCount as jest.Mock).mockResolvedValueOnce(42);

    const response = await bundle.app.inject({
      method: 'GET',
      url: '/api/v1/health'
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().activeCalls).toBe(42);
  });

  // 5. Active talkers count matches TalkManager.getActiveTalkerCount()
  it('returns activeTalkers equal to TalkManager.getActiveTalkerCount()', async () => {
    bundle.talkManager.startTalking('client-X', ['call-x1']);
    bundle.talkManager.startTalking('client-Y', ['call-y1']);

    const response = await bundle.app.inject({
      method: 'GET',
      url: '/api/v1/health'
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().activeTalkers).toBe(2);

    // Cleanup
    bundle.talkManager.stopTalking('client-X');
    bundle.talkManager.stopTalking('client-Y');
  });

  // 6. No auth required — GET without token returns 200
  it('returns 200 without any Authorization header', async () => {
    const response = await bundle.app.inject({
      method: 'GET',
      url: '/api/v1/health'
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ok');
  });
});
