/**
 * The lock decides whether a second writer may start, so its classification is
 * tested directly (pure function) as well as through a live process.
 *
 * Round-3 finding F5: the rule used to be "alive pid ⇒ keep the lock forever"
 * with an age escape hatch measured in days, which both stole from live holders
 * and blocked startup for a month after a pid was reused. The rule is now the
 * heartbeat: a holder that refreshes owns the lock, a frozen one is ambiguous,
 * and only a human may settle it.
 */
import { describe, expect, it } from 'vitest';
import { classifyLock, LOCK_HEARTBEAT_GRACE_MS, LOCK_HEARTBEAT_MS } from './store';

const LOCK = 'C:/tmp/tasks.json.lock';
const NOW = Date.parse('2026-09-17T10:00:00.000Z');
const alive = () => true;
const dead = () => false;

function lock(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

describe('store lock classification', () => {
  it('heals a missing lock, a dead holder and a payload without a pid', () => {
    expect(classifyLock(undefined, { lockPath: LOCK, now: NOW })).toMatchObject({
      state: 'no_lock',
      stale: true,
      ambiguous: false,
    });
    expect(
      classifyLock(lock({ pid: 4242, startedAt: '2026-09-17T09:00:00.000Z' }), {
        lockPath: LOCK,
        now: NOW,
        alive: dead,
      }),
    ).toMatchObject({ state: 'dead_pid', stale: true, ambiguous: false, holderPid: 4242 });
    expect(
      classifyLock('{ not json', { lockPath: LOCK, now: NOW, fileAgeMs: 10 * 60 * 1000 }),
    ).toMatchObject({ state: 'owner_unknown', stale: true, ambiguous: false });
  });

  it('keeps the lock for a holder whose heartbeat is fresh', () => {
    const status = classifyLock(
      lock({ pid: 4242, heartbeatAt: new Date(NOW - 5_000).toISOString() }),
      { lockPath: LOCK, now: NOW, alive },
    );
    expect(status.state).toBe('heartbeat_fresh');
    expect(status.stale).toBe(false);
    expect(status.ambiguous).toBe(false);
  });

  it('accepts a heartbeat exactly at the grace boundary and rejects one past it', () => {
    const atGrace = classifyLock(
      lock({ pid: 4242, heartbeatAt: new Date(NOW - LOCK_HEARTBEAT_GRACE_MS).toISOString() }),
      { lockPath: LOCK, now: NOW, alive },
    );
    expect(atGrace.state).toBe('heartbeat_fresh');
    const past = classifyLock(
      lock({ pid: 4242, heartbeatAt: new Date(NOW - LOCK_HEARTBEAT_GRACE_MS - 1).toISOString() }),
      { lockPath: LOCK, now: NOW, alive },
    );
    expect(past.state).toBe('heartbeat_stale');
    expect(past.stale).toBe(false);
    expect(past.ambiguous).toBe(true);
  });

  it('never resolves an ambiguous lock on its own, however old the heartbeat is', () => {
    const ancient = classifyLock(
      lock({ pid: 4242, heartbeatAt: '2020-01-01T00:00:00.000Z', startedAt: '2020-01-01T00:00:00.000Z' }),
      { lockPath: LOCK, now: NOW, alive },
    );
    expect(ancient.stale).toBe(false);
    expect(ancient.ambiguous).toBe(true);
  });

  it('treats a heartbeat-less lock by age: fresh is live, old is ambiguous', () => {
    const fresh = classifyLock(lock({ pid: 4242, startedAt: new Date(NOW - 1_000).toISOString() }), {
      lockPath: LOCK,
      now: NOW,
      alive,
    });
    expect(fresh.state).toBe('no_heartbeat');
    expect(fresh.ambiguous).toBe(false);
    const old = classifyLock(lock({ pid: 4242, startedAt: '2026-09-01T00:00:00.000Z' }), {
      lockPath: LOCK,
      now: NOW,
      alive,
    });
    expect(old.state).toBe('no_heartbeat');
    expect(old.stale).toBe(false);
    expect(old.ambiguous).toBe(true);
  });

  it('keeps the grace well above the interval so a slow beat is not a dead holder', () => {
    expect(LOCK_HEARTBEAT_GRACE_MS).toBeGreaterThanOrEqual(LOCK_HEARTBEAT_MS * 3);
  });

  it('treats a torn payload that still names the pid as that holder', () => {
    const status = classifyLock('{"pid":4242,"heartbeatAt":"2026-09-17T09:59:00.000Z"', {
      lockPath: LOCK,
      now: NOW,
      alive,
    });
    expect(status.holderPid).toBe(4242);
    expect(status.state).toBe('heartbeat_fresh');
  });

  it('ignores a nonsense pid and a future heartbeat is still fresh', () => {
    expect(classifyLock(lock({ pid: 'ours' }), { lockPath: LOCK, now: NOW, alive }).state).toBe(
      'owner_unknown',
    );
    const skewed = classifyLock(
      lock({ pid: 4242, heartbeatAt: new Date(NOW + 60_000).toISOString() }),
      { lockPath: LOCK, now: NOW, alive },
    );
    expect(skewed.state).toBe('heartbeat_fresh');
    expect(skewed.heartbeatAgeMs).toBeLessThan(0);
  });
});
