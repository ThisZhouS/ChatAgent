import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHermesAdapter, type HermesAdapter } from './adapter';
import { computeActionDigest } from './authorization';
import { LocalAgentHost } from './host';
import { handleHostCommand } from './ipc';
import { MemoryAgentHostStore, JsonFileAgentHostStore } from './store';
import {
  assertInsideWorkRoot,
  collectArtifacts,
  isInside,
  sha256Of,
  writeFileIfUnchanged,
} from './sandbox';
import type { LocalTaskInput } from './types';

const DEVICE = 'device_test_1';
const AGENT = 'agent_test_1';

const roots: string[] = [];
async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'chatagent-host-'));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    // The crash-recovery test deliberately leaves a "dead" host writing, and on
    // Windows a delete that races those final writes fails with ENOTEMPTY.
    // Retrying is the documented remedy instead of failing the suite.
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

function makeHost(options: { adapter?: HermesAdapter; workRoot: string; store?: MemoryAgentHostStore }) {
  const store = options.store ?? new MemoryAgentHostStore();
  return {
    store,
    host: new LocalAgentHost({
      deviceId: DEVICE,
      agentId: AGENT,
      workRoot: options.workRoot,
      store,
      adapter: options.adapter ?? new FakeHermesAdapter({ durationMs: 10 }),
      executorReason: 'fake executor in use for tests',
      leaseMs: 5_000,
      defaultTimeoutMs: 3_000,
    }),
  };
}

function baseTask(overrides: Partial<LocalTaskInput> = {}): LocalTaskInput {
  return {
    taskId: `task_${Math.random().toString(36).slice(2, 8)}`,
    agentId: AGENT,
    goal: '生成一份会议纪要',
    kind: 'document',
    workDir: '',
    toolsets: ['document'],
    ...overrides,
  };
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for condition');
}

describe('local agent host lifecycle', () => {
  it('runs a single-device task producing a verifiable artifact', async () => {
    const root = await makeRoot();
    const { host } = makeHost({ workRoot: root });
    await host.start();
    const submitted = await host.submit(baseTask());
    expect(submitted.state).toBe('queued');

    await waitFor(async () => (await host.get(submitted.taskId))?.state === 'succeeded');
    const finished = await host.get(submitted.taskId);
    expect(finished?.executor).toBe('fake');
    expect(finished?.artifacts.length).toBeGreaterThan(0);
    const artifact = finished?.artifacts[0];
    expect(artifact?.sha256).toMatch(/^[a-f0-9]{64}$/);
    // The artifact really exists on disk inside the task directory.
    const onDisk = await readFile(join(finished?.workDir ?? '', artifact?.name ?? ''), 'utf8');
    expect(onDisk).toContain('fake executor');
    await host.stop();
  });

  it('keeps the UI and the agent independent: chat-style calls do not block a run', async () => {
    const root = await makeRoot();
    const { host } = makeHost({ workRoot: root, adapter: new FakeHermesAdapter({ durationMs: 400 }) });
    await host.start();
    const submitted = await host.submit(baseTask());

    // While the task runs, the host still answers status/list/submit requests.
    const startedAt = Date.now();
    const status = await host.status();
    const listed = await host.list();
    const second = await host.submit(baseTask());
    expect(Date.now() - startedAt).toBeLessThan(300);
    expect(status.running).toBe(true);
    expect(listed.length).toBeGreaterThan(0);
    expect(second.state).toBe('queued');

    await waitFor(async () => (await host.get(submitted.taskId))?.state === 'succeeded');
    await host.stop();
  });

  it('recovers a task that was running when the host died, and never calls it succeeded', async () => {
    const root = await makeRoot();
    const store = new MemoryAgentHostStore();
    // A slow executor makes the "running" window observable before the crash.
    const first = makeHost({ workRoot: root, store, adapter: new FakeHermesAdapter({ durationMs: 800 }) });
    await first.host.start();
    const submitted = await first.host.submit(baseTask());
    await waitFor(async () => (await first.host.get(submitted.taskId))?.state === 'running');

    // Simulate a crash: a new store instance read from disk sees `running`.
    const persistedRoot = await makeRoot();
    const fileStore = new JsonFileAgentHostStore(join(persistedRoot, 'tasks.json'));
    await fileStore.load();
    const crashed = { ...(await first.store.get(submitted.taskId))! };
    await fileStore.put(crashed);

    const revived = new LocalAgentHost({
      deviceId: DEVICE,
      agentId: AGENT,
      workRoot: root,
      store: fileStore,
      adapter: new FakeHermesAdapter({ durationMs: 10 }),
      defaultTimeoutMs: 2_000,
    });
    await revived.start();
    const recovered = await revived.get(submitted.taskId);
    expect(recovered?.state).toBe('queued');
    expect(recovered?.error).toBe('host_restart_retry');
    expect(recovered?.summary).toContain('未计为完成');

    await waitFor(async () => (await revived.get(submitted.taskId))?.state === 'succeeded');
    await revived.stop();
    await first.host.stop();
  });

  it('cancels a running task without reporting success', async () => {
    const root = await makeRoot();
    const { host } = makeHost({ workRoot: root, adapter: new FakeHermesAdapter({ durationMs: 300 }) });
    await host.start();
    const submitted = await host.submit(baseTask());
    await waitFor(async () => (await host.get(submitted.taskId))?.state === 'running');

    expect(await host.cancel(submitted.taskId)).toBe(true);
    await waitFor(async () => (await host.get(submitted.taskId))?.state === 'cancelled');
    const record = await host.get(submitted.taskId);
    expect(record?.state).toBe('cancelled');
    expect(record?.artifacts).toEqual([]);
    await host.stop();
  });

  it('pause stops new claims while a running task keeps its outcome', async () => {
    const root = await makeRoot();
    const { host } = makeHost({ workRoot: root, adapter: new FakeHermesAdapter({ durationMs: 50 }) });
    await host.start();
    const running = await host.submit(baseTask());
    await waitFor(async () => (await host.get(running.taskId))?.state === 'running');
    host.pause();

    const queued = await host.submit(baseTask());
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await host.get(queued.taskId))?.state).toBe('queued');

    await waitFor(async () => (await host.get(running.taskId))?.state === 'succeeded');
    host.resume();
    await waitFor(async () => (await host.get(queued.taskId))?.state === 'succeeded');
    await host.stop();
  });

  it('never executes an organization side effect without a verified delegation and approval', async () => {
    const root = await makeRoot();
    const { host } = makeHost({ workRoot: root });
    await host.start();
    const grants = host.authorizationRegistry;
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 1_000).toISOString();
    const issuedAt = new Date().toISOString();

    // No grant registered at all.
    const noDelegation = await host.submit(baseTask({ kind: 'side_effect' }));
    expect(noDelegation.state).toBe('failed');
    expect(noDelegation.blockedReason).toBe('delegation_missing');

    // An id the host never registered is not a delegation, however well formed
    // the caller's idea of it is.
    const unknown = await host.submit(
      baseTask({ kind: 'side_effect', delegationId: 'delegation_never_registered' }),
    );
    expect(unknown.blockedReason).toBe('delegation_unknown');

    grants.grantDelegation({
      id: 'dg_expired',
      ownerId: 'u_owner',
      agentId: AGENT,
      deviceId: DEVICE,
      expiresAt: past,
      capabilities: ['document'],
      issuedAt,
      source: 'test',
    });
    const expired = await host.submit(
      baseTask({ kind: 'side_effect', delegationId: 'dg_expired', approvalId: 'ap_1' }),
    );
    expect(expired.blockedReason).toBe('delegation_expired');

    grants.grantDelegation({
      id: 'dg_ok',
      ownerId: 'u_owner',
      agentId: AGENT,
      deviceId: DEVICE,
      expiresAt: future,
      capabilities: ['document'],
      issuedAt,
      source: 'test',
    });
    grants.grantApproval({
      id: 'ap_pending',
      approved: false,
      expiresAt: future,
      actionDigest: 'digest',
      ownerId: 'u_owner',
      issuedAt,
      source: 'test',
    });
    const notApproved = await host.submit(
      baseTask({ kind: 'side_effect', delegationId: 'dg_ok', approvalId: 'ap_pending' }),
    );
    expect(notApproved.blockedReason).toBe('approval_not_approved');

    // An approval bound to a different payload must not authorize this task.
    grants.grantApproval({
      id: 'ap_other_action',
      approved: true,
      expiresAt: future,
      actionDigest: 'digest-of-something-else',
      ownerId: 'u_owner',
      delegationId: 'dg_ok',
      issuedAt,
      source: 'test',
    });
    const mismatched = await host.submit(
      baseTask({ kind: 'side_effect', delegationId: 'dg_ok', approvalId: 'ap_other_action' }),
    );
    expect(mismatched.blockedReason).toBe('approval_digest_mismatch');

    // The correctly bound approval lets exactly this payload run.
    const approvedTask = baseTask({ kind: 'side_effect', delegationId: 'dg_ok' });
    grants.grantApproval({
      id: 'ap_bound',
      approved: true,
      expiresAt: future,
      actionDigest: computeActionDigest({
        taskId: approvedTask.taskId,
        agentId: AGENT,
        kind: approvedTask.kind,
        goal: approvedTask.goal,
        toolsets: approvedTask.toolsets,
      }),
      ownerId: 'u_owner',
      delegationId: 'dg_ok',
      issuedAt,
      source: 'test',
    });
    const approved = await host.submit({ ...approvedTask, approvalId: 'ap_bound' });
    expect(approved.state).toBe('queued');
    await waitFor(async () => (await host.get(approved.taskId))?.state === 'succeeded');
    await host.stop();
  });

  it('runs a task exactly once even when it is submitted twice', async () => {
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
    await host.submit(task);
    await host.submit(task); // same taskId again
    await waitFor(async () => (await host.get(task.taskId))?.state === 'succeeded');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(runs).toBe(1);
    await host.stop();
  });

  it('refuses a working directory outside the authorized root', async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const { host } = makeHost({ workRoot: root });
    await expect(host.assertWorkDir(outside)).rejects.toThrow(/escapes the authorized work root/);
    expect(isInside(root, join(root, 'a', 'b'))).toBe(true);
  });

  it('records a failed executor run as failed with the exit code, not as success', async () => {
    const root = await makeRoot();
    const { host } = makeHost({ workRoot: root, adapter: new FakeHermesAdapter({ failWith: 'no_provider' }) });
    await host.start();
    const submitted = await host.submit(baseTask());
    await waitFor(async () => (await host.get(submitted.taskId))?.state === 'failed');
    const record = await host.get(submitted.taskId);
    expect(record?.state).toBe('failed');
    expect(record?.error).toContain('no_provider');
    expect(record?.artifacts).toEqual([]);
    await host.stop();
  });
});

describe('work directory and file safety', () => {
  it('does not overwrite a file that changed since it was read', async () => {
    const root = await makeRoot();
    const target = join(root, 'report.md');
    await writeFile(target, 'v1', 'utf8');
    const baseline = sha256Of('v1');

    // Matching baseline: the agent may replace the file it read.
    const updated = await writeFileIfUnchanged(target, 'v2', baseline);
    expect(updated.versioned).toBeUndefined();
    expect(await readFile(target, 'utf8')).toBe('v2');

    // Stale baseline: the employee changed the file, so a new version is written.
    const stale = await writeFileIfUnchanged(target, 'v3', baseline);
    expect(stale.versioned).toBeDefined();
    expect(await readFile(target, 'utf8')).toBe('v2');
    expect(await readFile(stale.versioned as string, 'utf8')).toBe('v3');

    // No baseline at all never clobbers an existing file either.
    const noBaseline = await writeFileIfUnchanged(target, 'v4');
    expect(noBaseline.versioned).toBeDefined();
    expect(await readFile(target, 'utf8')).toBe('v2');
  });

  it('collects hashed artifacts relative to the task directory', async () => {
    const root = await makeRoot();
    await writeFile(join(root, 'a.txt'), 'alpha', 'utf8');
    const artifacts = await collectArtifacts(root);
    expect(artifacts.map((item) => item.name)).toContain('a.txt');
    expect(artifacts[0]?.relativePath).toBe('a.txt');
    expect(artifacts[0]?.bytes).toBe(5);
  });

  it('rejects a symlinked directory that points outside the root', async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    const link = join(root, 'escape');
    try {
      const { symlink } = await import('node:fs/promises');
      await symlink(outside, link, 'junction');
    } catch {
      return; // symlink creation needs privileges on Windows; nothing to assert
    }
    await expect(assertInsideWorkRoot(root, link)).rejects.toThrow(/escapes the authorized work root/);
  });
});

describe('narrow UI command surface', () => {
  it('rejects a caller without the launch token and accepts the validated shape', async () => {
    const root = await makeRoot();
    const { host } = makeHost({ workRoot: root });
    await host.start();
    const token = 'launch-token-1';

    const unauthorized = await handleHostCommand(host, { type: 'status' }, { token }, 'wrong');
    expect(unauthorized.ok).toBe(false);

    const status = await handleHostCommand(host, { type: 'status' }, { token }, token);
    expect(status.ok).toBe(true);

    const invalid = await handleHostCommand(
      host,
      // an unknown field / missing required goal must be refused by the schema
      { type: 'submit', taskId: 'x' } as never,
      { token },
      token,
    );
    expect(invalid.ok).toBe(false);

    const submitted = await handleHostCommand(
      host,
      { type: 'submit', taskId: 'ui_task_1', goal: '整理一份清单', kind: 'document', toolsets: ['document'] },
      { token },
      token,
    );
    expect(submitted.ok).toBe(true);
    await waitFor(async () => (await host.get('ui_task_1'))?.state === 'succeeded');
    await host.stop();
  });
});
