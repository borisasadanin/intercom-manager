import jwt from 'jsonwebtoken';

/**
 * The payload stored inside every JWT token.
 * `iat` and `exp` are added by jsonwebtoken automatically.
 */
export interface JwtPayload {
  clientId: string;
  name: string;
  role: string;
  location: string;
  iat: number;
  exp: number;
}

/**
 * The input to generateToken(). Does NOT include iat/exp — those are auto-generated.
 */
export interface JwtTokenInput {
  clientId: string;
  name: string;
  role: string;
  location: string;
}

let secret: string | undefined;

/**
 * Stores the HS256 signing secret for module-scoped use.
 * Must be called once at startup before any generateToken or verifyToken calls.
 */
export function initJwt(s: string): void {
  secret = s;
}

/**
 * Creates an HS256-signed JWT with 24-hour expiry.
 * Throws if initJwt() was not called first.
 */
export function generateToken(payload: JwtTokenInput): string {
  if (!secret) {
    throw new Error('JWT secret not initialized. Call initJwt() first.');
  }
  return jwt.sign(
    {
      clientId: payload.clientId,
      name: payload.name,
      role: payload.role,
      location: payload.location
    },
    secret,
    { algorithm: 'HS256', expiresIn: '24h' }
  );
}

/**
 * Verifies and decodes a JWT token.
 * Returns the decoded payload on success, null on any failure.
 * NEVER throws.
 */
export function verifyToken(token: string): JwtPayload | null {
  try {
    if (!secret) {
      return null;
    }
    const decoded = jwt.verify(token, secret, {
      algorithms: ['HS256']
    });
    if (typeof decoded === 'string') {
      return null;
    }
    const payload = decoded as Record<string, unknown>;
    if (
      typeof payload.clientId !== 'string' ||
      typeof payload.name !== 'string' ||
      typeof payload.role !== 'string' ||
      typeof payload.location !== 'string' ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number'
    ) {
      return null;
    }
    return {
      clientId: payload.clientId,
      name: payload.name,
      role: payload.role,
      location: payload.location,
      iat: payload.iat,
      exp: payload.exp
    };
  } catch {
    return null;
  }
}
