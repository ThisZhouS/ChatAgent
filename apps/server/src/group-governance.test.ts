/**
 * Group governance: who owns a group, who may run it, what the room is told and how it ends.
 *
 * Before this slice any participant could rename a group or remove anybody, there was no
 * announcement, no way to dissolve a group, and the group lookup key ignored the
 * organization. These tests pin the owner/admin split and the consequences.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { join } from 'node:path';
import type { ChatMessage, Conversation, ConversationSummary } from '@chatagent/contracts';
import { ConversationStore } from './stores';
import { createTestApp, TEST_ORG, type TestMemberSeed } from './test-helpers';

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

const govIt = (name: string, fn: () => Promise<void>) => it(name, fn, 30_000);

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

async function createGroup(
  app: FastifyInstance,
  token: string,
  title: string,
  memberIds: string[],
): Promise<Conversation> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/groups',
    headers: auth(token),
    payload: { title, memberIds },
  });
  expect(created.statusCode, created.body).toBe(200);
  return created.json() as Conversation;
}

async function announce(app: FastifyInstance, token: string, id: string, text: string) {
  return app.inject({
    method: 'POST',
    url: '/api/conversations/' + id + '/announcement',
    headers: auth(token),
    payload: { announcement: text },
  });
}

async function setAdmin(app: FastifyInstance, token: string, id: string, memberId: string, admin: boolean) {
  return app.inject({
    method: 'POST',
    url: '/api/conversations/' + id + '/admins',
    headers: auth(token),
    payload: { memberId, admin },
  });
}

async function dissolve(app: FastifyInstance, token: string, id: string) {
  return app.inject({
    method: 'POST',
    url: '/api/conversations/' + id + '/dissolve',
    headers: auth(token),
  });
}

async function kick(app: FastifyInstance, token: string, id: string, memberId: string) {
  return app.inject({
    method: 'DELETE',
    url: '/api/conversations/' + id + '/members/' + memberId,
    headers: auth(token),
  });
}

async function leave(app: FastifyInstance, token: string, id: string) {
  return app.inject({
    method: 'POST',
    url: '/api/conversations/' + id + '/leave',
    headers: auth(token),
  });
}

async function send(app: FastifyInstance, token: string, id: string, text: string) {
  return app.inject({
    method: 'POST',
    url: '/api/conversations/' + id + '/messages',
    headers: auth(token),
    payload: { text },
  });
}

async function rename(app: FastifyInstance, token: string, id: string, title: string) {
  return app.inject({
    method: 'PATCH',
    url: '/api/conversations/' + id,
    headers: auth(token),
    payload: { title },
  });
}

describe('group ownership and admins', () => {
  govIt('makes the creator the owner and refuses governance to plain members', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');

    const group = await createGroup(app, alice, '治理组', ['u_bob', 'u_carol']);
    expect(group.ownerId).toBe('u_alice');
    expect(group.adminIds).toContain('u_alice');

    // A plain member cannot rename, announce or kick: the room belongs to its owner.
    expect((await rename(app, bob, group.id, '我说了算')).statusCode).toBe(403);
    expect((await announce(app, bob, group.id, '注意')).statusCode).toBe(403);
    expect((await kick(app, bob, group.id, 'u_carol')).statusCode).toBe(403);
    expect((await dissolve(app, bob, group.id)).statusCode).toBe(403);
    expect((await setAdmin(app, bob, group.id, 'u_carol', true)).statusCode).toBe(403);

    // The owner can.
    expect((await rename(app, alice, group.id, '治理组（已改名）')).statusCode).toBe(200);
  });

  govIt('lets an admin manage members but not other admins', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');
    const carol = await login(app, 'u_carol', 'carol-token');

    const group = await createGroup(app, alice, '管理员组', ['u_bob', 'u_carol']);
    const granted = await setAdmin(app, alice, group.id, 'u_bob', true);
    expect(granted.statusCode, granted.body).toBe(200);
    expect((granted.json() as Conversation).adminIds).toContain('u_bob');

    // A promoted admin may rename and remove a plain member.
    expect((await rename(app, bob, group.id, '管理员组（Bob 改名）')).statusCode).toBe(200);
    expect((await kick(app, bob, group.id, 'u_carol')).statusCode).toBe(200);

    // ...but not the owner, and not a peer admin.
    expect((await kick(app, bob, group.id, 'u_alice')).statusCode).toBe(403);
    await app.inject({
      method: 'POST',
      url: '/api/conversations/' + group.id + '/members',
      headers: auth(alice),
      payload: { memberId: 'u_carol' },
    });
    await setAdmin(app, alice, group.id, 'u_carol', true);
    const peer = await kick(app, bob, group.id, 'u_carol');
    expect(peer.statusCode).toBe(403);
    expect(peer.json().detail).toBe('cannot_remove_admin');

    // Revoking is the owner's call, and the owner cannot be demoted.
    expect((await setAdmin(app, alice, group.id, 'u_bob', false)).statusCode).toBe(200);
    expect((await setAdmin(app, alice, group.id, 'u_alice', false)).json().detail).toBe(
      'owner_immutable',
    );
  });

  govIt('keeps the owner: they must hand the group over before leaving', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');

    const group = await createGroup(app, alice, '交接组', ['u_bob']);
    const stranded = await leave(app, alice, group.id);
    expect(stranded.statusCode).toBe(409);
    expect(stranded.json().detail).toBe('owner_must_transfer');

    // A plain member leaves freely, and the owner may leave once nobody is left.
    expect((await leave(app, bob, group.id)).statusCode).toBe(200);
    expect((await leave(app, alice, group.id)).statusCode).toBe(200);
  });
});

describe('announcement and dissolution', () => {
  govIt('pins an announcement every participant can read and clears it again', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');
    const group = await createGroup(app, alice, '公告组', ['u_bob']);

    const set = await announce(app, alice, group.id, '本周五交周报');
    expect(set.statusCode, set.body).toBe(200);
    expect((set.json() as Conversation).announcement).toBe('本周五交周报');

    // Every participant sees it, not just the author.
    const seen = (
      await app.inject({ method: 'GET', url: '/api/conversations', headers: auth(bob) })
    ).json() as ConversationSummary[];
    expect(seen.find((item) => item.id === group.id)?.announcement).toBe('本周五交周报');

    const cleared = await announce(app, alice, group.id, '   ');
    expect((cleared.json() as Conversation).announcement).toBeUndefined();
  });

  govIt('dissolves a group without erasing what was said in it', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');
    const group = await createGroup(app, alice, '解散组', ['u_bob']);
    await send(app, alice, group.id, '解散前的记录');

    const dissolved = await dissolve(app, alice, group.id);
    expect(dissolved.statusCode, dissolved.body).toBe(200);
    expect((dissolved.json() as Conversation).dissolvedAt).toBeTruthy();

    // Nothing new goes in...
    const refused = await send(app, bob, group.id, '解散之后');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().detail).toBe('group_dissolved');
    // ...and no governance either, because the room is closed.
    expect((await announce(app, alice, group.id, '还有公告')).statusCode).toBe(409);

    // ...but the history is still there, for both participants.
    const history = (
      await app.inject({
        method: 'GET',
        url: '/api/conversations/' + group.id + '/messages',
        headers: auth(bob),
      })
    ).json() as ChatMessage[];
    expect(history.map((message) => message.text)).toContain('解散前的记录');

    // Dissolving twice is a no-op, not an error.
    expect((await dissolve(app, alice, group.id)).statusCode).toBe(200);
  });
});

describe('group identity', () => {
  govIt('scopes the deterministic group key to the organization', async () => {
    const { app, dataDir } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');

    // Same title and member list twice is the same conversation (by design)...
    const first = await createGroup(app, alice, '同名组', ['u_bob']);
    const again = await createGroup(app, alice, '同名组', ['u_bob']);
    expect(again.id).toBe(first.id);

    // ...but the lookup must never match a conversation from another organization. Two
    // organizations can produce the same chatId; sharing one would leak the room.
    // The lookup itself is organization-scoped: even with a colliding key (an imported or
    // hand-written row), another organization must not be handed this conversation.
    const store = new ConversationStore(join(dataDir, 'conversations.json'), {
      organizationId: TEST_ORG,
      legacyOwnerId: 'u_alice',
    });
    // Conversation writes are coalesced, so give the writer a moment to land on disk before a
    // second reader looks at the same file.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await store.findByChatId('group', first.chatId, TEST_ORG))?.id).toBe(first.id);
    expect(await store.findByChatId('group', first.chatId, 'org_other')).toBeUndefined();
    // Without an organization filter the old behaviour is kept for callers that have none
    // (the webhook path), which is why the parameter is optional.
    expect((await store.findByChatId('group', first.chatId))?.id).toBe(first.id);
  });
});
