import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestApp, devHeaders, type TestMemberSeed } from './test-helpers';

let active: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of active) {
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  active = [];
});

const MEMBERS: TestMemberSeed[] = [
  { id: 'u_alice', displayName: 'Alice', token: 'alice-token' },
  { id: 'u_bob', displayName: 'Bob', token: 'bob-token' },
  { id: 'u_carol', displayName: 'Carol', token: 'carol-token' },
];

async function boot() {
  const test = await createTestApp({ members: MEMBERS });
  active.push(test.app);
  return test;
}

async function login(app: FastifyInstance, memberId: string, token: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { memberId, token },
  });
  return response.json().token as string;
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('message search', () => {
  it('finds messages only in conversations the caller participates in', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');
    const carol = await login(app, 'u_carol', 'carol-token');

    const opened = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: auth(alice),
      payload: { targetId: 'u_bob', targetKind: 'member' },
    });
    const conversationId = opened.json().id as string;

    await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      headers: auth(alice),
      payload: { text: '季度预算复核已完成' },
    });

    const bobHits = (
      await app.inject({ method: 'GET', url: '/api/search?q=预算', headers: auth(bob) })
    ).json() as Array<{ conversationId: string }>;
    expect(bobHits).toHaveLength(1);
    expect(bobHits[0]?.conversationId).toBe(conversationId);

    // The author can find their own message too.
    const aliceHits = (
      await app.inject({ method: 'GET', url: '/api/search?q=预算', headers: auth(alice) })
    ).json() as unknown[];
    expect(aliceHits).toHaveLength(1);

    // A non-participant never sees it.
    const carolHits = (
      await app.inject({ method: 'GET', url: '/api/search?q=预算', headers: auth(carol) })
    ).json() as unknown[];
    expect(carolHits).toHaveLength(0);
  });

  it('rejects too-short queries', async () => {
    const { app } = await boot();
    const response = await app.inject({
      method: 'GET',
      url: '/api/search?q=a',
      headers: devHeaders('u_alice'),
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('coalesced persistence', () => {
  it('flushes pending messages on graceful shutdown', async () => {
    const test = await createTestApp({ members: MEMBERS });
    const alice = await login(test.app, 'u_alice', 'alice-token');

    const opened = await test.app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: auth(alice),
      payload: { targetId: 'u_bob', targetKind: 'member' },
    });
    const conversationId = opened.json().id as string;

    await test.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      headers: auth(alice),
      payload: { text: '关闭前写入的消息' },
    });

    // Close immediately: the coalescing writer must flush before exit.
    await test.app.close();

    const reopened = await createTestApp({ dataDir: test.dataDir, members: MEMBERS });
    active.push(reopened.app);
    const bob = await login(reopened.app, 'u_bob', 'bob-token');
    const messages = (
      await reopened.app.inject({
        method: 'GET',
        url: `/api/conversations/${conversationId}/messages`,
        headers: auth(bob),
      })
    ).json() as Array<{ text: string }>;

    expect(messages.map((message) => message.text)).toContain('关闭前写入的消息');
  });
});
