import type { TaskArtifact, TaskEvent, TaskRecord, TaskState } from '@chatagent/contracts';
import { TERMINAL_TASK_STATES } from '@chatagent/contracts';
import type {
  CancelResult,
  SubmitTaskInput,
  TaskContext,
  TaskEngineOptions,
  TaskHandler,
  TaskHandlerResult,
  TaskOutcome,
  TaskStore,
} from './types';

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}

export class TaskEngine {
  private readonly store: TaskStore;
  private readonly handler: TaskHandler;
  private readonly maxConcurrency: number;
  private readonly retryDelayMs: number;
  private readonly stopTimeoutMs: number;
  private readonly maxQueueDepth: number;
  private readonly listeners = new Set<(event: TaskEvent) => void>();
  private readonly eventLog = new Map<string, TaskEvent[]>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();
  /** Per-task serialization: a check-then-write must not interleave. */
  private readonly commitChains = new Map<string, Promise<void>>();
  private running = 0;
  private started = false;

  constructor(options: TaskEngineOptions) {
    this.store = options.store;
    this.handler = options.handler;
    this.maxConcurrency = options.maxConcurrency ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5000;
    this.maxQueueDepth = options.maxQueueDepth ?? 200;
  }

  async submit(input: SubmitTaskInput): Promise<TaskRecord> {
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: crypto.randomUUID(),
      accountId: input.accountId,
      conversationId: input.conversationId,
      organizationId: input.organizationId,
      requesterId: input.requesterId,
      goal: input.goal,
      state: 'pending',
      input: input.input ?? {},
      artifacts: [],
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 1,
      createdAt: now,
      updatedAt: now,
    };
    if (this.queue.length + this.running >= this.maxQueueDepth) {
      throw new Error('task queue is full, retry later');
    }
    await this.store.save(task);
    this.enqueue(task.id);
    this.emit({ taskId: task.id, type: 'queued', message: '任务已排队', at: now });
    if (!this.started) await this.start();
    void this.drain();
    return task;
  }

  /**
   * Picks up persisted work. Tasks left `pending` by a previous process are
   * re-queued; tasks left `running` are reset to `pending` once (crash
   * recovery). Full lease semantics are intentionally out of scope for this
   * gate; see docs/gate1-2-identity-task-integrity.md.
   */
  async start(): Promise<void> {
    this.started = true;
    const tasks = await this.store.list();
    for (const task of tasks) {
      if (task.state === 'pending') {
        this.enqueue(task.id);
        continue;
      }
      if (task.state === 'running') {
        await this.commit(task.id, { state: 'pending', startedAt: undefined });
        this.emit({
          taskId: task.id,
          type: 'progress',
          message: '恢复上次中断的任务',
          at: new Date().toISOString(),
        });
        this.enqueue(task.id);
      }
    }
    void this.drain();
  }

  /** Stops claiming work, aborts in-flight runs and waits for them to settle. */
  async stop(): Promise<void> {
    this.started = false;
    this.queue.length = 0;
    this.queued.clear();
    for (const controller of this.controllers.values()) controller.abort();
    const deadline = Date.now() + this.stopTimeoutMs;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        delay(50),
      ]);
    }
  }

  /** Queued + running tasks; used by the status endpoint. */
  get queueDepth(): number {
    return this.queue.length + this.running;
  }

  async get(id: string): Promise<TaskRecord | undefined> {
    return this.store.get(id);
  }

  async list(): Promise<TaskRecord[]> {
    return this.store.list();
  }

  getEvents(id: string): TaskEvent[] {
    return [...(this.eventLog.get(id) ?? [])];
  }

  async cancel(id: string): Promise<CancelResult> {
    const task = await this.store.get(id);
    if (!task) return { ok: false, reason: 'not_found' };
    if (isTerminalTaskState(task.state)) {
      return { ok: false, reason: 'already_finished', state: task.state };
    }

    this.controllers.get(id)?.abort();
    const committed = await this.commit(id, {
      state: 'cancelled',
      outcome: { status: 'cancelled', message: '任务已取消' },
      finishedAt: new Date().toISOString(),
    });
    if (!committed) {
      const latest = await this.store.get(id);
      return { ok: false, reason: 'already_finished', state: latest?.state };
    }

    this.emit({ taskId: id, type: 'cancelled', message: '任务已取消', at: new Date().toISOString() });
    return { ok: true, state: 'cancelled' };
  }

  /**
   * Re-queues a task that is blocked on an external condition (approval or
   * missing input). Terminal tasks are never revived.
   */
  async resume(id: string): Promise<CancelResult> {
    const task = await this.store.get(id);
    if (!task) return { ok: false, reason: 'not_found' };
    if (isTerminalTaskState(task.state)) {
      return { ok: false, reason: 'already_finished', state: task.state };
    }
    if (task.state === 'pending' || task.state === 'running') {
      return { ok: true, state: task.state };
    }

    const committed = await this.commit(id, { state: 'pending' });
    if (!committed) return { ok: false, reason: 'already_finished' };

    this.emit({
      taskId: id,
      type: 'progress',
      message: '前置条件已满足，任务继续执行',
      at: new Date().toISOString(),
    });
    this.enqueue(id);
    void this.drain();
    return { ok: true, state: 'pending' };
  }

  onEvent(listener: (event: TaskEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private enqueue(id: string): void {
    if (this.queued.has(id)) return;
    this.queued.add(id);
    this.queue.push(id);
  }

  private async drain(): Promise<void> {
    while (this.started && this.running < this.maxConcurrency && this.queue.length > 0) {
      const id = this.queue.shift();
      if (!id) continue;
      this.queued.delete(id);
      this.running += 1;
      const promise = this.run(id).finally(() => {
        this.running -= 1;
        this.inFlight.delete(promise);
        void this.drain();
      });
      this.inFlight.add(promise);
    }
  }

  private async run(id: string): Promise<void> {
    // The controller is registered *before* the (awaited) claim so a cancel
    // arriving during the claim window still aborts the run.
    const controller = new AbortController();
    this.controllers.set(id, controller);

    let claimed: TaskRecord | undefined;
    try {
      claimed = await this.claim(id);
    } finally {
      if (!claimed) this.controllers.delete(id);
    }
    if (!claimed) return;

    const latest = await this.store.get(id);
    if (controller.signal.aborted || !latest || latest.state !== 'running') {
      controller.abort();
      this.controllers.delete(id);
      return;
    }

    this.emit({ taskId: id, type: 'started', message: '任务开始执行', at: new Date().toISOString() });

    const context: TaskContext = {
      signal: controller.signal,
      emit: (event) => {
        this.emit({ taskId: id, ...event, at: new Date().toISOString() });
      },
      update: async (patch) => {
        await this.commit(id, patch);
      },
      appendArtifact: async (artifact: TaskArtifact) => {
        const current = await this.store.get(id);
        if (!current || isTerminalTaskState(current.state)) return;
        if (current.artifacts.some((item) => item.id === artifact.id)) return;
        await this.commit(id, { artifacts: [...current.artifacts, artifact] });
      },
    };

    try {
      const result = await this.handler(claimed, context);
      await this.settle(id, result);
    } catch (error) {
      await this.settleFailed(id, describeError(error), true);
    } finally {
      this.controllers.delete(id);
    }
  }

  /** pending -> running, guarded so a task is never claimed twice. */
  private async claim(id: string): Promise<TaskRecord | undefined> {
    let claimed: TaskRecord | undefined;
    await this.serialize(id, async () => {
      const task = await this.store.get(id);
      if (!task) return;
      if (task.state !== 'pending') return;

      const next: TaskRecord = {
        ...task,
        state: 'running',
        attempts: task.attempts + 1,
        startedAt: task.startedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await this.store.save(next);
      claimed = next;
    });
    return claimed;
  }

  private async settle(id: string, result: TaskHandlerResult): Promise<void> {
    const outcome = normalizeOutcome(result);
    const now = new Date().toISOString();

    switch (outcome.kind) {
      case 'completed': {
        const committed = await this.commit(id, {
          state: 'completed',
          result: outcome.result,
          outcome: { status: 'succeeded', message: outcome.result },
          error: undefined,
          finishedAt: now,
        });
        if (committed) {
          this.emit({ taskId: id, type: 'completed', message: '任务已完成', at: now });
        }
        return;
      }
      case 'cancelled': {
        const committed = await this.commit(id, {
          state: 'cancelled',
          outcome: { status: 'cancelled', message: outcome.reason },
          finishedAt: now,
        });
        if (committed) {
          this.emit({ taskId: id, type: 'cancelled', message: outcome.reason, at: now });
        }
        return;
      }
      case 'waiting_input': {
        const committed = await this.commit(id, {
          state: 'waiting_input',
          result: outcome.question,
          outcome: { status: 'waiting_input', message: outcome.question },
        });
        if (committed) {
          this.emit({
            taskId: id,
            type: 'waiting_input',
            message: outcome.question,
            at: now,
          });
        }
        return;
      }
      case 'waiting_approval': {
        const committed = await this.commit(id, {
          state: 'waiting_approval',
          result: outcome.approvalId,
          outcome: { status: 'waiting_approval', message: `待审批：${outcome.approvalId}` },
        });
        if (committed) {
          this.emit({
            taskId: id,
            type: 'waiting_approval',
            message: `等待审批 ${outcome.approvalId}`,
            at: now,
          });
        }
        return;
      }
      case 'incomplete': {
        const committed = await this.commit(id, {
          state: 'incomplete',
          result: outcome.message,
          outcome: { status: 'incomplete', code: outcome.reason, message: outcome.message },
          finishedAt: now,
        });
        if (committed) {
          this.emit({ taskId: id, type: 'incomplete', message: outcome.message, at: now });
        }
        return;
      }
      case 'failed': {
        await this.settleFailed(id, outcome.error, outcome.retryable !== false);
        return;
      }
    }
  }

  private async settleFailed(id: string, message: string, retryable: boolean): Promise<void> {
    const current = await this.store.get(id);
    if (!current || isTerminalTaskState(current.state)) return;

    if (retryable && current.attempts < current.maxAttempts) {
      const committed = await this.commit(id, { state: 'pending' });
      if (!committed) return;
      this.emit({
        taskId: id,
        type: 'progress',
        message: `执行失败，准备重试（${current.attempts}/${current.maxAttempts}）：${message}`,
        at: new Date().toISOString(),
      });
      await delay(this.retryDelayMs);
      this.enqueue(id);
      void this.drain();
      return;
    }

    const now = new Date().toISOString();
    const committed = await this.commit(id, {
      state: 'failed',
      error: message,
      outcome: { status: 'failed', message, retryable },
      finishedAt: now,
    });
    if (committed) {
      this.emit({ taskId: id, type: 'failed', message: `任务失败：${message}`, at: now });
    }
  }

  /**
   * Commit a patch unless the task already reached a terminal state. This is
   * the single writer for task state: a late handler result can never
   * overwrite `cancelled`/`completed`/`failed`/`incomplete`.
   */
  private async commit(id: string, patch: Partial<TaskRecord>): Promise<TaskRecord | undefined> {
    let result: TaskRecord | undefined;
    await this.serialize(id, async () => {
      const current = await this.store.get(id);
      if (!current) return;
      // Terminal records are immutable: a late writer can never rewrite the
      // result, artifacts or outcome of a cancelled/completed/failed task.
      if (isTerminalTaskState(current.state)) return;

      const updated: TaskRecord = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      await this.store.save(updated);
      result = updated;
    });
    return result;
  }

  /**
   * Runs `work` exclusively for one task id. Without this, cancel() and a late
   * handler result can both read the pre-cancel record and both write.
   */
  private async serialize(id: string, work: () => Promise<void>): Promise<void> {
    const previous = this.commitChains.get(id) ?? Promise.resolve();
    const next = previous.then(work).catch(() => undefined);
    this.commitChains.set(id, next);
    await next;
    if (this.commitChains.get(id) === next) this.commitChains.delete(id);
  }

  /** Per-task SSE replay buffer; bounded so long runs cannot grow forever. */
  private readonly maxEventsPerTask = 500;

  private emit(event: TaskEvent): void {
    const log = this.eventLog.get(event.taskId) ?? [];
    log.push(event);
    if (log.length > this.maxEventsPerTask) {
      log.splice(0, log.length - this.maxEventsPerTask);
    }
    this.eventLog.set(event.taskId, log);
    for (const listener of this.listeners) listener(event);
  }
}

function normalizeOutcome(result: TaskHandlerResult): TaskOutcome {
  if (typeof result === 'string') {
    return { kind: 'completed', result };
  }
  return result;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'unknown error';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { TaskState };
