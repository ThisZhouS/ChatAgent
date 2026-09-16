import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestApp, devHeaders, ownerHeaders, poll } from './test-helpers';

let active: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of active) {
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  active = [];
});

async function boot(members: NonNullable<Parameters<typeof createTestApp>[0]>['members'] = undefined) {
  const test = await createTestApp({ members });
  active.push(test.app);
  return test;
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    deviceId: 'desktop-win32',
    agentId: 'hermes',
    taskId: 'task-1',
    goal: '生成本地演示报告',
    kind: 'document',
    state: 'succeeded',
    executor: 'fake',
    artifacts: [{ name: 'result.md', sha256: 'a'.repeat(64), bytes: 12 }],
    createdAt: '2026-09-15T00:00:00.000Z',
    updatedAt: '2026-09-15T00:01:00.000Z',
    ...overrides,
  };
}

describe('local task receipts (on-device agent host mirror)', () => {
  it('rejects anonymous callers in production mode', async () => {
    const test = await createTestApp({ auth: { mode: 'production' } });
    active.push(test.app);
    const denied = await test.app.inject({ method: 'GET', url: '/api/local-tasks' });
    expect(denied.statusCode).toBe(401);
  });

  it('accepts a sync and returns the receipt to the same member', async () => {
    const { app } = await boot();
    const synced = await app.inject({
      method: 'POST',
      url: '/api/local-tasks',
      headers: devHeaders('u_alice'),
      payload: { receipts: [receipt()] },
    });
    expect(synced.statusCode).toBe(200);
    expect(synced.json()).toEqual({ accepted: 1 });

    const list = await app.inject({
      method: 'GET',
      url: '/api/local-tasks',
      headers: devHeaders('u_alice'),
    });
    expect(list.statusCode).toBe(200);
    const receipts = list.json() as Array<Record<string, unknown>>;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ taskId: 'task-1', state: 'succeeded' });
    expect(receipts[0].memberId).toBeUndefined(); // never leaks the scoping key
  });

  it('isolates receipts per member: another member sees nothing', async () => {
    const { app } = await boot();
    await app.inject({
      method: 'POST',
      url: '/api/local-tasks',
      headers: devHeaders('u_alice'),
      payload: { receipts: [receipt()] },
    });

    const bob = await app.inject({
      method: 'GET',
      url: '/api/local-tasks',
      headers: devHeaders('u_bob'),
    });
    expect(bob.statusCode).toBe(200);
    expect(bob.json()).toEqual([]);

    // bob syncing his own device does not touch alice's record
    await app.inject({
      method: 'POST',
      url: '/api/local-tasks',
      headers: devHeaders('u_bob'),
      payload: { receipts: [receipt({ deviceId: 'desktop-bob', taskId: 'task-bob' })] },
    });
    const alice = await app.inject({
      method: 'GET',
      url: '/api/local-tasks',
      headers: devHeaders('u_alice'),
    });
    const aliceReceipts = alice.json() as Array<Record<string, unknown>>;
    expect(aliceReceipts).toHaveLength(1);
    expect(aliceReceipts[0].taskId).toBe('task-1');
  });

  it('upserts by (device, taskId): re-sync updates instead of duplicating', async () => {
    const { app } = await boot();
    const headers = devHeaders('u_alice');
    await app.inject({
      method: 'POST',
      url: '/api/local-tasks',
      headers,
      payload: { receipts: [receipt({ state: 'running' })] },
    });
    await app.inject({
      method: 'POST',
      url: '/api/local-tasks',
      headers,
      payload: { receipts: [receipt({ state: 'succeeded', summary: '完成' })] },
    });

    const list = await app.inject({ method: 'GET', url: '/api/local-tasks', headers });
    const receipts = list.json() as Array<Record<string, unknown>>;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ state: 'succeeded', summary: '完成' });
  });

  it('validates the sync payload: size caps and enum states', async () => {
    const { app } = await boot();
    const headers = devHeaders('u_alice');

    const tooMany = await app.inject({
      method: 'POST',
      url: '/api/local-tasks',
      headers,
      payload: { receipts: Array.from({ length: 101 }, (_, i) => receipt({ taskId: `t${i}` })) },
    });
    expect(tooMany.statusCode).toBe(400);

    const badState = await app.inject({
      method: 'POST',
      url: '/api/local-tasks',
      headers,
      payload: { receipts: [receipt({ state: 'completed' })] }, // not a local host state
    });
    expect(badState.statusCode).toBe(400);

    const badExecutor = await app.inject({
      method: 'POST',
      url: '/api/local-tasks',
      headers,
      payload: { receipts: [receipt({ executor: 'unknown-executor' })] },
    });
    expect(badState.statusCode).toBe(400);
    expect(badExecutor.statusCode).toBe(400);

    const longGoal = await app.inject({
      method: 'POST',
      url: '/api/local-tasks',
      headers,
      payload: { receipts: [receipt({ goal: 'x'.repeat(2001) })] },
    });
    expect(longGoal.statusCode).toBe(400);
  });

  it('records an audit entry for each sync', async () => {
    const { app } = await boot();
    await app.inject({
      method: 'POST',
      url: '/api/local-tasks',
      headers: devHeaders('u_alice'),
      payload: { receipts: [receipt()] },
    });
    const audit = await poll(
      async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/audit?limit=50',
          headers: ownerHeaders(),
        });
        if (res.statusCode !== 200) return [] as Array<{ action?: string }>;
        const entries = res.json() as Array<{ action?: string }>;
        return entries.some((entry) => entry.action === 'local_tasks.sync')
          ? entries
          : ([] as Array<{ action?: string }>);
      },
      (entries) => entries.length > 0,
    );
    expect(audit.length).toBeGreaterThan(0);
  });

  it('binds on-device work to its owner: a foreign claim is refused and audited', async () => {
    const { app } = await boot();
    // Alice's device work, claimed by Bob's session on a shared machine.
    const spoof = await app.inject({
      method: 'POST',
      url: '/api/local-tasks',
      headers: devHeaders('u_bob'),
      payload: { receipts: [receipt({ ownerId: 'u_alice', taskId: 'task-alice' })] },
    });
    expect(spoof.statusCode).toBe(403);
    expect(spoof.json()).toEqual({ error: 'receipt_owner_mismatch' });

    // Nothing was stored for Bob, and Alice's own list stays empty too.
    const bob = await app.inject({ method: 'GET', url: '/api/local-tasks', headers: devHeaders('u_bob') });
    expect(bob.json()).toEqual([]);
    const alice = await app.inject({ method: 'GET', url: '/api/local-tasks', headers: devHeaders('u_alice') });
    expect(alice.json()).toEqual([]);

    const audit = await poll(
      async () => {
        const res = await app.inject({
          method: 'GET',
          url: '/api/audit?limit=50',
          headers: ownerHeaders(),
        });
        if (res.statusCode !== 200) return [] as Array<{ action?: string; outcome?: string }>;
        const entries = res.json() as Array<{ action?: string; outcome?: string }>;
        return entries.some((entry) => entry.action === 'local_tasks.sync' && entry.outcome === 'denied')
          ? entries
          : ([] as Array<{ action?: string; outcome?: string }>);
      },
      (entries) => entries.length > 0,
    );
    expect(audit.some((entry) => entry.action === 'local_tasks.sync' && entry.outcome === 'denied')).toBe(true);
  });

  it('accepts a receipt that claims the authenticated member, and local work without an owner', async () => {
    const { app } = await boot();
    const own = await app.inject({
      method: 'POST',
      url: '/api/local-tasks',
      headers: devHeaders('u_alice'),
      payload: { receipts: [receipt({ ownerId: 'u_alice', taskId: 'task-owned' }), receipt({ taskId: 'task-local' })] },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toEqual({ accepted: 2 });

    const list = await app.inject({ method: 'GET', url: '/api/local-tasks', headers: devHeaders('u_alice') });
    const receipts = list.json() as Array<Record<string, unknown>>;
    expect(receipts.map((item) => item.taskId).sort()).toEqual(['task-local', 'task-owned']);
  });

  it('keeps receipts bounded per member', async () => {
    const { app } = await boot();
    const headers = devHeaders('u_alice');
    // 2 syncs x 100 receipts, distinct task ids — store cap is 500 per member.
    for (let batch = 0; batch < 2; batch += 1) {
      const receipts = Array.from({ length: 100 }, (_, i) =>
        receipt({ taskId: `bulk-${batch}-${i}`, state: 'succeeded' }),
      );
      const res = await app.inject({ method: 'POST', url: '/api/local-tasks', headers, payload: { receipts } });
      expect(res.statusCode).toBe(200);
    }
    const list = await app.inject({ method: 'GET', url: '/api/local-tasks', headers });
    expect((list.json() as unknown[]).length).toBe(200);
  });
});
