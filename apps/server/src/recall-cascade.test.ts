/**
 * Cascade recall (product decision 3B, 2026-09-21).
 *
 * The owner decided that withdrawing a message also withdraws its forwarded copies: a copy
 * that stays readable would make "I took it back" untrue. Copies may live in another
 * conversation, so the cascade finds them by provenance rather than by room.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatMessage, Conversation } from '@chatagent/contracts';
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

const cascadeIt = (name: string, fn: () => Promise<void>) => it(name, fn, 30_000);

async function boot() {
  const test = await createTestApp({ members: MEMBERS });
  active.push(test.app);
  return test;
}

async function login(app: FastifyInstance, memberId: string, token: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { memberId, token } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json().token as string;
}

function auth(token: string): Record<string, string> {
  return { authorization: 'Bearer ' + token };
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
  const response = await app.inject({
    method: 'POST',
    url: '/api/conversations/' + conversationId + '/messages',
    headers: auth(token),
    payload: { text },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as { message: ChatMessage };
}

async function forward(app: FastifyInstance, token: string, messageId: string, conversationId: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/messages/' + messageId + '/forward',
    headers: auth(token),
    payload: { conversationId },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as { message: ChatMessage };
}

async function recall(app: FastifyInstance, token: string, messageId: string) {
  return app.inject({ method: 'POST', url: '/api/messages/' + messageId + '/recall', headers: auth(token) });
}

async function messages(app: FastifyInstance, token: string, conversationId: string): Promise<ChatMessage[]> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/conversations/' + conversationId + '/messages',
    headers: auth(token),
  });
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json() as { messages?: ChatMessage[] } | ChatMessage[];
  return Array.isArray(body) ? body : (body.messages ?? []);
}

describe('cascade recall of forwarded copies', () => {
  cascadeIt('withdraws the copies too, wherever they were forwarded to', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');

    const room = await openDirect(app, alice, 'u_bob');
    const original = await send(app, alice, room.id, '季度目标已确认');
    const elsewhere = await openDirect(app, bob, 'u_alice');
    const copy = await forward(app, bob, original.message.id, elsewhere.id);
    expect(copy.message.metadata?.forwardedFrom).toBeTruthy();

    const recalled = await recall(app, alice, original.message.id);
    expect(recalled.statusCode, recalled.body).toBe(200);

    const copies = await messages(app, bob, elsewhere.id);
    const after = copies.find((message) => message.id === copy.message.id);
    expect(after, 'the forwarded copy still exists as a row').toBeTruthy();
    expect(after?.recalledAt, 'the copy must be recalled as well').toBeTruthy();
    expect(after?.text ?? '').not.toContain('季度目标已确认');
  });

  cascadeIt('leaves a copy alone when its own sender already withdrew it', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');

    const room = await openDirect(app, alice, 'u_bob');
    const original = await send(app, alice, room.id, '待办清单');
    const elsewhere = await openDirect(app, bob, 'u_alice');
    const copy = await forward(app, bob, original.message.id, elsewhere.id);
    expect((await recall(app, bob, copy.message.id)).statusCode).toBe(200);

    // The original is still inside its own window, so this must succeed rather than throw.
    expect((await recall(app, alice, original.message.id)).statusCode).toBe(200);
    const copies = await messages(app, bob, elsewhere.id);
    expect(copies.find((message) => message.id === copy.message.id)?.recalledAt).toBeTruthy();
  });

  cascadeIt('still refuses a recall from someone who is not the sender', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');

    const room = await openDirect(app, alice, 'u_bob');
    const original = await send(app, alice, room.id, '不要动这条');
    const refused = await recall(app, bob, original.message.id);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().detail).toBe('sender_only');
  });
});
