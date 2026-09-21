/**
 * Stickers: a closed catalogue, and a message that is only a sticker.
 *
 * The catalogue lives in contracts (STICKER_IDS), so the server can refuse an unknown id and
 * every client renders the same set from its own bundle. Nothing user-supplied is ever treated
 * as a sticker: the id is the whole payload.
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
];

const stickerIt = (name: string, fn: () => Promise<void>) => it(name, fn, 30_000);

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

async function send(app: FastifyInstance, token: string, id: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/conversations/' + id + '/messages',
    headers: auth(token),
    payload,
  });
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

describe('stickers', () => {
  stickerIt('stores a catalogue sticker as a message of its own', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');
    const conversation = await openDirect(app, alice, 'u_bob');

    // A sticker needs neither text nor attachments.
    const sent = await send(app, alice, conversation.id, { sticker: 'ok' });
    expect(sent.statusCode, sent.body).toBe(200);
    const message = (sent.json() as { message: ChatMessage }).message;
    expect(message.sticker).toBe('ok');
    expect(message.kind).toBe('image');
    expect(message.text).toBe('');

    // The recipient sees the same id and renders it from their own bundle.
    const thread = await messages(app, bob, conversation.id);
    expect(thread[0]?.sticker).toBe('ok');

    // It shows up in the conversation preview as well (with an empty body).
    const summaries = (
      await app.inject({ method: 'GET', url: '/api/conversations', headers: auth(bob) })
    ).json() as ConversationSummary[];
    const preview = summaries.find((item) => item.id === conversation.id)?.lastMessage;
    expect(preview?.kind).toBe('image');
  });

  stickerIt('refuses a sticker id outside the catalogue, and stays compatible with text', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const conversation = await openDirect(app, alice, 'u_bob');

    // The catalogue is the contract: an invented id is a 400, not a silently stored payload.
    const invented = await send(app, alice, conversation.id, {
      sticker: 'data:image/svg+xml,<svg onload=alert(1)>',
    });
    expect(invented.statusCode).toBe(400);

    // Nothing was stored by the refused attempt.
    expect(await messages(app, alice, conversation.id)).toHaveLength(0);

    // An empty message is still refused: a sticker is the only thing that may stand alone.
    expect((await send(app, alice, conversation.id, {})).statusCode).toBe(400);

    // Text beside a sticker is allowed (a reaction with a note).
    const withText = await send(app, alice, conversation.id, { sticker: 'thanks', text: '辛苦了' });
    expect(withText.statusCode, withText.body).toBe(200);
    const message = (withText.json() as { message: ChatMessage }).message;
    expect(message.sticker).toBe('thanks');
    expect(message.text).toBe('辛苦了');
  });
});
