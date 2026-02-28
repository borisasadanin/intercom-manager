/**
 * In-memory tracker for active PTT talk state.
 * Maps clientId -> Set<callId> for all clients currently pressing PTT.
 * Process-local (single-instance POC). NOT persisted to DB.
 */
export class TalkManager {
  private activeTalks: Map<string, Set<string>> = new Map();

  /**
   * Record that a client started talking on the given calls.
   * Replaces any previous talk state for this client.
   */
  startTalking(clientId: string, callIds: string[]): void {
    this.activeTalks.set(clientId, new Set(callIds));
  }

  /**
   * Record that a client stopped talking (PTT released).
   * Removes all talk state for this client.
   */
  stopTalking(clientId: string): void {
    this.activeTalks.delete(clientId);
  }

  /**
   * Get all client IDs currently talking TO a specific client.
   * Requires the call graph to determine directionality.
   */
  getTalkersToClient(
    targetClientId: string,
    calls: Array<{ callId: string; callerId: string; calleeId: string }>
  ): string[] {
    const talkers: string[] = [];

    for (const [talkerId, callIds] of this.activeTalks) {
      if (talkerId === targetClientId) continue;

      for (const callId of callIds) {
        const call = calls.find((c) => c.callId === callId);
        if (!call) continue;

        // Check if the target is the other party in this call
        const isCallerToTarget =
          call.callerId === talkerId && call.calleeId === targetClientId;
        const isCalleeToTarget =
          call.calleeId === talkerId && call.callerId === targetClientId;

        if (isCallerToTarget || isCalleeToTarget) {
          talkers.push(talkerId);
          break; // Only add each talker once
        }
      }
    }

    return talkers;
  }

  /**
   * Get the full talk state snapshot.
   * Returns Map where key = clientId, value = array of callIds.
   */
  getActiveTalkers(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const [clientId, callIds] of this.activeTalks) {
      result.set(clientId, Array.from(callIds));
    }
    return result;
  }

  /**
   * Remove all talk state for a client (called on disconnect).
   * Does NOT trigger broadcasts -- the caller handles that.
   */
  removeClient(clientId: string): void {
    this.activeTalks.delete(clientId);
  }

  /**
   * Check if a specific client is currently talking.
   */
  isTalking(clientId: string): boolean {
    const callIds = this.activeTalks.get(clientId);
    return callIds !== undefined && callIds.size > 0;
  }

  /**
   * Get the number of currently active talkers.
   */
  getActiveTalkerCount(): number {
    return this.activeTalks.size;
  }
}
