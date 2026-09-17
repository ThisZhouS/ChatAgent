import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { StoreLoadReport } from './record-integrity';
import { validatePersistedRow } from './record-integrity';
import { DEFAULT_MAX_RECORDS, selectExpiredRecords } from './retention';
import type { LocalTaskRecord, LocalTaskState } from './types';
import { TERMINAL_LOCAL_STATES } from './types';

/** Raised when another live process already owns the task store (H-05). */
export class AgentHostStoreLockedError extends Error {
  readonly code = 'agent_host_store_locked';
  constructor(readonly lockPath: string) {
    super(
      `the local agent task store is locked by another running process (${lockPath}); ` +
        'refusing to become a second writer',
    );
    this.name = 'AgentHostStoreLockedError';
  }
}

/**
 * Durable task store for the local host.
 *
 * It is intentionally a plain JSON file: the PoC must run without a database, and
 * the ChatAgent TaskEngine stays the business ledger. What matters here is that
 * (a) state survives a host restart, (b) exactly one holder may run a task
 * (compare-and-set lease), and (c) exactly one *process* may write the file at a
 * time (OS-level lock file), plus (d) a failed write is reported to the caller
 * instead of being swallowed.
 */
export interface AgentHostStore {
  load(): Promise<void>;
  list(): Promise<LocalTaskRecord[]>;
  get(taskId: string): Promise<LocalTaskRecord | undefined>;
  /**
   * Unconditional upsert (create or replace). Returns the stored record with its
   * new compare-and-set version. A failed disk write rejects.
   */
  put(record: LocalTaskRecord): Promise<LocalTaskRecord>;
  /**
   * Creates `record` only when its taskId is still unknown, returning undefined
   * otherwise. Atomic within the single writer, which is what makes concurrent
   * submits of one id deterministic.
   */
  createIfAbsent?(record: LocalTaskRecord): Promise<LocalTaskRecord | undefined>;
  /**
   * Applies `next` only when the stored record still has `expectedVersion`.
   * Returns the stored record on success, or undefined when the state moved on
   * (e.g. the task was cancelled while the executor was still running).
   */
  compareAndSet(
    taskId: string,
    expectedVersion: number,
    next: LocalTaskRecord,
  ): Promise<LocalTaskRecord | undefined>;
  /**
   * Claims the task for `holder` when it is queued (or when the previous lease
   * expired). Returns the claimed record, or undefined when somebody else owns it.
   */
  claim(taskId: string, holder: string, leaseMs: number): Promise<LocalTaskRecord | undefined>;
  release(taskId: string, holder: string): Promise<void>;
  /** Marks tasks left `running` by a previous host process. */
  recoverInterrupted(): Promise<LocalTaskRecord[]>;
  flush(): Promise<void>;
  /** Releases the OS-level write lock (no-op for the in-memory store). */
  close(): Promise<void>;
  /**
   * What the store found while loading: repaired rows, quarantined rows,
   * duplicate ids, and a file that had to be moved aside. Optional: a store that
   * has nothing to report (the in-memory one) simply omits it.
   */
  getLoadReport?(): StoreLoadReport | undefined;
  /**
   * Retention activity: how many records this store has dropped so far, and how
   * many the loaded rows say are past the cap. Optional — a store without
   * retention simply omits it. Reported so pruning is never invisible.
   */
  retentionStats?(): { pruned: number };
}

export interface LockPayload {
  pid?: number;
  /** When the current holder took the lock. */
  startedAt?: string;
  /** Refreshed by the holder while it runs; a frozen value means nobody owns it. */
  heartbeatAt?: string;
  /** Random per acquisition: releasing never removes somebody else's lock. */
  token?: string;
}

/**
 * How often a running holder refreshes its lock, and how long a frozen heartbeat
 * may be believed. The grace spans several intervals so a busy or briefly
 * suspended process is not declared dead, while pid reuse is noticed in a minute
 * instead of a month (round-3 finding F5: the age-only rule was measured in days,
 * so a *live* holder could be stolen from while a reused pid blocked startup).
 */
export const LOCK_HEARTBEAT_MS = 15_000;
export const LOCK_HEARTBEAT_GRACE_MS = 60_000;

export type LockState =
  /** No lock file: nothing to take over. */
  | 'no_lock'
  /** The payload cannot name a process: a crashed writer, safe to replace. */
  | 'owner_unknown'
  /** The named pid is gone: a crashed holder, safe to replace. */
  | 'dead_pid'
  /** The holder refreshed the lock recently: it is really running. */
  | 'heartbeat_fresh'
  /** The owner is alive but stopped refreshing: probably a reused pid. */
  | 'heartbeat_stale'
  /** Written by a build without heartbeats: only the age of `startedAt` is left. */
  | 'no_heartbeat';

export interface LockStatus {
  state: LockState;
  /** True when the store may replace the lock without asking anybody. */
  stale: boolean;
  /** True when only a human decision (see lock-takeover.ts) can settle the owner. */
  ambiguous: boolean;
  lockPath: string;
  holderPid?: number;
  startedAt?: string;
  heartbeatAt?: string;
  heartbeatAgeMs?: number;
  reason: string;
}

/**
 * Reads what a torn/truncated lock payload still says. The lock is written once
 * with a single small write, so this is rare, but a reader that finds garbage
 * must not conclude "no owner" while the holder is alive and refreshing.
 */
export function parseLockText(raw: string): LockPayload {
  try {
    const parsed = JSON.parse(raw) as LockPayload;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // fall through to salvage
  }
  return salvageLockPayload(raw);
}

export function salvageLockPayload(raw: string): LockPayload {
  const pid = /"pid"\s*:\s*(\d+)/.exec(raw);
  const heartbeat = /"heartbeatAt"\s*:\s*"([^"]+)"/.exec(raw);
  const started = /"startedAt"\s*:\s*"([^"]+)"/.exec(raw);
  const token = /"token"\s*:\s*"([^"]+)"/.exec(raw);
  const payload: LockPayload = {};
  if (pid) payload.pid = Number(pid[1]);
  if (heartbeat) payload.heartbeatAt = heartbeat[1];
  if (started) payload.startedAt = started[1];
  if (token) payload.token = token[1];
  return payload;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH = no such process; EPERM = alive but owned by somebody else.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Classifies one lock file. Pure on purpose: the rule that decides whether a
 * second writer may start is the most safety-critical decision in the store, so it
 * is unit-tested directly instead of only through a live process.
 */
export function classifyLock(
  raw: string | undefined,
  options: {
    lockPath: string;
    now?: number;
    alive?: (pid: number) => boolean;
    graceMs?: number;
    /** How long ago the lock file was last written (checked for unreadable locks). */
    fileAgeMs?: number;
  },
): LockStatus {
  const now = options.now ?? Date.now();
  const alive = options.alive ?? isProcessAlive;
  const grace = options.graceMs ?? LOCK_HEARTBEAT_GRACE_MS;
  const lockPath = options.lockPath;
  if (raw === undefined) {
    return { state: 'no_lock', stale: true, ambiguous: false, lockPath, reason: 'no lock file' };
  }
  let payload: LockPayload;
  try {
    const parsed = JSON.parse(raw) as LockPayload;
    payload = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A truncated lock (crash while writing) may still name a live holder, so
    // salvage what the text does contain — the pid *and* its heartbeat — before
    // calling the lock abandoned.
    payload = salvageLockPayload(raw);
  }
  const pid = payload.pid;
  const base = { lockPath, startedAt: payload.startedAt, heartbeatAt: payload.heartbeatAt };
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    // A just-written payload that cannot be parsed may be a holder mid-write
    // (the file is created empty first), so a *fresh* unreadable lock is left to
    // a human; only an old one is a leftover nobody can still be holding.
    const fileAgeMs = options.fileAgeMs;
    if (fileAgeMs !== undefined && fileAgeMs <= grace) {
      return {
        ...base,
        state: 'owner_unknown',
        stale: false,
        ambiguous: true,
        reason: `the lock is unreadable but was written ${Math.max(0, Math.round(fileAgeMs / 1000))}s ago, so a holder may be mid-write`,
      };
    }
    return {
      ...base,
      state: 'owner_unknown',
      stale: true,
      ambiguous: false,
      reason: 'the lock does not name a pid, so nothing can still be running under it',
    };
  }
  if (!alive(pid)) {
    return {
      ...base,
      state: 'dead_pid',
      stale: true,
      ambiguous: false,
      holderPid: pid,
      reason: `pid ${pid} is gone, so the lock is a leftover`,
    };
  }
  const heartbeatMs = payload.heartbeatAt ? Date.parse(payload.heartbeatAt) : Number.NaN;
  const heartbeatAgeMs = Number.isNaN(heartbeatMs) ? undefined : now - heartbeatMs;
  if (heartbeatAgeMs !== undefined && heartbeatAgeMs <= grace) {
    return {
      ...base,
      state: 'heartbeat_fresh',
      stale: false,
      ambiguous: false,
      holderPid: pid,
      heartbeatAgeMs,
      reason: `pid ${pid} refreshed the lock ${Math.max(0, Math.round(heartbeatAgeMs / 1000))}s ago, so it is still running`,
    };
  }
  if (heartbeatAgeMs !== undefined) {
    return {
      ...base,
      state: 'heartbeat_stale',
      stale: false,
      ambiguous: true,
      holderPid: pid,
      heartbeatAgeMs,
      reason: `pid ${pid} is alive but has not refreshed the lock for ${Math.round(heartbeatAgeMs / 1000)}s, which usually means the pid was reused`,
    };
  }
  // No heartbeat in the payload (a lock written by an older build, or by hand):
  // age is the only evidence left, and only a human may act on it.
  const startedMs = payload.startedAt ? Date.parse(payload.startedAt) : Number.NaN;
  const ageMs = Number.isNaN(startedMs) ? undefined : now - startedMs;
  return {
    ...base,
    state: 'no_heartbeat',
    stale: false,
    ambiguous: ageMs === undefined || ageMs > grace,
    holderPid: pid,
    reason:
      ageMs === undefined
        ? `pid ${pid} is alive and the lock carries no heartbeat or usable timestamp`
        : `pid ${pid} is alive and the lock was written ${Math.round(ageMs / 1000)}s ago without a heartbeat`,
  };
}

export class JsonFileAgentHostStore implements AgentHostStore {
  private records = new Map<string, LocalTaskRecord>();
  private loadPromise?: Promise<void>;
  private loaded = false;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();
  private lockHeld = false;
  private lockHeartbeat?: NodeJS.Timeout;
  private lockBeatInFlight: Promise<void> = Promise.resolve();
  private lockHeartbeatFailures = 0;
  private lockLostReason?: string;
  private lockBeatTicks?: number;
  private lockBeatOnce?: () => Promise<void>;
  private lockStartedAt?: string;
  private lockToken?: string;
  private loadReport?: StoreLoadReport;
  private lastLoadError?: string;
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly lockEnabled: boolean;
  private readonly maxRecords: number;
  private readonly maxAgeMs?: number;
  private readonly heartbeatMs: number;
  private prunedRecords = 0;

  constructor(
    filePath: string,
    options: {
      lock?: boolean;
      maxRecords?: number;
      maxAgeMs?: number;
      /** Overridable for tests: how often the holder refreshes its lock. */
      heartbeatMs?: number;
    } = {},
  ) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.lockEnabled = options.lock !== false;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.maxAgeMs = options.maxAgeMs;
    this.heartbeatMs = options.heartbeatMs ?? LOCK_HEARTBEAT_MS;
  }

  async load(): Promise<void> {
    // Concurrent first callers must share one acquisition: without this, four
    // parallel reads each tried to create the lock file and three of them saw
    // their own (live) lock and failed.
    this.loadPromise ??= this.doLoad();
    return this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    if (this.loaded) return;
    await this.acquireLock();
    this.loaded = true;

    const report: StoreLoadReport = {
      loadedAt: new Date().toISOString(),
      rows: 0,
      repaired: [],
      quarantined: [],
      duplicates: [],
    };

    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // First run: an empty store is a normal outcome, not a repair.
        this.loadReport = report;
        return;
      }
      // Unreadable for any other reason (permissions, locked by antivirus): the
      // lock must not stay behind, and the caller has to see the real error.
      await this.releaseLock();
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // A corrupt file used to make the whole app unstartable. Keep the evidence
      // (renamed aside, never deleted), start clean, and report it.
      const reason = error instanceof Error ? error.message : String(error);
      report.corruptFile = await this.quarantineFile(`store file is not valid JSON: ${reason}`);
      report.quarantined.push({ taskId: '(file)', reason: `store file is not valid JSON: ${reason}` });
      this.loadReport = report;
      return;
    }

    if (!Array.isArray(parsed)) {
      const reason = `store file is not an array (${typeof parsed})`;
      report.corruptFile = await this.quarantineFile(reason);
      report.quarantined.push({ taskId: '(file)', reason });
      this.loadReport = report;
      return;
    }

    const now = new Date().toISOString();
    parsed.forEach((row, index) => {
      report.rows += 1;
      const verdict = validatePersistedRow(row, index, now);
      if (verdict.repairs.length > 0) {
        report.repaired.push({ taskId: verdict.record.taskId, repairs: verdict.repairs });
      }
      if (verdict.quarantined) {
        report.quarantined.push({ taskId: verdict.record.taskId, reason: verdict.quarantined });
      }
      const existing = this.records.get(verdict.record.taskId);
      if (existing) {
        // Two rows with one id: the newer version wins, the other is reported.
        const keepNew = verdict.record.version >= existing.version;
        report.duplicates.push({
          taskId: verdict.record.taskId,
          droppedVersion: keepNew ? existing.version : verdict.record.version,
          keptVersion: keepNew ? verdict.record.version : existing.version,
        });
        if (!keepNew) return;
      }
      this.records.set(verdict.record.taskId, verdict.record);
    });

    // Retention is reported, not applied: a load never rewrites the file. The
    // first accepted write drops these records (see commit()).
    const prunable = selectExpiredRecords([...this.records.values()], {
      maxRecords: this.maxRecords,
      maxAgeMs: this.maxAgeMs,
    });
    if (prunable.length > 0) report.prunable = prunable;

    this.loadReport = report;
  }

  /**
   * Moves an unreadable store file aside instead of deleting it, so a reviewer
   * can still see what was there. Returns the path it was moved to.
   */
  private async quarantineFile(reason: string): Promise<string | undefined> {
    const target = `${this.filePath}.corrupt-${Date.now()}`;
    try {
      await rename(this.filePath, target);
      return target;
    } catch {
      // Best effort: the report still carries the reason.
      this.lastLoadError = reason;
      return undefined;
    }
  }

  /** How many records retention has dropped since this store was opened. */
  retentionStats(): { pruned: number } {
    return { pruned: this.prunedRecords };
  }

  /** Integrity report from the last load; undefined before the store is loaded. */
  getLoadReport(): StoreLoadReport | undefined {
    return this.loadReport;
  }

  async list(): Promise<LocalTaskRecord[]> {
    await this.load();
    return [...this.records.values()]
      .map((record) => structuredClone(record))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(taskId: string): Promise<LocalTaskRecord | undefined> {
    await this.load();
    const record = this.records.get(taskId);
    return record ? structuredClone(record) : undefined;
  }

  async put(record: LocalTaskRecord): Promise<LocalTaskRecord> {
    await this.load();
    const previous = this.records.get(record.taskId);
    // Terminal states are only left through an explicit retry (compareAndSet).
    // A stale writer replaying an old snapshot must not resurrect finished work.
    if (
      previous &&
      TERMINAL_LOCAL_STATES.includes(previous.state) &&
      !TERMINAL_LOCAL_STATES.includes(record.state)
    ) {
      throw new Error(
        `terminal_state_protected: task ${record.taskId} is ${previous.state} and cannot be rewritten as ${record.state}`,
      );
    }
    const stored: LocalTaskRecord = {
      ...structuredClone(record),
      version: (previous?.version ?? 0) + 1,
    };
    await this.commit(record.taskId, stored, previous);
    return structuredClone(stored);
  }

  async compareAndSet(
    taskId: string,
    expectedVersion: number,
    next: LocalTaskRecord,
  ): Promise<LocalTaskRecord | undefined> {
    await this.load();
    const current = this.records.get(taskId);
    if (!current || current.version !== expectedVersion) return undefined;
    const stored: LocalTaskRecord = { ...structuredClone(next), version: current.version + 1 };
    await this.commit(taskId, stored, current);
    return structuredClone(stored);
  }

  async createIfAbsent(record: LocalTaskRecord): Promise<LocalTaskRecord | undefined> {
    await this.load();
    if (this.records.has(record.taskId)) return undefined;
    const stored: LocalTaskRecord = { ...structuredClone(record), version: 1 };
    await this.commit(record.taskId, stored, undefined);
    return structuredClone(stored);
  }

  async claim(taskId: string, holder: string, leaseMs: number): Promise<LocalTaskRecord | undefined> {
    await this.load();
    const record = this.records.get(taskId);
    if (!record) return undefined;
    if (TERMINAL_LOCAL_STATES.includes(record.state) || record.state === 'interrupted') return undefined;

    const now = Date.now();
    const leaseActive = record.lease !== undefined && Date.parse(record.lease.expiresAt) > now;
    if (record.state === 'running' && leaseActive && record.lease?.holder !== holder) return undefined;
    if (record.state === 'running' && record.lease?.holder === holder) return structuredClone(record);
    if (record.state !== 'queued' && record.state !== 'running') return undefined;

    // Compare-and-set: the map write happens without awaiting anything in between.
    const claimed: LocalTaskRecord = {
      ...structuredClone(record),
      lease: { holder, expiresAt: new Date(now + leaseMs).toISOString() },
      version: record.version + 1,
    };
    await this.commit(taskId, claimed, record);
    return structuredClone(claimed);
  }

  async release(taskId: string, holder: string): Promise<void> {
    await this.load();
    const record = this.records.get(taskId);
    if (!record || record.lease?.holder !== holder) return;
    const released: LocalTaskRecord = {
      ...structuredClone(record),
      version: record.version + 1,
      updatedAt: new Date().toISOString(),
    };
    delete released.lease;
    await this.commit(taskId, released, record);
  }

  async recoverInterrupted(): Promise<LocalTaskRecord[]> {
    await this.load();
    const recovered: LocalTaskRecord[] = [];
    for (const record of [...this.records.values()]) {
      if (record.state !== 'running') continue;
      const now = new Date().toISOString();
      // Never `succeeded`: the run was killed by a host restart and its outcome is
      // unknown. The task becomes recoverable (queued) or failed, with a reason.
      const canRetry = record.attempts < record.maxAttempts && record.kind === 'document';
      const next: LocalTaskRecord = {
        ...structuredClone(record),
        state: canRetry ? 'queued' : 'interrupted',
        error: canRetry ? 'host_restart_retry' : 'host_restart_outcome_unknown',
        summary: '主机重启：本次执行结果未知，未计为完成',
        finishedAt: canRetry ? undefined : now,
        updatedAt: now,
        version: record.version + 1,
      };
      delete next.lease;
      await this.commit(record.taskId, next, record);
      recovered.push(structuredClone(next));
    }
    return recovered;
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
    await this.releaseLock();
  }

  /**
   * Apply an in-memory change and make it durable. If the write fails the change
   * is rolled back: memory must never report an outcome the disk does not have,
   * or a "succeeded" task would silently re-run after a restart.
   */
  private async commit(
    taskId: string,
    next: LocalTaskRecord,
    previous: LocalTaskRecord | undefined,
  ): Promise<void> {
    this.records.set(taskId, next);
    // Retention applies at write time: the file only ever shrinks on a write we
    // were going to perform anyway, and never during a load.
    const prunable = selectExpiredRecords([...this.records.values()], {
      maxRecords: this.maxRecords,
      maxAgeMs: this.maxAgeMs,
    });
    const pruned = prunable.length > 0 ? prunable.map((id) => this.records.get(id)!) : [];
    for (const record of pruned) this.records.delete(record.taskId);
    this.prunedRecords += pruned.length;
    try {
      await this.persist();
    } catch (error) {
      // Put dropped records back: a failed write must not lose history.
      for (const record of pruned) this.records.set(record.taskId, record);
      // Only undo OUR failed write. Another write may have landed in between
      // (e.g. a retry of the same id), and rewinding it would silently lose a
      // result the caller was already told succeeded.
      if (this.records.get(taskId) === next) {
        if (previous) this.records.set(taskId, previous);
        else this.records.delete(taskId);
      }
      throw error;
    }
  }

  private async persist(): Promise<void> {
    // A closed store has released the lock; writing now would silently clobber
    // whoever holds it (the lock is the only thing keeping one writer in charge).
    if (this.closed) throw new Error('agent_host_store_closed: refusing to write after close()');
    if (this.lockEnabled && !this.lockHeld) {
      throw new AgentHostStoreLockedError(this.lockPath);
    }
    const snapshot = JSON.stringify([...this.records.values()], null, 2);
    // The chain keeps writes ordered; a failed write is surfaced to its caller
    // (H-03) without poisoning the writes that follow it.
    const run = this.queue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = join(dirname(this.filePath), `.${process.pid}-${Date.now()}.tmp`);
      // Write, flush to the OS, then rename: the rename is the commit point, and
      // fsync keeps a crash from leaving a half-written store behind.
      const handle = await open(tmp, 'w');
      try {
        await handle.writeFile(snapshot, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, this.filePath);
    });
    this.queue = run.catch(() => undefined);
    await run;
  }

  private async acquireLock(): Promise<void> {
    if (!this.lockEnabled || this.lockHeld) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    this.lockToken = randomUUID();
    this.lockStartedAt = new Date().toISOString();
    const payload = JSON.stringify({
      pid: process.pid,
      startedAt: this.lockStartedAt,
      heartbeatAt: this.lockStartedAt,
      token: this.lockToken,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await writeFile(this.lockPath, payload, { encoding: 'utf8', flag: 'wx' });
        this.lockHeld = true;
        this.startLockHeartbeat();
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (!(await this.isLockStale())) throw new AgentHostStoreLockedError(this.lockPath);
      // Abandoned lock from a crashed process: remove it and retry once more.
      await rm(this.lockPath, { force: true }).catch(() => undefined);
    }
    throw new AgentHostStoreLockedError(this.lockPath);
  }

  /**
   * Refresh the heartbeat right now instead of waiting for the interval. A long
   * task write can push the next scheduled beat past the grace window, and a
   * holder that looks frozen invites a human to take its lock away.
   */
  async refreshLock(): Promise<void> {
    await this.lockBeatOnce?.();
  }

  /** Reads and classifies the current lock file (no side effects). */
  async inspectLock(): Promise<LockStatus> {
    let raw: string | undefined;
    let fileAgeMs: number | undefined;
    try {
      raw = await readFile(this.lockPath, 'utf8');
    } catch {
      raw = undefined;
    }
    if (raw !== undefined) {
      try {
        fileAgeMs = Date.now() - (await stat(this.lockPath)).mtimeMs;
      } catch {
        fileAgeMs = undefined;
      }
    }
    return classifyLock(raw, { lockPath: this.lockPath, fileAgeMs });
  }

  /** What the store knows about its own lock, for status reporting. */
  lockStatus(): {
    held: boolean;
    heartbeatFailures: number;
    lostReason?: string;
    /** Heartbeats this holder has made — a frozen count explains a stale lock. */
    beats?: number;
    path: string;
  } {
    return {
      held: this.lockHeld,
      heartbeatFailures: this.lockHeartbeatFailures,
      lostReason: this.lockLostReason,
      beats: this.lockBeatTicks,
      path: this.lockPath,
    };
  }

  private async isLockStale(): Promise<boolean> {
    return (await this.inspectLock()).stale;
  }

  /**
   * Refreshes `heartbeatAt` while the lock is held: that timestamp is what tells a
   * second instance "this holder is really running", and a reused pid cannot
   * refresh it. Failures are counted, not thrown — losing a heartbeat must never
   * crash a running host, but it must also be visible through `lockStatus()`.
   */
  private startLockHeartbeat(): void {
    if (!this.lockEnabled || this.lockHeartbeat) return;
    const token = this.lockToken;
    const beat = async () => {
      this.lockBeatTicks = (this.lockBeatTicks ?? 0) + 1;
      if (!this.lockHeld || this.lockToken !== token) return;
      const payload: LockPayload = {
        pid: process.pid,
        startedAt: this.lockStartedAt,
        heartbeatAt: new Date().toISOString(),
        token,
      };
      const tmp = `${this.lockPath}.beat`;
      try {
        // Ownership is re-checked against the file itself, not only against our own
        // flags: a heartbeat must never overwrite a lock that was taken over while
        // this instance was idle, and it must never recreate one we released.
        const current = await readFile(this.lockPath, 'utf8').catch(() => undefined);
        if (current === undefined) return this.loseLock('the lock file disappeared');
        const owner = parseLockText(current);
        if (owner.pid !== process.pid || (owner.token !== undefined && owner.token !== token)) {
          return this.loseLock(`the lock is now held by pid ${String(owner.pid)}`);
        }
        const seenAt = await stat(this.lockPath).then(
          (info) => info.mtimeMs,
          () => undefined,
        );
        await writeFile(tmp, JSON.stringify(payload), 'utf8');
        if (!this.lockHeld || this.lockToken !== token) {
          await rm(tmp, { force: true }).catch(() => undefined);
          return;
        }
        // Last look before committing: if the file changed since we read it, another
        // writer is in charge now and the heartbeat must stand down.
        const nowAt = await stat(this.lockPath).then(
          (info) => info.mtimeMs,
          () => undefined,
        );
        if (seenAt !== undefined && nowAt !== undefined && nowAt !== seenAt) {
          await rm(tmp, { force: true }).catch(() => undefined);
          return this.loseLock('the lock file changed while heartbeating');
        }
        // Rename is the commit point: a reader never sees a half-written payload.
        await rename(tmp, this.lockPath);
      } catch {
        this.lockHeartbeatFailures += 1;
        await rm(tmp, { force: true }).catch(() => undefined);
      }
    };
    const schedule = () => {
      this.lockBeatInFlight = beat();
      void this.lockBeatInFlight;
    };
    this.lockBeatOnce = beat;
    schedule();
    this.lockHeartbeat = setInterval(schedule, this.heartbeatMs);
    // Never keep the process alive just to refresh a lock.
    this.lockHeartbeat.unref?.();
  }

  private stopLockHeartbeat(): void {
    if (!this.lockHeartbeat) return;
    clearInterval(this.lockHeartbeat);
    this.lockHeartbeat = undefined;
  }

  /**
   * The lock is no longer ours (taken over, replaced or deleted by another
   * process). Stop heartbeating and refuse to write: a store that lost its lock
   * must fail loudly instead of becoming a second writer over one task file.
   */
  private loseLock(reason: string): void {
    if (!this.lockHeld) return;
    this.lockHeld = false;
    this.lockLostReason = reason;
    this.stopLockHeartbeat();
  }

  private async releaseLock(): Promise<void> {
    this.stopLockHeartbeat();
    // Wait for a heartbeat that is already in flight: releasing while one is
    // between its ownership check and its rename would put the lock file back.
    await this.lockBeatInFlight.catch(() => undefined);
    await rm(`${this.lockPath}.beat`, { force: true }).catch(() => undefined);
    if (!this.lockHeld) return;
    this.lockHeld = false;
    // Only ever remove a lock this process wrote: deleting somebody else's lock
    // would let a third writer in behind the current holder.
    try {
      const payload = JSON.parse(await readFile(this.lockPath, 'utf8')) as LockPayload;
      // Both the pid and this acquisition's token must match: a pid reused between
      // a crash and this release must not lose the lock it legitimately holds.
      if (payload.pid !== process.pid) return;
      if (this.lockToken && payload.token !== this.lockToken) return;
    } catch {
      // Missing or unreadable: nothing of ours to release.
      return;
    }
    await rm(this.lockPath, { force: true }).catch(() => undefined);
  }
}

/** In-memory store for tests; same semantics, no disk. */
export class MemoryAgentHostStore implements AgentHostStore {
  private records = new Map<string, LocalTaskRecord>();

  async load(): Promise<void> {
    // nothing to load
  }

  async list(): Promise<LocalTaskRecord[]> {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  async get(taskId: string): Promise<LocalTaskRecord | undefined> {
    const record = this.records.get(taskId);
    return record ? structuredClone(record) : undefined;
  }

  async put(record: LocalTaskRecord): Promise<LocalTaskRecord> {
    const previous = this.records.get(record.taskId);
    // Same rule as the file store: a stale snapshot must not resurrect finished
    // work, nor rewrite one finished outcome as another.
    if (
      previous &&
      TERMINAL_LOCAL_STATES.includes(previous.state) &&
      previous.state !== record.state
    ) {
      throw new Error(
        `terminal_state_protected: task ${record.taskId} is ${previous.state} and cannot be rewritten as ${record.state}`,
      );
    }
    const stored: LocalTaskRecord = {
      ...structuredClone(record),
      version: (previous?.version ?? 0) + 1,
    };
    this.records.set(stored.taskId, stored);
    return structuredClone(stored);
  }

  async compareAndSet(
    taskId: string,
    expectedVersion: number,
    next: LocalTaskRecord,
  ): Promise<LocalTaskRecord | undefined> {
    const current = this.records.get(taskId);
    if (!current || current.version !== expectedVersion) return undefined;
    const stored: LocalTaskRecord = { ...structuredClone(next), version: current.version + 1 };
    this.records.set(taskId, stored);
    return structuredClone(stored);
  }

  async createIfAbsent(record: LocalTaskRecord): Promise<LocalTaskRecord | undefined> {
    if (this.records.has(record.taskId)) return undefined;
    const stored: LocalTaskRecord = { ...structuredClone(record), version: 1 };
    this.records.set(record.taskId, stored);
    return structuredClone(stored);
  }

  async claim(taskId: string, holder: string, leaseMs: number): Promise<LocalTaskRecord | undefined> {
    const record = this.records.get(taskId);
    if (!record) return undefined;
    if (TERMINAL_LOCAL_STATES.includes(record.state) || record.state === 'interrupted') return undefined;
    const now = Date.now();
    const leaseActive = record.lease !== undefined && Date.parse(record.lease.expiresAt) > now;
    if (record.state === 'running' && leaseActive && record.lease?.holder !== holder) return undefined;
    if (record.state === 'running' && record.lease?.holder === holder) return structuredClone(record);
    if (record.state !== 'queued' && record.state !== 'running') return undefined;
    record.lease = { holder, expiresAt: new Date(now + leaseMs).toISOString() };
    record.version += 1;
    this.records.set(taskId, record);
    return structuredClone(record);
  }

  async release(taskId: string, holder: string): Promise<void> {
    const record = this.records.get(taskId);
    if (!record || record.lease?.holder !== holder) return;
    delete record.lease;
    record.version += 1;
    this.records.set(taskId, record);
  }

  async recoverInterrupted(): Promise<LocalTaskRecord[]> {
    const recovered: LocalTaskRecord[] = [];
    for (const record of this.records.values()) {
      if (record.state !== 'running') continue;
      const canRetry = record.attempts < record.maxAttempts && record.kind === 'document';
      record.state = canRetry ? 'queued' : 'interrupted';
      record.error = canRetry ? 'host_restart_retry' : 'host_restart_outcome_unknown';
      record.updatedAt = new Date().toISOString();
      record.version += 1;
      delete record.lease;
      recovered.push(structuredClone(record));
    }
    return recovered;
  }

  async flush(): Promise<void> {
    // nothing to flush
  }

  async close(): Promise<void> {
    // nothing to release
  }
}

// Persisted rows are normalized by `validatePersistedRow` (record-integrity.ts)
// while loading, which also reports every repair and quarantines what it cannot
// trust — a helper hidden in the store was too easy to bypass.

export function isTerminal(state: LocalTaskState): boolean {
  return TERMINAL_LOCAL_STATES.includes(state);
}
