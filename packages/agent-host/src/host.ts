import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { HermesAdapter } from './adapter';
import { assertInsideWorkRoot, ensureTaskWorkDir } from './sandbox';
import type { AgentHostStore } from './store';
import { isTerminal } from './store';
import type {
  BlockReason,
  HostStatus,
  LocalTaskInput,
  LocalTaskRecord,
  LocalTaskState,
} from './types';

export interface LocalAgentHostOptions {
  deviceId: string;
  agentId: string;
  /** Only directories below this root may be used as task working directories. */
  workRoot: string;
  store: AgentHostStore;
  adapter: HermesAdapter;
  /** Why a fake executor is in use; surfaced in status so it is never passed off as real. */
  executorReason?: string;
  maxConcurrency?: number;
  leaseMs?: number;
  defaultTimeoutMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/**
 * On-device agent host.
 *
 * Lifecycle is independent from the window: start/stop/pause/resume/submit/cancel
 * can be driven from the desktop main process, from a headless node process, or
 * from tests, and the store keeps every transition.
 *
 * Guarantees enforced here (not by convention):
 * - one dispatcher: a task is executed only by the holder of its lease;
 * - authorization: side effects need a valid delegation and an already-approved
 *   approval reference, and the host never approves anything itself;
 * - terminal honesty: a run that failed, timed out, was cancelled or was cut off
 *   by a host restart is never reported as succeeded;
 * - work directory: every task directory must live inside the configured root.
 */
export class LocalAgentHost {
  private running = false;
  private paused = false;
  private stopped = false;
  private lastError?: string;
  private readonly active = new Map<string, AbortController>();
  private dispatcher?: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly options: LocalAgentHostOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  get workRoot(): string {
    return this.options.workRoot;
  }

  get agentId(): string {
    return this.options.agentId;
  }

  get deviceId(): string {
    return this.options.deviceId;
  }

  /** Starts the host: recovers interrupted work, then keeps dispatching. */
  async start(): Promise<void> {
    if (this.running) return;
    await mkdir(this.options.workRoot, { recursive: true });
    await this.options.store.load();
    await this.options.store.recoverInterrupted();
    this.running = true;
    this.stopped = false;
    this.paused = false;
    this.dispatcher = setInterval(() => {
      void this.tick();
    }, 50);
    this.dispatcher.unref?.();
  }

  /** Stops the host and cancels in-flight runs. In-flight tasks are not "succeeded". */
  async stop(reason = 'host_stopped'): Promise<void> {
    this.stopped = true;
    this.running = false;
    if (this.dispatcher) clearInterval(this.dispatcher);
    this.dispatcher = undefined;
    for (const [taskId, controller] of this.active) {
      controller.abort();
      this.active.delete(taskId);
      const record = await this.options.store.get(taskId);
      if (record && !isTerminal(record.state)) {
        await this.finish(record, 'cancelled', {
          error: reason,
          summary: '主机停止：本次执行已取消',
        });
      }
    }
    await this.options.store.flush();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    void this.tick();
  }

  async status(): Promise<HostStatus> {
    const tasks = await this.options.store.list();
    return {
      deviceId: this.options.deviceId,
      agentId: this.options.agentId,
      running: this.running,
      paused: this.paused,
      executor: this.options.adapter.kind,
      executorReason: this.options.adapter.kind === 'fake' ? this.options.executorReason : undefined,
      workRoot: this.options.workRoot,
      queued: tasks.filter((task) => task.state === 'queued').length,
      runningTasks: tasks.filter((task) => task.state === 'running').length,
      finished: tasks.filter((task) => isTerminal(task.state)).length,
      lastError: this.lastError,
    };
  }

  async list(): Promise<LocalTaskRecord[]> {
    return this.options.store.list();
  }

  async get(taskId: string): Promise<LocalTaskRecord | undefined> {
    return this.options.store.get(taskId);
  }

  /**
   * Accepts a task. Authorization problems do not throw: the task is recorded with
   * a block reason so the UI can explain why nothing ran.
   */
  async submit(input: LocalTaskInput): Promise<LocalTaskRecord> {
    const timestamp = new Date(this.now()).toISOString();
    const record: LocalTaskRecord = {
      taskId: input.taskId,
      deviceId: this.options.deviceId,
      agentId: input.agentId || this.options.agentId,
      goal: input.goal,
      kind: input.kind,
      state: 'queued',
      workDir: input.workDir,
      toolsets: input.toolsets.length > 0 ? input.toolsets : ['document'],
      artifacts: [],
      attempts: 0,
      maxAttempts: input.kind === 'side_effect' ? 1 : 2,
      delegation: input.delegation,
      approval: input.approval,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const blocked = await this.authorizationBlock(input);
    if (blocked) {
      record.state = 'failed';
      record.blockedReason = blocked;
      record.error = blocked;
      record.summary = `未执行：${describeBlock(blocked)}`;
      record.finishedAt = timestamp;
    } else {
      try {
        record.workDir = await ensureTaskWorkDir(this.workRoot, input.taskId);
      } catch (error) {
        record.state = 'failed';
        record.error = 'workroot_refused';
        record.summary = error instanceof Error ? error.message : 'working directory refused';
        record.finishedAt = timestamp;
      }
    }

    await this.options.store.put(record);
    void this.tick();
    return record;
  }

  /** Cancels a queued or running task. */
  async cancel(taskId: string): Promise<boolean> {
    const record = await this.options.store.get(taskId);
    if (!record || isTerminal(record.state)) return false;
    const controller = this.active.get(taskId);
    if (controller) {
      controller.abort();
      return true;
    }
    await this.finish(record, 'cancelled', { error: 'cancelled_before_start', summary: '任务在执行前被取消' });
    return true;
  }

  /** One dispatch pass: claim, authorize, run. Exposed for tests. */
  async tick(): Promise<void> {
    if (!this.running || this.paused || this.stopped) return;
    const maxConcurrency = this.options.maxConcurrency ?? 1;
    if (this.active.size >= maxConcurrency) return;

    const tasks = await this.options.store.list();
    for (const candidate of tasks) {
      if (candidate.state !== 'queued') continue;
      if (this.active.size >= maxConcurrency) return;
      const holder = `${this.options.deviceId}:${process.pid}`;
      const claimed = await this.options.store.claim(candidate.taskId, holder, this.options.leaseMs ?? 60_000);
      if (!claimed) continue; // somebody else owns it
      void this.execute(claimed, holder);
    }
  }

  private async execute(record: LocalTaskRecord, holder: string): Promise<void> {
    const runId = randomUUID();
    const timeoutMs = this.options.defaultTimeoutMs ?? 120_000;
    const controller = new AbortController();
    this.active.set(record.taskId, controller);

    const startedAt = new Date(this.now()).toISOString();
    const running: LocalTaskRecord = {
      ...record,
      state: 'running',
      runId,
      attempts: record.attempts + 1,
      startedAt,
      updatedAt: startedAt,
      error: undefined,
      blockedReason: undefined,
    };
    await this.options.store.put(running);

    try {
      const result = await this.options.adapter.run({
        taskId: record.taskId,
        runId,
        goal: record.goal,
        workDir: record.workDir,
        toolsets: record.toolsets,
        timeoutMs,
        signal: controller.signal,
      });
      const latest = (await this.options.store.get(record.taskId)) ?? running;
      const state: LocalTaskState =
        result.failure === undefined
          ? 'succeeded'
          : result.failure.kind === 'cancelled'
            ? 'cancelled'
            : 'failed';
      await this.finish(
        latest,
        state,
        {
          executor: result.executor,
          runId,
          artifacts: result.artifacts,
          exitCode: result.exitCode,
          summary: result.output.slice(0, 500) || summarize(result),
          error: result.failure?.message,
        },
        result.failure?.kind === 'timeout' && latest.attempts < latest.maxAttempts ? 'retry' : undefined,
      );
    } catch (error) {
      const latest = (await this.options.store.get(record.taskId)) ?? running;
      this.lastError = error instanceof Error ? error.message : String(error);
      await this.finish(latest, 'failed', { error: this.lastError, summary: '执行器异常' });
    } finally {
      this.active.delete(record.taskId);
      await this.options.store.release(record.taskId, holder);
      void this.tick();
    }
  }

  private async finish(
    record: LocalTaskRecord,
    state: LocalTaskState,
    patch: Partial<LocalTaskRecord>,
    retry?: 'retry',
  ): Promise<void> {
    const timestamp = new Date(this.now()).toISOString();
    const next: LocalTaskRecord = {
      ...record,
      ...patch,
      state,
      updatedAt: timestamp,
    };
    if (state === 'succeeded' || state === 'failed' || state === 'cancelled') {
      next.finishedAt = timestamp;
    }
    if (retry === 'retry') {
      next.state = 'queued';
      next.finishedAt = undefined;
      next.error = 'timeout_retry';
      next.summary = '执行超时，已重新排队';
    }
    await this.options.store.put(next);
  }

  /** Authorization gate for a task; returns the reason it must not run. */
  private async authorizationBlock(input: LocalTaskInput): Promise<BlockReason | undefined> {
    if (input.kind === 'document') return undefined;

    const delegation = input.delegation;
    if (!delegation || delegation.ownerId === '' || delegation.agentId === '') {
      return 'delegation_missing';
    }
    if (delegation.deviceId !== this.options.deviceId) return 'delegation_missing';
    if (Date.parse(delegation.expiresAt) <= this.now()) return 'delegation_expired';

    const approval = input.approval;
    if (!approval) return 'approval_missing';
    if (!approval.approved) return 'approval_not_approved';
    if (Date.parse(approval.expiresAt) <= this.now()) return 'approval_expired';
    return undefined;
  }

  /** Verifies a directory before use; the desktop layer calls this on user input. */
  async assertWorkDir(candidate: string): Promise<string> {
    return assertInsideWorkRoot(this.workRoot, candidate);
  }
}

function describeBlock(reason: BlockReason): string {
  switch (reason) {
    case 'delegation_missing':
      return '缺少有效的设备委托';
    case 'delegation_expired':
      return '委托已过期，需要重新授权';
    case 'approval_missing':
      return '外部副作用需要审批，当前没有审批记录';
    case 'approval_not_approved':
      return '审批尚未批准，宿主不会自行批准';
    case 'approval_expired':
      return '审批已过期，需要重新审批';
    case 'host_paused':
      return '后台 Agent 已暂停';
    case 'host_stopped':
      return '后台 Agent 已停止';
    case 'work_root_missing':
      return '授权工作目录不存在';
    default:
      return String(reason);
  }
}

function summarize(result: { artifacts: Array<{ name: string }>; output: string }): string {
  if (result.artifacts.length > 0) {
    return `产出 ${result.artifacts.map((artifact) => artifact.name).join('、')}`;
  }
  return result.output.slice(0, 200);
}
