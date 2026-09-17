/**
 * Stale single-writer lock: inspection and *consented* takeover.
 *
 * The store heals the unambiguous cases by itself (no lock file, no pid in the
 * payload, or a pid that is gone). What it cannot decide alone is the ambiguous
 * one: the lock names a pid that is alive but has stopped refreshing its
 * heartbeat, which usually means the number was reused by an unrelated process.
 * Silently stealing a live process's lock would create a second writer over one
 * task file — the exact thing the lock exists to prevent.
 *
 * So the ambiguous case is handed to the local human: the desktop asks, and only
 * an explicit "yes" calls `takeOverStoreLock`. That call never deletes evidence —
 * the old lock is renamed aside and every takeover is appended to an audit file
 * next to the store.
 *
 * The classification itself lives in `store.ts` (`classifyLock`) so the rule that
 * decides "may a second writer start" has exactly one implementation.
 */
import { mkdir, open, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { classifyLock, LOCK_HEARTBEAT_GRACE_MS } from './store';
import type { LockState } from './store';

export interface LockPayloadShape {
  pid?: number;
  startedAt?: string;
  heartbeatAt?: string;
  token?: string;
}

export interface LockInspection {
  lockPath: string;
  exists: boolean;
  holderPid?: number;
  startedAt?: string;
  heartbeatAt?: string;
  /** Seconds since the holder last refreshed the lock (undefined when it never did). */
  heartbeatAgeMs?: number;
  /** The holder answered a liveness probe (may still be an unrelated process). */
  holderAlive?: boolean;
  ageMs?: number;
  /** True when the lock exists and only a human decision can settle its owner. */
  ambiguous: boolean;
  state: LockState;
  reason: string;
}

export interface LockTakeoverResult {
  takenOver: boolean;
  /** Where the old lock was moved (evidence, never deleted). */
  replacedPath?: string;
  /** Append-only audit trail of local consent. */
  auditPath: string;
  previous?: LockPayloadShape;
  reason: string;
}

export interface LockTakeoverOptions {
  /** Who consented: only `local-user-consent` is accepted from the desktop UI. */
  actor: 'local-user-consent';
  /** Human-readable cause shown in the audit entry. */
  reason: string;
  now?: () => Date;
}

/** Salvages a pid from a truncated lock payload (crash while writing). */
export function parseLockPayload(raw: string): LockPayloadShape {
  try {
    const parsed = JSON.parse(raw) as LockPayloadShape;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    const salvaged = /"pid"\s*:\s*(\d+)/.exec(raw);
    if (salvaged) return { pid: Number(salvaged[1]) };
  }
  return {};
}

export async function inspectStoreLock(
  filePath: string,
  now = () => new Date(),
  readLock?: (lockPath: string) => Promise<string | undefined>,
): Promise<LockInspection> {
  const lockPath = `${filePath}.lock`;
  let raw: string | undefined;
  let fileAgeMs: number | undefined;
  if (readLock) {
    raw = await readLock(lockPath);
  } else {
    try {
      const { readFile } = await import('node:fs/promises');
      raw = await readFile(lockPath, 'utf8');
    } catch {
      raw = undefined;
    }
  }
  if (raw === undefined) {
    return { lockPath, exists: false, ambiguous: false, state: 'no_lock', reason: 'no lock file' };
  }
  try {
    fileAgeMs = now().getTime() - (await stat(lockPath)).mtimeMs;
  } catch {
    fileAgeMs = undefined;
  }
  const classification = classifyLock(raw, {
    lockPath,
    now: now().getTime(),
    graceMs: LOCK_HEARTBEAT_GRACE_MS,
    fileAgeMs,
  });
  const payload = parseLockPayload(raw);
  const startedAt = payload.startedAt ? Date.parse(payload.startedAt) : Number.NaN;
  return {
    lockPath,
    exists: true,
    holderPid: classification.holderPid,
    startedAt: payload.startedAt,
    heartbeatAt: classification.heartbeatAt,
    heartbeatAgeMs: classification.heartbeatAgeMs,
    holderAlive: classification.holderPid !== undefined && classification.stale === false,
    ageMs: Number.isNaN(startedAt) ? undefined : now().getTime() - startedAt,
    ambiguous: classification.ambiguous,
    state: classification.state,
    reason: classification.reason,
  };
}

/**
 * Takes over a lock after explicit local consent. Callers must have asked the
 * human; this function records that it happened instead of trusting a flag.
 */
export async function takeOverStoreLock(
  filePath: string,
  options: LockTakeoverOptions,
): Promise<LockTakeoverResult> {
  const auditPath = `${filePath}.lock-audit.jsonl`;
  const now = options.now ?? (() => new Date());
  const inspection = await inspectStoreLock(filePath, now);
  if (!inspection.exists) {
    return { takenOver: false, auditPath, reason: 'no lock file to take over' };
  }
  if (inspection.holderPid === process.pid) {
    // Would delete our own mutual exclusion; refuse regardless of consent.
    return {
      takenOver: false,
      auditPath,
      previous: { pid: inspection.holderPid, startedAt: inspection.startedAt },
      reason: 'the lock belongs to this process, so there is nothing to take over',
    };
  }
  const replacedPath = `${inspection.lockPath}.replaced-${now().getTime()}`;
  await rename(inspection.lockPath, replacedPath);
  const entry = {
    at: now().toISOString(),
    actor: options.actor,
    action: 'store_lock.takeover',
    reason: options.reason,
    lock: inspection.lockPath,
    replaced: replacedPath,
    previousHolder: { pid: inspection.holderPid, startedAt: inspection.startedAt },
    holderAlive: inspection.holderAlive,
    // Evidence for the audit: a takeover of a *freshly* heartbeating holder is a
    // different (and much more suspicious) act than one of a frozen pid.
    lockState: inspection.state,
    heartbeatAgeMs: inspection.heartbeatAgeMs,
  };
  await mkdir(dirname(auditPath), { recursive: true });
  const handle = await open(auditPath, 'a');
  try {
    await handle.write(`${JSON.stringify(entry)}\n`);
  } finally {
    await handle.close();
  }
  return {
    takenOver: true,
    replacedPath,
    auditPath,
    previous: { pid: inspection.holderPid, startedAt: inspection.startedAt },
    reason: 'lock taken over after explicit local consent',
  };
}
