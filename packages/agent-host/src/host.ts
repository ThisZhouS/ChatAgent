import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { HermesAdapter } from './adapter';
import { computeActionDigest, TrustedAuthorizationRegistry } from './authorization';
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
  /**
   * Registry of verified delegations/approvals. Defaults to an empty registry,
   * which means every side-effect task is blocked until trusted code registers a
   * grant — fail closed, never "trust the caller".
   */
  authorizations?: TrustedAuthorizationRegistry;
  /** Why a fake executor is in use; surfaced in status so it is never passed off as real. */
  executorReason?: string;
  maxConcurrency?: number;
  leaseMs?: number;
  defaultTimeoutMs?: number;
  /** How long `stop()` waits for in-flight runs before forcing a cancelled state. */
  stopTimeoutMs?: number;
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
 * - idempotent submission: an existing taskId is never executed a second time;
 * - authorization: side effects need a delegation and an approval *held by the
 *   host*, bound to the exact action digest, and re-checked right before the run;
 * - terminal honesty: a run that failed, timed out, was cancelled or was cut off
 *   by a host restart is never reported as succeeded, and a late result cannot
 *   overwrite a terminal state (compare-and-set on every write);
 * - work directory: every task directory must live inside the configured root.
 */
export class LocalAgentHost {
  private running = false;
  private paused = false;
  private stopped = false;
  private lastError?: string;
  private lateResultsDropped = 0;
  private closed = false;
  private readonly active = new Map<string, AbortController>();
  private readonly authorizations: TrustedAuthorizationRegistry;
  private dispatcher?: NodeJS.Timeout;
  private readonly now: () => number;

  constructor(private readonly options: LocalAgentHostOptions) {
    this.now = options.now ?? (() => Date.now());
    this.authorizations = options.authorizations ?? new TrustedAuthorizationRegistry();
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

  /** Trusted registry used by the desktop main process to register grants. */
  get authorizationRegistry(): TrustedAuthorizationRegistry {
    return this.authorizations;
  }

  /** Starts the host: recovers interrupted work, then keeps dispatching. */
  async start(): Promise<void> {
    if (this.running || this.closed) return;
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

  /**
   * Stops the host and cancels in-flight runs. In-flight tasks are not "succeeded".
   * Waits (bounded) for the executors to observe the abort before forcing a
   * cancelled state, so a stop never leaves an unmanaged running task behind.
   */
  async stop(reason = 'host_stopped'): Promise<void> {
    this.stopped = true;
    this.running = false;
    if (this.dispatcher) clearInterval(this.dispatcher);
    this.dispatcher = undefined;

    for (const controller of this.active.values()) controller.abort();

    const deadline = this.now() + (this.options.stopTimeoutMs ?? 3_000);
    while (this.active.size > 0 && this.now() < deadline) {
      await delay(20);
    }

    for (const taskId of [...this.active.keys()]) {
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

  /** Stops the host and releases the store's single-writer lock. */
  async close(reason = 'host_closed'): Promise<void> {
    await this.stop(reason);
    this.closed = true;
    await this.options.store.close();
  }

  /**
   * A closed host released the store lock, so it must not accept work any more:
   * writing after close() would clobber whoever holds the lock now.
   */
  private assertOpen(operation: string): void {
    if (this.closed) {
      throw new Error(`host_closed: the agent host is closed and refuses ${operation}`);
    }
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
      lateResultsDropped: this.lateResultsDropped,
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
   * Accepts a task.
   *
   * Idempotent by taskId: if the id already exists (queued, running or finished)
   * the stored record is returned untouched, so a repeated submit — from a retry
   * loop, a double click or a replayed IPC message — can never run a completed
   * task again. Re-running is an explicit `retry()`.
   *
   * Authorization problems do not throw: the task is recorded with a block reason
   * so the UI can explain why nothing ran.
   */
  async submit(input: LocalTaskInput): Promise<LocalTaskRecord> {
    this.assertOpen('submit');
    const existing = await this.options.store.get(input.taskId);
    if (existing) return this.replayOrConflict(existing, input);

    const timestamp = new Date(this.now()).toISOString();
    const toolsets = input.toolsets.length > 0 ? input.toolsets : ['document'];
    const agentId = input.agentId || this.options.agentId;
    const actionDigest = computeActionDigest({
      taskId: input.taskId,
      agentId,
      kind: input.kind,
      goal: input.goal,
      toolsets,
    });

    const record: LocalTaskRecord = {
      taskId: input.taskId,
      deviceId: this.options.deviceId,
      agentId,
      goal: input.goal,
      kind: input.kind,
      state: 'queued',
      version: 0, // the store assigns the first real version on write
      workDir: input.workDir,
      toolsets,
      artifacts: [],
      attempts: 0,
      maxAttempts: input.kind === 'side_effect' ? 1 : 2,
      delegationId: input.delegationId,
      approvalId: input.approvalId,
      actionDigest,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const decision = this.authorizations.authorize(
      {
        kind: input.kind,
        delegationId: input.delegationId,
        approvalId: input.approvalId,
        capabilities: toolsets,
        actionDigest,
      },
      { deviceId: this.options.deviceId, agentId: this.options.agentId, now: this.now() },
    );
    // Capability floor: `document` is the no-side-effect kind, so it may only ask
    // for local document toolsets. Without this a caller could label an
    // external-effect toolset (web/terminal/… or the `*` wildcard) as a document
    // task and skip delegation/approval entirely.
    const refused = refuseCapabilities(input.kind, toolsets);

    if (refused) {
      record.state = 'failed';
      record.blockedReason = refused;
      record.error = refused;
      record.summary = `未执行：${describeBlock(refused)}`;
      record.finishedAt = timestamp;
    } else if (!decision.ok) {
      record.state = 'failed';
      record.blockedReason = decision.reason;
      record.error = decision.reason;
      record.summary = `未执行：${describeBlock(decision.reason)}`;
      record.finishedAt = timestamp;
    } else {
      record.delegation = decision.delegation;
      record.approval = decision.approval;
      try {
        record.workDir = await ensureTaskWorkDir(this.workRoot, input.taskId);
      } catch (error) {
        record.state = 'failed';
        record.error = 'workroot_refused';
        record.summary = error instanceof Error ? error.message : 'working directory refused';
        record.finishedAt = timestamp;
      }
    }

    let stored: LocalTaskRecord | undefined;
    try {
      // Create-if-absent, so two concurrent submits of one id cannot both win.
      stored = this.options.store.createIfAbsent
        ? await this.options.store.createIfAbsent(record)
        : await this.options.store.put(record);
    } catch (error) {
      // H-03: a task that could not be written to disk is never acknowledged as
      // accepted — the caller must see the failure instead of a phantom task.
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = `store_write_failed: ${message}`;
      throw new Error(`task store write failed: ${message}`);
    }
    if (!stored) {
      // Somebody else created this id between the read and the write: fall back to
      // the idempotency rule against the record that actually won.
      const winner = await this.options.store.get(input.taskId);
      if (!winner) throw new Error(`task store write failed: ${input.taskId} disappeared`);
      return this.replayOrConflict(winner, input);
    }
    void this.tick();
    return stored;
  }

  /**
   * Idempotency rule for a taskId that already exists: the same request is
   * replayed unchanged, a different payload is rejected. Records written before
   * the digest existed are compared by recomputing it from what was stored, so an
   * old row never becomes a permanent free pass.
   */
  private replayOrConflict(existing: LocalTaskRecord, input: LocalTaskInput): LocalTaskRecord {
    const incomingDigest = computeActionDigest({
      taskId: input.taskId,
      agentId: input.agentId || this.options.agentId,
      kind: input.kind,
      goal: input.goal,
      toolsets: input.toolsets.length > 0 ? input.toolsets : ['document'],
    });
    const storedDigest =
      existing.actionDigest ??
      computeActionDigest({
        taskId: existing.taskId,
        agentId: existing.agentId,
        kind: existing.kind,
        goal: existing.goal,
        toolsets: existing.toolsets,
      });
    if (storedDigest !== incomingDigest) {
      throw new Error(
        `idempotency_conflict: task ${input.taskId} already exists with a different payload`,
      );
    }
    return existing;
  }

  /**
   * Re-queues a failed/interrupted local document task. Side effects are excluded:
   * they need a fresh approval, which means a new submit with a new approval id.
   */
  async retry(taskId: string): Promise<LocalTaskRecord | undefined> {
    this.assertOpen('retry');
    const record = await this.options.store.get(taskId);
    if (!record) return undefined;
    if (record.state !== 'failed' && record.state !== 'interrupted') return undefined;
    if (record.kind === 'side_effect') return undefined;
    if (record.attempts >= record.maxAttempts) return undefined;

    const timestamp = new Date(this.now()).toISOString();
    const stored = await this.options.store.compareAndSet(taskId, record.version, {
      ...record,
      state: 'queued',
      blockedReason: undefined,
      error: undefined,
      summary: '人工重试：已重新排队',
      finishedAt: undefined,
      lease: undefined,
      updatedAt: timestamp,
    });
    if (stored) void this.tick();
    return stored;
  }

  /**
   * Cancels a queued or running task.
   *
   * For a running task the terminal state is written *immediately* (after the
   * abort signal), so the outcome is cancelled even if the executor is slow to
   * die: whatever it reports afterwards is dropped by the compare-and-set guard.
   */
  async cancel(taskId: string): Promise<boolean> {
    this.assertOpen('cancel');
    const record = await this.options.store.get(taskId);
    if (!record || isTerminal(record.state)) return false;
    const controller = this.active.get(taskId);
    if (controller) {
      controller.abort();
      await this.finish(record, 'cancelled', {
        error: 'cancelled_by_user',
        summary: '任务已取消：执行器已收到停止信号',
      });
      return true;
    }
    await this.finish(record, 'cancelled', { error: 'cancelled_before_start', summary: '任务在执行前被取消' });
    return true;
  }

  /** One dispatch pass: claim, authorize, run. Exposed for tests. */
  async tick(): Promise<void> {
    // Every call site is `void this.tick()`: an escaping rejection would be an
    // unhandled rejection, which on Node ends the process.
    try {
      await this.dispatch();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private async dispatch(): Promise<void> {
    if (!this.running || this.paused || this.stopped) return;
    const maxConcurrency = this.options.maxConcurrency ?? 1;
    if (this.active.size >= maxConcurrency) return;

    const tasks = await this.options.store.list();
    for (const candidate of tasks) {
      if (candidate.state !== 'queued') continue;
      if (this.active.size >= maxConcurrency) return;
      const holder = `${this.options.deviceId}:${process.pid}`;
      let claimed: LocalTaskRecord | undefined;
      try {
        claimed = await this.options.store.claim(candidate.taskId, holder, this.options.leaseMs ?? 60_000);
      } catch (error) {
        // A store failure must not kill the dispatcher; it is surfaced in status.
        this.lastError = error instanceof Error ? error.message : String(error);
        continue;
      }
      if (!claimed) continue; // somebody else owns it
      void this.execute(claimed, holder);
    }
  }

  private async execute(record: LocalTaskRecord, holder: string): Promise<void> {
    const runId = randomUUID();
    const timeoutMs = this.options.defaultTimeoutMs ?? 120_000;

    // H-02: authorization is re-evaluated immediately before the run starts, so a
    // delegation revoked (or an approval expired) after submit cannot execute.
    const recheck = this.authorizations.authorize(
      {
        kind: record.kind,
        delegationId: record.delegationId,
        approvalId: record.approvalId,
        capabilities: record.toolsets,
        actionDigest: record.actionDigest ?? '',
      },
      { deviceId: this.options.deviceId, agentId: this.options.agentId, now: this.now() },
    );
    if (!recheck.ok) {
      await this.finish(record, 'failed', {
        blockedReason: recheck.reason,
        error: recheck.reason,
        summary: `执行前复核未通过：${describeBlock(recheck.reason)}`,
      });
      await this.options.store.release(record.taskId, holder);
      return;
    }

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
      summary: undefined,
      artifacts: [],
    };
    const started = await this.options.store.compareAndSet(record.taskId, record.version, running);
    if (!started) {
      // Somebody cancelled or re-queued the task between claim and start.
      this.active.delete(record.taskId);
      await this.options.store.release(record.taskId, holder);
      return;
    }

    // An approval authorizes exactly one execution: consume it as the run really
    // starts, so a queued duplicate or a manual replay cannot reuse it.
    if (record.kind === 'side_effect' && record.approvalId) {
      this.authorizations.consumeApproval(record.approvalId);
    }

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
      const state: LocalTaskState =
        result.failure === undefined
          ? 'succeeded'
          : result.failure.kind === 'cancelled'
            ? 'cancelled'
            : 'failed';
      const latest = await this.options.store.get(record.taskId);
      await this.finish(
        latest ?? started,
        state,
        {
          executor: result.executor,
          runId,
          artifacts: result.artifacts,
          exitCode: result.exitCode,
          summary: result.output.slice(0, 500) || summarize(result),
          error: result.failure?.message,
        },
        result.failure?.kind === 'timeout' && (latest?.attempts ?? 1) < (latest?.maxAttempts ?? 1)
          ? 'retry'
          : undefined,
      );
    } catch (error) {
      const latest = await this.options.store.get(record.taskId);
      this.lastError = error instanceof Error ? error.message : String(error);
      await this.finish(latest ?? started, 'failed', { error: this.lastError, summary: '执行器异常' });
    } finally {
      this.active.delete(record.taskId);
      await this.options.store.release(record.taskId, holder).catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error);
      });
      void this.tick();
    }
  }

  /**
   * Applies a final state with compare-and-set.
   *
   * A result that arrives after the task already reached a terminal state (it was
   * cancelled, or the host stopped) is discarded instead of overwriting it, and
   * the version check makes the same true when two writers race.
   */
  private async finish(
    record: LocalTaskRecord,
    state: LocalTaskState,
    patch: Partial<LocalTaskRecord>,
    retry?: 'retry',
  ): Promise<void> {
    const current = await this.options.store.get(record.taskId);
    if (!current) return;
    if (isTerminal(current.state)) {
      this.lateResultsDropped += 1;
      return;
    }
    const timestamp = new Date(this.now()).toISOString();
    const next: LocalTaskRecord = {
      ...current,
      ...patch,
      state,
      updatedAt: timestamp,
    };
    if (state === 'succeeded' || state === 'failed' || state === 'cancelled') {
      next.finishedAt = timestamp;
      delete next.lease;
    }
    if (retry === 'retry') {
      next.state = 'queued';
      next.finishedAt = undefined;
      next.error = 'timeout_retry';
      next.summary = '执行超时，已重新排队';
    }
    const applied = await this.options.store.compareAndSet(record.taskId, current.version, next);
    if (!applied) this.lateResultsDropped += 1;
  }

  /** Verifies a directory before use; the desktop layer calls this on user input. */
  async assertWorkDir(candidate: string): Promise<string> {
    return assertInsideWorkRoot(this.workRoot, candidate);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Toolsets a `document` task may use. The kind is the host's own claim that a task
 * has no external effect, so it only ever gets local document tools — everything
 * else (messaging, web, terminal, code execution, the `*` wildcard) is either a
 * side effect that needs a delegation + approval, or is refused outright.
 */
const DOCUMENT_TOOLSETS = new Set(['document', 'document.read']);
const FORBIDDEN_TOOLSETS = new Set([
  '*',
  'terminal',
  'code_execution',
  'node',
  'python',
  'shell',
  'custom',
]);

/**
 * Returns the block reason when the requested capabilities may not run for this
 * kind, or undefined when they may. Fail closed: an unknown toolset is not a
 * document toolset.
 */
export function refuseCapabilities(
  kind: LocalTaskRecord['kind'],
  toolsets: string[],
): BlockReason | undefined {
  const forbidden = toolsets.find((toolset) => FORBIDDEN_TOOLSETS.has(toolset));
  if (forbidden) return 'capability_not_granted';
  if (kind !== 'document') return undefined; // side effects are gated by delegation
  const unknown = toolsets.find((toolset) => !DOCUMENT_TOOLSETS.has(toolset));
  return unknown ? 'capability_not_granted' : undefined;
}

function describeBlock(reason: BlockReason): string {
  switch (reason) {
    case 'delegation_missing':
      return '缺少有效的设备委托';
    case 'delegation_unknown':
      return '委托无法核验（未登记、已撤销或不属于本设备）';
    case 'delegation_expired':
      return '委托已过期，需要重新授权';
    case 'agent_mismatch':
      return '委托不属于当前 Agent 身份';
    case 'capability_not_granted':
      return '委托未包含所需能力';
    case 'approval_missing':
      return '外部副作用需要审批，当前没有审批记录';
    case 'approval_unknown':
      return '审批无法核验（未登记、已撤销或与委托不匹配）';
    case 'approval_not_approved':
      return '审批尚未批准，宿主不会自行批准';
    case 'approval_expired':
      return '审批已过期，需要重新审批';
    case 'approval_digest_mismatch':
      return '审批与当前任务内容不一致，需要重新审批';
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
