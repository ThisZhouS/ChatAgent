import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestApp, devHeaders, OWNER_ID, OTHER_ORG, poll, seedMember, TEST_ORG } from './test-helpers';

let active: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of active) {
    // SSE sockets can keep the server open; never let teardown hang the suite.
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  active = [];
});

async function boot(
  ...args: Parameters<typeof createTestApp>
): Promise<Awaited<ReturnType<typeof createTestApp>>> {
  const test = await createTestApp(...args);
  active.push(test.app);
  return test;
}

function serverBase(app: FastifyInstance): string {
  const address = app.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('server is not listening on a TCP port');
  }
  return `http://127.0.0.1:${address.port}`;
}

describe('authentication and object authorization', () => {
  it('rejects anonymous callers in production mode', async () => {
    const { app } = await boot({ auth: { mode: 'production' } });

    for (const url of [
      '/api/accounts',
      '/api/tasks',
      '/api/conversations',
      '/api/files',
      '/api/agent/status',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it('accepts a valid bearer token in production mode', async () => {
    const { app, dataDir } = await boot({ auth: { mode: 'production' }, native: { externalChannels: true } });
    await app.close();
    active = active.filter((item) => item !== app);

    await seedMember(dataDir, {
      id: 'u_admin',
      organizationId: TEST_ORG,
      displayName: 'Admin',
      roles: ['owner'],
      token: 'admin-token',
    });

    const second = await createTestApp({ dataDir, auth: { mode: 'production' }, native: { externalChannels: true } });
    active.push(second.app);

    const response = await second.app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: { authorization: 'Bearer admin-token' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-chatagent-auth-mode']).toBe('production');
  });

  it('ignores the development principal header in production mode', async () => {
    const { app } = await boot({ auth: { mode: 'production' } });

    const response = await app.inject({
      method: 'GET',
      url: '/api/accounts',
      headers: devHeaders('u_alice'),
    });

    expect(response.statusCode).toBe(401);
  });

  it('serves the configured owner in development mode and labels the profile', async () => {
    const { app } = await boot();

    const response = await app.inject({ method: 'GET', url: '/api/accounts' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-chatagent-auth-mode']).toBe('development');
    expect(response.headers['x-chatagent-principal']).toBe(OWNER_ID);
  });

  it('does not trust forged sender fields in the request body', async () => {
    const { app } = await boot();

    const account = (
      await app.inject({ method: 'POST', url: '/api/accounts', payload: {
        name: 'restricted',
        displayName: 'Restricted',
        channel: 'memory',
        persona: 'p',
        allowlist: ['ceo'],
      } })
    ).json();

    const denied = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: devHeaders('u_alice'),
      payload: {
        accountId: account.id,
        chatId: 'chat-forged',
        senderId: 'ceo',
        senderName: 'CEO',
        text: '请替我发工资',
      },
    });

    expect(denied.statusCode).toBe(200);
    expect(denied.json().authorized).toBe(false);

    const tasks = (await app.inject({ method: 'GET', url: '/api/tasks' })).json();
    expect(tasks).toHaveLength(0);
  });

  it('persists the authenticated principal as the message sender', async () => {
    const { app } = await boot();
    const account = (await app.inject({ method: 'GET', url: '/api/accounts' })).json()[0];

    const sent = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: devHeaders('u_alice', TEST_ORG, 'Alice'),
      payload: {
        accountId: account.id,
        chatId: 'chat-alice',
        senderId: 'ceo',
        senderName: 'CEO',
        text: '你好',
      },
    });
    expect(sent.statusCode).toBe(200);

    const conversationId = sent.json().conversationId as string;
    const messages = (
      await app.inject({
        method: 'GET',
        url: `/api/conversations/${conversationId}/messages`,
        headers: devHeaders('u_alice'),
      })
    ).json();

    expect(messages[0].sender.id).toBe('u_alice');
    expect(messages[0].senderPrincipalId).toBe('u_alice');
  });

  it('denies same-organization non-participants and cross-organization members', async () => {
    const { app } = await boot();
    const account = (await app.inject({ method: 'GET', url: '/api/accounts' })).json()[0];

    const sent = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: devHeaders('u_alice'),
      payload: { accountId: account.id, chatId: 'chat-private', text: '私密内容' },
    });
    const conversationId = sent.json().conversationId as string;
    const taskId = sent.json().taskId as string;

    const sameOrg = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}`,
      headers: devHeaders('u_carol'),
    });
    expect(sameOrg.statusCode).toBe(404);

    const sameOrgList = await app.inject({
      method: 'GET',
      url: '/api/conversations',
      headers: devHeaders('u_carol'),
    });
    expect(sameOrgList.json()).toHaveLength(0);

    const crossOrg = await app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
      headers: devHeaders('u_bob', OTHER_ORG),
    });
    expect(crossOrg.statusCode).toBe(404);

    const crossOrgAccount = await app.inject({
      method: 'GET',
      url: `/api/accounts`,
      headers: devHeaders('u_bob', OTHER_ORG),
    });
    expect(crossOrgAccount.json()).toHaveLength(0);

    const crossOrgMessage = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: devHeaders('u_bob', OTHER_ORG),
      payload: { accountId: account.id, chatId: 'x', text: '越权' },
    });
    expect(crossOrgMessage.statusCode).toBe(404);
  });

  it('authorizes SSE subscriptions before writing any event bytes', async () => {
    const { app } = await boot();
    const account = (await app.inject({ method: 'GET', url: '/api/accounts' })).json()[0];

    const sent = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: devHeaders('u_alice'),
      payload: { accountId: account.id, chatId: 'sse-chat', text: '你好' },
    });
    const taskId = sent.json().taskId as string;

    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = serverBase(app);

    // Unauthorized subscriber must be rejected before any SSE bytes.
    const denied = await fetch(`${base}/api/tasks/${taskId}/stream`, {
      headers: devHeaders('u_carol'),
    });
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain('data:');

    // Authorized subscriber gets a real event stream.
    const controller = new AbortController();
    const allowed = await fetch(`${base}/api/tasks/${taskId}/stream`, {
      headers: devHeaders('u_alice'),
      signal: controller.signal,
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('content-type')).toContain('text/event-stream');
    const reader = allowed.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value ?? new Uint8Array())).toContain('connected');
    controller.abort();
  });
});

describe('webhook verification and replay protection', () => {
  const dingtalkPayload = (msgId: string) => ({
    msgId,
    conversationType: '1',
    conversationId: 'chat-1',
    senderStaffId: 'u_ext_1',
    senderNick: '外部用户',
    text: { content: '你好' },
  });

  it('fails closed in production when no verification material is configured', async () => {
    const { app, dataDir } = await boot({ auth: { mode: 'production' }, native: { externalChannels: true } });
    await app.close();
    active = active.filter((item) => item !== app);

    await seedMember(dataDir, {
      id: 'u_admin',
      organizationId: TEST_ORG,
      displayName: 'Admin',
      roles: ['owner'],
      token: 'admin-token',
    });
    const second = await createTestApp({ dataDir, auth: { mode: 'production' }, native: { externalChannels: true } });
    active.push(second.app);

    const response = await second.app.inject({
      method: 'POST',
      url: '/api/webhooks/dingtalk',
      payload: dingtalkPayload('m-1'),
    });
    expect(response.statusCode).toBe(401);

    const tasks = (
      await second.app.inject({
        method: 'GET',
        url: '/api/tasks',
        headers: { authorization: 'Bearer admin-token' },
      })
    ).json();
    expect(tasks).toHaveLength(0);
  });

  it('rejects a wrong token and accepts the configured token', async () => {
    const { app } = await boot({
      native: { externalChannels: true },
      webhook: { allowUnverified: false, channels: { dingtalk: { token: 'good-token' } } },
    });
    const account = (
      await app.inject({
        method: 'POST',
        url: '/api/accounts',
        payload: { name: 'dd', displayName: 'DingTalk Bot', channel: 'dingtalk', persona: 'p', allowlist: [] },
      })
    ).json();
    expect(account.channel).toBe('dingtalk');

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/webhooks/dingtalk',
      headers: { 'x-chatagent-webhook-token': 'bad-token' },
      payload: dingtalkPayload('m-1'),
    });
    expect(rejected.statusCode).toBe(401);

    const accepted = await app.inject({
      method: 'POST',
      url: '/api/webhooks/dingtalk',
      headers: { 'x-chatagent-webhook-token': 'good-token' },
      payload: dingtalkPayload('m-1'),
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().verificationMode).toBe('token');
  });

  it('does not create a second task for a replayed webhook message', async () => {
    const { app } = await boot({
      native: { externalChannels: true },
      webhook: { allowUnverified: true, maxSkewSeconds: 0 },
    });
    await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'dd', displayName: 'DingTalk Bot', channel: 'dingtalk', persona: 'p', allowlist: [] },
    });

    const first = await app.inject({
      method: 'POST',
      url: '/api/webhooks/dingtalk',
      payload: dingtalkPayload('m-dup'),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().results[0].deduplicated).toBeUndefined();

    const second = await app.inject({
      method: 'POST',
      url: '/api/webhooks/dingtalk',
      payload: dingtalkPayload('m-dup'),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().results[0].deduplicated).toBe(true);

    const tasks = await poll(
      async () => (await app.inject({ method: 'GET', url: '/api/tasks' })).json(),
      (list: unknown[]) => list.length >= 1,
    );
    expect(tasks).toHaveLength(1);
  });

  it('rejects a payload outside the allowed timestamp window', async () => {
    const { app } = await boot({
      native: { externalChannels: true },
      webhook: { allowUnverified: true, maxSkewSeconds: 60 },
    });
    await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: { name: 'dd', displayName: 'DingTalk Bot', channel: 'dingtalk', persona: 'p', allowlist: [] },
    });

    const stale = await app.inject({
      method: 'POST',
      url: '/api/webhooks/dingtalk',
      payload: { ...dingtalkPayload('m-old'), timestamp: Date.now() - 10 * 60 * 1000 },
    });
    expect(stale.statusCode).toBe(401);
  });
});
