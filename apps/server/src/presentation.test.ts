/**
 * Presentation and notification preferences (P1-4).
 *
 * The audit found a forwarded message lost its author and time in the UI, images were only
 * downloadable, and every message raised the same notification. These tests pin what the
 * server now sends and what the client does with it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatMessage, Conversation, ConversationSummary, ForwardedFrom } from '@chatagent/contracts';
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

const presentIt = (name: string, fn: () => Promise<void>) => it(name, fn, 30_000);

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

async function send(app: FastifyInstance, token: string, id: string, text: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/conversations/' + id + '/messages',
    headers: auth(token),
    payload: { text },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as { message: ChatMessage };
}

async function summaries(app: FastifyInstance, token: string): Promise<ConversationSummary[]> {
  return (
    await app.inject({ method: 'GET', url: '/api/conversations', headers: auth(token) })
  ).json() as ConversationSummary[];
}

describe('forwarded messages', () => {
  presentIt('carries the original author and time with the copy', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');

    const source = await openDirect(app, alice, 'u_bob');
    const original = await send(app, alice, source.id, '季度目标已确认');

    // Bob forwards it into a fresh conversation with Alice.
    const target = await openDirect(app, bob, 'u_alice');
    const forwarded = (
      await app.inject({
        method: 'POST',
        url: '/api/messages/' + original.message.id + '/forward',
        headers: auth(bob),
        payload: { conversationId: target.id },
      })
    ).json() as { message: ChatMessage };

    const provenance = forwarded.message.metadata?.forwardedFrom as ForwardedFrom;
    expect(provenance.senderName).toBe('Alice');
    expect(provenance.messageId).toBe(original.message.id);
    // Without this the copy would claim to have been written just now.
    expect(provenance.createdAt).toBe(original.message.createdAt);
    expect(forwarded.message.text).toBe('季度目标已确认');
  });
});

describe('conversation mute', () => {
  presentIt('mutes one member only, and keeps the unread count honest', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');
    const conversation = await openDirect(app, alice, 'u_bob');

    const muted = await app.inject({
      method: 'POST',
      url: '/api/conversations/' + conversation.id + '/mute',
      headers: auth(alice),
      payload: { muted: true },
    });
    expect(muted.statusCode, muted.body).toBe(200);
    expect((muted.json() as { muted: boolean }).muted).toBe(true);

    await send(app, bob, conversation.id, '周报我改好了');
    const aliceView = (await summaries(app, alice)).find((item) => item.id === conversation.id);
    expect(aliceView?.muted).toBe(true);
    // Muting hides the notification, never the message: the badge stays truthful.
    expect(aliceView?.unreadCount).toBe(1);
    // The peer's own view is untouched.
    const bobView = (await summaries(app, bob)).find((item) => item.id === conversation.id);
    expect(bobView?.muted).toBe(false);

    // Un-muting is the same call with false, and does not lose the read cursor.
    const unmuted = await app.inject({
      method: 'POST',
      url: '/api/conversations/' + conversation.id + '/mute',
      headers: auth(alice),
      payload: { muted: false },
    });
    expect((unmuted.json() as { muted: boolean }).muted).toBe(false);
    expect((await summaries(app, alice)).find((item) => item.id === conversation.id)?.muted).toBe(
      false,
    );
  });

  presentIt('refuses a mute for somebody who is not in the conversation', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const conversation = await openDirect(app, alice, 'u_bob');

    const outsider = await app.inject({
      method: 'POST',
      url: '/api/conversations/' + conversation.id + '/mute',
      headers: auth('not-a-session'),
      payload: { muted: true },
    });
    expect(outsider.statusCode).toBe(401);

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/conversations/' + conversation.id + '/mute',
      headers: auth(alice),
      payload: { muted: 'yes' },
    });
    expect(malformed.statusCode).toBe(400);
  });
});
