import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AgentAccount, ChatMessage, Conversation, MemberView, TaskRecord } from '@chatagent/contracts';
import { createTestApp, TEST_ORG, type TestMemberSeed } from './test-helpers';

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

async function bootNative(overrides: Parameters<typeof createTestApp>[0] = {}) {
  const test = await createTestApp({
    members: MEMBERS,
    agentIntake: { mode: 'immediate' },
    ...overrides,
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

function serverBase(app: FastifyInstance): string {
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('server is not listening');
  return `http://127.0.0.1:${address.port}`;
}

async function readStream(
  url: string,
  headers: Record<string, string>,
  stopWhen: (text: string) => boolean,
  timeoutMs = 2500,
): Promise<string> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  if (response.status !== 200) {
    controller.abort();
    return `status:${response.status}`;
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (!stopWhen(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // Aborted by the timeout: whatever arrived is the evidence.
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return text;
}

describe('native identity', () => {
  it('exchanges a member token for a session and rejects wrong credentials', async () => {
    const { app } = await bootNative({ auth: { mode: 'production' } });

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { memberId: 'u_alice', token: 'not-my-token' },
    });
    expect(wrong.statusCode).toBe(401);

    const unknownMember = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { memberId: 'nobody', token: 'alice-token' },
    });
    expect(unknownMember.statusCode).toBe(401);

    // Production mode never falls back to the development principal.
    const anonymous = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(anonymous.statusCode).toBe(401);

    const token = await login(app, 'u_alice', 'alice-token');
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(token) });
    expect(me.statusCode).toBe(200);
    expect(me.json().id).toBe('u_alice');
    expect(me.json().kind).toBe('member');

    const badSession = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: auth('definitely-not-a-session'),
    });
    expect(badSession.statusCode).toBe(401);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: auth(token),
    });
    expect(logout.json().ok).toBe(true);

    const afterLogout = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: auth(token),
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('lists colleagues and AI accounts as contacts', async () => {
    const { app } = await bootNative();
    const token = await login(app, 'u_alice', 'alice-token');

    const contacts = (
      await app.inject({ method: 'GET', url: '/api/contacts', headers: auth(token) })
    ).json() as MemberView[];

    expect(contacts.some((c) => c.id === 'u_alice' && c.kind === 'member')).toBe(true);
    expect(contacts.some((c) => c.id === 'u_bob' && c.kind === 'member')).toBe(true);
    expect(contacts.some((c) => c.kind === 'agent')).toBe(true);
  });
});

describe('native chat', () => {
  it('runs the AI pipeline inside a native conversation', async () => {
    const { app } = await bootNative();
    const alice = await login(app, 'u_alice', 'alice-token');

    const account = (
      await app.inject({ method: 'GET', url: '/api/accounts', headers: auth(alice) })
    ).json()[0] as AgentAccount;

    const opened = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: auth(alice),
      payload: { targetId: account.id, targetKind: 'agent' },
    });
    expect(opened.statusCode).toBe(200);
    const conversation = opened.json() as Conversation;
    expect(conversation.origin).toBe('native');
    expect(conversation.targetKind).toBe('agent');
    expect(conversation.participantIds).toContain('u_alice');
    expect(conversation.participantIds).toContain(account.id);

    const sent = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation.id}/messages`,
      headers: auth(alice),
      payload: { text: '你好，介绍一下你能做什么' },
    });
    expect(sent.statusCode).toBe(200);
    const body = sent.json() as { message: ChatMessage; taskId?: string };
    expect(body.message.sender.id).toBe('u_alice');
    expect(body.message.senderPrincipalId).toBe('u_alice');
    expect(body.taskId).toBeTruthy();

    const tasks = (
      await app.inject({ method: 'GET', url: '/api/tasks', headers: auth(alice) })
    ).json() as TaskRecord[];
    expect(tasks.some((task) => task.id === body.taskId)).toBe(true);
  });

  it('delivers member-to-member messages to the peer only', async () => {
    const { app } = await bootNative();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');
    const carol = await login(app, 'u_carol', 'carol-token');

    const opened = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: auth(alice),
      payload: { targetId: 'u_bob', targetKind: 'member' },
    });
    expect(opened.statusCode).toBe(200);
    const conversation = opened.json() as Conversation;
    expect(conversation.targetKind).toBe('member');
    expect(conversation.accountId).toBeUndefined();

    const sent = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation.id}/messages`,
      headers: auth(alice),
      payload: { text: '下午一起过一下 Gate 4' },
    });
    expect(sent.statusCode).toBe(200);
    expect((sent.json() as { taskId?: string }).taskId).toBeUndefined();

    const bobConversations = (
      await app.inject({ method: 'GET', url: '/api/conversations', headers: auth(bob) })
    ).json() as Conversation[];
    expect(bobConversations.map((item) => item.id)).toContain(conversation.id);

    const bobMessages = (
      await app.inject({
        method: 'GET',
        url: `/api/conversations/${conversation.id}/messages`,
        headers: auth(bob),
      })
    ).json() as ChatMessage[];
    expect(bobMessages).toHaveLength(1);
    expect(bobMessages[0]?.text).toBe('下午一起过一下 Gate 4');

    const denied = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversation.id}/messages`,
      headers: auth(carol),
    });
    expect(denied.statusCode).toBe(404);

    // The peer cannot be impersonated: the sender is always the session member.
    const forged = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation.id}/messages`,
      headers: auth(carol),
      payload: { text: '越权发送' },
    });
    expect(forged.statusCode).toBe(404);
  });

  it('pages message history backwards', async () => {
    const { app } = await bootNative();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');

    const opened = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: auth(alice),
      payload: { targetId: 'u_bob', targetKind: 'member' },
    });
    const conversationId = opened.json().id as string;

    for (let index = 0; index < 7; index += 1) {
      await app.inject({
        method: 'POST',
        url: `/api/conversations/${conversationId}/messages`,
        headers: auth(alice),
        payload: { text: `第 ${index} 条` },
      });
    }

    const lastThree = (
      await app.inject({
        method: 'GET',
        url: `/api/conversations/${conversationId}/messages?limit=3`,
        headers: auth(bob),
      })
    ).json() as ChatMessage[];
    expect(lastThree.map((message) => message.text)).toEqual(['第 4 条', '第 5 条', '第 6 条']);

    const earlier = (
      await app.inject({
        method: 'GET',
        url: `/api/conversations/${conversationId}/messages?limit=3&before=${lastThree[0]?.id}`,
        headers: auth(bob),
      })
    ).json() as ChatMessage[];
    expect(earlier.map((message) => message.text)).toEqual(['第 1 条', '第 2 条', '第 3 条']);

    const capped = (
      await app.inject({
        method: 'GET',
        url: `/api/conversations/${conversationId}/messages?limit=9999`,
        headers: auth(bob),
      })
    ).json() as ChatMessage[];
    expect(capped).toHaveLength(7);
  });

  it('streams authorized native events over SSE', async () => {
    const { app } = await bootNative();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');
    const carol = await login(app, 'u_carol', 'carol-token');

    const opened = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: auth(alice),
      payload: { targetId: 'u_bob', targetKind: 'member' },
    });
    const conversationId = (opened.json() as Conversation).id;

    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = serverBase(app);

    const bobStream = readStream(
      `${base}/api/events/stream`,
      auth(bob),
      (text) => text.includes('event: message'),
    );
    const carolStream = readStream(
      `${base}/api/events/stream`,
      auth(carol),
      (text) => text.includes('event: message'),
      700,
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
    await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      headers: auth(alice),
      payload: { text: 'SSE 广播测试' },
    });

    const [bobText, carolText] = await Promise.all([bobStream, carolStream]);
    expect(bobText).toContain('event: message');
    expect(bobText).toContain('SSE 广播测试');
    expect(carolText).not.toContain('event: message');
  });
});

describe('group conversations', () => {
  it('creates a group and fans messages out to every participant', async () => {
    const { app } = await bootNative();
    const alice = await login(app, 'u_alice', 'alice-token');
    const bob = await login(app, 'u_bob', 'bob-token');
    const carol = await login(app, 'u_carol', 'carol-token');

    const created = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: auth(alice),
      payload: { title: 'Gate 5 小组', memberIds: ['u_bob', 'u_carol'] },
    });
    expect(created.statusCode).toBe(200);
    const group = created.json() as Conversation;
    expect(group.chatType).toBe('group');
    expect(group.targetKind).toBe('group');
    expect(group.title).toBe('Gate 5 小组');
    expect(group.participantIds.sort()).toEqual(['u_alice', 'u_bob', 'u_carol']);

    const sent = await app.inject({
      method: 'POST',
      url: `/api/conversations/${group.id}/messages`,
      headers: auth(alice),
      payload: { text: '大家早上好' },
    });
    expect(sent.statusCode).toBe(200);
    expect((sent.json() as { taskId?: string }).taskId).toBeUndefined();

    for (const token of [bob, carol]) {
      const messages = (
        await app.inject({
          method: 'GET',
          url: `/api/conversations/${group.id}/messages`,
          headers: auth(token),
        })
      ).json() as ChatMessage[];
      expect(messages.map((message) => message.text)).toContain('大家早上好');
    }

    // Recreating the same group returns the same conversation.
    const again = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: auth(alice),
      payload: { title: 'Gate 5 小组', memberIds: ['u_carol', 'u_bob'] },
    });
    expect((again.json() as Conversation).id).toBe(group.id);
  });

  it('summons a mentioned AI account inside a group', async () => {
    const { app } = await bootNative();
    const alice = await login(app, 'u_alice', 'alice-token');

    const account = (
      await app.inject({ method: 'GET', url: '/api/accounts', headers: auth(alice) })
    ).json()[0] as AgentAccount;
    const bob = await login(app, 'u_bob', 'bob-token');

    const created = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: auth(alice),
      payload: { title: 'AI 协作组', memberIds: ['u_bob', account.id] },
    });
    expect(created.statusCode).toBe(200);
    const group = created.json() as Conversation;
    expect(group.participantIds).toContain(account.id);

    // Without a mention the AI stays silent.
    const plain = await app.inject({
      method: 'POST',
      url: `/api/conversations/${group.id}/messages`,
      headers: auth(alice),
      payload: { text: '我们先自己讨论' },
    });
    expect((plain.json() as { taskIds?: string[] }).taskIds ?? []).toHaveLength(0);

    // Mentioning the AI account creates a task in the group context.
    const summoned = await app.inject({
      method: 'POST',
      url: `/api/conversations/${group.id}/messages`,
      headers: auth(alice),
      payload: { text: '帮忙生成一份 Word 周报', mentions: [account.id] },
    });
    expect(summoned.statusCode).toBe(200);
    const body = summoned.json() as { taskId?: string; taskIds?: string[] };
    expect(body.taskIds).toHaveLength(1);
    expect(body.taskId).toBeTruthy();

    const tasks = (
      await app.inject({ method: 'GET', url: '/api/tasks', headers: auth(alice) })
    ).json() as TaskRecord[];
    const task = tasks.find((item) => item.id === body.taskId);
    expect(task?.conversationId).toBe(group.id);

    // Another participant sees the summoning message.
    const messages = (
      await app.inject({
        method: 'GET',
        url: `/api/conversations/${group.id}/messages`,
        headers: auth(bob),
      })
    ).json() as ChatMessage[];
    expect(messages.some((message) => message.mentions.includes(account.id))).toBe(true);
  });

  it('creates only one task when the same AI is mentioned repeatedly', async () => {
    const { app } = await bootNative();
    const alice = await login(app, 'u_alice', 'alice-token');
    const account = (
      await app.inject({ method: 'GET', url: '/api/accounts', headers: auth(alice) })
    ).json()[0] as AgentAccount;

    const created = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: auth(alice),
      payload: { title: '去重组', memberIds: ['u_bob', account.id] },
    });
    const groupId = created.json().id as string;

    const sent = await app.inject({
      method: 'POST',
      url: `/api/conversations/${groupId}/messages`,
      headers: auth(alice),
      payload: { text: '重复 @ 测试', mentions: [account.id, account.id, account.id] },
    });
    expect((sent.json() as { taskIds?: string[] }).taskIds).toHaveLength(1);

    const tasks = (
      await app.inject({ method: 'GET', url: '/api/tasks', headers: auth(alice) })
    ).json() as TaskRecord[];
    expect(tasks.filter((task) => task.conversationId === groupId)).toHaveLength(1);
  });

  it('returns nothing for a stale pagination cursor', async () => {
    const { app } = await bootNative();
    const alice = await login(app, 'u_alice', 'alice-token');
    const opened = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: auth(alice),
      payload: { targetId: 'u_bob', targetKind: 'member' },
    });
    const conversationId = opened.json().id as string;

    const page = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages?limit=5&before=does-not-exist`,
      headers: auth(alice),
    });
    expect(page.json()).toEqual([]);
  });

  it('invites a member into a group and lets a member leave', async () => {
    const { app } = await bootNative();
    const alice = await login(app, 'u_alice', 'alice-token');
    const carol = await login(app, 'u_carol', 'carol-token');

    const created = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: auth(alice),
      payload: { title: '可邀请群', memberIds: ['u_bob'] },
    });
    const groupId = created.json().id as string;

    // A non-participant cannot invite.
    const outsider = await app.inject({
      method: 'POST',
      url: `/api/conversations/${groupId}/members`,
      headers: auth(carol),
      payload: { memberId: 'u_carol' },
    });
    expect(outsider.statusCode).toBe(404);

    const invited = await app.inject({
      method: 'POST',
      url: `/api/conversations/${groupId}/members`,
      headers: auth(alice),
      payload: { memberId: 'u_carol' },
    });
    expect(invited.statusCode).toBe(200);

    const carolConversations = (
      await app.inject({ method: 'GET', url: '/api/conversations', headers: auth(carol) })
    ).json() as Conversation[];
    expect(carolConversations.map((item) => item.id)).toContain(groupId);

    const left = await app.inject({
      method: 'POST',
      url: `/api/conversations/${groupId}/leave`,
      headers: auth(carol),
    });
    expect(left.statusCode).toBe(200);

    const afterLeave = (
      await app.inject({ method: 'GET', url: '/api/conversations', headers: auth(carol) })
    ).json() as Conversation[];
    expect(afterLeave.map((item) => item.id)).not.toContain(groupId);
  });

  it('rotates the caller token and invalidates its sessions', async () => {
    const { app } = await bootNative();
    const session = await login(app, 'u_alice', 'alice-token');

    const rotated = await app.inject({
      method: 'POST',
      url: '/api/auth/token/rotate',
      headers: auth(session),
    });
    expect(rotated.statusCode).toBe(200);
    const newToken = rotated.json().token as string;
    expect(newToken).toHaveLength(64);

    // The old session is gone...
    const oldSession = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: auth(session),
    });
    expect(oldSession.statusCode).toBe(401);

    // ...and the new token logs in.
    const relogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { memberId: 'u_alice', token: newToken },
    });
    expect(relogin.statusCode).toBe(200);
  });

  it('rejects groups with unknown members or a single participant', async () => {
    const { app } = await bootNative();
    const alice = await login(app, 'u_alice', 'alice-token');

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: auth(alice),
      payload: { title: 'x', memberIds: ['u_ghost'] },
    });
    expect(unknown.statusCode).toBe(404);

    const single = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: auth(alice),
      payload: { title: 'x', memberIds: ['u_alice'] },
    });
    expect(single.statusCode).toBe(400);
  });
});

describe('standalone by default', () => {
  it('does not expose third-party webhook channels unless explicitly enabled', async () => {
    const { app } = await bootNative();

    for (const channel of ['dingtalk', 'feishu', 'wechat-work', 'qq']) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/webhooks/${channel}`,
        payload: { msgId: 'm1', text: { content: 'hi' } },
      });
      expect(response.statusCode, channel).toBe(404);
    }
  });

  it('uses the ambient organization for native conversations', async () => {
    const { app } = await bootNative();
    const alice = await login(app, 'u_alice', 'alice-token');
    const opened = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: auth(alice),
      payload: { targetId: 'u_bob', targetKind: 'member' },
    });
    expect((opened.json() as Conversation).organizationId).toBe(TEST_ORG);
  });
});

describe('presence', () => {
  it('reports a member as online only while their event stream is open', async () => {
    const { app } = await bootNative();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = serverBase(app);
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const bobToken = await login(app, 'u_bob', 'bob-token');

    const before = await app.inject({ method: 'GET', url: '/api/presence', headers: auth(bobToken) });
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json().online).not.toContain('u_alice');

    // Open Alice's stream, then observe presence from Bob's request.
    const controller = new AbortController();
    const stream = await fetch(`${base}/api/events/stream`, {
      headers: auth(aliceToken),
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    const reader = stream.body?.getReader();
    expect(reader).toBeTruthy();
    await reader?.read();

    let online: string[] = [];
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const response = await app.inject({ method: 'GET', url: '/api/presence', headers: auth(bobToken) });
      online = response.json().online as string[];
      if (online.includes('u_alice')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(online).toContain('u_alice');

    const contacts = await app.inject({ method: 'GET', url: '/api/contacts', headers: auth(bobToken) });
    const alice = (contacts.json() as Array<{ id: string; online?: boolean }>).find(
      (contact) => contact.id === 'u_alice',
    );
    expect(alice?.online).toBe(true);

    controller.abort();
    const offlineDeadline = Date.now() + 5000;
    let after: string[] = online;
    while (Date.now() < offlineDeadline) {
      const response = await app.inject({ method: 'GET', url: '/api/presence', headers: auth(bobToken) });
      after = response.json().online as string[];
      if (!after.includes('u_alice')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(after).not.toContain('u_alice');
  });
});
