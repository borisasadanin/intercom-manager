import jwt from 'jsonwebtoken';
import {
  initJwt,
  generateToken,
  verifyToken,
  JwtPayload,
  JwtTokenInput
} from './jwt';

const TEST_SECRET = 'test-secret-for-jwt-tests';

const SAMPLE_PAYLOAD: JwtTokenInput = {
  clientId: 'abc-123',
  name: 'Test',
  role: 'producer',
  location: 'Stockholm'
};

/**
 * Reset the module-level secret between test suites by re-initialising.
 * For the "before initJwt" test we use a fresh module import via jest.isolateModules.
 */

describe('jwt module', () => {
  beforeEach(() => {
    // Ensure secret is initialised for most tests
    initJwt(TEST_SECRET);
  });

  // -----------------------------------------------------------------------
  // generateToken
  // -----------------------------------------------------------------------

  describe('generateToken', () => {
    it('returns a non-empty string', () => {
      const token = generateToken(SAMPLE_PAYLOAD);
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    });

    it('generates a decodable JWT with three dot-separated parts', () => {
      const token = generateToken(SAMPLE_PAYLOAD);
      const parts = token.split('.');
      expect(parts).toHaveLength(3);
    });

    it('generated token contains all payload fields (clientId, name, role, location, iat, exp)', () => {
      const token = generateToken(SAMPLE_PAYLOAD);
      const decoded = jwt.decode(token) as Record<string, unknown>;

      expect(decoded).not.toBeNull();
      expect(decoded.clientId).toBe(SAMPLE_PAYLOAD.clientId);
      expect(decoded.name).toBe(SAMPLE_PAYLOAD.name);
      expect(decoded.role).toBe(SAMPLE_PAYLOAD.role);
      expect(decoded.location).toBe(SAMPLE_PAYLOAD.location);
      expect(typeof decoded.iat).toBe('number');
      expect(typeof decoded.exp).toBe('number');
    });

    it('generated token expires in exactly 24h (exp - iat === 86400)', () => {
      const token = generateToken(SAMPLE_PAYLOAD);
      const decoded = jwt.decode(token) as Record<string, unknown>;

      expect(typeof decoded.exp).toBe('number');
      expect(typeof decoded.iat).toBe('number');
      expect((decoded.exp as number) - (decoded.iat as number)).toBe(86400);
    });
  });

  // -----------------------------------------------------------------------
  // verifyToken — success cases
  // -----------------------------------------------------------------------

  describe('verifyToken — success', () => {
    it('returns JwtPayload with matching fields for a valid token', () => {
      const token = generateToken(SAMPLE_PAYLOAD);
      const result = verifyToken(token);

      expect(result).not.toBeNull();
      const payload = result as JwtPayload;
      expect(payload.clientId).toBe(SAMPLE_PAYLOAD.clientId);
      expect(payload.name).toBe(SAMPLE_PAYLOAD.name);
      expect(payload.role).toBe(SAMPLE_PAYLOAD.role);
      expect(payload.location).toBe(SAMPLE_PAYLOAD.location);
      expect(typeof payload.iat).toBe('number');
      expect(typeof payload.exp).toBe('number');
    });
  });

  // -----------------------------------------------------------------------
  // verifyToken — failure cases
  // -----------------------------------------------------------------------

  describe('verifyToken — failure cases', () => {
    it('returns null for an expired token (fake timers advanced 25h)', () => {
      // Generate a token with the current secret
      const token = generateToken(SAMPLE_PAYLOAD);

      // Advance time by 25 hours (past the 24h expiry)
      jest.useFakeTimers();
      jest.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);

      const result = verifyToken(token);

      jest.useRealTimers();

      expect(result).toBeNull();
    });

    it('returns null when token was signed with a different secret', () => {
      // Generate with TEST_SECRET, then switch to a different secret and verify
      const token = generateToken(SAMPLE_PAYLOAD);

      initJwt('completely-different-secret');
      const result = verifyToken(token);

      // Restore for subsequent tests
      initJwt(TEST_SECRET);

      expect(result).toBeNull();
    });

    it('returns null for a malformed string', () => {
      expect(verifyToken('not-a-jwt')).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(verifyToken('')).toBeNull();
    });

    it('returns null (no throw) when verifyToken is called before initJwt', () => {
      // Use jest.isolateModules to get a fresh module instance without initJwt called
      let freshVerifyToken: (token: string) => JwtPayload | null;

      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const freshModule = require('./jwt');
        freshVerifyToken = freshModule.verifyToken;
      });

      expect(() => freshVerifyToken!('any-token')).not.toThrow();
      expect(freshVerifyToken!('any-token')).toBeNull();
    });
  });
});
