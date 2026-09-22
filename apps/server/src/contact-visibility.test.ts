/**
 * Who can see whom (product decision 1C, option (a): a searchable organization directory).
 *
 * The owner's answer was C for question 1 - interpersonal friendship governs **visibility**, the
 * agent tier governs **capability** - and after the first attempt showed that gating *direct chat*
 * on friendship changes the communication model (10 files / 35 cases failed and it was reverted),
 * the visibility rule lives in the discovery layer:
 *
 *   - the contact list holds the people you have a relationship with (friend, blocked, privately
 *     named, or a request in flight);
 *   - the organization directory still lists everybody, so a stranger can be found and added;
 *   - presence (the `online` flag and `/api/presence`) is a friend-level fact;
 *   - direct chat, groups and search are untouched - you can still talk to a colleague you have
 *     not added, which is what the reverted attempt got wrong.
 *
 * These cases pin all four halves, including the "unaffected" ones, because the point of a
 * visibility change is what it must NOT break.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatMessage, Conversation, FriendRequestRecord, MemberView } from '@chatagent/contracts';
import { createTestApp, type TestMemberSeed } from './test-helpers';

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

const visibilityIt = (name: string, fn: () => Promise<void>) => it(name, fn, 30_000);

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
  expect(response.statusCode, response.body).toBe(200);
  return response.json().token as string;
}

function auth(token: string): Record<string, string> {
  return { authorization: 'Bearer ' + token };
}

async function contacts(app: FastifyInstance, token: string): Promise<MemberView[]> {
  return (
    await app.inject({ method: 'GET', url: '/api/contacts', headers: auth(token) })
  ).json() as MemberView[];
}

async function directory(app: FastifyInstance, token: string): Promise<MemberView[]> {
  return (
    await app.inject({ method: 'GET', url: '/api/members', headers: auth(token) })
  ).json() as MemberView[];
}

async function request(app: FastifyInstance, token: string, toMemberId: string) {
  return app.inject({
    method: 'POST',
    url: '/api/friend-requests',
    headers: auth(token),
    payload: { toMemberId },
  });
}

async function decide(
  app: FastifyInstance,
  token: string,
  requestId: string,
  decision: 'accept' | 'decline',
) {
  return app.inject({
    method: 'POST',
    url: `/api/friend-requests/${requestId}/decision`,
    headers: auth(token),
    payload: { decision },
  });
}

async function befriend(app: FastifyInstance, tokens: { from: string; to: string }): Promise<void> {
  const created = await request(app, tokens.from, 'u_bob');
  expect(created.statusCode, created.body).toBe(201);
  const accepted = await decide(app, tokens.to, (created.json() as FriendRequestRecord).id, 'accept');
  expect(accepted.statusCode, accepted.body).toBe(200);
}

function has(list: MemberView[], id: string): boolean {
  return list.some((entry) => entry.id === id);
}

function find(list: MemberView[], id: string): MemberView | undefined {
  return list.find((entry) => entry.id === id);
}

describe('contact visibility (decision 1C-(a))', () => {
  visibilityIt('hides a colleague with no relationship, and shows them once a request is in flight', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');

    // Nothing has happened between them: Alice sees her own card and the AI accounts, not Bob.
    const before = await contacts(app, alice);
    expect(has(before, 'u_alice')).toBe(true);
    expect(has(before, 'u_bob')).toBe(false);
    // Bob is not hidden from her - he is in the directory, which is where she adds him from.
    const org = await directory(app, alice);
    expect(has(org, 'u_bob')).toBe(true);
    expect(find(org, 'u_bob')?.displayName).toBe('Bob');
    // His roles stay readable: the admin console reads them from this endpoint.
    expect(find(org, 'u_bob')?.roles).toEqual(['member']);

    const created = await request(app, alice, 'u_bob');
    expect(created.statusCode, created.body).toBe(201);

    // Both sides now have a reason to see each other: the request has to be answerable.
    const aliceOut = await contacts(app, alice);
    expect(find(aliceOut, 'u_bob')?.relation).toMatchObject({ state: 'request_out' });
    const bobIn = await contacts(app, bob);
    expect(find(bobIn, 'u_alice')?.relation).toMatchObject({ state: 'request_in' });

    // Accepting makes it a friendship that survives further reads.
    const accepted = await decide(app, bob, (created.json() as FriendRequestRecord).id, 'accept');
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(find(await contacts(app, alice), 'u_bob')?.relation?.state).toBe('friend');
    expect(find(await contacts(app, bob), 'u_alice')?.relation?.state).toBe('friend');
  });

  visibilityIt('keeps a blocked or privately named colleague visible, so both can be undone', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');

    // A private remark alone is a relationship record: the row has to stay reachable or the
    // owner could never edit what they named.
    const named = await app.inject({
      method: 'PATCH',
      url: '/api/contacts/u_bob',
      headers: auth(alice),
      payload: { remark: '周报小组的 Bob' },
    });
    expect(named.statusCode, named.body).toBe(200);
    const afterRemark = find(await contacts(app, alice), 'u_bob');
    expect(afterRemark?.relation?.remark).toBe('周报小组的 Bob');

    // Same for a block: hiding the person you just blocked would leave no way to unblock them.
    const blocked = await app.inject({
      method: 'PATCH',
      url: '/api/contacts/u_bob',
      headers: auth(alice),
      payload: { blocked: true },
    });
    expect(blocked.statusCode, blocked.body).toBe(200);
    expect(find(await contacts(app, alice), 'u_bob')?.relation?.state).toBe('blocked');

    const unblocked = await app.inject({
      method: 'PATCH',
      url: '/api/contacts/u_bob',
      headers: auth(alice),
      payload: { blocked: false },
    });
    expect(unblocked.statusCode, unblocked.body).toBe(200);
    // The remark is still there, so the row stays: clearing the block did not erase the naming.
    expect(find(await contacts(app, alice), 'u_bob')?.relation?.remark).toBe('周报小组的 Bob');
  });

  visibilityIt('keeps presence to yourself and your friends, in the directory and in /api/presence', async () => {
    const { app } = await boot();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = (() => {
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('server is not listening');
      return `http://127.0.0.1:${address.port}`;
    })();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');
    const carol = await login(app, 'u_carol', 'carol-token');
    await befriend(app, { from: alice, to: bob });

    // Alice opens an event stream, which is what "online" means.
    const controller = new AbortController();
    const stream = await fetch(`${base}/api/events/stream`, {
      headers: auth(alice),
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    const reader = stream.body?.getReader();
    await reader?.read();

    const deadline = Date.now() + 5000;
    let friendSees: string[] = [];
    let strangerSees: string[] = [];
    while (Date.now() < deadline) {
      friendSees = (
        await app.inject({ method: 'GET', url: '/api/presence', headers: auth(bob) })
      ).json().online as string[];
      strangerSees = (
        await app.inject({ method: 'GET', url: '/api/presence', headers: auth(carol) })
      ).json().online as string[];
      if (friendSees.includes('u_alice')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(friendSees).toContain('u_alice');
    // Carol has no relationship with Alice: "is she at her desk?" is not hers to ask.
    expect(strangerSees).not.toContain('u_alice');

    const friendDirectory = await directory(app, bob);
    expect(find(friendDirectory, 'u_alice')?.online).toBe(true);
    const strangerDirectory = await directory(app, carol);
    const aliceInDirectory = find(strangerDirectory, 'u_alice');
    expect(aliceInDirectory, 'the directory still lists her').toBeTruthy();
    expect(aliceInDirectory?.online, 'but without presence').toBeUndefined();

    controller.abort();
    await reader?.cancel().catch(() => undefined);
  });

  visibilityIt('does not change who you may talk to: direct chat and groups with a non-friend still work', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');
    const carol = await login(app, 'u_carol', 'carol-token');

    // Group with two colleagues Alice has no relationship with. This is the case the reverted
    // attempt broke, so it is pinned here.
    const group = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: auth(alice),
      payload: { title: '项目组', memberIds: ['u_bob', 'u_carol'] },
    });
    expect(group.statusCode, group.body).toBe(200);
    const groupId = (group.json() as Conversation).id;

    const sent = await app.inject({
      method: 'POST',
      url: `/api/conversations/${groupId}/messages`,
      headers: auth(alice),
      payload: { text: '进度同步一下' },
    });
    expect(sent.statusCode, sent.body).toBe(200);

    // A direct chat with a non-friend is still allowed in both directions.
    const opened = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: auth(alice),
      payload: { targetId: 'u_bob', targetKind: 'member' },
    });
    expect(opened.statusCode, opened.body).toBe(200);
    const directId = (opened.json() as Conversation).id;
    const reply = await app.inject({
      method: 'POST',
      url: `/api/conversations/${directId}/messages`,
      headers: auth(bob),
      payload: { text: '收到' },
    });
    expect(reply.statusCode, reply.body).toBe(200);
    const messages = (
      await app.inject({
        method: 'GET',
        url: `/api/conversations/${directId}/messages`,
        headers: auth(alice),
      })
    ).json() as ChatMessage[];
    expect(messages.some((message) => message.text === '收到')).toBe(true);

    // And the group stays readable for a member who is not in anybody's contact list.
    const carolView = (
      await app.inject({ method: 'GET', url: '/api/conversations', headers: auth(carol) })
    ).json() as Array<{ id: string }>;
    expect(carolView.some((conversation) => conversation.id === groupId)).toBe(true);
  });
});
