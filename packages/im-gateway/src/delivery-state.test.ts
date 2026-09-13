import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeDingTalk } from './normalizers';
import { WebhookImGateway } from './webhook-gateway';

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = request.url ?? '/';
    if (url.startsWith('/500')) {
      response.writeHead(502, { 'Content-Type': 'text/plain' }).end('bad gateway');
      return;
    }
    if (url.startsWith('/400')) {
      response.writeHead(400, { 'Content-Type': 'text/plain' }).end('bad request');
      return;
    }
    if (url.startsWith('/biz')) {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ errcode: 1 }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server not listening');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function gateway(path: string): WebhookImGateway {
  return new WebhookImGateway({
    channel: 'dingtalk',
    name: 'dingtalk',
    normalizer: normalizeDingTalk,
    sendUrl: `${base}${path}`,
  });
}

describe('outbound delivery states', () => {
  it('maps a 5xx to unknown so a blind resend cannot duplicate the send', async () => {
    const result = await gateway('/500').sendMessage({
      accountId: 'acc_1',
      to: 'u_bob',
      chatType: 'direct',
      text: 'hi',
    });
    expect(result.state).toBe('unknown');
    expect(result.ok).toBe(false);
  });

  it('maps a 4xx to failed (safe to retry)', async () => {
    const result = await gateway('/400').sendMessage({
      accountId: 'acc_1',
      to: 'u_bob',
      chatType: 'direct',
      text: 'hi',
    });
    expect(result.state).toBe('failed');
  });

  it('treats a 2xx business error as failed', async () => {
    const result = await gateway('/biz').sendFile({
      accountId: 'acc_1',
      to: 'u_bob',
      chatType: 'direct',
      name: 'report.docx',
    });
    expect(result.state).toBe('failed');
  });

  it('treats a clean 2xx as accepted', async () => {
    const result = await gateway('/ok').sendMessage({
      accountId: 'acc_1',
      to: 'u_bob',
      chatType: 'direct',
      text: 'hi',
    });
    expect(result.state).toBe('accepted');
    expect(result.ok).toBe(true);
  });

  it('reports simulated when no delivery endpoint is configured', async () => {
    const local = new WebhookImGateway({
      channel: 'dingtalk',
      name: 'dingtalk',
      normalizer: normalizeDingTalk,
    });
    const result = await local.sendMessage({
      accountId: 'acc_1',
      to: 'u_bob',
      chatType: 'direct',
      text: 'hi',
    });
    expect(result.state).toBe('simulated');
    expect(result.ok).toBe(false);
  });
});
