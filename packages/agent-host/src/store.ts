import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LocalTaskRecord, LocalTaskState } from './types';
import { TERMINAL_LOCAL_STATES } from './types';

/**
 * Durable task store for the local host.
 *
 * It is intentionally a plain JSON file: the PoC must run without a database, and
 * the ChatAgent TaskEngine stays the business ledger. What matters here is that
 * (a) state survives a host restart and (b) exactly one holder may run a task,
 * which is enforced by a compare-and-set claim rather than by convention.
 */
export interface AgentHostStore {
  load(): Promise<void>;
  list(): Promise<LocalTaskRecord[]>;
  get(taskId: string): Promise<LocalTaskRecord | undefined>;
  put(record: LocalTaskRecord): Promise<void>;
  /**
   * Claims the task for `holder` when it is queued (or when the previous lease
   * expired). Returns the claimed record, or undefined when somebody else owns it.
   */
  claim(taskId: string, holder: string, leaseMs: number): Promise<LocalTaskRecord | undefined>;
  release(taskId: string, holder: string): Promise<void>;
  /** Marks tasks left `running` by a previous host process. */
  recoverInterrupted(): Promise<LocalTaskRecord[]>;
  flush(): Promise<void>;
}

export class JsonFileAgentHostStore implements AgentHostStore {
  private records = new Map<string, LocalTaskRecord>();
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const record of parsed as LocalTaskRecord[]) {
          if (record && typeof record.taskId === 'string') this.records.set(record.taskId, record);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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

  async put(record: LocalTaskRecord): Promise<void> {
    await this.load();
    this.records.set(record.taskId, structuredClone(record));
    await this.persist();
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

    // Compare-and-set: the write happens without awaiting anything in between.
    record.lease = { holder, expiresAt: new Date(now + leaseMs).toISOString() };
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

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify([...this.records.values()], null, 2);
    this.queue = this.queue
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        const tmp = join(dirname(this.filePath), `.${Date.now()}.tmp`);
        await writeFile(tmp, snapshot, 'utf8');
        await rename(tmp, this.filePath);
      })
      .catch(() => undefined);
    await this.queue;
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

  async put(record: LocalTaskRecord): Promise<void> {
    this.records.set(record.taskId, structuredClone(record));
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
    this.records.set(taskId, record);
    return structuredClone(record);
  }

  async release(taskId: string, holder: string): Promise<void> {
    const record = this.records.get(taskId);
    if (!record || record.lease?.holder !== holder) return;
    delete record.lease;
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
      delete record.lease;
      recovered.push(structuredClone(record));
    }
    return recovered;
  }

  async flush(): Promise<void> {
    // nothing to flush
  }
}

export function isTerminal(state: LocalTaskState): boolean {
  return TERMINAL_LOCAL_STATES.includes(state);
}
