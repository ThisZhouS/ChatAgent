/**
 * Message intake gate: a message reaches an agent only after the recall window.
 *
 * The gate is the code half of the product rule; the prompt only states it. These tests
 * pin the half that cannot be argued with: withdrawn messages are never handed over, a
 * submitted handoff is terminal, and a restart replays a due handoff exactly once.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@chatagent/contracts';
import { AgentIntakeGate, type AgentIntakeEvent } from './agent-intake';
import { AgentIntakeStore } from './stores';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'chatagent-intake-'));
  dirs.push(dir);
  return dir;
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    channel: 'web',
    accountId: 'acc1',
    conversationId: 'conv1',
    chatType: 'direct',
    direction: 'inbound',
    kind: 'text',
    text: '帮我整理周报',
    sender: { id: 'u_alice', name: 'Alice' },
    senderPrincipalId: 'u_alice',
    mentions: [],
    attachments: [],
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

interface Harness {
  gate: AgentIntakeGate;
  store: AgentIntakeStore;
  events: AgentIntakeEvent[];
  submits: Array<{ intakeId: string; goal: string; historyLength: number }>;
  historyLimits: number[];
  messages: Map<string, ChatMessage>;
  advance(ms: number): void;
  failNext(error: Error): void;
  /** Every submit fails until this is cleared: simulates a broken environment. */
  failAlways(error?: Error): void;
}

async function harness(
  options: { deferMs?: number; mode?: 'deferred' | 'immediate'; contextMessages?: number } = {},
): Promise<Harness> {
  const dir = await scratch();
  const store = new AgentIntakeStore(join(dir, 'intake.json'));
  const events: AgentIntakeEvent[] = [];
  const submits: Harness['submits'] = [];
  const historyLimits: number[] = [];
  const messages = new Map<string, ChatMessage>([['m1', message()]]);
  let clock = Date.parse('2026-09-17T10:00:00.000Z');
  let failure: Error | undefined;
  let persistentFailure: Error | undefined;
  const gate = new AgentIntakeGate({
    store,
    mode: options.mode ?? 'deferred',
    deferMs: options.deferMs ?? 120_000,
    contextMessages: options.contextMessages ?? 20,
    now: () => clock,
    lookupMessage: async (id) => messages.get(id),
    buildHistory: async (_conversationId, limit) => {
      historyLimits.push(limit);
      return [
        { role: 'user', content: '早' },
        { role: 'assistant', content: '早上好' },
        { role: 'user', content: '帮我整理周报' },
      ];
    },
    submit: async ({ record, history }) => {
      if (persistentFailure) throw persistentFailure;
      if (failure) {
        const error = failure;
        failure = undefined;
        throw error;
      }
      submits.push({ intakeId: record.id, goal: record.goal, historyLength: history.length });
      return { taskId: `task-${submits.length}` };
    },
    onEvent: (event) => events.push(event),
  });
  return {
    gate,
    store,
    events,
    submits,
    historyLimits,
    messages,
    advance: (ms) => {
      clock += ms;
    },
    failNext: (error) => {
      failure = error;
    },
    failAlways: (error) => {
      persistentFailure = error;
    },
  };
}

const deferInput = {
  conversationId: 'conv1',
  messageId: 'm1',
  accountId: 'acc1',
  organizationId: 'org_local',
  requesterId: 'u_alice',
  chatType: 'direct' as const,
  goal: '帮我整理周报',
};

describe('agent intake gate', () => {
  it('does not hand a message over before the recall window has elapsed', async () => {
    const h = await harness({ deferMs: 120_000 });
    const record = await h.gate.defer(deferInput);
    expect(record.state).toBe('pending');
    expect(Date.parse(record.dueAt) - Date.parse(record.createdAt)).toBe(120_000);
    expect(await h.gate.tick()).toBe(0);
    expect(h.submits).toHaveLength(0);
    // The response the sender sees says "queued", not "running".
    const events = h.events.filter((event) => event.type === 'agent_intake');
    expect(events[0]?.state).toBe('pending');
    expect(events[0]?.dueAt).toBe(record.dueAt);

    h.advance(120_001);
    expect(await h.gate.tick()).toBe(1);
    expect(h.submits).toHaveLength(1);
    const submitted = await h.store.get(record.id);
    expect(submitted?.state).toBe('submitted');
    expect(submitted?.taskId).toBe('task-1');
    expect(h.events.some((event) => event.state === 'submitted')).toBe(true);
  });

  it('never hands over a message the sender withdrew inside the window', async () => {
    const h = await harness({ deferMs: 120_000 });
    const record = await h.gate.defer(deferInput);
    h.advance(60_000);
    const cancelled = await h.gate.cancelForMessage('m1', 'recalled');
    expect(cancelled?.state).toBe('cancelled');
    expect(cancelled?.cancelReason).toBe('recalled');
    h.advance(120_000);
    expect(await h.gate.tick()).toBe(0);
    expect(h.submits).toHaveLength(0);
    expect((await h.store.get(record.id))?.state).toBe('cancelled');
    const last = h.events.filter((event) => event.type === 'agent_intake').at(-1);
    expect(last?.state).toBe('cancelled');
    expect(last?.reason).toBe('recalled');
  });

  it('drops a handoff whose message was recalled without going through the gate', async () => {
    const h = await harness({ deferMs: 1_000 });
    const record = await h.gate.defer(deferInput);
    // A recall that happened elsewhere (another replica, a direct store write) still
    // has to stop the handoff: the message itself is the source of truth.
    h.messages.set('m1', message({ recalledAt: new Date().toISOString() }));
    h.advance(1_001);
    expect(await h.gate.tick()).toBe(0);
    expect(h.submits).toHaveLength(0);
    const stored = await h.store.get(record.id);
    expect(stored?.state).toBe('cancelled');
    expect(stored?.cancelReason).toBe('recalled');
  });

  it('submits a handoff exactly once, and a restart neither replays nor drops one', async () => {
    const h = await harness({ deferMs: 1_000 });
    const first = await h.gate.defer(deferInput);
    h.advance(1_001);
    await h.gate.tick();
    await h.gate.tick();
    expect(h.submits).toHaveLength(1);
    const submittedRow = await h.store.get(first.id);
    expect(submittedRow?.state).toBe('submitted');

    // A second request that came due while the process was down.
    const second = await h.gate.defer({ ...deferInput, messageId: 'm1' });
    expect(second.state).toBe('pending');

    const restarted = await harness({ deferMs: 1_000 });
    await restarted.store.save(submittedRow!);
    await restarted.store.save(second);
    restarted.messages.set('m1', message());
    restarted.advance(5_000);
    await restarted.gate.recover();
    // The submitted row is terminal; only the pending one is handed over, once.
    expect(restarted.submits.map((item) => item.intakeId)).toEqual([second.id]);
    await restarted.gate.recover();
    expect(restarted.submits).toHaveLength(1);
  });

  it('retries a failed handoff with backoff instead of dropping the request', async () => {
    const h = await harness({ deferMs: 1_000 });
    const record = await h.gate.defer(deferInput);
    h.failNext(new Error('task queue is full, retry later'));
    h.advance(1_001);
    expect(await h.gate.tick()).toBe(0);
    const afterFailure = await h.store.get(record.id);
    expect(afterFailure?.state).toBe('pending');
    expect(afterFailure?.attempts).toBe(1);
    expect(afterFailure?.lastError).toContain('queue is full');
    expect(Date.parse(afterFailure!.dueAt)).toBeGreaterThan(h.submits.length);
    // Not yet due again: the backoff holds it back.
    expect(await h.gate.tick()).toBe(0);
    h.advance(5_001);
    expect(await h.gate.tick()).toBe(1);
    expect((await h.store.get(record.id))?.state).toBe('submitted');
  });

  it('reads only the configured number of recent messages at handoff time', async () => {
    const h = await harness({ deferMs: 0, contextMessages: 7 });
    await h.gate.defer(deferInput);
    await h.gate.tick();
    expect(h.historyLimits).toEqual([7]);
  });

  it('submits synchronously in immediate mode and still records the handoff', async () => {
    const h = await harness({ mode: 'immediate' });
    const record = await h.gate.defer(deferInput);
    expect(record.state).toBe('submitted');
    expect(record.taskId).toBeDefined();
    expect(h.submits).toHaveLength(1);
    // No timer is needed, and a later tick cannot double-submit.
    expect(await h.gate.tick()).toBe(0);
  });

  it('reports queue state for operators, including the oldest waiting handoff', async () => {
    const h = await harness({ deferMs: 60_000 });
    const record = await h.gate.defer(deferInput);
    const status = await h.gate.status();
    expect(status).toMatchObject({ mode: 'deferred', deferMs: 60_000, pending: 1, submitted: 0 });
    expect(status.oldestPendingAt).toBe(record.dueAt);
    h.advance(60_001);
    await h.gate.tick();
    expect(await h.gate.status()).toMatchObject({ pending: 0, submitted: 1 });
  });

  it('stops its timer without leaving the process pinned', async () => {
    const h = await harness({ deferMs: 1_000 });
    h.gate.start(20);
    h.gate.stop();
    // A stopped gate does no work even when the clock moves past the due time.
    const record = await h.gate.defer(deferInput);
    h.advance(5_000);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await h.store.get(record.id))?.state).toBe('pending');
  });

  it('parks a handoff as failed once the retry budget is spent, and never retries it again', async () => {
    const h = await harness({ deferMs: 1_000 });
    const record = await h.gate.defer(deferInput);
    expect(record.maxAttempts).toBe(8);
    // A broken environment: every attempt throws, so nothing is ever submitted.
    h.failAlways(new Error('model credentials are not configured'));
    for (let round = 0; round < 12; round += 1) {
      h.advance(10 * 60_000);
      await h.gate.tick();
    }

    const parked = await h.store.get(record.id);
    expect(parked?.state).toBe('failed');
    expect(parked?.attempts).toBe(8);
    expect(parked?.lastError).toContain('credentials');
    expect(h.submits).toHaveLength(0);

    // Terminal: even with the environment fixed the queue does not pick the row up again;
    // the sender resends, which is a new message and a new handoff.
    h.failAlways(undefined);
    h.advance(10 * 60_000);
    expect(await h.gate.tick()).toBe(0);
    expect((await h.store.get(record.id))?.state).toBe('failed');
    expect(h.submits).toHaveLength(0);

    // The room is told why, and the client is told how hard the host tried - but the raw
    // error text stays in the log and the status surface, never on the wire.
    const failedEvent = h.events.find((event) => event.state === 'failed');
    expect(failedEvent?.reason).toBe('retry_exhausted');
    expect(failedEvent?.attempts).toBe(8);
    expect(JSON.stringify(h.events)).not.toContain('credentials');

    expect(await h.gate.status()).toMatchObject({
      pending: 0,
      submitted: 0,
      failed: 1,
      stalled: 0,
      maxAttempts: 8,
    });
  });

  it('counts a stalled queue while it retries, and the recall window never spends the budget', async () => {
    const h = await harness({ deferMs: 600_000 });
    const record = await h.gate.defer(deferInput);
    // Ten ticks inside the recall window: the handoff is queued, and that is not a failure.
    for (let round = 0; round < 10; round += 1) {
      h.advance(1_000);
      expect(await h.gate.tick()).toBe(0);
    }
    const waiting = await h.store.get(record.id);
    expect(waiting?.state).toBe('pending');
    expect(waiting?.attempts).toBe(0);
    expect(await h.gate.status()).toMatchObject({ pending: 1, failed: 0, stalled: 0 });
    expect(h.events.some((event) => event.state === 'failed')).toBe(false);

    // One real failure while pending shows up as a stalling queue, and the next attempt
    // after the backoff still goes through.
    h.advance(600_000);
    h.failNext(new Error('task queue is full, retry later'));
    expect(await h.gate.tick()).toBe(0);
    expect(await h.gate.status()).toMatchObject({ pending: 1, failed: 0, stalled: 1 });
    h.advance(5_001);
    expect(await h.gate.tick()).toBe(1);
    expect(await h.gate.status()).toMatchObject({ pending: 0, submitted: 1, failed: 0, stalled: 0 });
  });
});
