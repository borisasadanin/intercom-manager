/**
 * Unit tests for TalkManager.
 * Pure in-memory class — no Fastify, no mocks needed.
 * Covers: startTalking, stopTalking, isTalking, getActiveTalkers,
 *          getActiveTalkerCount, removeClient, getTalkersToClient.
 */

import { TalkManager } from './talk_manager';

// ===========================================================================
// TalkManager state tests
// ===========================================================================

describe('TalkManager — state management', () => {
  let tm: TalkManager;

  beforeEach(() => {
    tm = new TalkManager();
  });

  // 1. startTalking records state — getActiveTalkers returns the entry
  it('startTalking records the client and call IDs in getActiveTalkers', () => {
    tm.startTalking('A', ['call1', 'call2']);

    const active = tm.getActiveTalkers();
    expect(active.has('A')).toBe(true);
    expect(active.get('A')).toEqual(expect.arrayContaining(['call1', 'call2']));
    expect(active.get('A')).toHaveLength(2);
  });

  // 2. stopTalking clears state
  it('stopTalking removes the client from getActiveTalkers', () => {
    tm.startTalking('A', ['call1']);
    tm.stopTalking('A');

    const active = tm.getActiveTalkers();
    expect(active.has('A')).toBe(false);
    expect(active.size).toBe(0);
  });

  // 3. startTalking replaces previous state
  it('startTalking replaces existing call IDs with new ones', () => {
    tm.startTalking('A', ['call1']);
    tm.startTalking('A', ['call2']);

    const active = tm.getActiveTalkers();
    expect(active.get('A')).toEqual(['call2']);
    expect(active.get('A')).not.toContain('call1');
  });

  // 4. Multiple talkers tracked independently
  it('tracks A and B as independent talkers simultaneously', () => {
    tm.startTalking('A', ['call-AB']);
    tm.startTalking('B', ['call-BC']);

    const active = tm.getActiveTalkers();
    expect(active.has('A')).toBe(true);
    expect(active.has('B')).toBe(true);
    expect(active.size).toBe(2);
  });

  // 5. Stop one client does not affect others
  it('stopping A does not affect B still being tracked', () => {
    tm.startTalking('A', ['call-AB']);
    tm.startTalking('B', ['call-BC']);
    tm.stopTalking('A');

    const active = tm.getActiveTalkers();
    expect(active.has('A')).toBe(false);
    expect(active.has('B')).toBe(true);
    expect(active.get('B')).toEqual(['call-BC']);
  });
});

// ===========================================================================
// TalkManager — isTalking tests
// ===========================================================================

describe('TalkManager — isTalking', () => {
  let tm: TalkManager;

  beforeEach(() => {
    tm = new TalkManager();
  });

  // 6. isTalking returns true for active talker
  it('returns true when client is currently talking', () => {
    tm.startTalking('A', ['call1']);
    expect(tm.isTalking('A')).toBe(true);
  });

  // 7. isTalking returns false for inactive client
  it('returns false when client has never started talking', () => {
    expect(tm.isTalking('B')).toBe(false);
  });

  // 8. isTalking returns false after stop
  it('returns false after stopTalking is called', () => {
    tm.startTalking('A', ['call1']);
    tm.stopTalking('A');
    expect(tm.isTalking('A')).toBe(false);
  });
});

// ===========================================================================
// TalkManager — getActiveTalkerCount tests
// ===========================================================================

describe('TalkManager — getActiveTalkerCount', () => {
  let tm: TalkManager;

  beforeEach(() => {
    tm = new TalkManager();
  });

  // 9. getActiveTalkerCount returns correct count
  it('returns 0 initially, then increments and decrements correctly', () => {
    expect(tm.getActiveTalkerCount()).toBe(0);

    tm.startTalking('A', ['call1']);
    expect(tm.getActiveTalkerCount()).toBe(1);

    tm.startTalking('B', ['call2']);
    expect(tm.getActiveTalkerCount()).toBe(2);

    tm.stopTalking('A');
    expect(tm.getActiveTalkerCount()).toBe(1);

    tm.stopTalking('B');
    expect(tm.getActiveTalkerCount()).toBe(0);
  });
});

// ===========================================================================
// TalkManager — removeClient tests
// ===========================================================================

describe('TalkManager — removeClient', () => {
  let tm: TalkManager;

  beforeEach(() => {
    tm = new TalkManager();
  });

  // 10. removeClient clears state — start, removeClient, verify gone
  it('removeClient removes the client from talk state', () => {
    tm.startTalking('A', ['call1', 'call2']);
    expect(tm.isTalking('A')).toBe(true);

    tm.removeClient('A');
    expect(tm.isTalking('A')).toBe(false);

    const active = tm.getActiveTalkers();
    expect(active.has('A')).toBe(false);
  });
});

// ===========================================================================
// TalkManager — getTalkersToClient tests
// ===========================================================================

describe('TalkManager — getTalkersToClient', () => {
  let tm: TalkManager;

  // A basic call graph used in several tests
  const calls = [
    { callId: 'call-AB', callerId: 'A', calleeId: 'B' },
    { callId: 'call-BA', callerId: 'B', calleeId: 'A' },
    { callId: 'call-AC', callerId: 'A', calleeId: 'C' }
  ];

  beforeEach(() => {
    tm = new TalkManager();
  });

  // 11. A talks on call-AB (A=caller, B=callee) → getTalkersToClient('B') returns ['A']
  it('returns the caller when caller is talking to target callee', () => {
    tm.startTalking('A', ['call-AB']);

    const talkers = tm.getTalkersToClient('B', calls);
    expect(talkers).toEqual(['A']);
  });

  // 12. getTalkersToClient with no active talkers — returns []
  it('returns empty array when nobody is talking', () => {
    const talkers = tm.getTalkersToClient('B', calls);
    expect(talkers).toEqual([]);
  });

  // 13. Bidirectional — A talks on call-AB, B talks on call-BA, both talking to each other
  it('returns both talkers in the bidirectional case', () => {
    tm.startTalking('A', ['call-AB']);
    tm.startTalking('B', ['call-BA']);

    const talkersToA = tm.getTalkersToClient('A', calls);
    expect(talkersToA).toEqual(['B']);

    const talkersToB = tm.getTalkersToClient('B', calls);
    expect(talkersToB).toEqual(['A']);
  });

  // 14. Multi-target — A talks on call-AB and call-AC simultaneously
  //     Both B and C see A as their talker
  it('handles multi-target: A talks on call-AB and call-AC, B and C both see A as talker', () => {
    tm.startTalking('A', ['call-AB', 'call-AC']);

    const talkersToB = tm.getTalkersToClient('B', calls);
    expect(talkersToB).toEqual(['A']);

    const talkersToC = tm.getTalkersToClient('C', calls);
    expect(talkersToC).toEqual(['A']);
  });
});
