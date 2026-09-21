/**
 * What happens when a reconnecting client asks for a cursor the server can no longer honour.
 *
 * The replay buffer is memory, so a restart wipes it. Returning an empty list for a stale cursor
 * tells the client "nothing happened while you were away" - a lie it believes, and the messages
 * it missed stay missed. The stream must instead say "reload".
 */
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
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
];

const cursorIt = (name: string, fn: () => Promise<void>) => it(name, fn, 30_000);

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

function openStream(
  app: FastifyInstance,
  token: string,
  query: string,
  waitMs = 600,
): Promise<{ status: number; body: string }> {
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server is not listening');
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: address.port,
        path: '/api/events/stream' + query,
        method: 'GET',
        headers: { authorization: 'Bearer ' + token, accept: 'text/event-stream' },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        setTimeout(() => {
          res.destroy();
          resolve({ status: res.statusCode ?? 0, body });
        }, waitMs);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('stale event cursors', () => {
  cursorIt('reports a cursor older than the buffer as truncated, not as empty', async () => {
    const hub = new NativeEventHub({ replayBufferSize: 2 });
    for (let index = 0; index < 4; index += 1) {
      hub.publish({ type: 'conversation_updated', conversationId: 'c1', title: 't' + index, at: 'now' });
    }
    expect(hub.oldestSeq).toBe(3);
    const stale = hub.since(0);
    expect(stale.truncated, 'cursor 0 is older than everything still held').toBe(true);
    expect(stale.entries.map((entry) => entry.seq)).toEqual([3, 4]);
    // A cursor inside the window is served normally.
    expect(hub.since(3).truncated).toBe(false);
    expect(hub.since(3).entries.map((entry) => entry.seq)).toEqual([4]);
    // An empty buffer with a client that claims to have seen events: the buffer was reset,
    // so the server cannot vouch for the gap and says so.
    const restarted = new NativeEventHub({ replayBufferSize: 2 });
    expect(restarted.since(7).truncated).toBe(true);
    expect(restarted.since(0).truncated, 'a client at the beginning is not behind').toBe(false);
  });

  cursorIt('sends resync before replaying whatever is still held', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    await app.listen({ port: 0, host: '127.0.0.1' });

    // A cursor from before the process started: nothing in the buffer can satisfy it.
    const resumed = await openStream(app, alice, '?since=1');
    expect(resumed.status).toBe(200);
    expect(resumed.body).toContain('event: resync');
    expect(resumed.body).toContain('cursor_expired');

    // A stream without a cursor does not get the notice: it is not resuming anything.
    const fresh = await openStream(app, alice, '');
    expect(fresh.status).toBe(200);
    expect(fresh.body).not.toContain('event: resync');
    expect(fresh.body).toContain(': connected');
  });

  cursorIt('does not claim a truncation it cannot prove', async () => {
    const { app } = await boot();
    const alice = await login(app, 'u_alice', 'alice-token');
    await app.listen({ port: 0, host: '127.0.0.1' });

    // Cursor 0 with an empty buffer: nothing is held, so the client is genuinely up to date.
    const empty = await openStream(app, alice, '?since=0');
    expect(empty.status).toBe(200);
    expect(empty.body).not.toContain('event: resync');
  });
});
