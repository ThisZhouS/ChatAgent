/**
 * Contact tiers: how much an assistant may do with a message from a given person.
 *
 * The rule is enforced in code at three points - intake (is it handed over at all), the
 * run's tool surface (what may it use), and direct task submission - so these tests drive
 * the real HTTP surface and check effects, not intentions.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AgentAccount, ChatMessage, Conversation, TaskRecord } from '@chatagent/contracts';
import { allowedToolsForTier, resolveContactTier, tierPolicy, tierPromptRule } from './agent-tier';
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

const tierIt = (name: string, fn: () => Promise<void>) => it(name, fn, 30_000);

async function boot() {
  const test = await createTestApp({
    members: MEMBERS,
    // Immediate handoff: these tests are about tiers, not about the recall window.
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

async function firstAccount(app: FastifyInstance): Promise<AgentAccount> {
  const response = await app.inject({ method: 'GET', url: '/api/accounts' });
  expect(response.statusCode, response.body).toBe(200);
  return response.json()[0] as AgentAccount;
}

async function openAgentConversation(
  app: FastifyInstance,
  accountId: string,
  token?: string,
): Promise<Conversation> {
  const opened = await app.inject({
    method: 'POST',
    url: '/api/conversations',
    headers: token ? auth(token) : {},
    payload: { targetId: accountId, targetKind: 'agent' },
  });
  expect(opened.statusCode, opened.body).toBe(200);
  return opened.json() as Conversation;
}

async function listTasks(app: FastifyInstance, token: string): Promise<TaskRecord[]> {
  const response = await app.inject({ method: 'GET', url: '/api/tasks', headers: auth(token) });
  return response.json() as TaskRecord[];
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

describe('contact tier resolution', () => {
  const account = {
    ownerId: 'u_owner',
    defaultTier: 'chat' as const,
    contactTiers: { u_alice: 'ignore' as const },
  };

  it('derives the owner tier from ownership, never from configuration', () => {
    expect(resolveContactTier(account, 'u_owner')).toBe('owner');
    expect(resolveContactTier(account, 'u_alice')).toBe('ignore');
    expect(resolveContactTier(account, 'u_carol')).toBe('chat');
    expect(resolveContactTier(account, undefined)).toBe('chat');
  });

  it('treats an organization admin as the owner tier', () => {
    expect(resolveContactTier({ ownerId: 'u_owner' }, 'u_admin', { isOrgAdmin: true })).toBe('owner');
  });

  it('falls back to confirm for unknown or unusable values', () => {
    expect(resolveContactTier({ ownerId: 'u_owner' }, 'u_carol')).toBe('confirm');
    // A stored value that is not a known tier must not widen permissions.
    const odd = {
      ownerId: 'u_owner',
      defaultTier: 'root' as never,
      contactTiers: { u_bob: 'all' as never },
    };
    expect(resolveContactTier(odd, 'u_bob')).toBe('confirm');
    expect(resolveContactTier(odd, 'u_carol')).toBe('confirm');
  });

  it('describes each tier in one rule line for the prompt', () => {
    expect(tierPromptRule('chat', 'Alice')).toContain('CHAT tier');
    expect(tierPromptRule('ignore', 'Alice')).toContain('IGNORE tier');
    expect(tierPromptRule('confirm', 'Alice')).toContain('CONFIRM tier');
    expect(tierPromptRule('owner', 'Alice')).toContain('account owner');
  });

  it('turns a tier into a hard tool surface', () => {
    const registered = ['parse_document', 'create_word_document', 'send_message', 'forward_file'];
    expect(tierPolicy('ignore').intake).toBe(false);
    expect(allowedToolsForTier('chat', registered)).toEqual(['parse_document']);
    // Owner and confirm keep the full surface; side effects still need an approval.
    expect(allowedToolsForTier('owner', registered)).toBeUndefined();
    expect(allowedToolsForTier('confirm', registered)).toBeUndefined();
  });
});

describe('contact tier enforcement', () => {
  tierIt('refuses to hand a message from an ignored contact to the assistant', async () => {
    const { app, dataDir } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const account = await firstAccount(app);

    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/accounts/' + account.id,
      payload: { contactTiers: { u_alice: 'ignore' } },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect((patched.json() as AgentAccount).contactTiers).toMatchObject({ u_alice: 'ignore' });

    const conversation = await openAgentConversation(app, account.id, alice);
    const sent = await app.inject({
      method: 'POST',
      url: '/api/conversations/' + conversation.id + '/messages',
      headers: auth(alice),
      payload: { text: '帮我整理一份周报' },
    });
    expect(sent.statusCode, sent.body).toBe(200);
    const body = sent.json() as { intake?: unknown; taskId?: string; message: ChatMessage };
    // The message exists (it is a chat message), but no assistant was asked to read it.
    expect(body.message.text).toBe('帮我整理一份周报');
    expect(body.intake).toBeUndefined();
    expect(body.taskId).toBeUndefined();
    expect(await listTasks(app, alice)).toHaveLength(0);

    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const audit = await readFile(join(dataDir, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('agent_intake.ignored');
  });

  tierIt('refuses a direct task submission from an ignored contact', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const account = await firstAccount(app);
    await app.inject({
      method: 'PATCH',
      url: '/api/accounts/' + account.id,
      payload: { defaultTier: 'ignore' },
    });

    const submitted = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: auth(alice),
      payload: { accountId: account.id, goal: '帮我整理一份周报' },
    });
    // The API is the second door into the same room: it is closed too, with a reason an
    // operator can act on (the tier is the owner's policy, not a generic denial).
    expect(submitted.statusCode).toBe(403);
    expect(submitted.json().detail).toBe('contact_tier_ignored');
    expect(await listTasks(app, alice)).toHaveLength(0);
  });

  tierIt('stops a chat-tier contact from producing side effects, while the owner still can', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const account = await firstAccount(app);
    await app.inject({
      method: 'PATCH',
      url: '/api/accounts/' + account.id,
      payload: { contactTiers: { u_alice: 'chat' } },
    });

    const conversation = await openAgentConversation(app, account.id, alice);
    const sent = await app.inject({
      method: 'POST',
      url: '/api/conversations/' + conversation.id + '/messages',
      headers: auth(alice),
      payload: { text: '帮我生成一份 Word 周报' },
    });
    expect(sent.statusCode, sent.body).toBe(200);
    // The chat tier may talk, so the request is accepted and a task exists.
    const created = await waitFor(async () => (await listTasks(app, alice)).length > 0);
    expect(created, 'the chat tier still gets an answer path').toBe(true);
    await waitFor(async () =>
      (await listTasks(app, alice)).some((task) => task.state === 'completed'),
    );
    const aliceTask = (await listTasks(app, alice)).find((task) => task.requesterId === 'u_alice');
    // The run reached a terminal state without producing anything: the document tool was
    // switched off, so the assistant could only answer in words.
    expect(['completed', 'failed', 'incomplete']).toContain(aliceTask?.state);
    expect(aliceTask?.artifacts ?? []).toHaveLength(0);

    // The owner is unaffected by a contact's tier and still gets the document, which is
    // what makes the assertion above meaningful rather than a broken pipeline.
    const ownerConversation = await openAgentConversation(app, account.id);
    await app.inject({
      method: 'POST',
      url: '/api/conversations/' + ownerConversation.id + '/messages',
      payload: { text: '帮我生成一份 Word 周报' },
    });
    const ownerProduced = await waitFor(async () => {
      const response = await app.inject({ method: 'GET', url: '/api/tasks' });
      return (response.json() as TaskRecord[]).some((task) => (task.artifacts ?? []).length > 0);
    });
    expect(ownerProduced, 'the owner tier still produces documents').toBe(true);
  });
});
