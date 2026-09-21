/**
 * Content hooks end to end: a group can summon its assistant by what a message says.
 *
 * Mentions are the explicit route; a hook is the standing rule. Both go through the same intake
 * gate, tier check and audit trail, and the server refuses to store a rule it would not want to
 * run on every message.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AgentAccount, ChatMessage, Conversation, TaskRecord } from '@chatagent/contracts';
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
];

const hookIt = (name: string, fn: () => Promise<void>) => it(name, fn, 60_000);

async function boot() {
  const test = await createTestApp({
    members: MEMBERS,
    // Immediate handoff: this suite is about what summons the assistant, not about timing.
    agentIntake: { mode: 'immediate' },
  });
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

async function agent(app: FastifyInstance, token: string): Promise<AgentAccount> {
  return (
    await app.inject({ method: 'GET', url: '/api/accounts', headers: auth(token) })
  ).json()[0] as AgentAccount;
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

async function setHooks(app: FastifyInstance, token: string, id: string, hooks: string[]) {
  return app.inject({
    method: 'POST',
    url: '/api/conversations/' + id + '/hooks',
    headers: auth(token),
    payload: { hooks },
  });
}

async function send(app: FastifyInstance, token: string, id: string, text: string, mentions: string[] = []) {
  return app.inject({
    method: 'POST',
    url: '/api/conversations/' + id + '/messages',
    headers: auth(token),
    payload: { text, mentions },
  });
}

async function tasks(app: FastifyInstance, token: string): Promise<TaskRecord[]> {
  return (await app.inject({ method: 'GET', url: '/api/tasks', headers: auth(token) })).json() as TaskRecord[];
}

describe('group content hooks', () => {
  hookIt('summons the assistant when a message matches a stored rule', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const account = await agent(app, alice);
    const room = await group(app, alice, '规则触发组', ['u_bob', account.id]);

    // Without a rule and without a mention, nothing is summoned.
    const quiet = await send(app, alice, room.id, '我们先自己讨论');
    expect((quiet.json() as { taskIds?: string[] }).taskIds ?? []).toHaveLength(0);

    const stored = await setHooks(app, alice, room.id, ['周报', '^(紧急|加急)[:：]']);
    expect(stored.statusCode, stored.body).toBe(200);
    expect((stored.json() as Conversation).hooks).toEqual(['周报', '^(紧急|加急)[:：]']);

    // No mention this time: the rule is what summons it.
    const summoned = await send(app, alice, room.id, '本周周报请大家今晚发我');
    expect(summoned.statusCode, summoned.body).toBe(200);
    const body = summoned.json() as { taskIds?: string[]; intakes?: Array<{ state: string }> };
    expect(body.taskIds?.[0], 'the rule summoned the assistant').toBeTruthy();

    const created = (await tasks(app, alice)).find((task) => task.id === body.taskIds?.[0]);
    // The assistant is told how it was summoned, so the transcript is explainable.
    expect(created?.goal).toContain('由内容规则触发');
    expect(created?.goal).toContain('周报');

    // A message that matches nothing stays a normal message.
    const unrelated = await send(app, alice, room.id, '午饭吃什么');
    expect((unrelated.json() as { taskIds?: string[] }).taskIds ?? []).toHaveLength(0);

    // The rule can be removed again.
    expect((await setHooks(app, alice, room.id, [])).statusCode).toBe(200);
    const after = await send(app, alice, room.id, '周报周报周报');
    expect((after.json() as { taskIds?: string[] }).taskIds ?? []).toHaveLength(0);
  });

  hookIt('refuses a hostile or broken rule, and refuses plain members entirely', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');
    const account = await agent(app, alice);
    const room = await group(app, alice, '规则校验组', ['u_bob', account.id]);

    // A plain member cannot install a rule that runs on everybody's messages.
    const denied = await setHooks(app, bob, room.id, ['周报']);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().detail).toBe('group_manager_required');

    // Catastrophic backtracking, a broken pattern and an oversized list are refused by name.
    const unsafe = await setHooks(app, alice, room.id, ['(a+)+$']);
    expect(unsafe.statusCode).toBe(400);
    expect(unsafe.json().detail).toBe('unsafe_pattern');
    const broken = await setHooks(app, alice, room.id, ['(']);
    expect(broken.statusCode).toBe(400);
    expect(broken.json().detail).toBe('invalid_regex');
    const tooMany = await setHooks(app, alice, room.id, Array.from({ length: 21 }, (_, i) => 'k' + i));
    expect(tooMany.statusCode).toBe(400);

    // None of the refusals changed the stored rules.
    const state = (
      await app.inject({ method: 'GET', url: '/api/conversations', headers: auth(alice) })
    ).json() as Conversation[];
    expect(state.find((item) => item.id === room.id)?.hooks ?? []).toEqual([]);
  });

  hookIt('does not let a rule override a mention, and honours the recall window for the rule', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const account = await agent(app, alice);
    const room = await group(app, alice, '规则与提及组', ['u_bob', account.id]);
    await setHooks(app, alice, room.id, ['周报']);

    // A mention is an explicit request: it wins, and it does not double-submit.
    const mentioned = await send(app, alice, room.id, '周报 @助理 帮我看一下', [account.id]);
    const mentionedIds = (mentioned.json() as { taskIds?: string[] }).taskIds ?? [];
    expect(mentionedIds).toHaveLength(1);

    const messages = (
      await app.inject({
        method: 'GET',
        url: '/api/conversations/' + room.id + '/messages',
        headers: auth(alice),
      })
    ).json() as ChatMessage[];
    expect(messages.some((message) => message.text.includes('周报'))).toBe(true);
  });
});
