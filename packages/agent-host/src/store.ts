import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { StoreLoadReport } from './record-integrity';
import { validatePersistedRow } from './record-integrity';
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
}

interface LockPayload {
  pid?: number;
  startedAt?: string;
}

/** A live holder keeps its lock; only a lock this old may be taken over by pid reuse. */
const LOCK_PID_REUSE_MS = 30 * 24 * 60 * 60 * 1000;

export class JsonFileAgentHostStore implements AgentHostStore {
  private records = new Map<string, LocalTaskRecord>();
  private loadPromise?: Promise<void>;
  private loaded = false;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();
  private lockHeld = false;
  private loadReport?: StoreLoadReport;
  private lastLoadError?: string;
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly lockEnabled: boolean;

  constructor(filePath: string, options: { lock?: boolean } = {}) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.lockEnabled = options.lock !== false;
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
    try {
      await this.persist();
    } catch (error) {
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
    const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await writeFile(this.lockPath, payload, { encoding: 'utf8', flag: 'wx' });
        this.lockHeld = true;
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

  private async isLockStale(): Promise<boolean> {
    let raw: string;
    try {
      raw = await readFile(this.lockPath, 'utf8');
    } catch {
      return true; // no lock file left: nothing to take over
    }
    let payload: LockPayload;
    try {
      payload = JSON.parse(raw) as LockPayload;
    } catch {
      // A truncated lock (crash while writing) may still name a live holder, so
      // salvage the pid before calling it abandoned.
      const salvaged = /"pid"\s*:\s*(\d+)/.exec(raw);
      payload = salvaged ? { pid: Number(salvaged[1]) } : {};
    }
    const pid = payload.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return true; // owner unknown
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      // ESRCH = no such process (safe to steal); EPERM = alive but not ours.
      alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
    if (!alive) return true;
    // Liveness comes first: the desktop host is designed to stay resident for
    // days, so age alone must never hand a live holder's lock to a second writer.
    // The age rule only covers pid reuse on a lock nobody has refreshed for a month.
    const startedAt = payload.startedAt ? Date.parse(payload.startedAt) : Number.NaN;
    return !Number.isNaN(startedAt) && Date.now() - startedAt > LOCK_PID_REUSE_MS;
  }

  private async releaseLock(): Promise<void> {
    if (!this.lockHeld) return;
    this.lockHeld = false;
    // Only ever remove a lock this process wrote: deleting somebody else's lock
    // would let a third writer in behind the current holder.
    try {
      const payload = JSON.parse(await readFile(this.lockPath, 'utf8')) as LockPayload;
      if (payload.pid !== process.pid) return;
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
