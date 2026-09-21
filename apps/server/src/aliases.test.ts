/**
 * Private labels inside one conversation.
 *
 * The product asks for 群内备注 / 个人昵称 / 群名称备注. All three are the *viewer's* labels, so they
 * live on the viewer's own read-state row: nobody can rename anybody else, and no other member
 * learns what they are called.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatMessage, Conversation, ConversationSummary } from '@chatagent/contracts';
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

const aliasIt = (name: string, fn: () => Promise<void>) => it(name, fn, 30_000);

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

async function group(app: FastifyInstance, token: string, title: string, memberIds: string[]) {
  const created = await app.inject({
    method: 'POST',
    url: '/api/groups',
    headers: auth(token),
    payload: { title, memberIds },
  });
  expect(created.statusCode, created.body).toBe(200);
  return created.json() as Conversation;
}

async function setAliases(
  app: FastifyInstance,
  token: string,
  id: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: 'POST',
    url: '/api/conversations/' + id + '/aliases',
    headers: auth(token),
    payload,
  });
}

async function summaries(app: FastifyInstance, token: string): Promise<ConversationSummary[]> {
  return (
    await app.inject({ method: 'GET', url: '/api/conversations', headers: auth(token) })
  ).json() as ConversationSummary[];
}

describe('conversation aliases', () => {
  aliasIt('keeps the viewer labels private to the viewer', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');
    const room = await group(app, alice, '项目组', ['u_bob']);

    const stored = await setAliases(app, alice, room.id, {
      title: '我的周报组',
      members: { u_bob: '小 Bob', u_alice: '组长' },
    });
    expect(stored.statusCode, stored.body).toBe(200);
    expect((stored.json() as { aliases: unknown }).aliases).toEqual({
      title: '我的周报组',
      members: { u_bob: '小 Bob', u_alice: '组长' },
    });

    const aliceView = (await summaries(app, alice)).find((item) => item.id === room.id);
    expect(aliceView?.aliases?.title).toBe('我的周报组');
    expect(aliceView?.aliases?.members?.u_bob).toBe('小 Bob');
    // The real title is untouched, and Bob sees neither the label nor the nickname.
    expect(aliceView?.title).toBe('项目组');
    const bobView = (await summaries(app, bob)).find((item) => item.id === room.id);
    expect(bobView?.aliases).toBeUndefined();
    expect(bobView?.title).toBe('项目组');
  });

  aliasIt('clears an alias by sending a blank, and refuses a stranger label', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const carol = await login(app, 'u_carol', 'carol-token');
    const room = await group(app, alice, '同名组', ['u_bob']);

    await setAliases(app, alice, room.id, { title: '别名', members: { u_bob: 'B' } });
    // Blanks are dropped, so "no alias" has exactly one representation.
    const cleared = await setAliases(app, alice, room.id, { title: '   ', members: { u_bob: '' } });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((cleared.json() as { aliases?: unknown }).aliases).toBeUndefined();
    expect((await summaries(app, alice)).find((item) => item.id === room.id)?.aliases).toBeUndefined();

    // A label for somebody who is not in this conversation can never be rendered.
    const stranger = await setAliases(app, alice, room.id, { members: { u_carol: '外人' } });
    expect(stranger.statusCode).toBe(400);
    expect(stranger.json().detail).toBe('unknown_member');
    // And an outsider cannot set aliases on a room they are not in.
    expect((await setAliases(app, carol, room.id, { title: 'x' })).statusCode).toBe(404);
  });

  aliasIt('bounds the label so a message cannot carry unbounded text into the sidebar', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const room = await group(app, alice, '边界组', ['u_bob']);

    expect((await setAliases(app, alice, room.id, { title: 'x'.repeat(33) })).statusCode).toBe(400);
    expect(
      (await setAliases(app, alice, room.id, { members: { u_bob: 'y'.repeat(33) } })).statusCode,
    ).toBe(400);
    expect((await setAliases(app, alice, room.id, { extra: 'field' })).statusCode).toBe(400);

    const many = Object.fromEntries(
      Array.from({ length: 201 }, (_, index) => ['u_' + index, 'label']),
    );
    expect((await setAliases(app, alice, room.id, { members: many })).statusCode).toBe(400);
  });
});
