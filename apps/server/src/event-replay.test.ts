/**
 * Reconnect and retry behaviour of the native event stream.
 *
 * Two guarantees are pinned here: a stream that drops can ask for what it missed (event ids
 * plus replayed events, still authorized per event), and a retried send cannot create a
 * second message (the client's key returns the first one).
 */
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ChatMessage, Conversation } from '@chatagent/contracts';
import { NativeEventHub } from './events';
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

const streamIt = (name: string, fn: () => Promise<void>) => it(name, fn, 30_000);

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

async function send(app: FastifyInstance, token: string, conversationId: string, text: string, clientMsgId?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/conversations/' + conversationId + '/messages',
    headers: auth(token),
    payload: { text, clientMsgId },
  });
}

interface StreamCapture {
  status: number;
  body: string;
  close(): void;
}

/** Opens the SSE endpoint and returns what it wrote until the deadline. */
function openStream(
  app: FastifyInstance,
  token: string,
  options: { lastEventId?: number; since?: number } = {},
  waitMs = 700,
): Promise<StreamCapture> {
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server is not listening');
  const query = options.since === undefined ? '' : `?since=${options.since}`;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: address.port,
        path: `/api/events/stream${query}`,
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'text/event-stream',
          ...(options.lastEventId === undefined
            ? {}
            : { 'last-event-id': String(options.lastEventId) }),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        setTimeout(() => {
          res.destroy();
          resolve({ status: res.statusCode ?? 0, body, close: () => res.destroy() });
        }, waitMs);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function seqOf(body: string, needle: string): number | undefined {
  // Finds the `id:` line that precedes the data line carrying the needle.
  const blocks = body.split('\n\n');
  for (const block of blocks) {
    if (!block.includes(needle)) continue;
    const idLine = block.split('\n').find((line) => line.startsWith('id: '));
    if (idLine) return Number(idLine.slice(4));
  }
  return undefined;
}

describe('event hub sequencing', () => {
  it('numbers published events and replays only what is newer', () => {
    const hub = new NativeEventHub({ replayBufferSize: 3 });
    const delivered: number[] = [];
    hub.subscribe((_event, seq) => delivered.push(seq));
    for (let index = 0; index < 5; index += 1) {
      hub.publish({ type: 'conversation_updated', conversationId: 'c1', title: `t${index}`, at: 'now' });
    }
    expect(delivered).toEqual([1, 2, 3, 4, 5]);
    expect(hub.latestSeq).toBe(5);
    // The buffer is bounded: only the newest three survive, so a very old cursor simply
    // gets what is still held instead of a false "nothing missed".
    expect(hub.since(0).map((entry) => entry.seq)).toEqual([3, 4, 5]);
    expect(hub.since(4).map((entry) => entry.seq)).toEqual([5]);
    expect(hub.since(5)).toEqual([]);
    expect(hub.since(Number.NaN)).toEqual([]);
  });
});

describe('stream reconnect', () => {
  streamIt('replays the events a reconnecting client missed, with event ids', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');
    const conversation = await openDirect(app, alice, 'u_bob');
    await app.listen({ port: 0, host: '127.0.0.1' });

    // Alice sees her own event first, so the test knows the cursor to resume from.
    const live = await openStream(app, alice, {}, 300);
    const first = await send(app, alice, conversation.id, '第一条');
    expect(first.statusCode, first.body).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    live.close();

    // Bob was offline for the second message: reconnect with Last-Event-ID from before it.
    const missed = await send(app, alice, conversation.id, '断线期间的消息');
    const missedId = (missed.json() as { message: ChatMessage }).message.id;
    const resumed = await openStream(app, bob, { lastEventId: 0 });
    expect(resumed.status).toBe(200);
    expect(resumed.body).toContain(missedId);
    expect(resumed.body).toContain('断线期间的消息');
    expect(seqOf(resumed.body, missedId)).toBeGreaterThan(0);
  });

  streamIt('re-authorizes every replayed event instead of trusting the cursor', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const carol = await login(app, 'u_carol', 'carol-token');
    const conversation = await openDirect(app, alice, 'u_bob');
    await app.listen({ port: 0, host: '127.0.0.1' });
    const sent = await send(app, alice, conversation.id, '只给 Bob 看的内容');
    const messageId = (sent.json() as { message: ChatMessage }).message.id;

    // Carol is not a participant: the cursor is not a key.
    const stranger = await openStream(app, carol, { since: 0 });
    expect(stranger.status).toBe(200);
    expect(stranger.body).not.toContain(messageId);
    expect(stranger.body).not.toContain('只给 Bob 看的内容');
  });
});

describe('idempotent send', () => {
  streamIt('stores one message when a send is retried with the same client key', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    const conversation = await openDirect(app, alice, 'u_bob');

    const first = await send(app, alice, conversation.id, '超时后重试的消息', 'draft-1');
    expect(first.statusCode, first.body).toBe(200);
    const retried = await send(app, alice, conversation.id, '超时后重试的消息', 'draft-1');
    expect(retried.statusCode, retried.body).toBe(200);
    const firstId = (first.json() as { message: ChatMessage }).message.id;
    expect((retried.json() as { message: ChatMessage }).message.id).toBe(firstId);

    const messages = (
      await app.inject({
        method: 'GET',
        url: '/api/conversations/' + conversation.id + '/messages',
        headers: auth(alice),
      })
    ).json() as ChatMessage[];
    expect(messages.filter((message) => message.text === '超时后重试的消息')).toHaveLength(1);

    // A different key is a different message: the key is not a global de-duplicator.
    const other = await send(app, alice, conversation.id, '超时后重试的消息', 'draft-2');
    expect((other.json() as { message: ChatMessage }).message.id).not.toBe(firstId);
  });
});
