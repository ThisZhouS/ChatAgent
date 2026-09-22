/**
 * Per-member agent preferences (the "queue stack" knobs).
 *
 * The owner answered question 5 with "user-configurable", which turns two numbers that used to
 * be deployment-wide defaults into each member's own setting: how much of the conversation an
 * assistant is handed with one request, and how much history a resumed task keeps.
 *
 * These tests cover the surface (defaults, bounds, isolation, persistence) and, more
 * importantly, the two places the value actually changes behaviour: the queued handoff and the
 * clarification answer. A setting that is stored and never read is the failure mode this file
 * exists to rule out.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AgentAccount, Conversation, TaskRecord } from '@chatagent/contracts';
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

/** Tests that drive the real queue need room on a loaded machine. */
const slowIt = (name: string, fn: () => Promise<void>) => it(name, fn, 60_000);

interface Preferences {
  agentContextMessages: number;
  clarifyHistoryLimit: number;
}

const DEFAULTS: Preferences = { agentContextMessages: 20, clarifyHistoryLimit: 50 };

async function boot(options: { dataDir?: string } = {}) {
  const test = await createTestApp({
    members: MEMBERS,
    // Immediate mode makes the handoff happen in the same request, so the tests observe the
    // history the queue actually built instead of racing a timer.
    agentIntake: { mode: 'immediate' },
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
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

async function getPreferences(app: FastifyInstance, token: string): Promise<Preferences> {
  const response = await app.inject({ method: 'GET', url: '/api/preferences', headers: auth(token) });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Preferences;
}

async function patchPreferences(
  app: FastifyInstance,
  token: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: 'PATCH',
    url: '/api/preferences',
    headers: auth(token),
    payload,
  });
}

async function agentAccount(app: FastifyInstance, token: string): Promise<AgentAccount> {
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

async function send(app: FastifyInstance, token: string, conversationId: string, text: string) {
  return app.inject({
    method: 'POST',
    url: '/api/conversations/' + conversationId + '/messages',
    headers: auth(token),
    payload: { text },
  });
}

async function tasks(app: FastifyInstance, token: string): Promise<TaskRecord[]> {
  return (
    await app.inject({ method: 'GET', url: '/api/tasks', headers: auth(token) })
  ).json() as TaskRecord[];
}

/** The model history the queue snapshotted onto a task, oldest first. */
function historyOf(task: TaskRecord | undefined): Array<{ role: string; content: string }> {
  const history = (task?.input as { history?: unknown } | undefined)?.history;
  return Array.isArray(history) ? (history as Array<{ role: string; content: string }>) : [];
}

function contentsOf(task: TaskRecord | undefined): string {
  return historyOf(task)
    .map((entry) => entry.content)
    .join(' | ');
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * The task created by the newest message. The API returns tasks in store order, not creation
 * order, so asking for the last element of the list would read the *oldest* task's history.
 */
function latestTask(list: TaskRecord[]): TaskRecord | undefined {
  return [...list].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).at(-1);
}

describe('member agent preferences', () => {
  it('reads the deployment defaults before anything has been set', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');

    // The member never configured anything: the resolved value is the deployment default, so a
    // client never has to know it and a changed default still reaches everybody.
    expect(await getPreferences(app, alice)).toEqual(DEFAULTS);
  });

  it('stores one member\'s change without touching anybody else', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');

    const updated = await patchPreferences(app, alice, { agentContextMessages: 5 });
    expect(updated.statusCode, updated.body).toBe(200);
    // A one-field patch answers with the whole resolved pair: the other knob keeps its default
    // rather than being reset to zero or dropped.
    expect(updated.json()).toEqual({ agentContextMessages: 5, clarifyHistoryLimit: 50 });

    expect(await getPreferences(app, alice)).toEqual({ agentContextMessages: 5, clarifyHistoryLimit: 50 });
    expect(await getPreferences(app, bob)).toEqual(DEFAULTS);
  });

  it('refuses out-of-range, unknown and empty patches instead of clamping', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');

    const refusedPayloads: Array<Record<string, unknown>> = [
      { agentContextMessages: 0 },
      { agentContextMessages: 201 },
      { agentContextMessages: 5.5 },
      { agentContextMessages: '5' },
      { clarifyHistoryLimit: 0 },
      { clarifyHistoryLimit: 201 },
      {},
    ];
    for (const payload of refusedPayloads) {
      const refused = await patchPreferences(app, alice, payload);
      expect(refused.statusCode, JSON.stringify(payload) + ' -> ' + refused.body).toBe(400);
    }

    // "Only your own" is structural: the route takes no member id, and the shape a client would
    // use to address somebody else is refused rather than silently ignored.
    const targeting = await patchPreferences(app, alice, { memberId: 'u_bob', agentContextMessages: 3 });
    expect(targeting.statusCode, targeting.body).toBe(400);

    // Nothing above was stored - not even the fields that were individually valid.
    expect(await getPreferences(app, alice)).toEqual(DEFAULTS);
    expect(await getPreferences(app, bob)).toEqual(DEFAULTS);
  });

  it('survives a restart of the server', async () => {
    const first = await boot();
    const alice = await login(first.app, 'u_alice', 'alice-token');
    const patched = await patchPreferences(first.app, alice, {
      agentContextMessages: 7,
      clarifyHistoryLimit: 9,
    });
    expect(patched.statusCode, patched.body).toBe(200);
    await first.app.close();
    active = active.filter((app) => app !== first.app);

    const second = await boot({ dataDir: first.dataDir });
    const aliceAgain = await login(second.app, 'u_alice', 'alice-token');
    expect(await getPreferences(second.app, aliceAgain)).toEqual({
      agentContextMessages: 7,
      clarifyHistoryLimit: 9,
    });
  });

  slowIt('hands a queued request only the window its requester configured', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');
    const account = await agentAccount(app, alice);
    const aliceConversation = await openAgentConversation(app, alice, account.id);
    const bobConversation = await openAgentConversation(app, bob, account.id);

    // Both conversations grow past the window Alice is about to choose, so a shorter history can
    // only come from her setting and not from a conversation that was short anyway.
    for (let index = 1; index <= 6; index += 1) {
      await send(app, alice, aliceConversation.id, `Alice 的第 ${index} 条历史`);
      await send(app, bob, bobConversation.id, `Bob 的第 ${index} 条历史`);
    }
    const aliceBefore = latestTask(await tasks(app, alice));
    expect(historyOf(aliceBefore).length, 'the default window is not the thing under test').toBeGreaterThan(3);

    const patched = await patchPreferences(app, alice, { agentContextMessages: 3 });
    expect(patched.statusCode, patched.body).toBe(200);

    const sent = await send(app, alice, aliceConversation.id, 'Alice 设置之后的一次请求');
    expect(sent.statusCode, sent.body).toBe(200);
    const submitted = await waitFor(async () =>
      (await tasks(app, alice)).some((task) => task.goal.includes('设置之后')),
    );
    expect(submitted, 'the request should still reach the assistant').toBe(true);

    const windowed = (await tasks(app, alice)).find((task) => task.goal.includes('设置之后'));
    const history = historyOf(windowed);
    expect(history).toHaveLength(3);
    // The three newest messages are in the window and the older ones are not, so this is a
    // window and not "the limit was ignored while the history happened to be short".
    expect(contentsOf(windowed)).toContain('第 6 条历史');
    expect(contentsOf(windowed)).not.toContain('第 3 条历史');
    expect(windowed?.goal).toContain('设置之后');

    // Bob never set anything, so his own queue still hands over the deployment default.
    const bobLatest = latestTask(await tasks(app, bob));
    expect(historyOf(bobLatest).length).toBeGreaterThan(3);
  });

  slowIt('keeps only the requester\'s clarification window when a task resumes', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const account = await agentAccount(app, alice);
    const conversation = await openAgentConversation(app, alice, account.id);

    for (let index = 1; index <= 4; index += 1) {
      await send(app, alice, conversation.id, `第 ${index} 条背景`);
    }
    // The offline provider asks a clarifying question for this phrasing (its intent table), so
    // the resume path is reachable without a model.
    const asked = await send(app, alice, conversation.id, '信息不足，请向我确认要统计哪个月');
    expect(asked.statusCode, asked.body).toBe(200);
    const waiting = await waitFor(async () =>
      (await tasks(app, alice)).some((task) => task.state === 'waiting_input'),
    );
    expect(waiting, 'the task should wait for an answer').toBe(true);

    const openTask = (await tasks(app, alice)).find((task) => task.state === 'waiting_input');
    expect(historyOf(openTask).length, 'there is more history than the window under test').toBeGreaterThan(2);

    const patched = await patchPreferences(app, alice, { clarifyHistoryLimit: 2 });
    expect(patched.statusCode, patched.body).toBe(200);

    const answered = await send(app, alice, conversation.id, '统计九月');
    expect(answered.statusCode, answered.body).toBe(200);
    expect((answered.json() as { taskId?: string }).taskId).toBe(openTask?.id);

    const resumed = await waitFor(async () =>
      (await tasks(app, alice)).some((task) => task.id === openTask?.id && task.state !== 'waiting_input'),
    );
    expect(resumed, 'the answer should continue the waiting task').toBe(true);

    const task = (await tasks(app, alice)).find((item) => item.id === openTask?.id);
    const history = historyOf(task);
    // The answer is appended and the history is sliced to the requester's own limit, so the
    // resumed run carries the answer plus one entry - not the whole conversation.
    expect(history).toHaveLength(2);
    expect(history.at(-1)?.content ?? '').toContain('统计九月');
    expect(history.at(-1)?.role).toBe('user');
  });
});
