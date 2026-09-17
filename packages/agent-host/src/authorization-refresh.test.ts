/**
 * Continuous authorization refresh (Gate 7A.2 remainder).
 *
 * A long-resident host holds delegations/approvals in memory. Three things must
 * be true:
 *  1. the organization service can invalidate a grant after the fact, and pending
 *     work that needs it must not run;
 *  2. when the service cannot be reached the host fails closed for *new*
 *     side-effect work — while local document work keeps working offline;
 *  3. nothing that is already running is rolled back, and held work is not failed:
 *     it runs once a check succeeds again.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHermesAdapter } from './adapter';
import {
  computeActionDigest,
  TrustedAuthorizationRegistry,
  type AuthorizationVerification,
} from './authorization';
import { LocalAgentHost } from './host';
import { JsonFileAgentHostStore } from './store';
import type { LocalTaskInput } from './types';

const DEVICE = 'device-1';
const AGENT = 'hermes';
const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'chatagent-authz-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 3 });
});

/**
 * Waits for a condition instead of sleeping a fixed number of times: the whole
 * suite runs in parallel, so a fixed budget is a flake waiting to happen.
 */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for condition');
}

function delegation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'delegation-1',
    ownerId: 'employee-1',
    agentId: AGENT,
    deviceId: DEVICE,
    capabilities: ['browser'],
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    source: 'organization-server' as const,
    ...overrides,
  };
}

function approval(overrides: Record<string, unknown> = {}) {
  return {
    id: 'approval-1',
    ownerId: 'employee-1',
    approved: true,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    source: 'organization-server' as const,
    actionDigest: computeActionDigest({
      taskId: 'unused',
      agentId: AGENT,
      kind: 'side_effect',
      goal: 'unused',
      toolsets: ['browser'],
    }),
    ...overrides,
  };
}

/** A side-effect task plus the grants it needs (approval bound to its exact payload). */
function sideEffectTask(
  taskId: string,
  workRoot: string,
): { input: LocalTaskInput; digest: string } {
  const input: LocalTaskInput = {
    taskId,
    agentId: AGENT,
    goal: `副作用任务 ${taskId}`,
    kind: 'side_effect',
    workDir: join(workRoot, taskId),
    toolsets: ['browser'],
    delegationId: 'delegation-1',
    approvalId: 'approval-1',
  };
  return { input, digest: computeActionDigest(input) };
}

function documentTask(taskId: string, workRoot: string): LocalTaskInput {
  return {
    taskId,
    agentId: AGENT,
    goal: `本地文档任务 ${taskId}`,
    kind: 'document',
    workDir: join(workRoot, taskId),
    toolsets: ['document'],
  };
}

describe('registry: applying an organization-service answer', () => {
  it('refreshes a still-valid grant instead of forcing re-authorization', () => {
    const registry = new TrustedAuthorizationRegistry();
    registry.grantDelegation(delegation());
    const later = new Date(Date.now() + 7200_000).toISOString();
    const applied = registry.applyVerification(
      [{ id: 'delegation-1', kind: 'delegation', status: 'active', expiresAt: later }],
      Date.now(),
    );
    expect(applied).toEqual({ refreshed: 1, revoked: 0, unverifiable: 0 });
    expect(registry.getDelegation('delegation-1')?.expiresAt).toBe(later);
    expect(registry.refreshStatus().state).toBe('idle');
  });

  it('removes a revoked or expired grant so the pre-run re-check blocks it', () => {
    const registry = new TrustedAuthorizationRegistry();
    registry.grantDelegation(delegation());
    registry.grantApproval(approval());
    registry.applyVerification(
      [
        { id: 'delegation-1', kind: 'delegation', status: 'revoked' },
        { id: 'approval-1', kind: 'approval', status: 'expired' },
      ],
      Date.now(),
    );
    expect(registry.getDelegation('delegation-1')).toBeUndefined();
    expect(registry.getApproval('approval-1')).toBeUndefined();
    expect(registry.refreshStatus().revoked).toBe(2);
  });

  it('marks an unanswerable grant unverifiable without destroying it', () => {
    const registry = new TrustedAuthorizationRegistry();
    registry.grantDelegation(delegation());
    const applied = registry.applyVerification(
      [{ id: 'delegation-1', kind: 'delegation', status: 'unknown' }],
      Date.now(),
    );
    expect(applied.unverifiable).toBe(1);
    expect(registry.getDelegation('delegation-1')).toBeDefined();
    expect(registry.isGrantUnverifiable('delegation', 'delegation-1')).toBe(true);
    expect(
      registry.grantsAreUsable({
        kind: 'side_effect',
        delegationId: 'delegation-1',
        approvalId: 'approval-1',
      }),
    ).toBe(false);
    // A later `active` answer clears the mark: the grant was never thrown away.
    registry.applyVerification([{ id: 'delegation-1', kind: 'delegation', status: 'active' }], Date.now());
    expect(registry.isGrantUnverifiable('delegation', 'delegation-1')).toBe(false);
  });

  it('treats a failed check as unverified for every side-effect grant but not for documents', () => {
    const registry = new TrustedAuthorizationRegistry();
    registry.grantDelegation(delegation());
    registry.markCheckFailed('network down', Date.now());
    expect(registry.isUnverified()).toBe(true);
    expect(registry.grantsAreUsable({ kind: 'side_effect', delegationId: 'delegation-1' })).toBe(false);
    // Offline local document work is the reason the on-device host exists.
    expect(registry.grantsAreUsable({ kind: 'document' })).toBe(true);
    registry.markChecked(Date.now());
    expect(registry.isUnverified()).toBe(false);
    const status = registry.refreshStatus();
    expect(status).toMatchObject({ state: 'ok', checks: 1, failures: 1 });
    expect(status.lastCheckAt).toBeDefined();
  });

  it('only asks about grants it actually holds', () => {
    const registry = new TrustedAuthorizationRegistry();
    registry.grantDelegation(delegation());
    registry.grantApproval(approval());
    expect(registry.outstanding()).toEqual([
      { id: 'delegation-1', kind: 'delegation' },
      { id: 'approval-1', kind: 'approval' },
    ]);
    expect(registry.outstanding(['approval-1'])).toEqual([{ id: 'approval-1', kind: 'approval' }]);
    // An answer about a grant we dropped must not resurrect it.
    registry.revokeDelegation('delegation-1');
    registry.applyVerification([{ id: 'delegation-1', kind: 'delegation', status: 'active' }], Date.now());
    expect(registry.getDelegation('delegation-1')).toBeUndefined();
  });
});

describe('host: continuous authorization refresh', () => {
  it('does not run work whose delegation the service revoked after submission', async () => {
    const root = await makeRoot();
    const calls: string[] = [];
    const inner = new FakeHermesAdapter({ durationMs: 5 });
    const registry = new TrustedAuthorizationRegistry();
    const { input, digest } = sideEffectTask('t-revoked', root);
    registry.grantDelegation(delegation());
    registry.grantApproval(approval({ actionDigest: digest }));
    let answer: AuthorizationVerification[] = [];
    const host = new LocalAgentHost({
      deviceId: DEVICE,
      agentId: AGENT,
      workRoot: join(root, 'work'),
      store: new JsonFileAgentHostStore(join(root, 'tasks.json')),
      adapter: {
        kind: inner.kind,
        async run(request) {
          calls.push(request.taskId);
          return inner.run(request);
        },
      },
      authorizations: registry,
      authorizationRefresh: { verify: async () => answer, intervalMs: 10_000 },
    });
    await host.start();
    await host.pause(); // hold the queue so we can revoke before dispatch
    const record = await host.submit(input);
    expect(record.state).toBe('queued');
    answer = [{ id: 'delegation-1', kind: 'delegation', status: 'revoked' }];
    await host.refreshAuthorization();
    expect(registry.getDelegation('delegation-1')).toBeUndefined();
    await host.resume();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = await host.get('t-revoked');
    expect(calls).toEqual([]);
    expect(after?.state).toBe('failed');
    expect(after?.blockedReason).toBe('delegation_unknown');
    await host.close();
  });

  it('holds new side-effect work while the check fails, without touching running work', async () => {
    const root = await makeRoot();
    const calls: string[] = [];
    const inner = new FakeHermesAdapter({ durationMs: 150 });
    const registry = new TrustedAuthorizationRegistry();
    const first = sideEffectTask('t-running', root);
    // Each side effect carries its own single-use approval, bound to its payload.
    const secondInput: LocalTaskInput = { ...sideEffectTask('t-held', root).input, approvalId: 'approval-2' };
    registry.grantDelegation(delegation());
    registry.grantApproval(approval({ id: 'approval-1', actionDigest: first.digest }));
    registry.grantApproval(approval({ id: 'approval-2', actionDigest: computeActionDigest(secondInput) }));
    let fail = false;
    const host = new LocalAgentHost({
      deviceId: DEVICE,
      agentId: AGENT,
      workRoot: join(root, 'work'),
      store: new JsonFileAgentHostStore(join(root, 'tasks.json')),
      adapter: {
        kind: inner.kind,
        async run(request) {
          calls.push(request.taskId);
          return inner.run(request);
        },
      },
      authorizations: registry,
      authorizationRefresh: {
        verify: async () => {
          // Only the approval that is still valid is vouched for.
          if (fail) throw new Error('organization service unreachable');
          return [];
        },
      },
    });
    await host.start();
    await host.submit(first.input);
    await waitFor(async () => (await host.get('t-running'))?.state === 'running');
    fail = true;
    await host.refreshAuthorization();
    let status = await host.status();
    expect(status.authorization?.state).toBe('unverified');
    expect(status.authorization?.failures).toBe(1);
    expect(status.authorization?.lastError).toMatch(/unreachable/);

    const held = await host.submit(secondInput);
    expect(held.state).toBe('queued');
    const doc = await host.submit(documentTask('t-doc', root));
    expect(doc.state).toBe('queued');

    // The running task is never disturbed; only the new side effect is held.
    await waitFor(async () => (await host.get('t-running'))?.state === 'succeeded');
    expect((await host.get('t-running'))?.state).toBe('succeeded');
    status = await host.status();
    expect(status.authorization?.heldTasks).toBe(1);
    expect(status.authorization?.heldSince).toBeDefined();
    expect((await host.get('t-held'))?.state).toBe('queued');
    expect(calls).not.toContain('t-held');

    // Local document work still runs while the organization service is down.
    await waitFor(async () => (await host.get('t-doc'))?.state === 'succeeded');
    expect((await host.get('t-doc'))?.state).toBe('succeeded');
    // The running task finished and the offline document task ran; only the held
    // side effect never started.
    expect(calls.sort()).toEqual(['t-doc', 't-running']);

    // A successful check releases the held task: it runs, it was never failed.
    fail = false;
    await host.refreshAuthorization();
    await waitFor(async () => (await host.get('t-held'))?.state === 'succeeded');
    expect((await host.get('t-held'))?.state).toBe('succeeded');
    expect(calls).toContain('t-held');
    const recovered = await host.status();
    // Two successful checks (startup + recovery) and one recorded failure.
    expect(recovered.authorization).toMatchObject({ state: 'ok', heldTasks: 0, checks: 2, failures: 1 });
    expect(recovered.authorization?.heldSince).toBeUndefined();
    await host.close();
  }, 30000);

  it('holds a task whose grant the service cannot vouch for, without deleting the grant', async () => {
    const root = await makeRoot();
    const registry = new TrustedAuthorizationRegistry();
    const { input, digest } = sideEffectTask('t-unknown', root);
    registry.grantDelegation(delegation());
    registry.grantApproval(approval({ actionDigest: digest }));
    const adapter = new FakeHermesAdapter({ durationMs: 5 });
    const host = new LocalAgentHost({
      deviceId: DEVICE,
      agentId: AGENT,
      workRoot: join(root, 'work'),
      store: new JsonFileAgentHostStore(join(root, 'tasks.json')),
      adapter,
      authorizations: registry,
      authorizationRefresh: {
        verify: async () =>
          [
            { id: 'delegation-1', kind: 'delegation', status: 'unknown' },
          ] as AuthorizationVerification[],
      },
    });
    await host.start();
    await host.pause();
    await host.submit(input);
    await host.refreshAuthorization();
    await host.resume();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await host.get('t-unknown'))?.state).toBe('queued');
    expect(registry.getDelegation('delegation-1')).toBeDefined();
    expect((await host.status()).authorization?.unverifiable).toBe(1);
    await host.close();
  });

  it('treats a check that never answers as a failure instead of hanging the host', async () => {
    const root = await makeRoot();
    const registry = new TrustedAuthorizationRegistry();
    registry.grantDelegation(delegation());
    const adapter = new FakeHermesAdapter({ durationMs: 5 });
    const host = new LocalAgentHost({
      deviceId: DEVICE,
      agentId: AGENT,
      workRoot: join(root, 'work'),
      store: new JsonFileAgentHostStore(join(root, 'tasks.json')),
      adapter,
      authorizations: registry,
      authorizationRefresh: {
        verify: () => new Promise<AuthorizationVerification[]>(() => undefined),
        timeoutMs: 50,
      },
    });
    await host.start();
    await host.refreshAuthorization();
    const status = await host.status();
    expect(status.authorization?.state).toBe('unverified');
    expect(status.authorization?.lastError).toMatch(/timed out/);
    await host.close();
  });

  it('does not refresh at all when no verifier is configured', async () => {
    const root = await makeRoot();
    const registry = new TrustedAuthorizationRegistry();
    registry.grantDelegation(delegation());
    registry.grantApproval(approval());
    const adapter = new FakeHermesAdapter({ durationMs: 5 });
    const host = new LocalAgentHost({
      deviceId: DEVICE,
      agentId: AGENT,
      workRoot: join(root, 'work'),
      store: new JsonFileAgentHostStore(join(root, 'tasks.json')),
      adapter,
      authorizations: registry,
    });
    await host.start();
    await host.refreshAuthorization(); // a no-op, and it must not throw
    expect((await host.status()).authorization).toBeUndefined();
    expect(registry.isUnverified()).toBe(false);
    await host.close();
  });
});
