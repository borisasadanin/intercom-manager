import { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { requireAuth } from './auth/middleware';
import { CallManager } from './call_manager';
import { TalkManager } from './talk_manager';
import { DbManager } from './db/interface';
import { ConnectionManager } from './connection_manager';
import { Log } from './log';

/** Rate limit key generator: use clientId from JWT when available, otherwise IP. */
function clientKeyGenerator(request: FastifyRequest): string {
  return request.client?.clientId ?? request.ip;
}

export interface ApiStatusOptions {
  dbManager: DbManager;
  connectionManager: ConnectionManager;
  talkManager: TalkManager;
  callManager?: CallManager;
}

export function getApiStatus(): FastifyPluginCallback<ApiStatusOptions> {
  return (fastify, opts, done) => {
    const { dbManager, connectionManager, talkManager, callManager } = opts;

    // GET /status/talks — current talk state (authenticated)
    fastify.get(
      '/status/talks',
      {
        preHandler: requireAuth,
        config: {
          rateLimit: {
            max: 30,
            timeWindow: '1 minute',
            keyGenerator: clientKeyGenerator
          }
        }
      },
      async (request, reply) => {
        try {
          const activeTalkers = talkManager.getActiveTalkers();
          const talks = [];

          for (const [clientId, callIds] of activeTalkers) {
            try {
              const client = await dbManager.getClient(clientId);
              talks.push({
                clientId,
                clientName: client?.name ?? 'Unknown',
                callIds
              });
            } catch {
              talks.push({
                clientId,
                clientName: 'Unknown',
                callIds
              });
            }
          }

          return reply.code(200).send({ talks });
        } catch (error) {
          Log().error('Error fetching talk status:', error);
          return reply.code(500).send({ error: 'Internal server error' });
        }
      }
    );

    // GET /health — system health (public, no auth)
    fastify.get('/health', {
      config: {
        rateLimit: {
          max: 120,
          timeWindow: '1 minute'
        }
      }
    }, async (request, reply) => {
      try {
        const clients = connectionManager.getConnectedClientIds().length;
        const activeCalls = await dbManager.getActiveCallCount();
        const activeTalkers = talkManager.getActiveTalkerCount();

        const response: Record<string, unknown> = {
          status: 'ok',
          uptime: Math.floor(process.uptime()),
          clients,
          activeCalls,
          activeTalkers
        };

        // Include per-SMB instance status if callManager is available
        if (callManager) {
          response.smb = await callManager.getSmbStatus();
        }

        return reply.code(200).send(response);
      } catch (error) {
        Log().error('Error fetching health:', error);
        return reply.code(500).send({
          status: 'error',
          message: 'Health check failed'
        });
      }
    });

    done();
  };
}
