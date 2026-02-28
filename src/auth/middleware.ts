import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken, JwtPayload } from './jwt';

declare module 'fastify' {
  interface FastifyRequest {
    client?: JwtPayload;
  }
}

/**
 * Fastify preHandler hook that extracts and verifies a Bearer JWT token
 * from the Authorization header. On success, attaches the decoded payload
 * to request.client. On failure, returns 401 { error: "Unauthorized" }.
 */
export const requireAuth = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }

  const token = authHeader.slice(7);
  const payload = verifyToken(token);

  if (!payload) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }

  request.client = payload;
};
