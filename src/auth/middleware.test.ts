import jwt from 'jsonwebtoken';
import Fastify, { FastifyInstance } from 'fastify';
import { initJwt, generateToken } from './jwt';
import { requireAuth } from './middleware';

const TEST_SECRET = 'middleware-test-secret';

const SAMPLE_PAYLOAD = {
  clientId: 'client-uuid-001',
  name: 'Studio A',
  role: 'producer',
  location: 'Stockholm'
};

/**
 * Build a minimal Fastify server with a single protected route at GET /protected.
 * The route returns the request.client payload so tests can assert on it.
 */
async function buildTestServer(): Promise<FastifyInstance> {
  const app = Fastify();

  app.get(
    '/protected',
    { preHandler: requireAuth },
    async (request, reply) => {
      return reply.send(request.client);
    }
  );

  await app.ready();
  return app;
}

describe('requireAuth middleware', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    initJwt(TEST_SECRET);
    app = await buildTestServer();
  });

  afterAll(async () => {
    await app.close();
  });

  // -----------------------------------------------------------------------
  // Success
  // -----------------------------------------------------------------------

  it('passes through with a valid Bearer token and attaches request.client', async () => {
    const token = generateToken(SAMPLE_PAYLOAD);

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.clientId).toBe(SAMPLE_PAYLOAD.clientId);
    expect(body.name).toBe(SAMPLE_PAYLOAD.name);
    expect(body.role).toBe(SAMPLE_PAYLOAD.role);
    expect(body.location).toBe(SAMPLE_PAYLOAD.location);
    expect(typeof body.iat).toBe('number');
    expect(typeof body.exp).toBe('number');
  });

  // -----------------------------------------------------------------------
  // 401 cases
  // -----------------------------------------------------------------------

  it('returns 401 when the Authorization header is missing', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/protected'
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 when the Authorization header is empty', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {
        authorization: ''
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 when the Bearer prefix is missing (bare token)', async () => {
    const token = generateToken(SAMPLE_PAYLOAD);

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {
        authorization: token
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 when a wrong auth scheme is used (Basic)', async () => {
    const token = generateToken(SAMPLE_PAYLOAD);

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {
        authorization: `Basic ${token}`
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 for an expired token', async () => {
    // Build an already-expired token by back-dating iat/exp directly.
    // Using a negative expiresIn value causes jsonwebtoken to set exp in the past.
    const expiredToken = jwt.sign(
      { ...SAMPLE_PAYLOAD, iat: Math.floor(Date.now() / 1000) - 90000 },
      TEST_SECRET,
      { algorithm: 'HS256', expiresIn: -1 }
    );

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {
        authorization: `Bearer ${expiredToken}`
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 for an invalid/garbage token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {
        authorization: 'Bearer this-is-garbage'
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 when Bearer scheme is lowercase ("bearer")', async () => {
    const token = generateToken(SAMPLE_PAYLOAD);

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: {
        authorization: `bearer ${token}`
      }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'Unauthorized' });
  });
});
