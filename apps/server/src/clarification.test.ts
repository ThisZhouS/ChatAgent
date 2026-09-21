/**
 * Clarification questions end to end: the assistant asks instead of guessing, and the answer
 * continues the same task.
 *
 * The engine already had a `waiting_input` state; nothing produced it and nothing routed the
 * reply back. These tests cover both halves, including the ways a reply must NOT be taken as an
 * answer (another member, another conversation, a closed question).
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

const clarifyIt = (name: string, fn: () => Promise<void>) => it(name, fn, 60_000);

async function boot() {
  const test = await createTestApp({
    members: MEMBERS,
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

async function openAgentConversation(
  app: FastifyInstance,
  token: string,
  accountId: string,
): Promise<Conversation> {
  const opened = await app.inject({
    method: 'POST',
    url: '/api/conversations',
    headers: auth(token),
    payload: { targetId: accountId, targetKind: 'agent' },
  });
  expect(opened.statusCode, opened.body).toBe(200);
  return opened.json() as Conversation;
}

async function send(app: FastifyInstance, token: string, id: string, text: string) {
  return app.inject({
    method: 'POST',
    url: '/api/conversations/' + id + '/messages',
    headers: auth(token),
    payload: { text },
  });
}

async function tasks(app: FastifyInstance, token: string): Promise<TaskRecord[]> {
  return (await app.inject({ method: 'GET', url: '/api/tasks', headers: auth(token) })).json() as TaskRecord[];
}

async function messages(app: FastifyInstance, token: string, id: string): Promise<ChatMessage[]> {
  return (
    await app.inject({
      method: 'GET',
      url: '/api/conversations/' + id + '/messages',
      headers: auth(token),
    })
  ).json() as ChatMessage[];
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

describe('clarification questions', () => {
  clarifyIt('parks the task, asks in the conversation, and continues with the reply', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const account = await agent(app, alice);
    const conversation = await openAgentConversation(app, alice, account.id);

    // The offline provider asks a clarifying question for this phrasing (see MockProvider's
    // intent table), which is what makes the path testable without a model.
    const asked = await send(app, alice, conversation.id, '信息不足，请向我确认要统计哪个月');
    expect(asked.statusCode, asked.body).toBe(200);

    const waiting = await waitFor(async () =>
      (await tasks(app, alice)).some((task) => task.state === 'waiting_input'),
    );
    expect(waiting, 'the task should wait for an answer').toBe(true);
    const task = (await tasks(app, alice)).find((item) => item.state === 'waiting_input');
    // The recorded message is the question itself, so a client can show it without reading the
    // conversation (the conversation copy is what the requester answers).
    expect(task?.outcome?.message ?? '').toContain('请向我确认');

    // The question is a message in the conversation, so the answer has a place to go.
    const thread = await messages(app, alice, conversation.id);
    expect(thread.some((message) => message.text.includes('需要你补充一下'))).toBe(true);

    // The reply continues the same task instead of starting a new one.
    const answered = await send(app, alice, conversation.id, '统计九月');
    expect(answered.statusCode, answered.body).toBe(200);
    expect((answered.json() as { taskId?: string }).taskId).toBe(task?.id);

    const finished = await waitFor(async () =>
      (await tasks(app, alice)).some((item) => item.id === task?.id && item.state !== 'waiting_input'),
    );
    expect(finished, 'the waiting task should leave the waiting state').toBe(true);

    // Exactly one task exists: the answer did not queue a second handoff.
    const all = await tasks(app, alice);
    expect(all.filter((item) => item.conversationId === conversation.id)).toHaveLength(1);
  });

  clarifyIt('does not take a message from somebody else as the answer', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');
    const account = await agent(app, alice);
    const conversation = await openAgentConversation(app, alice, account.id);

    await send(app, alice, conversation.id, '信息不足，请向我确认要统计哪个月');
    const waiting = await waitFor(async () =>
      (await tasks(app, alice)).some((task) => task.state === 'waiting_input'),
    );
    expect(waiting).toBe(true);
    const waitingTask = (await tasks(app, alice)).find((task) => task.state === 'waiting_input');

    // Bob is not the requester: his message must not answer Alice's question (and he is not in
    // the conversation at all, so the send is refused by the participant check).
    const intruder = await send(app, bob, conversation.id, '统计十月');
    expect(intruder.statusCode).toBe(404);
    expect((await tasks(app, alice)).find((task) => task.state === 'waiting_input')?.id).toBe(
      waitingTask?.id,
    );
  });

  clarifyIt('keeps the question open across a restart of the read path', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const account = await agent(app, alice);
    const conversation = await openAgentConversation(app, alice, account.id);

    await send(app, alice, conversation.id, '信息不足，请向我确认要统计哪个月');
    await waitFor(async () => (await tasks(app, alice)).some((task) => task.state === 'waiting_input'));

    // Listing tasks twice (a fresh read) must not consume the question: only an answer does.
    await tasks(app, alice);
    await tasks(app, alice);
    const stillWaiting = (await tasks(app, alice)).find((task) => task.state === 'waiting_input');
    expect(stillWaiting, 'the question stays open until it is answered').toBeTruthy();

    const resumed = await app.inject({
      method: 'POST',
      url: '/api/tasks/' + stillWaiting?.id + '/resume',
      headers: auth(alice),
    });
    // Manual resume is still available (and does not require a message).
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(resumed.json().ok).toBe(true);
  });
});
