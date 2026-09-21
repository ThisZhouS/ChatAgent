/**
 * Conversation appearance.
 *
 * The value is rendered by every client, so the server only ever stores a preset id or a plain
 * hex colour. A style string from the network would be a CSS-injection surface: `url(...)` in a
 * background can make a client issue a request the user never asked for.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Conversation, ConversationSummary } from '@chatagent/contracts';
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

const lookIt = (name: string, fn: () => Promise<void>) => it(name, fn, 30_000);

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

async function setAppearance(
  app: FastifyInstance,
  token: string,
  id: string,
  payload: Record<string, unknown>,
) {
  return app.inject({
    method: 'POST',
    url: '/api/conversations/' + id + '/appearance',
    headers: auth(token),
    payload,
  });
}

async function summaries(app: FastifyInstance, token: string): Promise<ConversationSummary[]> {
  return (
    await app.inject({ method: 'GET', url: '/api/conversations', headers: auth(token) })
  ).json() as ConversationSummary[];
}

describe('conversation appearance', () => {
  lookIt('stores a preset or a hex colour and shows it to the participants', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');
    const conversation = await openDirect(app, alice, 'u_bob');

    const preset = await setAppearance(app, alice, conversation.id, { background: 'paper' });
    expect(preset.statusCode, preset.body).toBe(200);
    expect((preset.json() as Conversation).appearance).toEqual({ background: 'paper' });

    // Everyone in the conversation sees the same room.
    const bobView = (await summaries(app, bob)).find((item) => item.id === conversation.id);
    expect(bobView?.appearance).toEqual({ background: 'paper' });

    // A hex colour is normalised to lower case; the preset can be replaced by it.
    const coloured = await setAppearance(app, bob, conversation.id, {
      background: 'mint',
      color: '#A1B2C3',
    });
    expect(coloured.statusCode, coloured.body).toBe(200);
    expect((coloured.json() as Conversation).appearance).toEqual({
      background: 'mint',
      color: '#a1b2c3',
    });

    // Clearing it restores the client default.
    const cleared = await setAppearance(app, alice, conversation.id, {});
    expect((cleared.json() as Conversation).appearance).toBeUndefined();
  });

  lookIt('refuses anything that is not a preset id or a hex colour', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const conversation = await openDirect(app, alice, 'u_bob');

    // A style string is the thing this feature must never accept.
    for (const payload of [
      { color: 'url(https://evil.invalid/pixel)' },
      { color: 'red; background-image: url(//evil)' },
      { background: 'Paper' },
      { background: 'paper; background: red' },
      { color: '#12345' },
      { extra: 'x' },
    ]) {
      const refused = await setAppearance(app, alice, conversation.id, payload);
      expect(refused.statusCode, JSON.stringify(payload)).toBe(400);
    }

    // Nothing was stored by the refused attempts.
    const view = (await summaries(app, alice)).find((item) => item.id === conversation.id);
    expect(view?.appearance).toBeUndefined();
  });

  lookIt('refuses an outsider, and a missing conversation stays a 404', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const carol = await login(app, 'u_carol', 'carol-token');
    const conversation = await openDirect(app, alice, 'u_bob');

    const outsider = await setAppearance(app, carol, conversation.id, { background: 'paper' });
    expect(outsider.statusCode).toBe(404);

    const missing = await setAppearance(app, alice, 'conv_does_not_exist', { background: 'paper' });
    expect(missing.statusCode).toBe(404);
  });
});
