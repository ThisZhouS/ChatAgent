import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHermesAdapter, type HermesAdapter } from './adapter';
import { computeActionDigest, TrustedAuthorizationRegistry } from './authorization';
import { LocalAgentHost } from './host';
import { handleHostCommand } from './ipc';
import { AgentHostStoreLockedError, JsonFileAgentHostStore, MemoryAgentHostStore } from './store';
import type { AgentHostStore } from './store';
import type { LocalTaskInput, LocalTaskRecord } from './types';

/**
 * Regression suite for the Gate 7A.1 findings (H-01 … H-06) from
 * docs/review-2026-09-15-host-gaps-roadmap.md.
 *
 * Each test asserts the *safe* behaviour; the review's probes asserted the bug.
 */

const DEVICE = 'device_security_1';
const AGENT = 'agent_security_1';

const roots: string[] = [];
async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'chatagent-host-security-'));
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
  adapter?: HermesAdapter;
  workRoot: string;
  store?: AgentHostStore;
  authorizations?: TrustedAuthorizationRegistry;
  stopTimeoutMs?: number;
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
    stopTimeoutMs: options.stopTimeoutMs ?? 500,
  });
  hosts.push(host);
  return { host, store };
}

function baseTask(overrides: Partial<LocalTaskInput> = {}): LocalTaskInput {
  return {
    taskId: `secure_${Math.random().toString(36).slice(2, 10)}`,
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

/** Registers a valid delegation + a matching approval for one exact payload. */
function approvePayload(
  registry: TrustedAuthorizationRegistry,
  task: LocalTaskInput,
  options: { delegationId?: string; approvalId?: string; capabilities?: string[]; expiresAt?: string } = {},
): { delegationId: string; approvalId: string } {
  const delegationId = options.delegationId ?? `dg_${task.taskId}`;
  const approvalId = options.approvalId ?? `ap_${task.taskId}`;
  const expiresAt = options.expiresAt ?? new Date(Date.now() + 60_000).toISOString();
  const issuedAt = new Date().toISOString();
  registry.grantDelegation({
    id: delegationId,
    ownerId: 'u_owner',
    agentId: AGENT,
    deviceId: DEVICE,
    expiresAt,
    capabilities: options.capabilities ?? task.toolsets,
    issuedAt,
    source: 'test',
  });
  registry.grantApproval({
    id: approvalId,
    approved: true,
    expiresAt,
    actionDigest: computeActionDigest({
      taskId: task.taskId,
      agentId: task.agentId,
      kind: task.kind,
      goal: task.goal,
      toolsets: task.toolsets,
    }),
    ownerId: 'u_owner',
    delegationId,
    issuedAt,
    source: 'test',
  });
  return { delegationId, approvalId };
}

describe('H-01 idempotent submission', () => {
  it('never runs a completed task again when the same id is submitted twice', async () => {
    const root = await makeRoot();
    let runs = 0;
    const counting: HermesAdapter = {
      kind: 'fake',
      run: async (request) => {
        runs += 1;
        return new FakeHermesAdapter({ durationMs: 5 }).run(request);
      },
    };
    const { host } = makeHost({ workRoot: root, adapter: counting });
    await host.start();

    const task = baseTask();
    const first = await host.submit(task);
    await waitFor(async () => (await host.get(task.taskId))?.state === 'succeeded');
    const afterSuccess = await host.get(task.taskId);

    const replay = await host.submit(task);
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(runs).toBe(1);
    expect(replay.taskId).toBe(task.taskId);
    expect(replay.state).toBe('succeeded');
    expect(replay.version).toBe(afterSuccess?.version);
    expect((await host.list()).filter((item) => item.taskId === task.taskId)).toHaveLength(1);
    await host.stop();
  });

  it('rejects the same taskId used with a different payload', async () => {
    const root = await makeRoot();
    const { host } = makeHost({ workRoot: root });
    await host.start();
    const task = baseTask();
    await host.submit(task);
    await waitFor(async () => (await host.get(task.taskId))?.state === 'succeeded');

    await expect(host.submit({ ...task, goal: '完全不同的目标' })).rejects.toThrow(/idempotency_conflict/);
    const record = await host.get(task.taskId);
    expect(record?.goal).toBe(task.goal);
    await host.stop();
  });

  it('only re-runs a failed local task through an explicit retry', async () => {
    const root = await makeRoot();
    let runs = 0;
    const flaky: HermesAdapter = {
      kind: 'fake',
      run: async (request) => {
        runs += 1;
        return runs === 1
          ? { executor: 'fake', exitCode: 1, output: '', artifacts: [], audit: [], durationMs: 1, failure: { kind: 'executor_error', message: 'synthetic failure' } }
          : new FakeHermesAdapter({ durationMs: 5 }).run(request);
      },
    };
    const { host } = makeHost({ workRoot: root, adapter: flaky });
    await host.start();
    const task = baseTask();
    await host.submit(task);
    await waitFor(async () => (await host.get(task.taskId))?.state === 'failed');

    // Submitting again must not re-run it…
    await host.submit(task);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runs).toBe(1);

    // …while an explicit retry does, exactly once.
    const retried = await host.retry(task.taskId);
    expect(retried?.state).toBe('queued');
    await waitFor(async () => (await host.get(task.taskId))?.state === 'succeeded');
    expect(runs).toBe(2);
    await host.stop();
  });

  it('keeps a side-effect task out of automated retry', async () => {
    const root = await makeRoot();
    const { host } = makeHost({ workRoot: root });
    await host.start();
    const task = baseTask({ kind: 'side_effect' });
    const submitted = await host.submit(task);
    expect(submitted.state).toBe('failed');
    expect(await host.retry(task.taskId)).toBeUndefined();
    await host.stop();
  });
});

describe('H-02 trusted authorization', () => {
  it('ignores a caller-supplied delegation/approval object at the command surface', async () => {
    const root = await makeRoot();
    let runs = 0;
    const { host } = makeHost({
      workRoot: root,
      adapter: { kind: 'fake', run: async (request) => { runs += 1; return new FakeHermesAdapter({ durationMs: 5 }).run(request); } },
    });
    await host.start();
    const token = 'security-token';

    const forged = await handleHostCommand(
      host,
      {
        type: 'submit',
        taskId: 'forged_side_effect',
        goal: 'synthetic only',
        kind: 'side_effect',
        toolsets: ['document'],
        // The old surface accepted these; the schema now refuses them outright.
        delegation: {
          ownerId: 'unverified-owner',
          agentId: 'wrong-agent',
          deviceId: DEVICE,
          expiresAt: 'not-a-date',
          capabilities: [],
        },
        approval: { id: 'unverified', approved: true, expiresAt: 'not-a-date', actionDigest: 'unbound' },
      } as never,
      { token },
      token,
    );

    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.error).toBe('invalid_command');
    expect(runs).toBe(0);
    expect(await host.get('forged_side_effect')).toBeUndefined();
    await host.stop();
  });

  it('refuses an unregistered approval id and a capability the delegation lacks', async () => {
    const root = await makeRoot();
    const registry = new TrustedAuthorizationRegistry();
    let runs = 0;
    const { host } = makeHost({
      workRoot: root,
      authorizations: registry,
      adapter: { kind: 'fake', run: async (request) => { runs += 1; return new FakeHermesAdapter({ durationMs: 5 }).run(request); } },
    });
    await host.start();
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();

    registry.grantDelegation({
      id: 'dg_narrow',
      ownerId: 'u_owner',
      agentId: AGENT,
      deviceId: DEVICE,
      expiresAt,
      capabilities: ['document.read'],
      issuedAt,
      source: 'test',
    });

    const wrongCapability = await host.submit(
      baseTask({ kind: 'side_effect', toolsets: ['document'], delegationId: 'dg_narrow', approvalId: 'ap_missing' }),
    );
    expect(wrongCapability.blockedReason).toBe('capability_not_granted');

    registry.grantDelegation({
      id: 'dg_wide',
      ownerId: 'u_owner',
      agentId: AGENT,
      deviceId: DEVICE,
      expiresAt,
      capabilities: ['document'],
      issuedAt,
      source: 'test',
    });
    const unknownApproval = await host.submit(
      baseTask({ kind: 'side_effect', toolsets: ['document'], delegationId: 'dg_wide', approvalId: 'ap_never_registered' }),
    );
    expect(unknownApproval.blockedReason).toBe('approval_unknown');
    expect(runs).toBe(0);
    await host.stop();
  });

  it('re-checks authorization before running and drops a revoked delegation', async () => {
    const root = await makeRoot();
    const registry = new TrustedAuthorizationRegistry();
    let runs = 0;
    const { host } = makeHost({
      workRoot: root,
      authorizations: registry,
      adapter: { kind: 'fake', run: async (request) => { runs += 1; return new FakeHermesAdapter({ durationMs: 5 }).run(request); } },
    });
    await host.start();
    host.pause(); // keep the task queued while we revoke the grant

    const task = baseTask({ kind: 'side_effect' });
    const refs = approvePayload(registry, task);
    const submitted = await host.submit({ ...task, ...refs });
    expect(submitted.state).toBe('queued');

    registry.revokeDelegation(refs.delegationId);
    host.resume();
    await waitFor(async () => (await host.get(task.taskId))?.state === 'failed');

    const record = await host.get(task.taskId);
    expect(record?.blockedReason).toBe('delegation_unknown');
    expect(record?.summary).toContain('执行前复核未通过');
    expect(runs).toBe(0);
    await host.stop();
  });

  it('rejects a delegation issued for another device or agent', async () => {
    const root = await makeRoot();
    const registry = new TrustedAuthorizationRegistry();
    const { host } = makeHost({ workRoot: root, authorizations: registry });
    await host.start();
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    registry.grantDelegation({
      id: 'dg_other_device',
      ownerId: 'u_owner',
      agentId: AGENT,
      deviceId: 'another-device',
      expiresAt,
      capabilities: ['document'],
      issuedAt,
      source: 'test',
    });
    registry.grantDelegation({
      id: 'dg_other_agent',
      ownerId: 'u_owner',
      agentId: 'another-agent',
      deviceId: DEVICE,
      expiresAt,
      capabilities: ['document'],
      issuedAt,
      source: 'test',
    });

    const device = await host.submit(baseTask({ kind: 'side_effect', delegationId: 'dg_other_device' }));
    expect(device.blockedReason).toBe('delegation_unknown');
    const agent = await host.submit(baseTask({ kind: 'side_effect', delegationId: 'dg_other_agent' }));
    expect(agent.blockedReason).toBe('agent_mismatch');
    await host.stop();
  });
});

describe('H-03 durable writes are not swallowed', () => {
  it('rejects a submission when the store cannot write', async () => {
    const root = await makeRoot();
    const memory = new MemoryAgentHostStore();
    const failing: AgentHostStore = {
      load: () => memory.load(),
      list: () => memory.list(),
      get: (taskId) => memory.get(taskId),
      put: async () => {
        throw new Error('synthetic disk failure');
      },
      compareAndSet: (taskId, version, next) => memory.compareAndSet(taskId, version, next),
      claim: (taskId, holder, leaseMs) => memory.claim(taskId, holder, leaseMs),
      release: (taskId, holder) => memory.release(taskId, holder),
      recoverInterrupted: () => memory.recoverInterrupted(),
      flush: () => memory.flush(),
      close: () => memory.close(),
    };
    const { host } = makeHost({ workRoot: root, store: failing });
    await host.start();

    await expect(host.submit(baseTask())).rejects.toThrow(/task store write failed/);
    expect(await host.list()).toHaveLength(0);
    expect((await host.status()).lastError).toContain('store_write_failed');
    await host.stop();
  });

  it('reports a store failure at command level instead of acknowledging the task', async () => {
    const root = await makeRoot();
    const memory = new MemoryAgentHostStore();
    const failing: AgentHostStore = {
      load: () => memory.load(),
      list: () => memory.list(),
      get: (taskId) => memory.get(taskId),
      put: async () => {
        throw new Error('synthetic disk failure');
      },
      compareAndSet: (taskId, version, next) => memory.compareAndSet(taskId, version, next),
      claim: (taskId, holder, leaseMs) => memory.claim(taskId, holder, leaseMs),
      release: (taskId, holder) => memory.release(taskId, holder),
      recoverInterrupted: () => memory.recoverInterrupted(),
      flush: () => memory.flush(),
      close: () => memory.close(),
    };
    const { host } = makeHost({ workRoot: root, store: failing });
    await host.start();
    const token = 'security-token';
    const response = await handleHostCommand(
      host,
      { type: 'submit', taskId: 'write_failure', goal: '整理清单', kind: 'document', toolsets: ['document'] },
      { token },
      token,
    );
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error).toBe('host_error');
    await host.stop();
  });

  it('does not keep an updated record in memory when the JSON store cannot write', async () => {
    const root = await makeRoot();
    const storeDir = await makeRoot();
    const store = new JsonFileAgentHostStore(join(storeDir, 'tasks.json'));
    await store.load();
    // Make the target unwritable by turning the file path into a directory.
    await rm(join(storeDir, 'tasks.json'), { force: true });
    const blocked = join(storeDir, 'tasks.json');
    await (await import('node:fs/promises')).mkdir(blocked, { recursive: true });

    const record: LocalTaskRecord = {
      taskId: 'unwritable',
      deviceId: DEVICE,
      agentId: AGENT,
      goal: 'synthetic',
      kind: 'document',
      state: 'queued',
      version: 0,
      workDir: root,
      toolsets: ['document'],
      artifacts: [],
      attempts: 0,
      maxAttempts: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await expect(store.put(record)).rejects.toThrow();
    await store.close();
  });
});

describe('H-04 terminal states survive late results', () => {
  it('does not let a success that arrives after a stop overwrite cancelled', async () => {
    const root = await makeRoot();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: HermesAdapter = {
      kind: 'fake',
      // Deliberately ignores the abort signal: the worst case for the host.
      run: async (request) => {
        await gate;
        return new FakeHermesAdapter({ durationMs: 5 }).run(request);
      },
    };
    const { host } = makeHost({ workRoot: root, adapter: slow, stopTimeoutMs: 100 });
    await host.start();
    const task = baseTask();
    await host.submit(task);
    await waitFor(async () => (await host.get(task.taskId))?.state === 'running');

    await host.stop('app_quit');
    const cancelled = await host.get(task.taskId);
    expect(cancelled?.state).toBe('cancelled');

    release?.();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = await host.get(task.taskId);
    expect(after?.state).toBe('cancelled');
    expect(after?.version).toBe(cancelled?.version);
    expect((await host.status()).lateResultsDropped).toBeGreaterThan(0);
  });

  it('does not let a success that arrives after cancel overwrite cancelled', async () => {
    const root = await makeRoot();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: HermesAdapter = {
      kind: 'fake',
      run: async (request) => {
        await gate;
        return new FakeHermesAdapter({ durationMs: 5 }).run(request);
      },
    };
    const { host } = makeHost({ workRoot: root, adapter: slow });
    await host.start();
    const task = baseTask();
    await host.submit(task);
    await waitFor(async () => (await host.get(task.taskId))?.state === 'running');

    expect(await host.cancel(task.taskId)).toBe(true);
    await waitFor(async () => (await host.get(task.taskId))?.state === 'cancelled');
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const record = await host.get(task.taskId);
    expect(record?.state).toBe('cancelled');
    expect(record?.artifacts).toEqual([]);
    await host.stop();
  });
});

describe('H-05 single writer', () => {
  it('refuses a second store instance for the same task file while the first holds the lock', async () => {
    const dir = await makeRoot();
    const file = join(dir, 'tasks.json');
    const first = new JsonFileAgentHostStore(file);
    await first.load();

    const second = new JsonFileAgentHostStore(file);
    await expect(second.load()).rejects.toBeInstanceOf(AgentHostStoreLockedError);

    await first.close();
    const third = new JsonFileAgentHostStore(file);
    await third.load();
    await third.close();
  });

  it('takes over a lock left behind by a dead process', async () => {
    const dir = await makeRoot();
    const file = join(dir, 'tasks.json');
    await writeFile(
      `${file}.lock`,
      JSON.stringify({ pid: 2 ** 30, startedAt: new Date().toISOString() }),
      'utf8',
    );
    const store = new JsonFileAgentHostStore(file);
    await store.load();
    const lock = JSON.parse(await readFile(`${file}.lock`, 'utf8')) as { pid: number };
    expect(lock.pid).toBe(process.pid);
    await store.close();
  });

  it('leaves no lock file behind after close', async () => {
    const dir = await makeRoot();
    const file = join(dir, 'tasks.json');
    const store = new JsonFileAgentHostStore(file);
    await store.load();
    await store.put({
      taskId: 'lock_check',
      deviceId: DEVICE,
      agentId: AGENT,
      goal: 'synthetic',
      kind: 'document',
      state: 'queued',
      version: 0,
      workDir: dir,
      toolsets: ['document'],
      artifacts: [],
      attempts: 0,
      maxAttempts: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await store.close();
    await expect(readFile(`${file}.lock`, 'utf8')).rejects.toThrow();
    // The data itself survived.
    const reloaded = new JsonFileAgentHostStore(file);
    await reloaded.load();
    expect((await reloaded.list()).map((item) => item.taskId)).toEqual(['lock_check']);
    await reloaded.close();
  });
});

describe('H-06 one IPC contract', () => {
  it('returns { tasks } so the workbench can read result.tasks', async () => {
    const root = await makeRoot();
    const { host } = makeHost({ workRoot: root });
    await host.start();
    const token = 'security-token';
    const task = baseTask();
    await host.submit(task);

    const listed = await handleHostCommand(host, { type: 'list' }, { token }, token);
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      const result = listed.result as { tasks?: LocalTaskRecord[]; total?: number };
      expect(Array.isArray(result.tasks)).toBe(true);
      expect(result.tasks?.map((item) => item.taskId)).toContain(task.taskId);
      expect(result.tasks?.[0]?.version).toBeGreaterThan(0);
      expect(result.total).toBe(result.tasks?.length);
    }
    await host.stop();
  });

  it('lists newest first and never returns an unbounded page', async () => {
    const root = await makeRoot();
    // Seeded directly: the ordering contract is what is under test, and real
    // submit() timestamps land in the same millisecond while a task is running.
    const store = new MemoryAgentHostStore();
    const { host } = makeHost({ workRoot: root, store });
    await host.start();
    const token = 'security-token';
    for (const [taskId, updatedAt, version] of [
      ['oldest', '2026-09-16T00:00:00.000Z', 1],
      ['middle', '2026-09-16T01:00:00.000Z', 1],
      ['newest', '2026-09-16T02:00:00.000Z', 1],
    ] as const) {
      await store.put({
        ...baseTask({ taskId, workDir: join(root, taskId) }),
        deviceId: DEVICE,
        state: 'succeeded',
        version,
        artifacts: [],
        attempts: 1,
        maxAttempts: 2,
        createdAt: updatedAt,
        updatedAt,
      });
    }

    const two = await handleHostCommand(host, { type: 'list', limit: 2 }, { token }, token);
    expect(two.ok).toBe(true);
    if (two.ok) {
      const result = two.result as { tasks?: LocalTaskRecord[]; total?: number };
      expect(result.tasks?.map((item) => item.taskId)).toEqual(['newest', 'middle']);
      // The page is capped but the total is honest, so the UI can say what it hides.
      expect(result.total).toBe(3);
    }

    const refused = await handleHostCommand(host, { type: 'list', limit: 0 }, { token }, token);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe('invalid_command');
    const tooMany = await handleHostCommand(host, { type: 'list', limit: 5000 }, { token }, token);
    expect(tooMany.ok).toBe(false);
    await host.stop();
  });

  it('exposes the verified delegation snapshot for audit after a blocked side effect', async () => {
    const root = await makeRoot();
    const registry = new TrustedAuthorizationRegistry();
    const { host } = makeHost({ workRoot: root, authorizations: registry });
    await host.start();
    const task = baseTask({ kind: 'side_effect' });
    const refs = approvePayload(registry, task);
    await host.submit({ ...task, ...refs });
    await waitFor(async () => (await host.get(task.taskId))?.state === 'succeeded');
    const record = await host.get(task.taskId);
    expect(record?.delegationId).toBe(refs.delegationId);
    expect(record?.approvalId).toBe(refs.approvalId);
    expect(record?.actionDigest).toMatch(/^[a-f0-9]{64}$/);
    await host.stop();
  });
});

/**
 * Regression suite for the round-3 adversarial findings (F1, F7) in
 * Temp/verify-round3/REPORT.md. The probe asserted the bug; these assert the
 * safe behaviour that replaced it.
 */
describe('H-07 quarantined rows and the capability floor', () => {
  it('never executes a quarantined row, not even after retry() or an IPC retry', async () => {
    const root = await makeRoot();
    const file = join(root, 'tasks.json');
    await writeFile(
      file,
      JSON.stringify([
        // Quarantined: no workDir, so the loader must not trust the row.
        { ...baseTask({ taskId: 'q-dir', workDir: '' }), state: 'failed', version: 1 },
        // Quarantined: an unknown kind.
        { ...baseTask({ taskId: 'q-kind', workDir: join(root, 'q-kind') }), kind: 'shell', state: 'failed', version: 1 },
        // Quarantined: toolset names that are not a list.
        { ...baseTask({ taskId: 'q-tools', workDir: join(root, 'q-tools') }), toolsets: 'terminal', state: 'failed', version: 1 },
        // Runnable shape, but no capability at all: refused by the floor, not run.
        { ...baseTask({ taskId: 'q-empty', workDir: join(root, 'q-empty') }), toolsets: [], state: 'queued', version: 1 },
      ]),
      'utf8',
    );
    const calls: string[] = [];
    const adapter: HermesAdapter = {
      kind: 'fake',
      async run(request: Parameters<HermesAdapter['run']>[0]) {
        calls.push(request.taskId);
        throw new Error('a quarantined row must never reach the executor');
      },
    } as unknown as HermesAdapter;
    const store = new JsonFileAgentHostStore(file);
    const { host } = makeHost({ workRoot: root, store, adapter });
    await host.start();

    for (const taskId of ['q-dir', 'q-kind', 'q-tools']) {
      const record = await host.get(taskId);
      expect(record?.state).toBe('failed');
      expect(record?.blockedReason).toBe('invalid_persisted_row');
      expect(await host.retry(taskId)).toBeUndefined();
    }
    // The empty-capability row passes row validation but is refused by the floor.
    await waitFor(async () => (await host.get('q-empty'))?.state === 'failed');
    const empty = await host.get('q-empty');
    expect([empty?.state, empty?.blockedReason]).toEqual(['failed', 'capability_not_granted']);
    expect(await host.retry('q-empty')).toBeUndefined();

    const token = 'security-token';
    const ipc = await handleHostCommand(host, { type: 'retry', taskId: 'q-dir' }, { token }, token);
    expect(ipc.ok).toBe(false);
    if (!ipc.ok) expect(ipc.error).toBe('retry_refused');
    expect(calls).toEqual([]);
    await host.stop();
  });

  it('refuses an empty, blank or wrong-typed toolset list instead of substituting a capability', async () => {
    const root = await makeRoot();
    const calls: string[] = [];
    const adapter: HermesAdapter = {
      kind: 'fake',
      async run(request) {
        calls.push(request.taskId);
        return {
          executor: 'fake',
          exitCode: 0,
          output: '',
          artifacts: [],
          audit: ['recording adapter'],
          durationMs: 1,
        };
      },
    };
    const { host } = makeHost({ workRoot: root, adapter });
    await host.start();

    for (const [label, toolsets] of [
      ['blank', ['']],
      ['spaces', ['   ']],
      ['number', 7],
      ['string', 'document'],
    ] as Array<[string, unknown]>) {
      const record = await host.submit({
        ...baseTask({ taskId: `floor-${label}`, workDir: join(root, label) }),
        toolsets: toolsets as string[],
      });
      expect([label, record.state, record.blockedReason]).toEqual([
        label,
        'failed',
        'capability_not_granted',
      ]);
    }
    // An omitted (or empty) toolset at this trusted surface keeps the documented
    // default instead of being refused: the IPC contract defaults the same way.
    for (const [label, toolsets] of [
      ['omitted', undefined],
      ['empty', []],
    ] as Array<[string, unknown]>) {
      const record = await host.submit({
        ...baseTask({ taskId: `floor-${label}`, workDir: join(root, label) }),
        toolsets: toolsets as string[],
      });
      expect([label, record.toolsets]).toEqual([label, ['document']]);
    }
    // Only the two defaulted rows are runnable; every refused row above stayed out.
    await waitFor(async () => calls.length === 2);
    expect(calls.sort()).toEqual(['floor-empty', 'floor-omitted']);
    await host.stop();
  });
});
