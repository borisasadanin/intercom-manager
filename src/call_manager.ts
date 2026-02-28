import { v4 as uuidv4 } from 'uuid';
import { parse, write } from 'sdp-transform';
import { Connection } from './connection';
import { DbManager } from './db/interface';
import { ConnectionManager } from './connection_manager';
import { ISmbProtocol } from './smb';
import { CallDocument, SmbEndpointDescription } from './models';
import { Log } from './log';
import { MediaStreamsInfoSsrc } from './media_streams_info';

export interface SmbInstance {
  url: string;
  apiKey: string;
  maxConferences: number;
}

export interface CallManagerOptions {
  dbManager: DbManager;
  connectionManager: ConnectionManager;
  smb: ISmbProtocol;
  smbInstances: SmbInstance[];
  endpointIdleTimeout: number;
}

export class CallManager {
  private dbManager: DbManager;
  private connectionManager: ConnectionManager;
  private smb: ISmbProtocol;
  private smbInstances: SmbInstance[];
  private endpointIdleTimeout: number;

  constructor(opts: CallManagerOptions) {
    this.dbManager = opts.dbManager;
    this.connectionManager = opts.connectionManager;
    this.smb = opts.smb;
    this.smbInstances = opts.smbInstances;
    this.endpointIdleTimeout = opts.endpointIdleTimeout;
  }

  /**
   * Get the configured SMB instances (for health endpoint).
   */
  getSmbInstances(): SmbInstance[] {
    return this.smbInstances;
  }

  /**
   * Query each SMB instance for current conference count and status.
   */
  async getSmbStatus(): Promise<
    Array<{
      label: string;
      conferences: number;
      maxConferences: number;
      status: string;
    }>
  > {
    const results = [];
    for (let i = 0; i < this.smbInstances.length; i++) {
      const instance = this.smbInstances[i];
      const label = `smb-${i}`;
      try {
        const conferences = await this.smb.getConferences(
          instance.url,
          instance.apiKey
        );
        results.push({
          label,
          conferences: conferences.length,
          maxConferences: instance.maxConferences,
          status: 'ok'
        });
      } catch {
        results.push({
          label,
          conferences: -1,
          maxConferences: instance.maxConferences,
          status: 'unreachable'
        });
      }
    }
    return results;
  }

  /**
   * Select the least-loaded SMB instance that is under its max conference limit.
   * For single-instance deployments, skips the getConferences query.
   */
  private async selectSmbInstance(): Promise<SmbInstance> {
    // Single-instance optimization: skip query overhead
    if (this.smbInstances.length === 1) {
      return this.smbInstances[0];
    }

    let bestInstance: SmbInstance | null = null;
    let bestCount = Infinity;

    for (const instance of this.smbInstances) {
      try {
        const conferences = await this.smb.getConferences(
          instance.url,
          instance.apiKey
        );
        const count = conferences.length;
        if (count < instance.maxConferences && count < bestCount) {
          bestCount = count;
          bestInstance = instance;
        }
      } catch (err) {
        Log().warn(`SMB instance ${instance.url} unreachable, skipping`);
      }
    }

    if (!bestInstance) {
      throw new Error('No available SMB instance (all full or unreachable)');
    }

    return bestInstance;
  }

  /**
   * Look up the API key for an SMB URL from the configured instances.
   * Used when joining/configuring endpoints on an already-allocated conference.
   */
  private getApiKeyForUrl(smbUrl: string): string {
    const instance = this.smbInstances.find((i) => i.url === smbUrl);
    if (instance) {
      return instance.apiKey;
    }
    // Fallback: try first instance (backward compat for single-SMB)
    Log().warn(
      `SMB URL ${smbUrl} not found in configured instances, using first instance API key`
    );
    return this.smbInstances[0]?.apiKey ?? '';
  }

  /**
   * Initiate a call. Allocates SMB conference + caller endpoint, returns SDP offer.
   *
   * @returns { callId, sdpOffer, callDocument }
   * @throws if SMB allocation fails
   */
  async initiateCall(
    callerId: string,
    callerName: string,
    calleeId: string,
    calleeName: string
  ): Promise<{ callId: string; sdpOffer: string; callDocument: CallDocument }> {
    const callId = uuidv4();

    // 1. Select least-loaded SMB instance
    const smbInstance = await this.selectSmbInstance();

    // 2. Allocate SMB conference
    const smbConferenceId = await this.smb.allocateConference(
      smbInstance.url,
      smbInstance.apiKey
    );

    // 3. Create caller endpoint
    const callerEndpointId = uuidv4();
    const callerEndpoint = await this.smb.allocateEndpoint(
      smbInstance.url,
      smbConferenceId,
      callerEndpointId,
      true, // audio
      true, // data
      true, // iceControlling (caller controls)
      'forwarder',
      this.endpointIdleTimeout,
      smbInstance.apiKey
    );

    // 4. Generate SDP offer (same pattern as CoreFunctions.createConnection)
    const sdpOffer = this.generateSdpOffer(callerEndpoint, callerEndpointId);

    // 5. Save call document
    const callDocument: CallDocument = {
      _id: callId,
      docType: 'call',
      callerId,
      calleeId,
      callerName,
      calleeName,
      smbConferenceId,
      smbUrl: smbInstance.url,
      state: 'pending',
      callerEndpointId,
      calleeEndpointId: null,
      callerEndpointDescription: callerEndpoint,
      calleeEndpointDescription: null,
      callerConnected: false,
      calleeConnected: false,
      createdAt: new Date().toISOString(),
      endedAt: null,
      endedBy: null
    };

    await this.dbManager.saveCall(callDocument);

    return { callId, sdpOffer, callDocument };
  }

  /**
   * Callee joins the call. Creates callee endpoint, returns SDP offer.
   *
   * @returns { sdpOffer, callDocument }
   * @throws if call not found, callee already joined, SMB allocation fails
   */
  async joinCall(
    callId: string,
    clientId: string
  ): Promise<{ sdpOffer: string; callDocument: CallDocument }> {
    const call = await this.dbManager.getCall(callId);
    if (!call || call.state === 'ended') {
      throw new Error('Call not found');
    }

    if (call.calleeEndpointId) {
      throw new Error('Callee already joined');
    }

    const smbApiKey = this.getApiKeyForUrl(call.smbUrl);

    const calleeEndpointId = uuidv4();
    const calleeEndpoint = await this.smb.allocateEndpoint(
      call.smbUrl,
      call.smbConferenceId,
      calleeEndpointId,
      true, // audio
      true, // data
      false, // NOT iceControlling (callee is controlled)
      'forwarder',
      this.endpointIdleTimeout,
      smbApiKey
    );

    const sdpOffer = this.generateSdpOffer(calleeEndpoint, calleeEndpointId);

    await this.dbManager.updateCall(callId, {
      calleeEndpointId,
      calleeEndpointDescription: calleeEndpoint
    });

    const updatedCall = await this.dbManager.getCall(callId);
    return { sdpOffer, callDocument: updatedCall! };
  }

  /**
   * Process SDP answer from caller or callee. Configures the SMB endpoint.
   * If both sides are connected after this, transitions call to 'active'.
   *
   * @param role 'caller' | 'callee'
   * @returns updated CallDocument
   * @throws if call not found, SDP parsing fails, SMB configure fails
   */
  async processAnswer(
    callId: string,
    clientId: string,
    sdpAnswer: string,
    role: 'caller' | 'callee'
  ): Promise<CallDocument> {
    const call = await this.dbManager.getCall(callId);
    if (!call || call.state === 'ended') {
      throw new Error('Call not found');
    }

    const endpointId =
      role === 'caller' ? call.callerEndpointId : call.calleeEndpointId;
    const endpointDescription =
      role === 'caller'
        ? call.callerEndpointDescription
        : call.calleeEndpointDescription;

    if (!endpointId || !endpointDescription) {
      throw new Error(`${role} endpoint not found`);
    }

    // Parse SDP answer and configure SMB endpoint
    // Following the pattern from CoreFunctions.handleAnswerRequest
    const configuredEndpoint = this.applyAnswerToEndpoint(
      sdpAnswer,
      endpointDescription
    );

    const smbApiKey = this.getApiKeyForUrl(call.smbUrl);

    await this.smb.configureEndpoint(
      call.smbUrl,
      call.smbConferenceId,
      endpointId,
      configuredEndpoint,
      smbApiKey
    );

    // Update connection state
    const updates: Partial<CallDocument> = {};
    if (role === 'caller') {
      updates.callerConnected = true;
      updates.callerEndpointDescription = configuredEndpoint;
    } else {
      updates.calleeConnected = true;
      updates.calleeEndpointDescription = configuredEndpoint;
    }

    // Check if both connected -> transition to active
    const otherConnected =
      role === 'caller' ? call.calleeConnected : call.callerConnected;
    if (otherConnected) {
      updates.state = 'active';
    }

    await this.dbManager.updateCall(callId, updates);
    return (await this.dbManager.getCall(callId))!;
  }

  /**
   * End a call. Updates DB state.
   * SMB conference cleanup happens via idle timeout (best-effort).
   *
   * @returns updated CallDocument
   * @throws if call not found
   */
  async endCall(callId: string, clientId: string): Promise<CallDocument> {
    const call = await this.dbManager.getCall(callId);
    if (!call) {
      throw new Error('Call not found');
    }
    if (call.state === 'ended') {
      throw new Error('Call already ended');
    }

    await this.dbManager.updateCall(callId, {
      state: 'ended',
      endedAt: new Date().toISOString(),
      endedBy: clientId
    });

    return (await this.dbManager.getCall(callId))!;
  }

  /**
   * Get active calls for a client (both as caller and callee).
   */
  async getActiveCalls(clientId: string): Promise<CallDocument[]> {
    return this.dbManager.getActiveCallsForClient(clientId);
  }

  /**
   * End all active calls for a client. Called on WebSocket disconnect.
   * Iterates all active calls where client is caller or callee and ends them.
   */
  async endAllCallsForClient(clientId: string): Promise<string[]> {
    const activeCalls = await this.dbManager.getActiveCallsForClient(clientId);
    const endedCallIds: string[] = [];
    for (const call of activeCalls) {
      try {
        await this.endCall(call._id, clientId);
        endedCallIds.push(call._id);
      } catch (e) {
        Log().error(`Failed to end call ${call._id}:`, e);
      }
    }
    return endedCallIds;
  }

  /**
   * Generate SDP offer from SMB endpoint description.
   * Follows the same pattern as CoreFunctions.createConnection().
   */
  private generateSdpOffer(
    endpoint: SmbEndpointDescription,
    endpointId: string
  ): string {
    if (!endpoint.audio) {
      throw new Error('Missing audio when creating offer');
    }

    const ssrcs: MediaStreamsInfoSsrc[] = endpoint.audio.ssrcs.map((ssrc) => ({
      ssrc: ssrc.toString(),
      cname: uuidv4(),
      mslabel: uuidv4(),
      label: uuidv4()
    }));

    const endpointMediaStreamInfo = {
      audio: {
        ssrcs: ssrcs
      }
    };

    // Use Connection class to generate SDP offer
    // Type assertion same as CoreFunctions.createConnection
    const connection = new Connection(
      endpointId, // resourceId
      endpointMediaStreamInfo, // mediaStreams
      endpoint as any, // endpointDescription
      endpointId // connectionId
    );

    const offer = connection.createOffer();
    return write(offer);
  }

  /**
   * Apply SDP answer to endpoint description for configureEndpoint.
   * Follows the pattern from CoreFunctions.handleAnswerRequest().
   */
  private applyAnswerToEndpoint(
    sdpAnswer: string,
    endpointDescription: SmbEndpointDescription
  ): SmbEndpointDescription {
    // Deep clone to avoid mutation
    const endpoint: SmbEndpointDescription = JSON.parse(
      JSON.stringify(endpointDescription)
    );

    // Clear existing audio SSRCs - will be populated from answer
    endpoint.audio.ssrcs = [];

    const parsedAnswer = parse(sdpAnswer);
    const answerMediaDescription = parsedAnswer.media[0];
    if (!answerMediaDescription) {
      throw new Error(
        'Missing audio media description when handling sdp answer'
      );
    }

    const audioMedia = parsedAnswer.media.find((m) => m.type === 'audio');
    if (audioMedia?.ssrcs) {
      let parsedSsrcs = audioMedia.ssrcs[0].id;
      if (typeof parsedSsrcs === 'string') {
        parsedSsrcs = parseInt(parsedSsrcs, 10);
      }
      endpoint.audio.ssrcs.push(parsedSsrcs);
    }

    if (endpoint.audio.ssrcs.length === 0) {
      throw new Error('Missing audio ssrcs when handling sdp answer');
    }

    const transport = endpoint['bundle-transport'];
    if (!transport) {
      throw new Error('Missing bundle-transport in endpoint description');
    }
    if (!transport.dtls) {
      throw new Error('Missing dtls in endpoint description');
    }
    if (!transport.ice) {
      throw new Error('Missing ice in endpoint description');
    }

    const answerFingerprint = parsedAnswer.fingerprint
      ? parsedAnswer.fingerprint
      : answerMediaDescription.fingerprint;
    if (!answerFingerprint) {
      throw new Error('Missing fingerprint when handling sdp answer');
    }
    transport.dtls.type = answerFingerprint.type;
    transport.dtls.hash = answerFingerprint.hash;
    transport.dtls.setup = answerMediaDescription.setup || '';
    transport.ice.ufrag = this.toStringIfNumber(
      answerMediaDescription.iceUfrag
    );
    transport.ice.pwd = answerMediaDescription.icePwd || '';
    transport.ice.candidates = !answerMediaDescription.candidates
      ? []
      : answerMediaDescription.candidates.flatMap((element) => {
          return {
            generation: element.generation ? element.generation : 0,
            component: element.component,
            protocol: element.transport.toLowerCase(),
            port: element.port,
            ip: element.ip,
            relPort: element.rport,
            relAddr: element.raddr,
            foundation: element.foundation.toString(),
            priority: parseInt(element.priority.toString(), 10),
            type: element.type,
            network: element['network-id']
          };
        });

    return endpoint;
  }

  private toStringIfNumber(value: string | number | undefined): string {
    if (typeof value === 'number') {
      return String(value);
    } else if (typeof value === 'string') {
      return value;
    } else {
      throw new Error(`${value} has incorrect type`);
    }
  }
}
