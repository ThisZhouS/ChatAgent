/**
 * Message intake gate.
 *
 * The product rule (see Prompt/2026-09-17-product-decomposition.md) is that a message
 * is handed to an agent only after the recall window has elapsed: a sender who
 * withdraws a message inside the window must not have it read, quoted or acted on.
 * This module owns that rule in code - there is deliberately no API parameter, tool or
 * prompt that can hand a message to an agent earlier, and a recall removes a pending
 * handoff before the agent ever sees it.
 *
 * The queue is persisted, so a restart neither drops a request nor replays one that was
 * already submitted (a submitted handoff is terminal, even across restarts).
 */
import crypto from 'node:crypto';
import type { ChatMessage } from '@chatagent/contracts';
import type { ModelMessage } from '@chatagent/hermes';
import type { AgentIntakeRecord, AgentIntakeStore } from './stores';

export type AgentIntakeMode = 'deferred' | 'immediate';

export interface AgentIntakeEvent {
  type: 'agent_intake';
  intakeId: string;
  conversationId: string;
  messageId: string;
  state: AgentIntakeRecord['state'];
  dueAt?: string;
  taskId?: string;
  reason?: string;
  /** Set on a terminal failure so a client can say how many attempts were spent. */
  attempts?: number;
  at: string;
}

export interface AgentIntakeStatus {
  mode: AgentIntakeMode;
  deferMs: number;
  contextMessages: number;
  pending: number;
  submitted: number;
  cancelled: number;
  /**
   * Handoffs that used up their retry budget. Non-zero is never a user error: it means the
   * environment cannot take work (missing model credentials, locked or full workspace) and
   * the operator has to act. This is the counter a pilot should alarm on.
   */
  failed: number;
  /** Pending handoffs that already failed at least once: a queue that is stalling. */
  stalled: number;
  /** The budget in force, so the counters above can be read without guessing. */
  maxAttempts: number;
  /** Oldest handoff still waiting, so an operator can see a stuck queue. */
  oldestPendingAt?: string;
  lastError?: string;
}

export interface DeferIntakeInput {
  conversationId: string;
  messageId: string;
  accountId: string;
  organizationId: string;
  requesterId: string;
  chatType: 'direct' | 'group';
  goal: string;
}

export interface AgentIntakeGateOptions {
  store: AgentIntakeStore;
  /** `immediate` exists for tests and for deployments that disable recall. */
  mode: AgentIntakeMode;
  /** Hard-coded source of the delay: the recall window. */
  deferMs: number;
  /** How many recent messages around the request the agent may read. */
  contextMessages: number;
  /** Retry budget per handoff; defaults to DEFAULT_MAX_ATTEMPTS. */
  maxAttempts?: number;
  lookupMessage: (messageId: string) => Promise<ChatMessage | undefined>;
  buildHistory: (conversationId: string, limit: number) => Promise<ModelMessage[]>;
  submit: (input: {
    record: AgentIntakeRecord;
    history: ModelMessage[];
  }) => Promise<{ taskId: string }>;
  onEvent?: (event: AgentIntakeEvent) => void;
  now?: () => number;
  logger?: {
    warn(message: string, detail?: unknown): void;
    error(message: string, detail?: unknown): void;
  };
}

/** A handoff that keeps failing is retried with backoff instead of being dropped. */
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/**
 * Retry budget of a single handoff. Retrying forever looks harmless and is not: a request
 * stuck behind a broken environment (no model credentials, locked workspace) produces no
 * answer, no reason and no way for anyone to notice - the sender just waits, and the agent
 * looks like it ignored them. After this many failed ATTEMPTS the handoff is parked as
 * `failed`: the row is kept, the conversation is told to resend, and the queue reports the
 * count. Waiting out the recall window is not an attempt and never spends the budget.
 * Operators can raise the budget (or the tool can be configured for a long outage) with
 * CHATAGENT_AGENT_INTAKE_MAX_ATTEMPTS.
 */
const DEFAULT_MAX_ATTEMPTS = 8;

export class AgentIntakeGate {
  private readonly store: AgentIntakeStore;
  private readonly mode: AgentIntakeMode;
  private readonly deferMs: number;
  private readonly contextMessages: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;
  private readonly logger: AgentIntakeGateOptions['logger'];
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<number> | undefined;
  private lastError: string | undefined;

  constructor(private readonly options: AgentIntakeGateOptions) {
    this.store = options.store;
    this.mode = options.mode;
    this.deferMs = Math.max(0, options.deferMs);
    this.contextMessages = Math.max(1, options.contextMessages);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger;
  }

  get deferred(): boolean {
    return this.mode === 'deferred';
  }

  /** Exposed so responses can tell the client which mode produced this notice. */
  get intakeMode(): AgentIntakeMode {
    return this.mode;
  }

  /**
   * Queues a message for the agent. In deferred mode nothing is submitted until the
   * recall window has elapsed; in immediate mode the same code path submits at once, so
   * both modes share one idempotency story.
   */
  async defer(input: DeferIntakeInput): Promise<AgentIntakeRecord> {
    const at = new Date(this.now()).toISOString();
    const record: AgentIntakeRecord = {
      id: crypto.randomUUID(),
      conversationId: input.conversationId,
      messageId: input.messageId,
      accountId: input.accountId,
      organizationId: input.organizationId,
      requesterId: input.requesterId,
      chatType: input.chatType,
      goal: input.goal,
      state: 'pending',
      dueAt: new Date(this.now() + (this.deferred ? this.deferMs : 0)).toISOString(),
      createdAt: at,
      updatedAt: at,
      attempts: 0,
      maxAttempts: this.maxAttempts,
    };
    await this.store.save(record);
    if (this.deferred) {
      this.publish(record);
      return record;
    }
    return (await this.deliver(record)) ?? record;
  }

  /**
   * A recall cancels the pending handoff: the agent never reads the withdrawn text. An
   * already submitted handoff is left alone - a running task is not undone by a later
   * recall, which would silently invalidate work the user already saw start.
   */
  async cancelForMessage(
    messageId: string,
    reason: AgentIntakeRecord['cancelReason'] = 'recalled',
  ): Promise<AgentIntakeRecord | undefined> {
    const pending = (await this.store.list()).filter(
      (record) => record.messageId === messageId && record.state === 'pending',
    );
    let cancelled: AgentIntakeRecord | undefined;
    for (const record of pending) {
      const updated: AgentIntakeRecord = {
        ...record,
        state: 'cancelled',
        cancelReason: reason,
        updatedAt: new Date(this.now()).toISOString(),
      };
      await this.store.save(updated);
      this.publish(updated);
      cancelled = updated;
    }
    return cancelled;
  }

  /** Processes every handoff whose recall window has elapsed. Single-flight. */
  async tick(): Promise<number> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runTick().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async runTick(): Promise<number> {
    let submitted = 0;
    const pending = (await this.store.list())
      .filter((record) => record.state === 'pending' && Date.parse(record.dueAt) <= this.now())
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
    for (const record of pending) {
      const result = await this.deliver(record);
      if (result?.state === 'submitted') submitted += 1;
    }
    return submitted;
  }

  private async deliver(record: AgentIntakeRecord): Promise<AgentIntakeRecord | undefined> {
    const message = await this.options.lookupMessage(record.messageId);
    if (!message) return this.cancel(record, 'message_missing');
    if (message.recalledAt) return this.cancel(record, 'recalled');
    try {
      // History is read at handoff time, not at send time: whatever was withdrawn in
      // between is already gone from the conversation and never reaches the model.
      const history = await this.options.buildHistory(
        record.conversationId,
        this.contextMessages,
      );
      const { taskId } = await this.options.submit({ record, history });
      const updated: AgentIntakeRecord = {
        ...record,
        state: 'submitted',
        taskId,
        attempts: record.attempts + 1,
        lastError: undefined,
        updatedAt: new Date(this.now()).toISOString(),
      };
      await this.store.save(updated);
      this.publish(updated);
      return updated;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.lastError = detail;
      this.logger?.warn('agent intake submit failed; will retry', {
        intakeId: record.id,
        detail,
      });
      const attempts = record.attempts + 1;
      const budget = Math.max(1, record.maxAttempts ?? this.maxAttempts);
      if (attempts >= budget) {
        // Terminal, and deliberately not a silent drop: the row stays readable, the room
        // gets a reason it can act on (resend) and the operator gets a counter. The raw
        // error stays in the log and the status surface - it is not sent to the room.
        const failed: AgentIntakeRecord = {
          ...record,
          state: 'failed',
          attempts,
          lastError: detail,
          updatedAt: new Date(this.now()).toISOString(),
        };
        await this.store.save(failed);
        this.logger?.error('agent intake handoff gave up after its retry budget', {
          intakeId: record.id,
          attempts,
          detail,
        });
        this.publish(failed, 'retry_exhausted');
        return failed;
      }
      const retryIn = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
      const updated: AgentIntakeRecord = {
        ...record,
        attempts,
        lastError: detail,
        dueAt: new Date(this.now() + retryIn).toISOString(),
        updatedAt: new Date(this.now()).toISOString(),
      };
      await this.store.save(updated);
      return updated;
    }
  }

  private async cancel(
    record: AgentIntakeRecord,
    reason: NonNullable<AgentIntakeRecord['cancelReason']>,
  ): Promise<AgentIntakeRecord> {
    const updated: AgentIntakeRecord = {
      ...record,
      state: 'cancelled',
      cancelReason: reason,
      updatedAt: new Date(this.now()).toISOString(),
    };
    await this.store.save(updated);
    this.publish(updated);
    return updated;
  }

  private publish(record: AgentIntakeRecord, reason?: string): void {
    this.options.onEvent?.({
      type: 'agent_intake',
      intakeId: record.id,
      conversationId: record.conversationId,
      messageId: record.messageId,
      state: record.state,
      dueAt: record.state === 'pending' ? record.dueAt : undefined,
      taskId: record.taskId,
      attempts: record.state === 'failed' ? record.attempts : undefined,
      reason: reason ?? record.cancelReason,
      at: new Date(this.now()).toISOString(),
    });
  }

  /** Loads the queue and processes anything that came due while the server was down. */
  async recover(): Promise<void> {
    await this.store.load();
    try {
      await this.tick();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.lastError = detail;
      this.logger?.error('agent intake recovery failed', { detail });
    }
  }

  start(intervalMs = 1_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.logger?.error('agent intake tick failed', { detail: this.lastError });
      });
    }, intervalMs);
    // Never keep the process alive just to poll the queue.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async status(): Promise<AgentIntakeStatus> {
    const records = await this.store.list();
    const pending = records.filter((record) => record.state === 'pending');
    return {
      mode: this.mode,
      deferMs: this.deferMs,
      contextMessages: this.contextMessages,
      pending: pending.length,
      submitted: records.filter((record) => record.state === 'submitted').length,
      cancelled: records.filter((record) => record.state === 'cancelled').length,
      failed: records.filter((record) => record.state === 'failed').length,
      stalled: pending.filter((record) => record.attempts > 0).length,
      maxAttempts: this.maxAttempts,
      oldestPendingAt: pending
        .map((record) => record.dueAt)
        .sort((a, b) => Date.parse(a) - Date.parse(b))[0],
      lastError: this.lastError,
    };
  }
}
