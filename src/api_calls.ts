import { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { requireAuth } from './auth/middleware';
import { CallManager } from './call_manager';
import { DbManager } from './db/interface';
import { ConnectionManager } from './connection_manager';
import { Log } from './log';
import {
  CallInitiateRequest,
  CallInitiateResponse,
  CallSdpAnswerRequest,
  CallJoinResponse,
  CallStatusResponse,
  CallActiveResponse
} from './models';

/** Rate limit key generator: use clientId from JWT when available, otherwise IP. */
function clientKeyGenerator(request: FastifyRequest): string {
  return request.client?.clientId ?? request.ip;
}

export interface ApiCallsOptions {
  dbManager: DbManager;
  connectionManager: ConnectionManager;
  callManager: CallManager;
}

export function getApiCalls(): FastifyPluginCallback<ApiCallsOptions> {
  return (fastify, opts, done) => {
    const { dbManager, connectionManager, callManager } = opts;

    // ── POST /call -- Initiate a call ──────────────────────────────────

    fastify.post<{
      Body: { calleeId: string };
      Reply:
        | { callId: string; sdpOffer: string; callerId: string; calleeId: string }
        | { error: string; message?: string; callId?: string };
    }>(
      '/call',
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
          description: 'Initiate a new call from the authenticated client to the specified callee.',
          body: CallInitiateRequest,
          response: {
            200: CallInitiateResponse
          }
        }
      },
      async (request, reply) => {
        try {
          const callerId = request.client!.clientId;
          const { calleeId } = request.body;

          // Validate: calleeId must be a non-empty string, max 100 characters
          if (!calleeId || typeof calleeId !== 'string' || calleeId.length > 100) {
            reply.code(400).send({ error: 'Validation failed', message: 'calleeId must be a valid identifier' });
            return;
          }

          // Validate: cannot call yourself
          if (calleeId === callerId) {
            reply.code(400).send({ error: 'Cannot call yourself' });
            return;
          }

          // Validate: callee must exist
          const callee = await dbManager.getClient(calleeId);
          if (!callee) {
            reply.code(404).send({ error: 'Callee not found' });
            return;
          }

          // Validate: callee must be online
          if (!callee.isOnline) {
            reply.code(422).send({ error: 'Callee is offline' });
            return;
          }

          // Validate: no duplicate active call in same direction
          const existingCalls =
            await dbManager.getActiveCallsForClient(callerId);
          const duplicateCall = existingCalls.find(
            (c) => c.callerId === callerId && c.calleeId === calleeId
          );
          if (duplicateCall) {
            reply.code(409).send({
              error: 'Active call already exists',
              callId: duplicateCall._id
            });
            return;
          }

          // Get caller info for WS event
          const callerDoc = await dbManager.getClient(callerId);
          const callerName = callerDoc?.name ?? request.client!.name;

          // Initiate the call
          const { callId, sdpOffer } = await callManager.initiateCall(
            callerId,
            callerName,
            calleeId,
            callee.name
          );

          // Send call_incoming to callee via WebSocket (targeted, NOT broadcast)
          connectionManager.sendTo(calleeId, {
            type: 'call_incoming',
            callId,
            caller: {
              clientId: callerId,
              name: callerName,
              role: callerDoc?.role ?? request.client!.role,
              location: callerDoc?.location ?? request.client!.location
            }
          });

          reply.code(200).send({
            callId,
            sdpOffer,
            callerId,
            calleeId
          });
        } catch (err) {
          Log().error('POST /call error:', err);
          reply.code(500).send({
            error: 'Internal server error',
            message: 'Failed to initiate call'
          });
        }
      }
    );

    // ── PATCH /call/:callId -- Caller SDP answer ───────────────────────

    fastify.patch<{
      Params: { callId: string };
      Body: { sdpAnswer: string };
      Reply:
        | { callId: string; status: string }
        | { error: string; message?: string };
    }>(
      '/call/:callId',
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
          description: 'Caller sends SDP answer to complete the WebRTC handshake.',
          body: CallSdpAnswerRequest,
          response: {
            200: CallStatusResponse
          }
        }
      },
      async (request, reply) => {
        try {
          const clientId = request.client!.clientId;
          const { callId } = request.params;
          const { sdpAnswer } = request.body;

          // Fetch call
          const call = await dbManager.getCall(callId);
          if (!call || call.state === 'ended') {
            reply.code(404).send({ error: 'Call not found' });
            return;
          }

          // Verify caller
          if (clientId !== call.callerId) {
            reply.code(403).send({ error: 'Not the caller of this call' });
            return;
          }

          // Verify not already connected
          if (call.callerConnected) {
            reply.code(409).send({ error: 'Caller already connected' });
            return;
          }

          // Process answer
          const updatedCall = await callManager.processAnswer(
            callId,
            clientId,
            sdpAnswer,
            'caller'
          );

          // If both connected, broadcast call_started
          if (updatedCall.callerConnected && updatedCall.calleeConnected) {
            connectionManager.broadcast({
              type: 'call_started',
              callId,
              callerId: updatedCall.callerId,
              calleeId: updatedCall.calleeId,
              callerName: updatedCall.callerName,
              calleeName: updatedCall.calleeName
            });
          }

          reply
            .code(200)
            .send({ callId, status: 'caller_connected' });
        } catch (err) {
          Log().error('PATCH /call/:callId error:', err);
          reply.code(500).send({
            error: 'Internal server error',
            message: 'Failed to process SDP answer'
          });
        }
      }
    );

    // ── POST /call/:callId/join -- Callee joins ────────────────────────

    fastify.post<{
      Params: { callId: string };
      Reply:
        | { callId: string; sdpOffer: string; callerId: string; calleeId: string }
        | { error: string; message?: string };
    }>(
      '/call/:callId/join',
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
          description: 'Callee joins the call, server creates second endpoint.',
          response: {
            200: CallJoinResponse
          }
        }
      },
      async (request, reply) => {
        try {
          const clientId = request.client!.clientId;
          const { callId } = request.params;

          // Fetch call
          const call = await dbManager.getCall(callId);
          if (!call || call.state === 'ended') {
            reply.code(404).send({ error: 'Call not found' });
            return;
          }

          // Verify callee
          if (clientId !== call.calleeId) {
            reply.code(403).send({ error: 'Not the callee of this call' });
            return;
          }

          // Verify callee hasn't already joined
          if (call.calleeEndpointId) {
            reply.code(409).send({ error: 'Callee already joined' });
            return;
          }

          // Join the call
          const { sdpOffer, callDocument } = await callManager.joinCall(
            callId,
            clientId
          );

          reply.code(200).send({
            callId,
            sdpOffer,
            callerId: callDocument.callerId,
            calleeId: callDocument.calleeId
          });
        } catch (err) {
          Log().error('POST /call/:callId/join error:', err);
          reply.code(500).send({
            error: 'Internal server error',
            message: 'Failed to join call'
          });
        }
      }
    );

    // ── PATCH /call/:callId/answer -- Callee SDP answer ────────────────

    fastify.patch<{
      Params: { callId: string };
      Body: { sdpAnswer: string };
      Reply:
        | { callId: string; status: string }
        | { error: string; message?: string };
    }>(
      '/call/:callId/answer',
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
          description: 'Callee sends SDP answer to complete the WebRTC handshake.',
          body: CallSdpAnswerRequest,
          response: {
            200: CallStatusResponse
          }
        }
      },
      async (request, reply) => {
        try {
          const clientId = request.client!.clientId;
          const { callId } = request.params;
          const { sdpAnswer } = request.body;

          // Fetch call
          const call = await dbManager.getCall(callId);
          if (!call || call.state === 'ended') {
            reply.code(404).send({ error: 'Call not found' });
            return;
          }

          // Verify callee
          if (clientId !== call.calleeId) {
            reply.code(403).send({ error: 'Not the callee of this call' });
            return;
          }

          // Verify not already connected
          if (call.calleeConnected) {
            reply.code(409).send({ error: 'Callee already connected' });
            return;
          }

          // Process answer
          const updatedCall = await callManager.processAnswer(
            callId,
            clientId,
            sdpAnswer,
            'callee'
          );

          // If both connected, broadcast call_started
          if (updatedCall.callerConnected && updatedCall.calleeConnected) {
            connectionManager.broadcast({
              type: 'call_started',
              callId,
              callerId: updatedCall.callerId,
              calleeId: updatedCall.calleeId,
              callerName: updatedCall.callerName,
              calleeName: updatedCall.calleeName
            });
          }

          reply
            .code(200)
            .send({ callId, status: 'callee_connected' });
        } catch (err) {
          Log().error('PATCH /call/:callId/answer error:', err);
          reply.code(500).send({
            error: 'Internal server error',
            message: 'Failed to process SDP answer'
          });
        }
      }
    );

    // ── DELETE /call/:callId -- End call ────────────────────────────────

    fastify.delete<{
      Params: { callId: string };
      Reply:
        | { callId: string; status: string }
        | { error: string; message?: string };
    }>(
      '/call/:callId',
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
          description: 'End a call. Either caller or callee can end it.',
          response: {
            200: CallStatusResponse
          }
        }
      },
      async (request, reply) => {
        try {
          const clientId = request.client!.clientId;
          const { callId } = request.params;

          // Fetch call
          const call = await dbManager.getCall(callId);
          if (!call) {
            reply.code(404).send({ error: 'Call not found' });
            return;
          }

          // Check if already ended
          if (call.state === 'ended') {
            reply.code(409).send({ error: 'Call already ended' });
            return;
          }

          // Verify participant
          if (clientId !== call.callerId && clientId !== call.calleeId) {
            reply
              .code(403)
              .send({ error: 'Not a participant of this call' });
            return;
          }

          // End the call
          const updatedCall = await callManager.endCall(callId, clientId);

          // Broadcast call_ended
          connectionManager.broadcast({
            type: 'call_ended',
            callId,
            callerId: updatedCall.callerId,
            calleeId: updatedCall.calleeId,
            endedBy: clientId
          });

          reply.code(200).send({ callId, status: 'ended' });
        } catch (err) {
          Log().error('DELETE /call/:callId error:', err);
          reply.code(500).send({
            error: 'Internal server error',
            message: 'Failed to end call'
          });
        }
      }
    );

    // ── GET /call/active -- List active calls ──────────────────────────

    fastify.get<{
      Reply: { calls: Array<{
        callId: string;
        callerId: string;
        calleeId: string;
        callerName: string;
        calleeName: string;
        state: 'pending' | 'active';
        direction: 'outgoing' | 'incoming';
        createdAt: string;
      }> };
    }>(
      '/call/active',
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
          description: 'List all active calls for the authenticated client.',
          response: {
            200: CallActiveResponse
          }
        }
      },
      async (request, reply) => {
        try {
          const clientId = request.client!.clientId;

          const activeCalls =
            await dbManager.getActiveCallsForClient(clientId);

          const calls = activeCalls.map((call) => ({
            callId: call._id,
            callerId: call.callerId,
            calleeId: call.calleeId,
            callerName: call.callerName,
            calleeName: call.calleeName,
            state: call.state as 'pending' | 'active',
            direction: (call.callerId === clientId
              ? 'outgoing'
              : 'incoming') as 'outgoing' | 'incoming',
            createdAt: call.createdAt
          }));

          reply.code(200).send({ calls });
        } catch (err) {
          Log().error('GET /call/active error:', err);
          reply.code(500).send({ calls: [] });
        }
      }
    );

    done();
  };
}
