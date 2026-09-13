import { describe, expect, it } from 'vitest';
import type { TaskRecord } from '@chatagent/contracts';
import { MemoryTaskStore, TaskEngine } from './index';
import type { TaskHandler } from './types';

const BASE = { organizationId: 'org_test', requesterId: 'u_test' };

describe('TaskEngine', () => {
  it('runs a task to completion', async () => {
    const engine = new TaskEngine({
      store: new MemoryTaskStore(),
      handler: async () => 'done',
      maxConcurrency: 1,
    });
    await engine.start();

    const task = await engine.submit({ ...BASE, accountId: 'a1', goal: 'test' });
    const completed = await waitFor(() => engine.get(task.id), (t) => t?.state === 'completed');
    expect(completed?.result).toBe('done');
    expect(completed?.outcome?.status).toBe('succeeded');
  });

  it('retries once then fails', async () => {
    let attempts = 0;
    const engine = new TaskEngine({
      store: new MemoryTaskStore(),
      handler: async () => {
        attempts += 1;
        throw new Error('boom');
      },
      maxConcurrency: 1,
      retryDelayMs: 10,
    });
    await engine.start();

    const task = await engine.submit({ ...BASE, accountId: 'a1', goal: 'test', maxAttempts: 2 });
    const failed = await waitFor(() => engine.get(task.id), (t) => t?.state === 'failed');
    expect(failed?.attempts).toBe(2);
    expect(attempts).toBe(2);
    expect(failed?.outcome?.status).toBe('failed');
  });

  it('does not retry when the outcome is not retryable', async () => {
    let attempts = 0;
    const engine = new TaskEngine({
      store: new MemoryTaskStore(),
      handler: async () => {
        attempts += 1;
        return { kind: 'failed', error: 'permanent', retryable: false };
      },
      maxConcurrency: 1,
      retryDelayMs: 10,
    });
    await engine.start();

    const task = await engine.submit({ ...BASE, accountId: 'a1', goal: 'test', maxAttempts: 3 });
    const failed = await waitFor(() => engine.get(task.id), (t) => t?.state === 'failed');
    expect(attempts).toBe(1);
    expect(failed?.attempts).toBe(1);
  });

  it('maps waiting and incomplete outcomes to explicit states', async () => {
    const engine = new TaskEngine({
      store: new MemoryTaskStore(),
      handler: async (task) => {
        if (task.goal === 'approval') return { kind: 'waiting_approval', approvalId: 'ap_1' };
        if (task.goal === 'input') return { kind: 'waiting_input', question: '需要补充信息' };
        return { kind: 'incomplete', reason: 'step_limit', message: '步数耗尽' };
      },
      maxConcurrency: 1,
    });
    await engine.start();

    const approval = await engine.submit({ ...BASE, accountId: 'a1', goal: 'approval' });
    const approvalState = await waitFor(
      () => engine.get(approval.id),
      (t) => t?.state === 'waiting_approval',
    );
    expect(approvalState?.state).toBe('waiting_approval');

    const input = await engine.submit({ ...BASE, accountId: 'a1', goal: 'input' });
    const inputState = await waitFor(() => engine.get(input.id), (t) => t?.state === 'waiting_input');
    expect(inputState?.result).toBe('需要补充信息');

    const incomplete = await engine.submit({ ...BASE, accountId: 'a1', goal: 'other' });
    const incompleteState = await waitFor(
      () => engine.get(incomplete.id),
      (t) => t?.state === 'incomplete',
    );
    expect(incompleteState?.outcome).toMatchObject({ status: 'incomplete', code: 'step_limit' });
  });

  it('keeps cancelled when a late handler result arrives (cancel/complete race)', async () => {
    const gate = deferred<void>();
    const engine = new TaskEngine({
      store: new MemoryTaskStore(),
      handler: async () => {
        await gate.promise;
        return 'late success';
      },
      maxConcurrency: 1,
    });
    await engine.start();

    const task = await engine.submit({ ...BASE, accountId: 'a1', goal: 'race' });
    await waitFor(() => engine.get(task.id), (t) => t?.state === 'running');

    const cancelResult = await engine.cancel(task.id);
    expect(cancelResult.ok).toBe(true);

    gate.resolve();
    await delay(80);

    const final = await engine.get(task.id);
    expect(final?.state).toBe('cancelled');
    expect(final?.result).toBeUndefined();
    expect(engine.getEvents(task.id).some((event) => event.type === 'completed')).toBe(false);
  });

  it('reports already finished when completion wins the race', async () => {
    const engine = new TaskEngine({
      store: new MemoryTaskStore(),
      handler: async () => 'fast',
      maxConcurrency: 1,
    });
    await engine.start();

    const task = await engine.submit({ ...BASE, accountId: 'a1', goal: 'fast' });
    await waitFor(() => engine.get(task.id), (t) => t?.state === 'completed');

    const cancelResult = await engine.cancel(task.id);
    expect(cancelResult.ok).toBe(false);
    expect(cancelResult.reason).toBe('already_finished');
    expect(cancelResult.state).toBe('completed');
  });

  it('recovers persisted pending tasks on start and never double-claims', async () => {
    const store = new MemoryTaskStore();
    const seen: string[] = [];
    const handler: TaskHandler = async (task) => {
      seen.push(task.id);
      await delay(10);
      return 'ok';
    };

    const first = new TaskEngine({ store, handler, maxConcurrency: 1, retryDelayMs: 5 });
    await first.start();
    const task = await first.submit({ ...BASE, accountId: 'a1', goal: 'persist' });
    await waitFor(() => first.get(task.id), (t) => t?.state === 'completed');

    // Simulate a fresh process over the same store.
    const second = new TaskEngine({ store, handler, maxConcurrency: 1, retryDelayMs: 5 });
    await second.start();
    await delay(60);

    expect(seen.filter((id) => id === task.id)).toHaveLength(1);
  });

  it('serializes a same-tick cancel against a late completion', async () => {
    const gate = deferred<void>();
    const engine = new TaskEngine({
      store: new MemoryTaskStore(),
      handler: async () => {
        await gate.promise;
        return 'late success';
      },
      maxConcurrency: 1,
    });
    await engine.start();

    const task = await engine.submit({ ...BASE, accountId: 'a1', goal: 'same-tick race' });
    await waitFor(() => engine.get(task.id), (t) => t?.state === 'running');

    // Cancel and the handler result land in the same microtask batch: without
    // per-task serialization both could read the pre-cancel record and write.
    const cancelPromise = engine.cancel(task.id);
    gate.resolve();
    const cancelResult = await cancelPromise;

    expect(cancelResult.ok).toBe(true);
    const final = await engine.get(task.id);
    expect(final?.state).toBe('cancelled');
    expect(final?.result).toBeUndefined();
    expect(engine.getEvents(task.id).some((event) => event.type === 'completed')).toBe(false);
  });

  it('never rewrites a terminal record', async () => {
    const gate = deferred<void>();
    let contextRef: { update: (patch: Record<string, unknown>) => Promise<void> } | undefined;
    const engine = new TaskEngine({
      store: new MemoryTaskStore(),
      handler: async (_task, context) => {
        contextRef = context;
        await gate.promise;
        await context.update({ result: 'late write' });
        return { kind: 'completed', result: 'late success' };
      },
      maxConcurrency: 1,
    });
    await engine.start();

    const task = await engine.submit({ ...BASE, accountId: 'a1', goal: 'terminal' });
    await waitFor(() => engine.get(task.id), (t) => t?.state === 'running');
    await engine.cancel(task.id);

    gate.resolve();
    await delay(60);

    const final = await engine.get(task.id);
    expect(final?.state).toBe('cancelled');
    expect(final?.result).toBeUndefined();
    expect(contextRef).toBeDefined();
  });

  it('bounds the replay buffer for long tasks', async () => {
    const engine = new TaskEngine({
      store: new MemoryTaskStore(),
      handler: async (_task, context) => {
        for (let index = 0; index < 700; index += 1) {
          context.emit({ type: 'progress', message: `step ${index}` });
        }
        return 'done';
      },
      maxConcurrency: 1,
    });
    await engine.start();

    const task = await engine.submit({ ...BASE, accountId: 'a1', goal: 'chatty' });
    await waitFor(() => engine.get(task.id), (t) => t?.state === 'completed');

    const events = engine.getEvents(task.id);
    expect(events.length).toBeLessThanOrEqual(501);
    expect(events[events.length - 1]?.type).toBe('completed');
  });

  it('stop aborts in-flight work and cancels the signal', async () => {
    let aborted = false;
    const engine = new TaskEngine({
      store: new MemoryTaskStore(),
      handler: async (_task, context) => {
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        });
        return { kind: 'cancelled', reason: 'aborted by stop' };
      },
      maxConcurrency: 1,
      stopTimeoutMs: 2000,
    });
    await engine.start();

    const task = await engine.submit({ ...BASE, accountId: 'a1', goal: 'stop' });
    await waitFor(() => engine.get(task.id), (t) => t?.state === 'running');
    await engine.stop();

    expect(aborted).toBe(true);
    const final = await engine.get(task.id);
    expect(final?.state).toBe('cancelled');
  });
});

async function waitFor(
  read: () => Promise<TaskRecord | undefined>,
  predicate: (task: TaskRecord | undefined) => boolean,
  timeoutMs = 3000,
): Promise<TaskRecord | undefined> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = await read();
    if (predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return read();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
