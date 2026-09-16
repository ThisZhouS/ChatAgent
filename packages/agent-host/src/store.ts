import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
}

interface LockPayload {
  pid?: number;
  startedAt?: string;
}

/** A lock older than this is treated as abandoned even if the pid looks alive. */
const LOCK_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export class JsonFileAgentHostStore implements AgentHostStore {
  private records = new Map<string, LocalTaskRecord>();
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();
  private lockHeld = false;
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly lockEnabled: boolean;

  constructor(filePath: string, options: { lock?: boolean } = {}) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.lockEnabled = options.lock !== false;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await this.acquireLock();
    this.loaded = true;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const record of parsed as LocalTaskRecord[]) {
          if (record && typeof record.taskId === 'string') {
            this.records.set(record.taskId, normalizeRecord(record));
          }
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // A corrupt store must not be silently treated as empty: releasing the
        // lock keeps the app startable while the caller reports the failure.
        await this.releaseLock();
        throw error;
      }
    }
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
    const stored: LocalTaskRecord = {
      ...structuredClone(record),
      version: (previous?.version ?? 0) + 1,
    };
    this.records.set(stored.taskId, stored);
    await this.persist();
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
    this.records.set(taskId, stored);
    await this.persist();
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
    record.lease = { holder, expiresAt: new Date(now + leaseMs).toISOString() };
    record.version += 1;
    this.records.set(taskId, record);
    const claimed = structuredClone(record);
    await this.persist();
    return claimed;
  }

  async release(taskId: string, holder: string): Promise<void> {
    await this.load();
    const record = this.records.get(taskId);
    if (!record || record.lease?.holder !== holder) return;
    delete record.lease;
    record.version += 1;
    record.updatedAt = new Date().toISOString();
    this.records.set(taskId, record);
    await this.persist();
  }

  async recoverInterrupted(): Promise<LocalTaskRecord[]> {
    await this.load();
    const recovered: LocalTaskRecord[] = [];
    for (const record of this.records.values()) {
      if (record.state !== 'running') continue;
      const now = new Date().toISOString();
      // Never `succeeded`: the run was killed by a host restart and its outcome is
      // unknown. The task becomes recoverable (queued) or failed, with a reason.
      const canRetry = record.attempts < record.maxAttempts && record.kind === 'document';
      record.state = canRetry ? 'queued' : 'interrupted';
      record.error = canRetry ? 'host_restart_retry' : 'host_restart_outcome_unknown';
      record.summary = '主机重启：本次执行结果未知，未计为完成';
      record.finishedAt = canRetry ? undefined : now;
      record.updatedAt = now;
      record.version += 1;
      delete record.lease;
      this.records.set(record.taskId, record);
      recovered.push(structuredClone(record));
    }
    if (recovered.length > 0) await this.persist();
    return recovered;
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  async close(): Promise<void> {
    await this.flush();
    await this.releaseLock();
  }

  private async persist(): Promise<void> {
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
    let payload: LockPayload;
    try {
      payload = JSON.parse(await readFile(this.lockPath, 'utf8')) as LockPayload;
    } catch {
      return true; // unreadable or truncated lock: treat as abandoned
    }
    const startedAt = payload.startedAt ? Date.parse(payload.startedAt) : Number.NaN;
    if (!Number.isNaN(startedAt) && Date.now() - startedAt > LOCK_MAX_AGE_MS) return true;
    if (typeof payload.pid !== 'number' || !Number.isInteger(payload.pid) || payload.pid <= 0) return true;
    try {
      process.kill(payload.pid, 0);
      return false; // holder is alive (including another store in this process)
    } catch (error) {
      // ESRCH = no such process (safe to steal); EPERM = alive but not ours.
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }

  private async releaseLock(): Promise<void> {
    if (!this.lockHeld) return;
    this.lockHeld = false;
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

/** Records persisted before CAS existed start at version 1 instead of undefined. */
function normalizeRecord(record: LocalTaskRecord): LocalTaskRecord {
  return { ...record, version: typeof record.version === 'number' ? record.version : 1 };
}

export function isTerminal(state: LocalTaskState): boolean {
  return TERMINAL_LOCAL_STATES.includes(state);
}
