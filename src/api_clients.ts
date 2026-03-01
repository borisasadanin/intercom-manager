import { FastifyPluginCallback, FastifyRequest } from 'fastify';
import '@fastify/websocket';
import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from './auth/middleware';
import { generateToken, verifyToken } from './auth/jwt';
import { Log } from './log';
import { DbManager } from './db/interface';
import { ConnectionManager } from './connection_manager';
import { CallManager } from './call_manager';
import { TalkManager } from './talk_manager';
import {
  ClientDocument,
  ClientRegistrationRequest,
  ClientRegistrationResponse,
  ClientUpdateRequest,
  ClientProfileResponse,
  ClientListResponse,
  WsClientInfo
} from './models';

export interface ApiClientsOptions {
  dbManager: DbManager;
  connectionManager: ConnectionManager;
  callManager?: CallManager;
  talkManager?: TalkManager;
}

/** Rate limit key generator: use clientId from JWT when available, otherwise IP. */
function clientKeyGenerator(request: FastifyRequest): string {
  return request.client?.clientId ?? request.ip;
}

/**
 * Fastify plugin for client registry REST endpoints and WebSocket presence.
 *
 * REST routes:
 *   POST   /client/register   (public)
 *   GET    /client/me          (auth)
 *   PATCH  /client/me          (auth)
 *   GET    /client/list        (auth)
 *   GET    /client/:clientId   (auth)
 *
 * WebSocket:
 *   GET    /ws?token=JWT       (auth via query param)
 *
 * Heartbeat (WS fallback):
 *   POST   /client/heartbeat   (auth) — marks client online, returns client list
 */
export function getApiClients(): FastifyPluginCallback<ApiClientsOptions> {
  return (fastify, opts, done) => {
    const { dbManager, connectionManager } = opts;

    // ── Helpers ────────────────────────────────────────────────────────

    function toClientProfile(doc: ClientDocument): {
      clientId: string;
      name: string;
      role: string;
      location: string;
      isOnline: boolean;
      createdAt: string;
      lastSeenAt: string;
    } {
      return {
        clientId: doc._id,
        name: doc.name,
        role: doc.role,
        location: doc.location,
        isOnline: doc.isOnline,
        createdAt: doc.createdAt,
        lastSeenAt: doc.lastSeenAt
      };
    }

    function toClientInfo(doc: ClientDocument): WsClientInfo {
      return {
        clientId: doc._id,
        name: doc.name,
        role: doc.role,
        location: doc.location
      };
    }

    // ── POST /client/register (PUBLIC) ────────────────────────────────

    fastify.post<{
      Body: ClientRegistrationRequest;
      Reply: { clientId: string; token: string; name: string; role: string; location: string } | { error: string; message: string };
    }>(
      '/client/register',
      {
        config: {
          rateLimit: {
            max: 10,
            timeWindow: '1 minute'
          }
        },
        schema: {
          description: 'Register a new client or re-register an existing one.',
          body: ClientRegistrationRequest,
          response: {
            200: ClientRegistrationResponse
          }
        }
      },
      async (request, reply) => {
        try {
          let { name, role, location } = request.body;
          const { existingClientId } = request.body;

          // Input validation (beyond TypeBox schema checks)
          if (!name || typeof name !== 'string' || name.length > 100) {
            return reply.code(400).send({
              error: 'Validation failed',
              message: 'name is required and must be max 100 characters'
            });
          }
          if (!role || typeof role !== 'string' || role.length > 50) {
            return reply.code(400).send({
              error: 'Validation failed',
              message: 'role is required and must be max 50 characters'
            });
          }
          if (!location || typeof location !== 'string' || location.length > 100) {
            return reply.code(400).send({
              error: 'Validation failed',
              message: 'location is required and must be max 100 characters'
            });
          }

          // Sanitize: trim whitespace
          name = name.trim();
          role = role.trim();
          location = location.trim();
          let clientId: string | undefined;
          const now = new Date().toISOString();

          // Attempt re-registration if existingClientId provided
          if (existingClientId) {
            const existing = await dbManager.getClient(existingClientId);
            if (existing) {
              clientId = existing._id;
              await dbManager.updateClient(clientId, {
                name,
                role,
                location,
                lastSeenAt: now
              });
            }
            // If not found, fall through to new registration
          }

          // New registration
          if (!clientId) {
            clientId = uuidv4();
            const clientDoc: ClientDocument = {
              _id: clientId,
              docType: 'client',
              name,
              role,
              location,
              isOnline: false,
              createdAt: now,
              lastSeenAt: now
            };
            await dbManager.saveClient(clientDoc);
          }

          const token = generateToken({ clientId, name, role, location });
          reply.code(200).send({ clientId, token, name, role, location });
        } catch (err) {
          Log().error('POST /client/register error:', err);
          reply.code(500).send({
            error: 'Internal server error',
            message: 'Failed to register client'
          });
        }
      }
    );

    // ── GET /client/me (AUTH) ─────────────────────────────────────────

    fastify.get<{
      Reply:
        | { clientId: string; name: string; role: string; location: string; isOnline: boolean; createdAt: string; lastSeenAt: string }
        | { error: string };
    }>(
      '/client/me',
      {
        preHandler: requireAuth,
        config: {
          rateLimit: {
            max: 60,
            timeWindow: '1 minute',
            keyGenerator: clientKeyGenerator
          }
        },
        schema: {
          description: 'Get the authenticated client profile.',
          response: {
            200: ClientProfileResponse
          }
        }
      },
      async (request, reply) => {
        try {
          const { clientId } = request.client!;
          const doc = await dbManager.getClient(clientId);
          if (!doc) {
            reply.code(404).send({ error: 'Client not found' });
            return;
          }
          reply.code(200).send(toClientProfile(doc));
        } catch (err) {
          Log().error('GET /client/me error:', err);
          reply.code(500).send({ error: 'Internal server error' });
        }
      }
    );

    // ── PATCH /client/me (AUTH) ───────────────────────────────────────

    fastify.patch<{
      Body: ClientUpdateRequest;
      Reply:
        | { clientId: string; name: string; role: string; location: string; isOnline: boolean; createdAt: string; lastSeenAt: string }
        | { error: string; message?: string };
    }>(
      '/client/me',
      {
        preHandler: requireAuth,
        config: {
          rateLimit: {
            max: 20,
            timeWindow: '1 minute',
            keyGenerator: clientKeyGenerator
          }
        },
        schema: {
          description: 'Update the authenticated client metadata.',
          body: ClientUpdateRequest,
          response: {
            200: ClientProfileResponse
          }
        }
      },
      async (request, reply) => {
        try {
          let { name, role, location } = request.body;

          // At least one field must be provided
          if (!name && !role && !location) {
            reply.code(400).send({
              error: 'Validation failed',
              message: 'At least one field must be provided'
            });
            return;
          }

          // Validate optional field types and lengths
          if (name !== undefined) {
            if (typeof name !== 'string' || name.length > 100) {
              return reply.code(400).send({
                error: 'Validation failed',
                message: 'name must be max 100 characters'
              });
            }
            name = name.trim();
          }
          if (role !== undefined) {
            if (typeof role !== 'string' || role.length > 50) {
              return reply.code(400).send({
                error: 'Validation failed',
                message: 'role must be max 50 characters'
              });
            }
            role = role.trim();
          }
          if (location !== undefined) {
            if (typeof location !== 'string' || location.length > 100) {
              return reply.code(400).send({
                error: 'Validation failed',
                message: 'location must be max 100 characters'
              });
            }
            location = location.trim();
          }

          const { clientId } = request.client!;
          const doc = await dbManager.getClient(clientId);
          if (!doc) {
            reply.code(404).send({ error: 'Client not found' });
            return;
          }

          const updates: Partial<ClientDocument> = {
            lastSeenAt: new Date().toISOString()
          };
          if (name !== undefined) updates.name = name;
          if (role !== undefined) updates.role = role;
          if (location !== undefined) updates.location = location;

          await dbManager.updateClient(clientId, updates);

          // Re-fetch to return the full updated profile
          const updated = await dbManager.getClient(clientId);
          if (!updated) {
            reply.code(404).send({ error: 'Client not found' });
            return;
          }
          reply.code(200).send(toClientProfile(updated));
        } catch (err) {
          Log().error('PATCH /client/me error:', err);
          reply.code(500).send({ error: 'Internal server error' });
        }
      }
    );

    // ── POST /client/heartbeat (AUTH) ──────────────────────────────────
    // Fallback for clients that cannot establish a WebSocket connection
    // (e.g. HTTP/2 proxy issues). Marks the client online, updates
    // lastSeenAt, and returns the current online client list.

    fastify.post<{
      Reply:
        | { clients: Array<{ clientId: string; name: string; role: string; location: string; isOnline: boolean; lastSeenAt: string }> }
        | { error: string };
    }>(
      '/client/heartbeat',
      {
        preHandler: requireAuth,
        config: {
          rateLimit: {
            max: 30,
            timeWindow: '1 minute',
            keyGenerator: clientKeyGenerator
          }
        },
        schema: {
          description:
            'Heartbeat endpoint for clients without WebSocket. Marks client online and returns the online client list.'
        }
      },
      async (request, reply) => {
        try {
          const { clientId } = request.client!;

          const client = await dbManager.getClient(clientId);
          if (!client) {
            return reply.code(404).send({ error: 'Client not found' });
          }

          const wasOffline = !client.isOnline;

          // Mark online and update lastSeenAt
          await dbManager.updateClient(clientId, {
            isOnline: true,
            lastSeenAt: new Date().toISOString()
          });

          // If the client was offline, broadcast client_connected to WS clients
          if (wasOffline) {
            connectionManager.broadcast(
              {
                type: 'client_connected',
                client: toClientInfo(client)
              },
              clientId
            );
          }

          // Return online clients list (same shape as GET /client/list)
          const onlineClients = await dbManager.getOnlineClients();
          const clients = onlineClients.map((doc) => ({
            clientId: doc._id,
            name: doc.name,
            role: doc.role,
            location: doc.location,
            isOnline: doc.isOnline,
            lastSeenAt: doc.lastSeenAt
          }));

          return reply.send({ clients });
        } catch (err) {
          Log().error('POST /client/heartbeat error:', err);
          return reply.code(500).send({ error: 'Heartbeat failed' });
        }
      }
    );

    // ── GET /client/list (AUTH) ───────────────────────────────────────

    fastify.get<{
      Reply: { clients: Array<{ clientId: string; name: string; role: string; location: string; isOnline: boolean; lastSeenAt: string }> };
    }>(
      '/client/list',
      {
        preHandler: requireAuth,
        config: {
          rateLimit: {
            max: 30,
            timeWindow: '1 minute',
            keyGenerator: clientKeyGenerator
          }
        },
        schema: {
          description: 'List all currently online clients.',
          response: {
            200: ClientListResponse
          }
        }
      },
      async (request, reply) => {
        try {
          const onlineClients = await dbManager.getOnlineClients();
          const clients = onlineClients.map((doc) => ({
            clientId: doc._id,
            name: doc.name,
            role: doc.role,
            location: doc.location,
            isOnline: doc.isOnline,
            lastSeenAt: doc.lastSeenAt
          }));
          reply.code(200).send({ clients });
        } catch (err) {
          Log().error('GET /client/list error:', err);
          reply.code(500).send({ clients: [] });
        }
      }
    );

    // ── GET /client/:clientId (AUTH) ──────────────────────────────────

    fastify.get<{
      Params: { clientId: string };
      Reply:
        | { clientId: string; name: string; role: string; location: string; isOnline: boolean; createdAt: string; lastSeenAt: string }
        | { error: string };
    }>(
      '/client/:clientId',
      {
        preHandler: requireAuth,
        config: {
          rateLimit: {
            max: 60,
            timeWindow: '1 minute',
            keyGenerator: clientKeyGenerator
          }
        },
        schema: {
          description: 'Get a specific client profile by ID.',
          response: {
            200: ClientProfileResponse
          }
        }
      },
      async (request, reply) => {
        try {
          const doc = await dbManager.getClient(request.params.clientId);
          if (!doc) {
            reply.code(404).send({ error: 'Client not found' });
            return;
          }
          reply.code(200).send(toClientProfile(doc));
        } catch (err) {
          Log().error('GET /client/:clientId error:', err);
          reply.code(500).send({ error: 'Internal server error' });
        }
      }
    );

    // ── WS /ws (WebSocket presence) ──────────────────────────────────

    fastify.get<{
      Querystring: { token?: string };
    }>(
      '/ws',
      { websocket: true },
      (socket, request) => {
        // 1. Authenticate via query string token
        const token = request.query.token;
        if (!token) {
          socket.close(4001, 'Unauthorized');
          return;
        }

        const payload = verifyToken(token);
        if (!payload) {
          socket.close(4001, 'Unauthorized');
          return;
        }

        const { clientId } = payload;
        Log().info(`WS: client ${clientId} connected`);

        // 2. Add to connection manager (closes old socket if duplicate)
        connectionManager.add(clientId, socket);

        // 3. Mark online in DB + send initial state + broadcast
        (async () => {
          try {
            Log().info(`WS: marking ${clientId} online in DB`);
            await dbManager.updateClient(clientId, { isOnline: true });

            // Send client_list to the newly connected client (excluding self)
            const onlineClients = await dbManager.getOnlineClients();
            const clientList = onlineClients
              .filter((c) => c._id !== clientId)
              .map(toClientInfo);

            socket.send(
              JSON.stringify({
                type: 'client_list' as const,
                clients: clientList
              })
            );
            Log().info(
              `WS: sent client_list to ${clientId} (${clientList.length} clients)`
            );

            // M3: Send active_talks snapshot
            if (opts.talkManager) {
              const activeTalkers = opts.talkManager.getActiveTalkers();
              const talks: Record<string, string[]> = {};
              for (const [id, callIds] of activeTalkers) {
                talks[id] = callIds;
              }
              socket.send(JSON.stringify({ type: 'active_talks', talks }));
            }

            // Fetch this client's doc to broadcast info to others
            const selfDoc = await dbManager.getClient(clientId);
            if (selfDoc) {
              Log().info(
                `WS: broadcasting client_connected for ${clientId} (${selfDoc.name})`
              );
              connectionManager.broadcast(
                {
                  type: 'client_connected',
                  client: toClientInfo(selfDoc)
                },
                clientId
              );
            }
          } catch (err) {
            Log().error(`WS: error during connect for client ${clientId}:`, err);
          }
        })();

        // 4. Keep-alive: ping every 30s, terminate if no pong within 10s
        let isAlive = true;

        socket.on('pong', () => {
          isAlive = true;
        });

        const pingInterval = setInterval(() => {
          if (!isAlive) {
            Log().info(
              `WS: client ${clientId} did not respond to ping, terminating`
            );
            clearInterval(pingInterval);
            socket.terminate();
            return;
          }
          isAlive = false;
          socket.ping();
        }, 30_000);

        // 5. Handle incoming messages (M3: talk_start / talk_stop)
        socket.on('message', async (raw) => {
          if (!opts.talkManager) return;

          try {
            const msg = JSON.parse(raw.toString());

            if (
              msg.type === 'talk_start' &&
              Array.isArray(msg.callIds) &&
              msg.callIds.length > 0
            ) {
              // Validate callIds array: max 50 entries, each must be a string
              if (msg.callIds.length > 50) {
                Log().warn(`WS: client ${clientId} sent too many callIds (${msg.callIds.length})`);
                return;
              }
              if (!msg.callIds.every((id: unknown) => typeof id === 'string')) {
                Log().warn(`WS: client ${clientId} sent non-string callIds`);
                return;
              }

              // Validate callIds: filter to active calls where client is a participant
              const validCallIds: string[] = [];
              for (const callId of msg.callIds) {
                try {
                  const call = await dbManager.getCall(callId);
                  if (
                    call &&
                    call.state !== 'ended' &&
                    (call.callerId === clientId ||
                      call.calleeId === clientId)
                  ) {
                    validCallIds.push(callId);
                  }
                } catch {
                  // Skip invalid callIds
                }
              }

              if (validCallIds.length === 0) return;

              opts.talkManager.startTalking(clientId, validCallIds);

              // Get client name for broadcast enrichment
              let clientName = 'Unknown';
              try {
                const client = await dbManager.getClient(clientId);
                if (client) clientName = client.name;
              } catch {
                // Use default
              }

              // Broadcast enriched talk_start to all clients
              connectionManager.broadcast({
                type: 'talk_start',
                clientId,
                clientName,
                callIds: validCallIds
              });
            } else if (msg.type === 'talk_stop') {
              opts.talkManager.stopTalking(clientId);

              connectionManager.broadcast({
                type: 'talk_stop',
                clientId
              });
            }
          } catch (err) {
            Log().warn(`WS: invalid message from client ${clientId}`);
          }
        });

        // 6. Handle close
        socket.on('close', (code: number, reason: Buffer) => {
          clearInterval(pingInterval);
          const reasonStr = reason?.toString() || '';

          Log().info(
            `WS: socket closed for ${clientId}, code=${code}, reason=${reasonStr}`
          );

          // If this socket was replaced by a newer connection (code 4002),
          // the connectionManager already has the new socket. Skip cleanup.
          const currentSocket = connectionManager.getSocket(clientId);
          if (currentSocket && currentSocket !== socket) {
            Log().info(
              `WS: old socket for ${clientId} closed (replaced by new connection), skipping cleanup`
            );
            return;
          }

          Log().info(`WS: client ${clientId} disconnected, starting cleanup`);
          connectionManager.remove(clientId);

          // M3: Clean up talk state (before client_disconnected broadcast)
          if (opts.talkManager && opts.talkManager.isTalking(clientId)) {
            opts.talkManager.removeClient(clientId);
            connectionManager.broadcast({
              type: 'talk_stop',
              clientId
            });
          }

          (async () => {
            try {
              Log().info(`WS: marking ${clientId} offline in DB`);
              await dbManager.updateClient(clientId, { isOnline: false });
              connectionManager.broadcast({
                type: 'client_disconnected',
                clientId
              });

              // M2: End all active calls for this client on disconnect
              if (opts.callManager) {
                const endedCallIds =
                  await opts.callManager.endAllCallsForClient(clientId);
                for (const endedCallId of endedCallIds) {
                  const endedCall = await dbManager.getCall(endedCallId);
                  if (endedCall) {
                    connectionManager.broadcast({
                      type: 'call_ended',
                      callId: endedCallId,
                      callerId: endedCall.callerId,
                      calleeId: endedCall.calleeId,
                      endedBy: clientId
                    });
                  }
                }
              }
            } catch (err) {
              Log().error(
                `WS: error during disconnect for client ${clientId}:`,
                err
              );
            }
          })();
        });

        // 7. Handle errors
        socket.on('error', (err) => {
          Log().error(`WS: socket error for client ${clientId}:`, err);
        });
      }
    );

    done();
  };
}
