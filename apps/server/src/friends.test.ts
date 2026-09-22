/**
 * Address book: requests, private remarks and blocking.
 *
 * The directory is who exists in the organization; a relation is what the caller accepted,
 * named or blocked. These tests drive the HTTP surface, because the point is what the server
 * does with a relation - especially that a block actually stops delivery.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  ChatMessage,
  Conversation,
  FriendRequestRecord,
  MemberView,
} from '@chatagent/contracts';
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

const friendsIt = (name: string, fn: () => Promise<void>) => it(name, fn, 30_000);

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

async function relationTo(app: FastifyInstance, token: string, memberId: string) {
  const list = await contacts(app, token);
  return list.find((contact) => contact.id === memberId)?.relation;
}

async function openDirect(app: FastifyInstance, token: string, peerId: string): Promise<Conversation> {
  const opened = await app.inject({
    method: 'POST',
    url: '/api/conversations',
    headers: auth(token),
    payload: { targetId: peerId, targetKind: 'member' },
  });
  expect(opened.statusCode, opened.body).toBe(200);
  return opened.json() as Conversation;
}

async function send(app: FastifyInstance, token: string, conversationId: string, text: string) {
  return app.inject({
    method: 'POST',
    url: '/api/conversations/' + conversationId + '/messages',
    headers: auth(token),
    payload: { text },
  });
}

async function request(app: FastifyInstance, token: string, toMemberId: string, note?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/friend-requests',
    headers: auth(token),
    payload: { toMemberId, note },
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
    url: '/api/friend-requests/' + requestId + '/decision',
    headers: auth(token),
    payload: { decision },
  });
}

async function patchContact(
  app: FastifyInstance,
  token: string,
  peerId: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: 'PATCH',
    url: '/api/contacts/' + peerId,
    headers: auth(token),
    payload,
  });
}

describe('friend requests', () => {
  friendsIt('becomes a mutual contact only when the addressee accepts', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');

    const created = await request(app, alice, 'u_bob', '一起做周报');
    expect(created.statusCode, created.body).toBe(201);
    const requestRecord = created.json() as FriendRequestRecord;
    expect(requestRecord.status).toBe('pending');

    // Sender sees an outgoing request, addressee an incoming one - neither is a contact yet.
    expect((await relationTo(app, alice, 'u_bob'))?.state).toBe('request_out');
    expect((await relationTo(app, bob, 'u_alice'))?.state).toBe('request_in');
    const inbox = (
      await app.inject({ method: 'GET', url: '/api/friend-requests', headers: auth(bob) })
    ).json() as { incoming: FriendRequestRecord[] };
    expect(inbox.incoming.map((item) => item.id)).toEqual([requestRecord.id]);

    // Only the addressee decides.
    const hijack = await decide(app, alice, requestRecord.id, 'accept');
    expect(hijack.statusCode).toBe(403);
    expect(hijack.json().detail).toBe('addressee_only');

    const accepted = await decide(app, bob, requestRecord.id, 'accept');
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((accepted.json() as FriendRequestRecord).status).toBe('accepted');
    // A friendship is mutual by construction.
    expect((await relationTo(app, alice, 'u_bob'))?.state).toBe('friend');
    expect((await relationTo(app, bob, 'u_alice'))?.state).toBe('friend');
  });

  friendsIt('declines without becoming a contact, and does not stack duplicates', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');

    const first = (await request(app, alice, 'u_bob')).json() as FriendRequestRecord;
    const again = await request(app, alice, 'u_bob');
    // A second request while one is pending returns the pending one.
    expect(again.statusCode).toBe(201);
    expect((again.json() as FriendRequestRecord).id).toBe(first.id);

    await decide(app, bob, first.id, 'decline');
    // Decision 1C-(a): a declined request leaves no relationship behind, and "no relationship"
    // means the contact list does not show them at all - not merely a `none` badge. They stay
    // reachable through the organization directory, which is where a new request comes from.
    expect(await relationTo(app, alice, 'u_bob')).toBeUndefined();
    expect(await relationTo(app, bob, 'u_alice')).toBeUndefined();
    expect((await contacts(app, alice)).some((contact) => contact.id === 'u_bob')).toBe(false);
    expect((await contacts(app, bob)).some((contact) => contact.id === 'u_alice')).toBe(false);

    // After a decline a new request is allowed again: people change their minds.
    const retried = await request(app, alice, 'u_bob');
    expect(retried.statusCode).toBe(201);
    expect((retried.json() as FriendRequestRecord).id).not.toBe(first.id);
  });

  friendsIt('refuses a request to yourself and to somebody outside the organization', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');

    const self = await request(app, alice, 'u_alice');
    expect(self.statusCode).toBe(400);
    expect(self.json().detail).toBe('self_request');

    const stranger = await request(app, alice, 'u_outsider');
    expect(stranger.statusCode).toBe(404);
  });
});

describe('remarks and blocking', () => {
  friendsIt('keeps a remark private to its owner', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');

    const patched = await patchContact(app, alice, 'u_bob', { remark: '周报小组的 Bob' });
    expect(patched.statusCode, patched.body).toBe(200);
    expect((await relationTo(app, alice, 'u_bob'))?.remark).toBe('周报小组的 Bob');
    // The peer's own view of Alice is untouched: a remark is not a profile change.
    expect((await relationTo(app, bob, 'u_alice'))?.remark).toBeUndefined();

    const cleared = await patchContact(app, alice, 'u_bob', { remark: null });
    expect((cleared.json() as MemberView).relation?.remark).toBeUndefined();
    // An unknown field is rejected instead of being silently dropped.
    expect((await patchContact(app, alice, 'u_bob', { nickname: 'x' })).statusCode).toBe(400);
  });

  friendsIt('stops delivery from a blocked member, and restores it after unblocking', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');

    const conversation = await openDirect(app, alice, 'u_bob');
    expect((await send(app, bob, conversation.id, '在拉黑之前')).statusCode).toBe(200);

    expect((await patchContact(app, alice, 'u_bob', { blocked: true })).statusCode).toBe(200);
    expect((await relationTo(app, alice, 'u_bob'))?.state).toBe('blocked');

    // Blocking is a delivery rule: the next message is refused and nothing is stored.
    const refused = await send(app, bob, conversation.id, '拉黑之后');
    expect(refused.statusCode).toBe(403);
    expect(refused.json().detail).toBe('blocked_by_recipient');
    const messages = (
      await app.inject({
        method: 'GET',
        url: '/api/conversations/' + conversation.id + '/messages',
        headers: auth(alice),
      })
    ).json() as ChatMessage[];
    expect(messages.map((message) => message.text)).not.toContain('拉黑之后');

    // A blocked member cannot ask to be added either - and is not told who blocked them.
    const whileBlocked = await request(app, bob, 'u_alice');
    expect(whileBlocked.statusCode).toBe(403);
    expect(whileBlocked.json().detail).toBe('blocked_by_recipient');

    await patchContact(app, alice, 'u_bob', { blocked: false });
    expect((await send(app, bob, conversation.id, '解除拉黑之后')).statusCode).toBe(200);
  });

  friendsIt('does not let one member  block silence a shared group', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');

    const group = (
      await app.inject({
        method: 'POST',
        url: '/api/groups',
        headers: auth(alice),
        payload: { title: '小组', memberIds: ['u_bob', 'u_carol'] },
      })
    ).json() as Conversation;
    await patchContact(app, alice, 'u_bob', { blocked: true });

    // A block is not a way to silence a room for everyone else in it.
    expect((await send(app, bob, group.id, '群里说话')).statusCode).toBe(200);
  });
});
