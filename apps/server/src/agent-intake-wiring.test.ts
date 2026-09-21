/**
 * Intake wiring: the shipped default is deferred, so a message reaches an agent only
 * after the recall window. These tests drive the real app (HTTP), not the gate class,
 * because the guarantee users depend on is the wiring: REST -> queue -> agent.
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

/** Deferred mode with a one-second window keeps the test fast and still realistic. */
async function boot(recallWindowSeconds = 1) {
  const test = await createTestApp({
    members: MEMBERS,
    native: { recallWindowSeconds },
    agentIntake: { mode: 'deferred' },
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
  return { authorization: `Bearer ${token}` };
}

async function openAgentConversation(app: FastifyInstance, token: string): Promise<Conversation> {
  const account = (
    await app.inject({ method: 'GET', url: '/api/accounts', headers: auth(token) })
  ).json()[0] as AgentAccount;
  const opened = await app.inject({
    method: 'POST',
    url: '/api/conversations',
    headers: auth(token),
    payload: { targetId: account.id, targetKind: 'agent' },
  });
  expect(opened.statusCode, opened.body).toBe(200);
  return opened.json() as Conversation;
}

async function tasks(app: FastifyInstance, token: string): Promise<TaskRecord[]> {
  return (await app.inject({ method: 'GET', url: '/api/tasks', headers: auth(token) })).json() as TaskRecord[];
}

async function intakeStatus(app: FastifyInstance, token: string) {
  const status = (
    await app.inject({ method: 'GET', url: '/api/agent/status', headers: auth(token) })
  ).json() as { intake?: { mode: string; deferMs: number; pending: number; submitted: number; cancelled: number } };
  return status.intake;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** * These tests wait for the real queue to come due, so they need more than the 5 s * default: the window plus the poll would blow it on a loaded machine. */const intakeIt = (name: string, fn: () => Promise<void>) => it(name, fn, 30_000);describe('agent intake wiring', () => {
  intakeIt('queues a direct message and only creates the task after the recall window', async () => {
    // A 5 s window keeps the "nothing yet" assertion honest even on a loaded machine:
    // the gate cannot submit before it elapses, and the poll below has room to wait.
    const { app } = await boot(5);
    const alice = await login(app, 'u_alice', 'alice-token');
    const conversation = await openAgentConversation(app, alice);

    const sent = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation.id}/messages`,
      headers: auth(alice),
      payload: { text: '帮我整理一份周报' },
    });
    expect(sent.statusCode, sent.body).toBe(200);
    const body = sent.json() as {
      message: ChatMessage;
      taskId?: string;
      intake?: { state: string; mode: string; dueAt?: string };
    };
    // The agent has not been handed anything yet: no task id, and the response says so.
    expect(body.taskId).toBeUndefined();
    expect(body.intake?.state).toBe('pending');
    expect(body.intake?.mode).toBe('deferred');
    expect(body.intake?.dueAt).toBeTruthy();
    expect(await tasks(app, alice)).toHaveLength(0);

    const created = await waitFor(async () => (await tasks(app, alice)).length === 1, 20_000);
    expect(created, 'the queued handoff should be submitted once the window elapses').toBe(true);
    const [task] = await tasks(app, alice);
    expect(task?.goal).toContain('周报');
    expect(task?.requesterId).toBe('u_alice');
    expect(await intakeStatus(app, alice)).toMatchObject({ mode: 'deferred', pending: 0, submitted: 1 });
  });

  intakeIt('never hands over a message withdrawn inside the window', async () => {
    const { app, dataDir } = await boot(3);
    const alice = await login(app, 'u_alice', 'alice-token');
    const conversation = await openAgentConversation(app, alice);

    const sent = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation.id}/messages`,
      headers: auth(alice),
      payload: { text: '把这份草稿发给客户' },
    });
    const message = (sent.json() as { message: ChatMessage }).message;
    expect((sent.json() as { intake?: { state: string } }).intake?.state).toBe('pending');

    const recalled = await app.inject({
      method: 'POST',
      url: `/api/messages/${message.id}/recall`,
      headers: auth(alice),
    });
    expect(recalled.statusCode, recalled.body).toBe(200);

    // Wait past the due time: the handoff must stay cancelled, not merely delayed.
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    expect(await tasks(app, alice)).toHaveLength(0);
    const status = await intakeStatus(app, alice);
    expect(status).toMatchObject({ pending: 0, cancelled: 1 });

    // The cancellation is auditable, and the withdrawn text never entered a task.
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const audit = await readFile(join(dataDir, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('agent_intake.cancelled');
    expect(audit).not.toContain('把这份草稿发给客户');
  });

  intakeIt('queues a group mention and cancels it when the sender withdraws', async () => {
    const { app } = await boot(3);
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');

    const account = (
      await app.inject({ method: 'GET', url: '/api/accounts', headers: auth(alice) })
    ).json()[0] as AgentAccount;
    const created = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: auth(alice),
      payload: { title: '周报小组', memberIds: ['u_bob', account.id] },
    });
    expect(created.statusCode, created.body).toBe(200);
    const group = created.json() as Conversation;
    expect(group.participantIds).toContain(account.id);

    const sent = await app.inject({
      method: 'POST',
      url: `/api/conversations/${group.id}/messages`,
      headers: auth(alice),
      payload: { text: `@${account.displayName} 汇总一下本周进展`, mentions: [account.id] },
    });
    expect(sent.statusCode, sent.body).toBe(200);
    const body = sent.json() as { intakes?: Array<{ state: string; mode: string }>; taskIds?: string[] };
    expect(body.intakes?.[0]?.state).toBe('pending');
    expect(body.taskIds ?? []).toHaveLength(0);

    const message = (
      await app.inject({
        method: 'GET',
        url: `/api/conversations/${group.id}/messages`,
        headers: auth(alice),
      })
    ).json() as ChatMessage[];
    const mine = message.find((item) => item.senderPrincipalId === 'u_alice');
    expect(mine).toBeDefined();
    await app.inject({
      method: 'POST',
      url: `/api/messages/${mine!.id}/recall`,
      headers: auth(alice),
    });

    await new Promise((resolve) => setTimeout(resolve, 5_500));
    // Neither the sender nor the group peer sees a task for a withdrawn summons.
    expect(await tasks(app, alice)).toHaveLength(0);
    expect(await tasks(app, bob)).toHaveLength(0);
    expect(await intakeStatus(app, alice)).toMatchObject({ pending: 0, cancelled: 1 });
  });

  intakeIt('reports the intake policy so clients can explain a queued message', async () => {
    const { app } = await boot(30);
    const alice = await login(app, 'u_alice', 'alice-token');
    const status = (
      await app.inject({ method: 'GET', url: '/api/agent/status', headers: auth(alice) })
    ).json() as { recallWindowSeconds: number; intake: { mode: string; deferMs: number; contextMessages: number } };
    expect(status.recallWindowSeconds).toBe(30);
    // The delay IS the recall window: they cannot drift apart.
    expect(status.intake).toMatchObject({ mode: 'deferred', deferMs: 30_000, contextMessages: 20 });
  });
});
