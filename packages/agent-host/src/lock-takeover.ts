/**
 * Stale single-writer lock: inspection and *consented* takeover.
 *
 * The store heals the unambiguous case by itself (the holder pid is gone). What
 * it cannot decide alone is the ambiguous one: the lock names a pid that is
 * alive but may be an unrelated process that reused the number, or a payload
 * that cannot be parsed at all. Silently stealing a live process's lock would
 * create a second writer over one task file — the exact thing the lock exists to
 * prevent.
 *
 * So the ambiguous case is handed to the local human: the desktop asks, and only
 * an explicit "yes" calls `takeOverStoreLock`. That call never deletes evidence —
 * the old lock is renamed aside and every takeover is appended to an audit file
 * next to the store.
 */
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface LockPayloadShape {
  pid?: number;
  startedAt?: string;
}

export interface LockInspection {
  lockPath: string;
  exists: boolean;
  holderPid?: number;
  startedAt?: string;
  /** The holder answered a liveness probe (may still be an unrelated process). */
  holderAlive?: boolean;
  ageMs?: number;
  /** True when the lock exists and only a human decision can settle its owner. */
  ambiguous: boolean;
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = no such process; EPERM = alive but owned by somebody else.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
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

export async function inspectStoreLock(filePath: string, now = () => new Date()): Promise<LockInspection> {
  const lockPath = `${filePath}.lock`;
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch {
    return { lockPath, exists: false, ambiguous: false, reason: 'no lock file' };
  }
  const payload = parseLockPayload(raw);
  const startedAt = payload.startedAt ? Date.parse(payload.startedAt) : Number.NaN;
  const ageMs = Number.isNaN(startedAt) ? undefined : now().getTime() - startedAt;
  const pid = payload.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return {
      lockPath,
      exists: true,
      startedAt: payload.startedAt,
      ageMs,
      ambiguous: true,
      reason: 'the lock does not name a pid, so its owner cannot be checked',
    };
  }
  const alive = isAlive(pid);
  return {
    lockPath,
    exists: true,
    holderPid: pid,
    startedAt: payload.startedAt,
    holderAlive: alive,
    ageMs,
    // A live pid that is not this process cannot be proven to be a leftover.
    ambiguous: alive,
    reason: alive
      ? `pid ${pid} is alive, so this lock may belong to a running host (or to a process that reused the pid)`
      : `pid ${pid} is gone, so the lock is a leftover`,
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
