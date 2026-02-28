/**
 * WebSocket presence tests for GET /api/v1/ws?token=JWT
 *
 * Tests the M1 WebSocket endpoint defined in api_clients.ts.
 * Covers: authentication, online/offline status, client_list, client_connected,
 * client_disconnected broadcasts, and duplicate connection handling.
 *
 * Strategy:
 * - Uses server.injectWS() from @fastify/websocket for message-based tests.
 * - IMPORTANT: The first message (client_list) may arrive before the 'open'
 *   event resolves on the client side. We use the onInit hook to attach the
 *   message listener BEFORE the connection opens, to avoid this race condition.
 * - Uses a real TCP listen() port for close-code tests (2, 3, 10) since
 *   injectWS rejects (throws) on non-101 responses.
 */

import WebSocket from 'ws';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'net';
import api from './api';
import { initJwt } from './auth/jwt';
import { ConnectionManager } from './connection_manager';
import { CoreFunctions } from './api_productions_core_functions';
import { ConnectionQueue } from './connection_queue';
import { ClientDocument } from './models';

// ── JWT test secret ───────────────────────────────────────────────────────────

const TEST_JWT_SECRET = 'ws-test-secret-12345';

// ── Mock setup ────────────────────────────────────────────────────────────────

jest.mock('./db/mongodb');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeClientDoc(overrides: Partial<ClientDocument> & { _id: string }): ClientDocument {
  return {
    _id: overrides._id,
    docType: 'client',
    name: overrides.name ?? 'Test Client',
    role: overrides.role ?? 'producer',
    location: overrides.location ?? 'Stockholm',
    isOnline: overrides.isOnline ?? false,
    createdAt: overrides.createdAt ?? '2026-02-28T10:00:00.000Z',
    lastSeenAt: overrides.lastSeenAt ?? '2026-02-28T10:00:00.000Z'
  };
}

/**
 * Connect via injectWS and collect the FIRST message sent by the server.
 *
 * The message listener is attached in the onInit callback (before the WebSocket
 * 'open' event fires) to avoid a race condition where the server sends the
 * client_list message before the client 'open' resolves.
 *
 * Returns: { ws, firstMessage }
 */
async function connectAndGetFirstMessage(
  server: Awaited<ReturnType<typeof api>>,
  path: string
): Promise<{ ws: WebSocket; firstMessage: any }> {
  let resolveMsg: (msg: any) => void;
  let rejectMsg: (err: Error) => void;
  const msgPromise = new Promise<any>((res, rej) => {
    resolveMsg = res;
    rejectMsg = rej;
  });

  const msgTimeout = setTimeout(() => {
    rejectMsg(new Error('Timeout waiting for first WS message'));
  }, 5000);

  const ws = await server.injectWS(path, {}, {
    onInit: (socket: WebSocket) => {
      // Register message listener BEFORE open fires
      socket.once('message', (data: WebSocket.RawData) => {
        clearTimeout(msgTimeout);
        resolveMsg(JSON.parse(data.toString()));
      });
    }
  });

  const firstMessage = await msgPromise;
  return { ws, firstMessage };
}

/**
 * Get a promise that resolves with the next message received by an already-open ws.
 */
function waitForNextMessage(ws: WebSocket, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timeout waiting for WS message after ${timeoutMs}ms`)),
      timeoutMs
    );
    ws.once('message', (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()));
    });
  });
}

/**
 * Wait for the WS to close.
 */
function waitForClose(ws: WebSocket, timeoutMs = 5000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timeout waiting for WS close after ${timeoutMs}ms`)),
      timeoutMs
    );
    if (ws.readyState === WebSocket.CLOSED) {
      clearTimeout(timeout);
      resolve({ code: 1000, reason: '' });
      return;
    }
    ws.once('close', (code, reason) => {
      clearTimeout(timeout);
      resolve({ code, reason: reason.toString() });
    });
  });
}

/**
 * Small delay to allow async server-side operations to complete after events.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Mock DbManager factory ─────────────────────────────────────────────────

function makeMockDbManager() {
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
    // Client registry methods (M1)
    saveClient: jest.fn().mockResolvedValue(undefined),
    getClient: jest.fn().mockResolvedValue(null),
    updateClient: jest.fn().mockResolvedValue(undefined),
    getOnlineClients: jest.fn().mockResolvedValue([]),
    saveCall: jest.fn().mockResolvedValue(undefined),
    getCall: jest.fn().mockResolvedValue(null),
    updateCall: jest.fn().mockResolvedValue(undefined),
    getActiveCallsForClient: jest.fn().mockResolvedValue([]),
    getActiveCallCount: jest.fn().mockResolvedValue(0)
  };
}

const mockProductionManager = {
  checkUserStatus: jest.fn(),
  load: jest.fn().mockResolvedValue(undefined),
  createProduction: jest.fn().mockResolvedValue({}),
  getProductions: jest.fn().mockResolvedValue([]),
  getNumberOfProductions: jest.fn().mockResolvedValue(0),
  requireProduction: jest.fn().mockResolvedValue({}),
  updateProduction: jest.fn().mockResolvedValue({}),
  addProductionLine: jest.fn().mockResolvedValue(undefined),
  getLine: jest.fn().mockResolvedValue(undefined),
  getUsersForLine: jest.fn().mockResolvedValue([]),
  updateProductionLine: jest.fn().mockResolvedValue({}),
  deleteProductionLine: jest.fn().mockResolvedValue(undefined),
  deleteProduction: jest.fn().mockResolvedValue(true),
  removeUserSession: jest.fn().mockResolvedValue('session-id'),
  getUser: jest.fn().mockResolvedValue(undefined),
  requireLine: jest.fn().mockResolvedValue({}),
  updateUserLastSeen: jest.fn().mockResolvedValue(true),
  getProduction: jest.fn().mockResolvedValue(undefined),
  setLineId: jest.fn().mockResolvedValue(undefined),
  createUserSession: jest.fn(),
  updateUserEndpoint: jest.fn().mockResolvedValue(true),
  on: jest.fn(),
  once: jest.fn(),
  emit: jest.fn()
} as any;

const mockIngestManager = {
  load: jest.fn().mockResolvedValue(undefined),
  startPolling: jest.fn()
} as any;

// ── Test clients ──────────────────────────────────────────────────────────────

const clientA = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  name: 'Client A',
  role: 'producer',
  location: 'Stockholm'
};

const clientB = {
  id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  name: 'Client B',
  role: 'reporter',
  location: 'Gothenburg'
};

// ── Helper to build a valid JWT token ────────────────────────────────────────

function makeToken(client: typeof clientA): string {
  return jwt.sign(
    {
      clientId: client.id,
      name: client.name,
      role: client.role,
      location: client.location
    },
    TEST_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '24h' }
  );
}

// Initialize JWT once for all tests
beforeAll(() => {
  initJwt(TEST_JWT_SECRET);
});

// ── Suite: injectWS-based tests (no real port, tests that need messages) ──────

describe('WebSocket presence — message-based tests (injectWS)', () => {
  let server: Awaited<ReturnType<typeof api>>;
  let mockDbManager: ReturnType<typeof makeMockDbManager>;
  let connectionManager: ConnectionManager;
  const tokenA = makeToken(clientA);
  const tokenB = makeToken(clientB);

  /**
   * Create a fresh server + db mock for each test to avoid state leakage
   * (connectionManager tracks active sockets across tests).
   */
  beforeEach(async () => {
    mockDbManager = makeMockDbManager();
    connectionManager = new ConnectionManager();

    server = await api({
      title: 'ws-test',
      smbServerBaseUrl: 'http://localhost:8080',
      endpointIdleTimeout: '60',
      publicHost: 'http://localhost',
      dbManager: mockDbManager,
      productionManager: mockProductionManager,
      ingestManager: mockIngestManager,
      connectionManager,
      coreFunctions: new CoreFunctions(mockProductionManager, new ConnectionQueue())
    });

    await server.ready();
  });

  afterEach(async () => {
    await server.close();
  });

  // ── Test 1: Connect with valid token receives client_list ─────────────────

  it('1. connects with valid token and receives client_list as first message', async () => {
    mockDbManager.getClient.mockResolvedValue(
      makeClientDoc({ _id: clientA.id, name: clientA.name, role: clientA.role, location: clientA.location })
    );
    mockDbManager.getOnlineClients.mockResolvedValue([]);

    const { ws, firstMessage } = await connectAndGetFirstMessage(
      server,
      `/api/v1/ws?token=${tokenA}`
    );

    expect(firstMessage.type).toBe('client_list');
    expect(Array.isArray(firstMessage.clients)).toBe(true);

    ws.terminate();
    await delay(50);
  });

  // ── Test 4: Client marked online on connect ───────────────────────────────

  it('4. calls updateClient with isOnline:true when client connects', async () => {
    mockDbManager.getClient.mockResolvedValue(
      makeClientDoc({ _id: clientA.id })
    );
    mockDbManager.getOnlineClients.mockResolvedValue([]);

    // Wait for first message to confirm the async connect handler completed
    const { ws } = await connectAndGetFirstMessage(
      server,
      `/api/v1/ws?token=${tokenA}`
    );

    expect(mockDbManager.updateClient).toHaveBeenCalledWith(
      clientA.id,
      expect.objectContaining({ isOnline: true })
    );

    ws.terminate();
    await delay(50);
  });

  // ── Test 5: Client marked offline on disconnect ───────────────────────────

  it('5. calls updateClient with isOnline:false when client disconnects', async () => {
    mockDbManager.getClient.mockResolvedValue(
      makeClientDoc({ _id: clientA.id })
    );
    mockDbManager.getOnlineClients.mockResolvedValue([]);

    const { ws } = await connectAndGetFirstMessage(
      server,
      `/api/v1/ws?token=${tokenA}`
    );

    // Terminate the socket and allow disconnect handler to run
    ws.terminate();
    await delay(150);

    const calls = (mockDbManager.updateClient.mock.calls as any[][]);
    const offlineCall = calls.find(
      (call) =>
        call[0] === clientA.id &&
        call[1] !== null &&
        typeof call[1] === 'object' &&
        call[1].isOnline === false
    );
    expect(offlineCall).toBeDefined();
  });

  // ── Test 6: client_connected broadcast ───────────────────────────────────

  it('6. broadcasts client_connected to existing clients when a new client connects', async () => {
    const clientADoc = makeClientDoc({
      _id: clientA.id, name: clientA.name, role: clientA.role, location: clientA.location
    });
    const clientBDoc = makeClientDoc({
      _id: clientB.id, name: clientB.name, role: clientB.role, location: clientB.location
    });

    mockDbManager.getClient.mockImplementation((id: string) => {
      if (id === clientA.id) return Promise.resolve(clientADoc);
      if (id === clientB.id) return Promise.resolve(clientBDoc);
      return Promise.resolve(null);
    });
    mockDbManager.getOnlineClients.mockResolvedValue([]);

    // Connect A and consume its client_list
    const { ws: wsA } = await connectAndGetFirstMessage(
      server,
      `/api/v1/ws?token=${tokenA}`
    );

    // Set up a promise for A's next message BEFORE connecting B
    const nextMsgForA = waitForNextMessage(wsA);

    // Connect B (consume its client_list too)
    await connectAndGetFirstMessage(server, `/api/v1/ws?token=${tokenB}`);

    // A should receive client_connected for B
    const event = await nextMsgForA;
    expect(event.type).toBe('client_connected');
    expect(event.client.clientId).toBe(clientB.id);
    expect(event.client.name).toBe(clientB.name);
    expect(event.client.role).toBe(clientB.role);
    expect(event.client.location).toBe(clientB.location);

    // wsB is closed by server.close() in afterEach
    wsA.terminate();
    await delay(100);
  });

  // ── Test 7: client_disconnected broadcast ─────────────────────────────────

  it('7. broadcasts client_disconnected to remaining clients when a client disconnects', async () => {
    const clientADoc = makeClientDoc({ _id: clientA.id });
    const clientBDoc = makeClientDoc({ _id: clientB.id });

    mockDbManager.getClient.mockImplementation((id: string) => {
      if (id === clientA.id) return Promise.resolve(clientADoc);
      if (id === clientB.id) return Promise.resolve(clientBDoc);
      return Promise.resolve(null);
    });
    mockDbManager.getOnlineClients.mockResolvedValue([]);

    // Collect ALL messages received by A in a queue, so none are missed.
    const msgsForA: any[] = [];
    let pendingResolve: ((msg: any) => void) | null = null;

    function onMessageForA(data: WebSocket.RawData) {
      const parsed = JSON.parse(data.toString());
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve(parsed);
      } else {
        msgsForA.push(parsed);
      }
    }

    function nextMsgFromQueue(timeoutMs = 5000): Promise<any> {
      if (msgsForA.length > 0) {
        return Promise.resolve(msgsForA.shift()!);
      }
      return new Promise((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error('Timeout waiting for queued WS message')),
          timeoutMs
        );
        pendingResolve = (msg) => {
          clearTimeout(t);
          resolve(msg);
        };
      });
    }

    // Connect A — attach queue listener via onInit BEFORE the connection opens
    let wsA!: WebSocket;
    const wsAFirstMsg = new Promise<any>((resolve) => {
      // We resolve with the first message (client_list) and then keep queueing
      let gotFirst = false;
      server.injectWS(`/api/v1/ws?token=${tokenA}`, {}, {
        onInit: (socket: WebSocket) => {
          wsA = socket;
          socket.on('message', (data: WebSocket.RawData) => {
            const parsed = JSON.parse(data.toString());
            if (!gotFirst) {
              gotFirst = true;
              resolve(parsed); // resolve with client_list
            } else {
              onMessageForA(data);
            }
          });
        }
      });
    });
    await wsAFirstMsg; // wait for A's client_list

    // Connect B
    const { ws: wsB } = await connectAndGetFirstMessage(
      server,
      `/api/v1/ws?token=${tokenB}`
    );

    // A should have received client_connected for B (already queued or pending)
    const clientConnectedMsg = await nextMsgFromQueue();
    expect(clientConnectedMsg.type).toBe('client_connected');

    // Disconnect B
    wsB.terminate();

    // A should receive client_disconnected for B
    const disconnectEvent = await nextMsgFromQueue();
    expect(disconnectEvent.type).toBe('client_disconnected');
    expect(disconnectEvent.clientId).toBe(clientB.id);

    wsA.terminate();
    await delay(50);
  });

  // ── Test 8: client_list contains already-connected clients ───────────────

  it('8. newly connecting client receives client_list containing already-online clients', async () => {
    const clientADoc = makeClientDoc({
      _id: clientA.id,
      name: clientA.name,
      role: clientA.role,
      location: clientA.location,
      isOnline: true
    });
    const clientBDoc = makeClientDoc({ _id: clientB.id });

    mockDbManager.getClient.mockImplementation((id: string) => {
      if (id === clientA.id) return Promise.resolve(clientADoc);
      if (id === clientB.id) return Promise.resolve(clientBDoc);
      return Promise.resolve(null);
    });

    // Connect A first (getOnlineClients returns [] for A's client_list)
    mockDbManager.getOnlineClients.mockResolvedValue([]);
    const { ws: wsA } = await connectAndGetFirstMessage(
      server,
      `/api/v1/ws?token=${tokenA}`
    );

    // When B connects, simulate A being online in the DB
    mockDbManager.getOnlineClients.mockResolvedValue([clientADoc]);

    // Connect B — its client_list should contain A
    const { firstMessage: clientListMsg } = await connectAndGetFirstMessage(
      server,
      `/api/v1/ws?token=${tokenB}`
    );

    expect(clientListMsg.type).toBe('client_list');
    expect(Array.isArray(clientListMsg.clients)).toBe(true);

    const clientIds = clientListMsg.clients.map((c: any) => c.clientId);
    expect(clientIds).toContain(clientA.id);
    expect(clientIds).not.toContain(clientB.id); // self is excluded

    wsA.terminate();
    await delay(100);
  });

  // ── Test 9: Duplicate connection replaces old socket with code 4002 ───────

  it('9. old socket is closed with code 4002 when same clientId connects again', async () => {
    mockDbManager.getClient.mockResolvedValue(
      makeClientDoc({ _id: clientA.id })
    );
    mockDbManager.getOnlineClients.mockResolvedValue([]);

    // First connection
    const { ws: wsFirst } = await connectAndGetFirstMessage(
      server,
      `/api/v1/ws?token=${tokenA}`
    );

    // Set up close listener BEFORE connecting again
    const firstClosePromise = waitForClose(wsFirst);

    // Second connection with the same clientId
    const { ws: wsSecond } = await connectAndGetFirstMessage(
      server,
      `/api/v1/ws?token=${tokenA}`
    );

    // First socket must be closed with 4002
    const { code } = await firstClosePromise;
    expect(code).toBe(4002);

    wsSecond.terminate();
    await delay(50);
  });
});

// ── Suite: close-code tests using a real TCP port ─────────────────────────────

describe('WebSocket presence — close code tests (real TCP)', () => {
  let server: Awaited<ReturnType<typeof api>>;
  let port: number;
  let wsUrl: string;

  beforeAll(async () => {
    const mockDb = makeMockDbManager();
    const connMgr = new ConnectionManager();

    server = await api({
      title: 'ws-close-test',
      smbServerBaseUrl: 'http://localhost:8080',
      endpointIdleTimeout: '60',
      publicHost: 'http://localhost',
      dbManager: mockDb,
      productionManager: mockProductionManager,
      ingestManager: mockIngestManager,
      connectionManager: connMgr,
      coreFunctions: new CoreFunctions(mockProductionManager, new ConnectionQueue())
    });

    await server.listen({ port: 0 });
    const address = server.server.address() as AddressInfo;
    port = address.port;
    wsUrl = `ws://127.0.0.1:${port}/api/v1/ws`;
  });

  afterAll(async () => {
    await server.close();
  });

  // ── Test 2: Invalid token → close 4001 ───────────────────────────────────

  it('2. closes with code 4001 when token is invalid', async () => {
    const ws = new WebSocket(`${wsUrl}?token=garbage-token`);
    const { code } = await waitForClose(ws);
    expect(code).toBe(4001);
  });

  // ── Test 3: No token → close 4001 ────────────────────────────────────────

  it('3. closes with code 4001 when no token query param is provided', async () => {
    const ws = new WebSocket(wsUrl);
    const { code } = await waitForClose(ws);
    expect(code).toBe(4001);
  });

  // ── Test 10: Expired token → close 4001 ──────────────────────────────────

  it('10. closes with code 4001 when token is expired', async () => {
    const expiredToken = jwt.sign(
      {
        clientId: clientA.id,
        name: clientA.name,
        role: clientA.role,
        location: clientA.location,
        iat: Math.floor(Date.now() / 1000) - 90000
      },
      TEST_JWT_SECRET,
      { algorithm: 'HS256', expiresIn: -1 }
    );

    const ws = new WebSocket(`${wsUrl}?token=${expiredToken}`);
    const { code } = await waitForClose(ws);
    expect(code).toBe(4001);
  });
});
