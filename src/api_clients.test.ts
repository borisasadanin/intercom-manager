/**
 * Tests for M1 client registry REST endpoints.
 * Covers: POST /client/register, GET /client/me, PATCH /client/me,
 *         GET /client/list, GET /client/:clientId
 *
 * Uses a minimal Fastify server with only the getApiClients() plugin,
 * a mock DbManager, and a real ConnectionManager.
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
import jwt from 'jsonwebtoken';
import { initJwt, generateToken } from './auth/jwt';
import { ConnectionManager } from './connection_manager';
import { getApiClients } from './api_clients';
import { ClientDocument } from './models';
import { DbManager } from './db/interface';

const TEST_SECRET = 'test-secret-for-api-clients';

// --- Helpers ---------------------------------------------------------------

function makeClientDoc(overrides: Partial<ClientDocument> = {}): ClientDocument {
  return {
    _id: 'client-uuid-001',
    docType: 'client',
    name: 'Studio A',
    role: 'producer',
    location: 'Stockholm',
    isOnline: false,
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

async function buildServer(db: DbManager): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(websocket);
  app.register(getApiClients(), {
    prefix: 'api/v1',
    dbManager: db,
    connectionManager: new ConnectionManager()
  });
  await app.ready();
  return app;
}

// ===========================================================================
// 7.1  Registration Tests
// ===========================================================================

describe('POST /api/v1/client/register', () => {
  let app: FastifyInstance;
  let db: DbManager;

  beforeAll(async () => {
    initJwt(TEST_SECRET);
    db = makeMockDbManager();
    app = await buildServer(db);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // 1. Register new client — returns 200 with expected fields
  it('registers a new client and returns clientId, token, name, role, location', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/client/register',
      payload: { name: 'Studio A', role: 'producer', location: 'Stockholm' }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(typeof body.clientId).toBe('string');
    expect(body.clientId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(typeof body.token).toBe('string');
    expect(body.name).toBe('Studio A');
    expect(body.role).toBe('producer');
    expect(body.location).toBe('Stockholm');
  });

  // 2. Generated token is valid — decode and verify
  it('returns a valid JWT token containing clientId, name, role, location, exp', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/client/register',
      payload: { name: 'Studio A', role: 'producer', location: 'Stockholm' }
    });

    expect(response.statusCode).toBe(200);
    const { token, clientId } = response.json();

    const decoded = jwt.verify(token, TEST_SECRET) as Record<string, unknown>;
    expect(decoded.clientId).toBe(clientId);
    expect(decoded.name).toBe('Studio A');
    expect(decoded.role).toBe('producer');
    expect(decoded.location).toBe('Stockholm');
    expect(typeof decoded.exp).toBe('number');
  });

  // 3. Client saved in DB with isOnline: false, docType: 'client'
  it('calls saveClient with correct document (isOnline: false, docType: client)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/client/register',
      payload: { name: 'Studio A', role: 'producer', location: 'Stockholm' }
    });

    expect(response.statusCode).toBe(200);
    const { clientId } = response.json();

    expect(db.saveClient).toHaveBeenCalledTimes(1);
    const savedDoc = (db.saveClient as jest.Mock).mock.calls[0][0] as ClientDocument;
    expect(savedDoc._id).toBe(clientId);
    expect(savedDoc.docType).toBe('client');
    expect(savedDoc.isOnline).toBe(false);
    expect(savedDoc.name).toBe('Studio A');
    expect(savedDoc.role).toBe('producer');
    expect(savedDoc.location).toBe('Stockholm');
    expect(typeof savedDoc.createdAt).toBe('string');
    expect(typeof savedDoc.lastSeenAt).toBe('string');
  });

  // 4. Re-register existing client — same clientId returned, updateClient called
  it('re-registers existing client: same clientId, calls updateClient', async () => {
    const existingId = 'existing-client-uuid-001';
    const existingDoc = makeClientDoc({ _id: existingId });

    // First call to getClient (during re-registration lookup) returns the doc
    (db.getClient as jest.Mock).mockResolvedValueOnce(existingDoc);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/client/register',
      payload: {
        name: 'Studio A Updated',
        role: 'producer',
        location: 'Stockholm',
        existingClientId: existingId
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.clientId).toBe(existingId);
    expect(body.name).toBe('Studio A Updated');
    // updateClient should be called, not saveClient
    expect(db.updateClient).toHaveBeenCalledTimes(1);
    expect(db.saveClient).not.toHaveBeenCalled();
    const [updatedId, updates] = (db.updateClient as jest.Mock).mock.calls[0];
    expect(updatedId).toBe(existingId);
    expect(updates.name).toBe('Studio A Updated');
  });

  // 5. Re-register with invalid existingClientId — new clientId returned
  it('creates new client when existingClientId is not found in DB', async () => {
    const invalidId = 'nonexistent-id';
    // getClient returns null (not found)
    (db.getClient as jest.Mock).mockResolvedValueOnce(null);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/client/register',
      payload: {
        name: 'Studio A',
        role: 'producer',
        location: 'Stockholm',
        existingClientId: invalidId
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Should be a new UUID, not the invalid one
    expect(body.clientId).not.toBe(invalidId);
    expect(body.clientId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    // saveClient called to create new
    expect(db.saveClient).toHaveBeenCalledTimes(1);
  });

  // 6. Missing name — returns 400
  it('returns 400 when name is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/client/register',
      payload: { role: 'producer', location: 'Stockholm' }
    });

    expect(response.statusCode).toBe(400);
  });

  // 7. Missing role — returns 400
  it('returns 400 when role is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/client/register',
      payload: { name: 'Studio A', location: 'Stockholm' }
    });

    expect(response.statusCode).toBe(400);
  });

  // 8. Missing location — returns 400
  it('returns 400 when location is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/client/register',
      payload: { name: 'Studio A', role: 'producer' }
    });

    expect(response.statusCode).toBe(400);
  });

  // 9. Empty name — returns 400
  it('returns 400 when name is empty string', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/client/register',
      payload: { name: '', role: 'producer', location: 'Stockholm' }
    });

    expect(response.statusCode).toBe(400);
  });

  // 10. Name too long — returns 400
  it('returns 400 when name exceeds 200 characters', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/client/register',
      payload: { name: 'x'.repeat(201), role: 'producer', location: 'Stockholm' }
    });

    expect(response.statusCode).toBe(400);
  });
});

// ===========================================================================
// 7.2  Profile Tests
// ===========================================================================

describe('GET /api/v1/client/me and PATCH /api/v1/client/me', () => {
  let app: FastifyInstance;
  let db: DbManager;

  beforeAll(async () => {
    initJwt(TEST_SECRET);
    db = makeMockDbManager();
    app = await buildServer(db);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Helper: generate a valid token for a client
  function makeToken(clientId: string = 'client-uuid-001'): string {
    return generateToken({
      clientId,
      name: 'Studio A',
      role: 'producer',
      location: 'Stockholm'
    });
  }

  // 1. GET /client/me returns full profile
  it('GET /client/me returns full client profile when authenticated', async () => {
    const clientDoc = makeClientDoc({ isOnline: true });
    (db.getClient as jest.Mock).mockResolvedValueOnce(clientDoc);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/client/me',
      headers: { authorization: `Bearer ${makeToken()}` }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.clientId).toBe('client-uuid-001');
    expect(body.name).toBe('Studio A');
    expect(body.role).toBe('producer');
    expect(body.location).toBe('Stockholm');
    expect(body.isOnline).toBe(true);
    expect(typeof body.createdAt).toBe('string');
    expect(typeof body.lastSeenAt).toBe('string');
  });

  // 2. GET /client/me without auth — returns 401
  it('GET /client/me returns 401 when Authorization header is missing', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/client/me'
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized' });
  });

  // 3. GET /client/me with expired token — returns 401
  it('GET /client/me returns 401 when token is expired', async () => {
    const expiredToken = jwt.sign(
      {
        clientId: 'client-uuid-001',
        name: 'Studio A',
        role: 'producer',
        location: 'Stockholm',
        iat: Math.floor(Date.now() / 1000) - 90000
      },
      TEST_SECRET,
      { algorithm: 'HS256', expiresIn: -1 }
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/client/me',
      headers: { authorization: `Bearer ${expiredToken}` }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized' });
  });

  // 4. PATCH /client/me updates name
  it('PATCH /client/me updates name and returns updated profile', async () => {
    const originalDoc = makeClientDoc();
    const updatedDoc = makeClientDoc({ name: 'New Name' });
    // First call for looking up existing doc, second for re-fetch after update
    (db.getClient as jest.Mock)
      .mockResolvedValueOnce(originalDoc)
      .mockResolvedValueOnce(updatedDoc);

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/client/me',
      headers: { authorization: `Bearer ${makeToken()}` },
      payload: { name: 'New Name' }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.name).toBe('New Name');
    expect(body.role).toBe('producer');
    expect(body.location).toBe('Stockholm');
    expect(db.updateClient).toHaveBeenCalledTimes(1);
    const [calledId, updates] = (db.updateClient as jest.Mock).mock.calls[0];
    expect(calledId).toBe('client-uuid-001');
    expect(updates.name).toBe('New Name');
  });

  // 5. PATCH /client/me updates all fields
  it('PATCH /client/me updates all fields and returns full updated profile', async () => {
    const originalDoc = makeClientDoc();
    const updatedDoc = makeClientDoc({
      name: 'New Name',
      role: 'technician',
      location: 'Gothenburg'
    });
    (db.getClient as jest.Mock)
      .mockResolvedValueOnce(originalDoc)
      .mockResolvedValueOnce(updatedDoc);

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/client/me',
      headers: { authorization: `Bearer ${makeToken()}` },
      payload: { name: 'New Name', role: 'technician', location: 'Gothenburg' }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.name).toBe('New Name');
    expect(body.role).toBe('technician');
    expect(body.location).toBe('Gothenburg');
  });

  // 6. PATCH /client/me with empty body — returns 400
  it('PATCH /client/me returns 400 when body has no updatable fields', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/client/me',
      headers: { authorization: `Bearer ${makeToken()}` },
      payload: {}
    });

    expect(response.statusCode).toBe(400);
  });

  // 7. PATCH /client/me without auth — returns 401
  it('PATCH /client/me returns 401 when Authorization header is missing', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/client/me',
      payload: { name: 'New Name' }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized' });
  });
});

// ===========================================================================
// 7.3  Client List Tests
// ===========================================================================

describe('GET /api/v1/client/list and GET /api/v1/client/:clientId', () => {
  let app: FastifyInstance;
  let db: DbManager;
  let validToken: string;

  beforeAll(async () => {
    initJwt(TEST_SECRET);
    db = makeMockDbManager();
    app = await buildServer(db);
    validToken = generateToken({
      clientId: 'requester-uuid',
      name: 'Requester',
      role: 'producer',
      location: 'Stockholm'
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // 1. List returns online clients
  it('GET /client/list returns array of online clients', async () => {
    const client1 = makeClientDoc({
      _id: 'uuid-001',
      name: 'Studio A',
      isOnline: true,
      lastSeenAt: '2026-02-28T14:30:00.000Z'
    });
    const client2 = makeClientDoc({
      _id: 'uuid-002',
      name: 'OB Van 3',
      role: 'reporter',
      location: 'Malmo',
      isOnline: true,
      lastSeenAt: '2026-02-28T14:28:00.000Z'
    });
    (db.getOnlineClients as jest.Mock).mockResolvedValueOnce([client1, client2]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/client/list',
      headers: { authorization: `Bearer ${validToken}` }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Array.isArray(body.clients)).toBe(true);
    expect(body.clients).toHaveLength(2);
    expect(body.clients[0].clientId).toBe('uuid-001');
    expect(body.clients[0].name).toBe('Studio A');
    expect(body.clients[0].isOnline).toBe(true);
    expect(body.clients[1].clientId).toBe('uuid-002');
  });

  // 2. List returns empty array when no online clients
  it('GET /client/list returns { clients: [] } when no clients are online', async () => {
    (db.getOnlineClients as jest.Mock).mockResolvedValueOnce([]);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/client/list',
      headers: { authorization: `Bearer ${validToken}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ clients: [] });
  });

  // 3. GET /client/:clientId returns specific client
  it('GET /client/:clientId returns full profile for known client', async () => {
    const doc = makeClientDoc({
      _id: 'uuid-target-001',
      name: 'Target Client',
      isOnline: false
    });
    (db.getClient as jest.Mock).mockResolvedValueOnce(doc);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/client/uuid-target-001',
      headers: { authorization: `Bearer ${validToken}` }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.clientId).toBe('uuid-target-001');
    expect(body.name).toBe('Target Client');
    expect(body.isOnline).toBe(false);
    expect(typeof body.createdAt).toBe('string');
    expect(typeof body.lastSeenAt).toBe('string');
  });

  // 4. GET /client/:clientId not found — 404
  it('GET /client/:clientId returns 404 when client does not exist', async () => {
    (db.getClient as jest.Mock).mockResolvedValueOnce(null);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/client/nonexistent-uuid',
      headers: { authorization: `Bearer ${validToken}` }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Client not found' });
  });

  // 5. List without auth — returns 401
  it('GET /client/list returns 401 when Authorization header is missing', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/client/list'
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized' });
  });
});
