import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHermesAdapter, type HermesAdapter } from './adapter';
import { computeActionDigest, TrustedAuthorizationRegistry } from './authorization';
import { LocalAgentHost } from './host';
import { AgentHostStoreLockedError, JsonFileAgentHostStore, MemoryAgentHostStore } from './store';
import type { AgentHostStore } from './store';
import type { LocalTaskInput, LocalTaskRecord } from './types';

/**
 * Follow-up to the independent adversarial verification of the Gate 7A.1 fixes
 * (Temp/verify-2026-09-16/FINDINGS.md). Each test here seals one hole the
 * verifier actually reproduced, so the same attack cannot come back silently.
 */

const DEVICE = 'device_verify_1';
const AGENT = 'agent_verify_1';

const roots: string[] = [];
async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'chatagent-host-verify-'));
  roots.push(dir);
  return dir;
}

const hosts: LocalAgentHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close('test_cleanup').catch(() => undefined);
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

function makeHost(options: {
  workRoot: string;
  store?: AgentHostStore;
  adapter?: HermesAdapter;
  authorizations?: TrustedAuthorizationRegistry;
}): { host: LocalAgentHost; store: AgentHostStore } {
  const store = options.store ?? new MemoryAgentHostStore();
  const host = new LocalAgentHost({
    deviceId: DEVICE,
    agentId: AGENT,
    workRoot: options.workRoot,
    store,
    adapter: options.adapter ?? new FakeHermesAdapter({ durationMs: 10 }),
    authorizations: options.authorizations,
    executorReason: 'fake executor in use for tests',
    leaseMs: 5_000,
    defaultTimeoutMs: 3_000,
    stopTimeoutMs: 500,
  });
  hosts.push(host);
  return { host, store };
}

function baseTask(overrides: Partial<LocalTaskInput> = {}): LocalTaskInput {
  return {
    taskId: `verify_${Math.random().toString(36).slice(2, 10)}`,
    agentId: AGENT,
    goal: '整理一份安全合成数据清单',
    kind: 'document',
    workDir: '',
    toolsets: ['document'],
    ...overrides,
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for condition');
}

/** Store wrapper that can fail the next write, without changing store semantics. */
function flakyStore(inner: AgentHostStore, state: { fail: boolean }): AgentHostStore {
  const guard = () => {
    if (state.fail) throw new Error('disk on fire');
  };
  return {
    load: () => inner.load(),
    list: () => inner.list(),
    get: (taskId) => inner.get(taskId),
    async put(record) {
      guard();
      return inner.put(record);
    },
    async createIfAbsent(record) {
      guard();
      return inner.createIfAbsent?.(record);
    },
    async compareAndSet(taskId, expectedVersion, next) {
      guard();
      return inner.compareAndSet(taskId, expectedVersion, next);
    },
    claim: (taskId, holder, leaseMs) => inner.claim(taskId, holder, leaseMs),
    release: (taskId, holder) => inner.release(taskId, holder),
    recoverInterrupted: () => inner.recoverInterrupted(),
    flush: () => inner.flush(),
    close: () => inner.close(),
  };
}

describe('V-01 a closed host must stay silent', () => {
  it('refuses submit/retry/cancel after close() instead of writing unlocked', async () => {
    const root = await makeRoot();
    const file = join(root, 'tasks.json');
    const { host } = makeHost({ workRoot: root, store: new JsonFileAgentHostStore(file) });
    await host.start();
    const task = baseTask();
    await host.submit(task);
    await host.close('closed_for_test');

    await expect(host.submit(baseTask())).rejects.toThrow(/host_closed/);
    await expect(host.cancel(task.taskId)).rejects.toThrow(/host_closed/);
    await expect(host.retry(task.taskId)).rejects.toThrow(/host_closed/);

    // The lock is free, so a freshly started host may take the same file over.
    const reopened = makeHost({ workRoot: root, store: new JsonFileAgentHostStore(file) });
    await reopened.host.start();
    expect((await reopened.host.list()).some((item) => item.taskId === task.taskId)).toBe(true);
  });

  it('refuses to write through a released store', async () => {
    const root = await makeRoot();
    const store = new JsonFileAgentHostStore(join(root, 'tasks.json'));
    await store.load();
    const record: LocalTaskRecord = {
      taskId: 'closed_store_task',
      deviceId: DEVICE,
      agentId: AGENT,
      goal: '写不进去',
      kind: 'document',
      state: 'queued',
      version: 1,
      workDir: root,
      toolsets: ['document'],
      artifacts: [],
      attempts: 0,
      maxAttempts: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.put(record);
    await store.close();
    await expect(store.put({ ...record, goal: '关店之后' })).rejects.toThrow(
      /agent_host_store_closed/,
    );
  });
});

describe('V-02 a live holder keeps its lock', () => {
  it('does not steal an old lock that still names a live process', async () => {
    const root = await makeRoot();
    const file = join(root, 'tasks.json');
    // Our own pid is alive by definition; the lock is older than any session.
    await writeFile(
      `${file}.lock`,
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date(Date.now() - 13 * 3600_000).toISOString(),
      }),
      'utf8',
    );
    const store = new JsonFileAgentHostStore(file);
    await expect(store.load()).rejects.toThrow(AgentHostStoreLockedError);
  });

  it('does not release a lock that another process now owns', async () => {
    const root = await makeRoot();
    const file = join(root, 'tasks.json');
    const store = new JsonFileAgentHostStore(file);
    await store.load();
    // Another writer took the lock over while this instance was idle.
    await writeFile(`${file}.lock`, JSON.stringify({ pid: process.pid + 1 }), 'utf8');
    await store.close();
    await expect(readFile(`${file}.lock`, 'utf8')).resolves.toContain('pid');
    await rm(`${file}.lock`, { force: true });
  });

  it('serves concurrent first access from one lock acquisition', async () => {
    const root = await makeRoot();
    const store = new JsonFileAgentHostStore(join(root, 'tasks.json'));
    const results = await Promise.allSettled([
      store.get('a'),
      store.get('b'),
      store.list(),
      store.get('c'),
    ]);
    expect(results.map((item) => item.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    await store.close();
  });
});

describe('V-03 the document kind cannot buy external capabilities', () => {
  it('refuses an external-effect toolset on a document task with no delegation', async () => {
    const root = await makeRoot();
    const calls: string[][] = [];
    const inner = new FakeHermesAdapter({ durationMs: 10 });
    const spy: HermesAdapter = {
      kind: inner.kind,
      async run(input) {
        calls.push(input.toolsets);
        return inner.run(input);
      },
    };
    const { host } = makeHost({ workRoot: root, adapter: spy });
    await host.start();
    for (const toolsets of [['web'], ['*'], ['terminal'], ['document', 'code_execution']]) {
      const record = await host.submit(baseTask({ toolsets }));
      expect(record.state, `toolsets ${toolsets.join(',')} must be blocked`).toBe('failed');
      expect(record.blockedReason).toBe('capability_not_granted');
    }
    expect(calls).toEqual([]);
    await host.stop();
  });
});

describe('V-04 a failed write never fakes a result', () => {
  it('keeps the previous state when the terminal write fails', async () => {
    const root = await makeRoot();
    const inner = new MemoryAgentHostStore();
    const state = { fail: false };
    const { host } = makeHost({
      workRoot: root,
      store: flakyStore(inner, state),
      adapter: new FakeHermesAdapter({ durationMs: 400, artifactName: 'result.md' }),
    });
    await host.start();
    const task = baseTask();
    await host.submit(task);
    // Let the run start, then break the disk for the terminal write.
    await waitFor(async () => (await inner.get(task.taskId))?.state === 'running');
    state.fail = true;
    await new Promise((resolve) => setTimeout(resolve, 700));
    const record = await inner.get(task.taskId);
    expect(record?.state, 'a failed write must not leave a phantom success').toBe('running');
    expect((await host.get(task.taskId))?.state).toBe('running');
    state.fail = false;
    await host.stop();
  });

  it('does not reject when the dispatcher hits a store failure', async () => {
    const root = await makeRoot();
    const inner = new MemoryAgentHostStore();
    const flags = { failList: true };
    const flaky: AgentHostStore = {
      ...flakyStore(inner, { fail: false }),
      async list() {
        if (flags.failList) throw new Error('list exploded');
        return inner.list();
      },
    };
    const { host } = makeHost({ workRoot: root, store: flaky });
    await host.start();
    await expect(host.tick()).resolves.toBeUndefined();
    flags.failList = false;
    expect((await host.status()).lastError).toContain('list exploded');
  });
});

describe('V-05 idempotency holds under concurrency and for legacy rows', () => {
  it('acknowledges exactly one of two concurrent submits with the same id', async () => {
    const root = await makeRoot();
    const { host, store } = makeHost({ workRoot: root });
    await host.start();
    const taskId = 'race_task_1';
    const results = await Promise.allSettled([
      host.submit(baseTask({ taskId, goal: '第一个目标' })),
      host.submit(baseTask({ taskId, goal: '第二个目标' })),
    ]);
    const fulfilled = results.filter(
      (item): item is PromiseFulfilledResult<LocalTaskRecord> => item.status === 'fulfilled',
    );
    const rejected = results.filter(
      (item): item is PromiseRejectedResult => item.status === 'rejected',
    );
    const stored = await store.get(taskId);
    // Whichever submit won, the recorded payload is the one that was acknowledged.
    if (fulfilled.length === 1) {
      expect(stored?.goal).toBe(fulfilled[0].value.goal);
      expect(rejected).toHaveLength(1);
      expect(String(rejected[0].reason)).toMatch(/idempotency_conflict/);
    } else {
      // Both callers saw a replay of the same record: still exactly one payload.
      expect(fulfilled).toHaveLength(2);
      expect(new Set(fulfilled.map((item) => item.value.goal)).size).toBe(1);
      expect(stored?.goal).toBe(fulfilled[0].value.goal);
    }
  });

  it('rejects a different payload for a record written before actionDigest existed', async () => {
    const root = await makeRoot();
    const { host, store } = makeHost({ workRoot: root });
    await host.start();
    const task = baseTask({ taskId: 'legacy_task_1', goal: '旧记录目标' });
    const created = await host.submit(task);
    const legacy: LocalTaskRecord = { ...created };
    delete (legacy as { actionDigest?: string }).actionDigest;
    await store.put(legacy);
    await expect(host.submit({ ...task, goal: '被篡改的目标' })).rejects.toThrow(
      /idempotency_conflict/,
    );
  });

  it('refuses to re-queue a finished task through a stale put()', async () => {
    const root = await makeRoot();
    const { host, store } = makeHost({ workRoot: root });
    await host.start();
    const task = baseTask();
    const queued = await host.submit(task);
    await waitFor(async () => (await host.get(task.taskId))?.state === 'succeeded');
    await expect(store.put({ ...queued, state: 'queued' })).rejects.toThrow(
      /terminal_state_protected/,
    );
    expect((await host.get(task.taskId))?.state).toBe('succeeded');
    await host.stop();
  });
});

describe('V-06 approvals are single-use', () => {
  it('consumes the approval when the side effect actually runs', async () => {
    const root = await makeRoot();
    const registry = new TrustedAuthorizationRegistry();
    const { host } = makeHost({ workRoot: root, authorizations: registry });
    await host.start();
    const task = baseTask({ kind: 'side_effect', toolsets: ['messages.send'] });
    const delegationId = `dg_${task.taskId}`;
    const approvalId = `ap_${task.taskId}`;
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    registry.grantDelegation({
      id: delegationId,
      ownerId: 'u_owner',
      agentId: AGENT,
      deviceId: DEVICE,
      expiresAt,
      capabilities: task.toolsets,
      issuedAt: new Date().toISOString(),
      source: 'test',
    });
    registry.grantApproval({
      id: approvalId,
      approved: true,
      expiresAt,
      actionDigest: computeActionDigest({
        taskId: task.taskId,
        agentId: AGENT,
        kind: task.kind,
        goal: task.goal,
        toolsets: task.toolsets,
      }),
      ownerId: 'u_owner',
      delegationId,
      issuedAt: new Date().toISOString(),
      source: 'test',
    });
    expect(registry.getApproval(approvalId)).toBeTruthy();
    await host.submit({ ...task, delegationId, approvalId });
    await waitFor(async () => (await host.get(task.taskId))?.state === 'succeeded');
    expect(registry.getApproval(approvalId), 'approval must be spent').toBeUndefined();
    await host.stop();
  });
});

describe('V-07 the capability floor and the write chain hold everywhere', () => {
  it('refuses a legacy row that reached the store before the floor existed', async () => {
    const root = await makeRoot();
    const calls: string[][] = [];
    const inner = new FakeHermesAdapter({ durationMs: 10 });
    const spy: HermesAdapter = {
      kind: inner.kind,
      async run(input) {
        calls.push(input.toolsets);
        return inner.run(input);
      },
    };
    const { host, store } = makeHost({ workRoot: root, adapter: spy });
    await host.start();
    // Exactly the row shape the pre-fix version wrote: document kind, external toolset.
    const legacy = await store.createIfAbsent!.call(store, {
      taskId: 'legacy_external',
      deviceId: DEVICE,
      agentId: AGENT,
      goal: '旧版本写入的行',
      kind: 'document',
      state: 'queued',
      version: 1,
      workDir: root,
      toolsets: ['web'],
      artifacts: [],
      attempts: 0,
      maxAttempts: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(legacy).toBeTruthy();
    await host.tick();
    await waitFor(async () => (await host.get('legacy_external'))?.state === 'failed');
    const record = await host.get('legacy_external');
    expect(record?.blockedReason).toBe('capability_not_granted');
    expect(calls).toEqual([]);
    // Retry must not put it back in the queue either.
    expect(await host.retry('legacy_external')).toBeUndefined();
    // A replay of the stored row reports it as blocked instead of handing back
    // runnable-looking work that the dispatcher would refuse anyway.
    const replay = await host.submit({
      taskId: 'legacy_external',
      agentId: AGENT,
      goal: '旧版本写入的行',
      kind: 'document',
      workDir: root,
      toolsets: ['web'],
    });
    expect(replay.state).toBe('failed');
    expect(replay.blockedReason).toBe('capability_not_granted');
    await host.stop();
  });

  it('does not rewind a later successful write when an older write fails', async () => {
    const root = await makeRoot();
    const inner = new JsonFileAgentHostStore(join(root, 'tasks.json'));
    const flags = { failNext: false };
    const store: AgentHostStore = {
      load: () => inner.load(),
      list: () => inner.list(),
      get: (taskId) => inner.get(taskId),
      async put(record) {
        if (flags.failNext) {
          flags.failNext = false;
          throw new Error('EPERM: transient rename failure');
        }
        return inner.put(record);
      },
      createIfAbsent: (record) => inner.createIfAbsent!(record),
      compareAndSet: (taskId, expectedVersion, next) => inner.compareAndSet(taskId, expectedVersion, next),
      claim: (taskId, holder, leaseMs) => inner.claim(taskId, holder, leaseMs),
      release: (taskId, holder) => inner.release(taskId, holder),
      recoverInterrupted: () => inner.recoverInterrupted(),
      flush: () => inner.flush(),
      close: () => inner.close(),
    };
    const base = {
      taskId: 'rewind_guard',
      deviceId: DEVICE,
      agentId: AGENT,
      goal: '写失败不得回退后续写入',
      kind: 'document' as const,
      state: 'queued' as const,
      version: 1,
      workDir: root,
      toolsets: ['document'],
      artifacts: [],
      attempts: 0,
      maxAttempts: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const first = await store.put(base);
    flags.failNext = true;
    await expect(store.put({ ...first, goal: '失败的写入' })).rejects.toThrow(/EPERM/);
    const second = await store.put({ ...first, goal: '成功的写入' });
    // The failed write must not roll the map back over the successful one.
    expect((await store.get('rewind_guard'))?.goal).toBe('成功的写入');
    expect((await store.get('rewind_guard'))?.version).toBe(second.version);
    await store.close();
  });

  it('counts interrupted tasks as finished instead of hiding them', async () => {
    const root = await makeRoot();
    const { host } = makeHost({ workRoot: root });
    await host.start();
    const record = await host.submit(baseTask({ kind: 'side_effect', toolsets: ['messages.send'] }));
    expect(record.state).toBe('failed');
    const status = await host.status();
    expect(status.finished).toBeGreaterThan(0);
    await host.stop();
  });

  it('never rejects from the background execution chain', async () => {
    const root = await makeRoot();
    const inner = new MemoryAgentHostStore();
    const flags = { failRunning: true };
    const store: AgentHostStore = {
      load: () => inner.load(),
      list: () => inner.list(),
      get: (taskId) => inner.get(taskId),
      put: (record) => inner.put(record),
      createIfAbsent: (record) => inner.createIfAbsent!(record),
      async compareAndSet(taskId, expectedVersion, next) {
        if (flags.failRunning && next.state === 'running') {
          flags.failRunning = false;
          throw new Error('EPERM: transient store write failure');
        }
        return inner.compareAndSet(taskId, expectedVersion, next);
      },
      claim: (taskId, holder, leaseMs) => inner.claim(taskId, holder, leaseMs),
      release: (taskId, holder) => inner.release(taskId, holder),
      recoverInterrupted: () => inner.recoverInterrupted(),
      flush: () => inner.flush(),
      close: () => inner.close(),
    };
    const { host } = makeHost({ workRoot: root, store });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await host.start();
      await host.submit(baseTask());
      await new Promise((resolve) => setTimeout(resolve, 400));
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await host.stop();
    }
    expect(unhandled, 'a store failure must not escape as an unhandled rejection').toEqual([]);
    expect((await host.status()).lastError).toContain('EPERM');
  });
});

describe('V-08 a store without createIfAbsent still cannot lose a race silently', () => {
  it('resolves a lost create race through the idempotency rule', async () => {
    const root = await makeRoot();
    const inner = new MemoryAgentHostStore();
    let interceptNext = true;
    const store: AgentHostStore = {
      load: () => inner.load(),
      list: () => inner.list(),
      get: (taskId) => inner.get(taskId),
      async put(record) {
        const mine = await inner.put({ ...record, version: 2 });
        // Simulate a foreign writer that overwrote the very same row right after
        // our write returned — the re-read must notice and refuse to pretend ours won.
        if (interceptNext) {
          interceptNext = false;
          await inner.put({
            ...record,
            goal: '别的写者',
            version: 3,
            actionDigest: 'foreign-payload-digest',
          });
        }
        return mine;
      },
      compareAndSet: (taskId, expectedVersion, next) => inner.compareAndSet(taskId, expectedVersion, next),
      claim: (taskId, holder, leaseMs) => inner.claim(taskId, holder, leaseMs),
      release: (taskId, holder) => inner.release(taskId, holder),
      recoverInterrupted: () => inner.recoverInterrupted(),
      flush: () => inner.flush(),
      close: () => inner.close(),
    };
    const { host } = makeHost({ workRoot: root, store });
    await host.start();
    await expect(
      host.submit(baseTask({ goal: '我的任务' })),
    ).rejects.toThrow(/idempotency_conflict/);
    expect((await host.list()).length).toBe(1);
    await host.stop();
  });
});
