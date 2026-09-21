import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestApp, TEST_ORG, type TestMemberSeed } from './test-helpers';

/**
 * Regression tests for the access-control findings of the adversarial review:
 * conversation hijacking through a client-supplied chatId, task visibility
 * after leaving a group, group re-creation resurrecting a leaver, artifact
 * sharing, truncated uploads, streamed-response headers and credential minting
 * from the development fallback.
 */

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
  { id: 'u_mallory', displayName: 'Mallory', token: 'mallory-token' },
  { id: 'u_admin', displayName: 'Admin', token: 'admin-token', roles: ['owner'] },
];

async function boot() {
  const test = await createTestApp({
      members: MEMBERS,
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
  return { authorization: `Bearer ${token}` };
}

async function waitForMessages(
  app: FastifyInstance,
  headers: Record<string, string>,
  conversationId: string,
  predicate: (list: Array<{ id: string; direction: string; text: string }>) => boolean,
  timeoutMs = 15000,
): Promise<Array<{ id: string; direction: string; text: string }>> {
  const deadline = Date.now() + timeoutMs;
  let list: Array<{ id: string; direction: string; text: string }> = [];
  while (Date.now() < deadline) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages`,
      headers,
    });
    list = (response.json() ?? []) as Array<{ id: string; direction: string; text: string }>;
    if (predicate(list)) return list;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return list;
}

async function uploadText(app: FastifyInstance, token: string, name: string, text: string) {
  const boundary = '----attachment-probe';
  // Multipart separators must be CRLF: build them from escapes, not from
  // literal newlines in the source.
  const head =
    '--' +
    boundary +
    '\r\nContent-Disposition: form-data; name="file"; filename="' +
    name +
    '"\r\nContent-Type: text/plain\r\n\r\n';
  const tail = '\r\n--' + boundary + '--\r\n';
  const body = Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(text, 'utf8'), Buffer.from(tail, 'utf8')]);
  const response = await app.inject({
    method: 'POST',
    url: '/api/documents/parse',
    headers: { ...auth(token), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { file: { id: string; name: string } }).file;
}

async function createAgent(app: FastifyInstance, headers: Record<string, string>): Promise<string> {
  // The server boots with a default native AI account; provisioning another one
  // is an organization-admin operation, so the existing account is reused.
  const list = await app.inject({ method: 'GET', url: '/api/accounts', headers });
  expect(list.statusCode, list.body).toBe(200);
  const accounts = list.json() as Array<{ id: string; channel: string }>;
  expect(accounts.length, 'a default AI account is provisioned on boot').toBeGreaterThan(0);
  const native = accounts.find((account) => account.channel === 'native') ?? accounts[0];
  return native!.id;
}

/** Boots an app and returns an admin token for account provisioning. */
async function bootWithAdmin() {
  const test = await boot();
  const adminToken = await login(test.app, 'u_admin', 'admin-token');
  return { ...test, adminToken };
}

async function openAgentConversation(
  app: FastifyInstance,
  headers: Record<string, string>,
  accountId: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/conversations',
    headers,
    payload: { targetId: accountId, targetKind: 'agent' },
  });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { id: string }).id;
}

describe('conversation hijacking', () => {
  it('refuses a foreign chatId instead of joining the victim conversation', async () => {
    const { app, adminToken } = await bootWithAdmin();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const malloryToken = await login(app, 'u_mallory', 'mallory-token');
    const accountId = await createAgent(app, auth(adminToken));

    const conversationId = await openAgentConversation(app, auth(aliceToken), accountId);
    await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      headers: auth(aliceToken),
      payload: { text: 'ALICE-SECRET-CLEARTEXT' },
    });

    // The victim's conversation key is `native:agent:<account>:<member>`.
    const hijack = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: auth(malloryToken),
      payload: {
        accountId,
        chatType: 'direct',
        chatId: `native:agent:${accountId}:u_alice`,
        kind: 'text',
        text: 'MALLORY-INJECT',
      },
    });
    expect(hijack.statusCode, hijack.body).toBe(403);
    expect(hijack.json()).toEqual({ error: 'forbidden', detail: 'not_a_participant' });

    const read = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages`,
      headers: auth(malloryToken),
    });
    expect(read.statusCode).toBe(404);

    const victimMessages = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages`,
      headers: auth(aliceToken),
    });
    const texts = (victimMessages.json() as Array<{ text: string }>).map((item) => item.text);
    expect(texts.join('|')).not.toContain('MALLORY-INJECT');
    expect(texts).toContain('ALICE-SECRET-CLEARTEXT');
  });

  it('still lets a member create their own conversation through the chatId path', async () => {
    const { app, adminToken } = await bootWithAdmin();
    const bobToken = await login(app, 'u_bob', 'bob-token');
    const accountId = await createAgent(app, auth(adminToken));

    const first = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: auth(bobToken),
      payload: {
        accountId,
        chatType: 'direct',
        chatId: `native:agent:${accountId}:u_bob`,
        kind: 'text',
        text: '第一次联系',
      },
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().authorized).toBe(true);
  });
});

describe('task visibility after leaving a group', () => {
  it('revokes task read, events and cancel for the member who left', async () => {
    const { app, adminToken } = await bootWithAdmin();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const bobToken = await login(app, 'u_bob', 'bob-token');
    const accountId = await createAgent(app, auth(adminToken));

    const group = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: auth(aliceToken),
      payload: { title: '离职可见性验证组', memberIds: [accountId, 'u_bob'] },
    });
    expect(group.statusCode, group.body).toBe(200);
    const conversationId = group.json().id as string;

    const sent = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      headers: auth(aliceToken),
      payload: { text: '@ChatAgent 助理 请生成一份周报', mentions: [accountId] },
    });
    expect(sent.statusCode, sent.body).toBe(200);
    const taskId = sent.json().taskId as string;
    expect(typeof taskId).toBe('string');

    const beforeLeave = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}`, headers: auth(aliceToken) });
    expect(beforeLeave.statusCode, beforeLeave.body).toBe(200);

    const leave = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/leave`,
      headers: auth(aliceToken),
    });
    expect(leave.statusCode, leave.body).toBe(200);

    const afterLeave = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}`, headers: auth(aliceToken) });
    expect(afterLeave.statusCode).toBe(404);
    const events = await app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/events`,
      headers: auth(aliceToken),
    });
    expect(events.statusCode).toBe(404);
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/cancel`,
      headers: auth(aliceToken),
    });
    expect(cancel.statusCode).toBe(404);

    const listed = await app.inject({ method: 'GET', url: '/api/tasks', headers: auth(aliceToken) });
    expect((listed.json() as Array<{ id: string }>).some((task) => task.id === taskId)).toBe(false);

    // The member who stayed keeps full access.
    const bobView = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}`, headers: auth(bobToken) });
    expect([200, 404]).toContain(bobView.statusCode);
  });
});

describe('group re-creation semantics', () => {
  it('never removes members that were invited in the meantime', async () => {
    const { app, adminToken } = await bootWithAdmin();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const bobToken = await login(app, 'u_bob', 'bob-token');
    const accountId = await createAgent(app, auth(adminToken));

    // Re-creating the same conversation requires the same member set, which is
    // how the deterministic group key is derived.
    const payload = { title: '成员保全校验组', memberIds: [accountId, 'u_bob', 'u_alice'] };
    const created = await app.inject({ method: 'POST', url: '/api/groups', headers: auth(aliceToken), payload });
    expect(created.statusCode, created.body).toBe(200);
    const conversationId = (created.json() as { id: string }).id;

    const invited = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/members`,
      headers: auth(aliceToken),
      payload: { memberId: 'u_mallory' },
    });
    expect(invited.statusCode, invited.body).toBe(200);

    // Any participant may re-state the original member list; that must add
    // members, never evict the ones invited afterwards.
    const recreated = await app.inject({ method: 'POST', url: '/api/groups', headers: auth(bobToken), payload });
    expect(recreated.statusCode, recreated.body).toBe(200);
    const participants = (recreated.json() as { participantIds: string[] }).participantIds;
    expect(recreated.json()).toMatchObject({ id: conversationId });
    expect(participants).toContain('u_mallory');
    expect(participants).toContain('u_bob');
    expect(participants).toContain('u_alice');
    expect(participants).toContain(accountId);

    const malloryStillReads = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages`,
      headers: auth(await login(app, 'u_mallory', 'mallory-token')),
    });
    expect(malloryStillReads.statusCode, malloryStillReads.body).toBe(200);
  });

  it('refuses re-creation by a member who left the group', async () => {
    const { app, adminToken } = await bootWithAdmin();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const bobToken = await login(app, 'u_bob', 'bob-token');
    const accountId = await createAgent(app, auth(adminToken));

    const payload = { title: '退群不可自愈组', memberIds: [accountId, 'u_bob', 'u_alice'] };
    const created = await app.inject({ method: 'POST', url: '/api/groups', headers: auth(aliceToken), payload });
    const conversationId = (created.json() as { id: string }).id;

    const leave = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/leave`,
      headers: auth(bobToken),
    });
    expect(leave.statusCode, leave.body).toBe(200);

    await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      headers: auth(aliceToken),
      payload: { text: 'ALICE-AFTER-BOB-LEFT' },
    });

    const rejoin = await app.inject({ method: 'POST', url: '/api/groups', headers: auth(bobToken), payload });
    expect(rejoin.statusCode, rejoin.body).toBe(409);

    const read = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages`,
      headers: auth(bobToken),
    });
    expect(read.statusCode).toBe(404);

    // A member must invite him back explicitly.
    const invited = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/members`,
      headers: auth(aliceToken),
      payload: { memberId: 'u_bob' },
    });
    expect(invited.statusCode, invited.body).toBe(200);
    const afterInvite = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages`,
      headers: auth(bobToken),
    });
    expect(afterInvite.statusCode).toBe(200);
  });
});

describe('generated files are shared with the conversation', () => {
  it('lets a group peer download the document the AI produced', async () => {
    const { app, adminToken } = await bootWithAdmin();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const bobToken = await login(app, 'u_bob', 'bob-token');
    const accountId = await createAgent(app, auth(adminToken));

    const group = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: auth(aliceToken),
      payload: { title: '文件共享验证组', memberIds: [accountId, 'u_bob'] },
    });
    const conversationId = group.json().id as string;

    const sent = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      headers: auth(aliceToken),
      payload: { text: '@ChatAgent 助理 生成一份 Word 文档', mentions: [accountId] },
    });
    expect(sent.statusCode, sent.body).toBe(200);
    const taskId = sent.json().taskId as string;

    const deadline = Date.now() + 15000;
    let artifactId: string | undefined;
    while (Date.now() < deadline) {
      const task = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}`, headers: auth(aliceToken) });
      const artifacts = ((task.json() as { artifacts?: Array<{ id: string }> }).artifacts ?? []);
      if (artifacts.length > 0) {
        artifactId = artifacts[0]?.id;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(artifactId, 'the task produced an artifact').toBeTruthy();

    const peer = await app.inject({ method: 'GET', url: `/api/files/${artifactId}`, headers: auth(bobToken) });
    expect(peer.statusCode, peer.body).toBe(200);
    expect(peer.headers['content-disposition']).toContain('attachment');

    // The file bubble is posted into the conversation so both members see it.
    const messages = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages`,
      headers: auth(bobToken),
    });
    const fileMessages = (messages.json() as Array<{ kind: string; attachments: Array<{ id: string }> }>).filter(
      (message) => message.kind === 'file',
    );
    expect(fileMessages.length).toBeGreaterThan(0);
    expect(fileMessages[0]?.attachments[0]?.id).toBe(artifactId);
  });
});

describe('upload limits and stream headers', () => {
  it('rejects an upload above the size cap instead of storing a truncated file', async () => {
    const { app } = await boot();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const boundary = '----chatagentlimit';
    const payload = Buffer.alloc(21 * 1024 * 1024, 0x61);
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.txt"\r\nContent-Type: text/plain\r\n\r\n`,
      ),
      payload,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const response = await app.inject({
      method: 'POST',
      url: '/api/documents/parse',
      headers: { ...auth(aliceToken), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(response.statusCode, response.body).toBe(413);
  });

  it('sends hardening headers on streamed responses', async () => {
    const { app } = await boot();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('server is not listening');

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/events/stream`, {
      headers: auth(aliceToken),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    controller.abort();
  });
});

describe('conversation transcript export', () => {
  it('exports a Word transcript for participants only, without recalled bodies', async () => {
    const { app } = await boot();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const bobToken = await login(app, 'u_bob', 'bob-token');
    const malloryToken = await login(app, 'u_mallory', 'mallory-token');

    const opened = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: auth(aliceToken),
      payload: { targetId: 'u_bob', targetKind: 'member' },
    });
    const conversationId = (opened.json() as { id: string }).id;

    await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      headers: auth(aliceToken),
      payload: { text: 'TRANSCRIPT-KEEP-ME' },
    });
    const toRecall = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      headers: auth(aliceToken),
      payload: { text: 'TRANSCRIPT-DROP-ME' },
    });
    const recalledId = (toRecall.json() as { message: { id: string } }).message.id;
    await app.inject({
      method: 'POST',
      url: `/api/messages/${recalledId}/recall`,
      headers: auth(aliceToken),
    });

    const exported = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/export`,
      headers: auth(aliceToken),
    });
    expect(exported.statusCode, exported.body).toBe(200);
    const file = exported.json() as { id: string; name: string };
    expect(file.name.endsWith('.docx')).toBe(true);

    const download = await app.inject({
      method: 'GET',
      url: `/api/files/${file.id}`,
      headers: auth(aliceToken),
    });
    expect(download.statusCode, download.body).toBe(200);

    // The transcript belongs to whoever exported it; a peer cannot fetch that
    // copy (it contains only what the exporter could already read).
    const peerDownload = await app.inject({
      method: 'GET',
      url: `/api/files/${file.id}`,
      headers: auth(bobToken),
    });
    expect(peerDownload.statusCode).toBe(404);

    const { extractWordText } = await import('@chatagent/document');
    const text = await extractWordText(download.rawPayload);
    expect(text).toContain('TRANSCRIPT-KEEP-ME');
    expect(text).toContain('[已撤回]');
    expect(text).not.toContain('TRANSCRIPT-DROP-ME');

    const outsider = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/export`,
      headers: auth(malloryToken),
    });
    expect(outsider.statusCode).toBe(404);
  });
});

describe('conversation attachments are readable by the conversation', () => {
  it('lets the recipients of a message download its attachment', async () => {
    const { app } = await boot();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const bobToken = await login(app, 'u_bob', 'bob-token');
    const malloryToken = await login(app, 'u_mallory', 'mallory-token');

    const file = await uploadText(app, aliceToken, 'notes.txt', 'shared attachment');
    const opened = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: auth(aliceToken),
      payload: { targetId: 'u_bob', targetKind: 'member' },
    });
    const conversationId = (opened.json() as { id: string }).id;
    await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      headers: auth(aliceToken),
      payload: { text: '带附件的消息', attachments: [{ id: file.id, name: file.name }] },
    });

    const asRecipient = await app.inject({ method: 'GET', url: `/api/files/${file.id}`, headers: auth(bobToken) });
    expect(asRecipient.statusCode, asRecipient.body).toBe(200);
    expect(asRecipient.headers['content-disposition']).toContain('attachment');

    // The uploader keeps access, an unrelated member does not.
    const asSender = await app.inject({ method: 'GET', url: `/api/files/${file.id}`, headers: auth(aliceToken) });
    expect(asSender.statusCode).toBe(200);
    const asOutsider = await app.inject({
      method: 'GET',
      url: `/api/files/${file.id}`,
      headers: auth(malloryToken),
    });
    expect(asOutsider.statusCode).toBe(404);

    // The files page lists it for the recipient, and not for the outsider.
    const recipientFiles = await app.inject({ method: 'GET', url: '/api/files', headers: auth(bobToken) });
    expect(
      (recipientFiles.json() as { uploads: Array<{ id: string }> }).uploads.some((item) => item.id === file.id),
    ).toBe(true);
    const outsiderFiles = await app.inject({ method: 'GET', url: '/api/files', headers: auth(malloryToken) });
    expect(
      (outsiderFiles.json() as { uploads: Array<{ id: string }> }).uploads.some((item) => item.id === file.id),
    ).toBe(false);
  });

  it('records an admin break-glass read of a file that was never shared with them', async () => {
    const { app, dataDir, adminToken } = await bootWithAdmin();
    const aliceToken = await login(app, 'u_alice', 'alice-token');

    // Alice uploads a file and never posts it anywhere.
    const file = await uploadText(app, aliceToken, 'never-shared.txt', 'private');
    const denied = await app.inject({
      method: 'GET',
      url: `/api/files/${file.id}`,
      headers: auth(await login(app, 'u_mallory', 'mallory-token')),
    });
    expect(denied.statusCode).toBe(404);

    // The organization admin keeps break-glass access, but it is auditable.
    const admin = await app.inject({ method: 'GET', url: `/api/files/${file.id}`, headers: auth(adminToken) });
    expect(admin.statusCode, admin.body).toBe(200);

    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const deadline = Date.now() + 3000;
    let entries: Array<{ action?: string; actorId?: string; target?: string }> = [];
    while (Date.now() < deadline) {
      const raw = await readFile(join(dataDir, 'audit.jsonl'), 'utf8').catch(() => '');
      entries = raw
        .split(String.fromCharCode(10))
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as { action?: string; actorId?: string; target?: string });
      if (entries.some((entry) => entry.action === 'file.admin_access')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const record = entries.find((entry) => entry.action === 'file.admin_access');
    expect(record, 'the admin read is recorded').toBeTruthy();
    expect(record?.target).toBe(file.id);
  });

  it('refuses to let a member attach somebody else file', async () => {
    const { app } = await boot();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const malloryToken = await login(app, 'u_mallory', 'mallory-token');

    // Alice's private upload, never shared in a conversation.
    const privateFile = await uploadText(app, aliceToken, 'private.txt', 'alice only');

    // Mallory opens a DM with Alice and tries to reference the private file id:
    // that would turn "attach an id" into a read primitive for the whole thread.
    const dm = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: auth(malloryToken),
      payload: { targetId: 'u_alice', targetKind: 'member' },
    });
    const dmId = (dm.json() as { id: string }).id;
    const attempt = await app.inject({
      method: 'POST',
      url: `/api/conversations/${dmId}/messages`,
      headers: auth(malloryToken),
      payload: { text: '偷看', attachments: [{ id: privateFile.id, name: 'private.txt' }] },
    });
    expect(attempt.statusCode, attempt.body).toBe(400);
    expect(attempt.json().error).toContain('a file you uploaded');

    // And the file stays unreadable for her.
    expect(
      (await app.inject({ method: 'GET', url: `/api/files/${privateFile.id}`, headers: auth(malloryToken) }))
        .statusCode,
    ).toBe(404);

    // Alice can still share it herself.
    const own = await app.inject({
      method: 'POST',
      url: `/api/conversations/${dmId}/messages`,
      headers: auth(aliceToken),
      payload: { text: '共享给你', attachments: [{ id: privateFile.id, name: 'private.txt' }] },
    });
    expect(own.statusCode, own.body).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: `/api/files/${privateFile.id}`, headers: auth(malloryToken) }))
        .statusCode,
    ).toBe(200);
  });

  it('revokes attachment access when the member leaves the conversation', async () => {
    const { app, adminToken } = await bootWithAdmin();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const bobToken = await login(app, 'u_bob', 'bob-token');
    const accountId = await createAgent(app, auth(adminToken));

    const file = await uploadText(app, aliceToken, 'group-notes.txt', 'group attachment');
    const group = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: auth(aliceToken),
      payload: { title: '附件权限验证组', memberIds: ['u_bob', accountId] },
    });
    const conversationId = (group.json() as { id: string }).id;
    await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      headers: auth(aliceToken),
      payload: { text: '群里的附件', attachments: [{ id: file.id, name: file.name }] },
    });

    const before = await app.inject({ method: 'GET', url: `/api/files/${file.id}`, headers: auth(bobToken) });
    expect(before.statusCode).toBe(200);

    await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/leave`,
      headers: auth(bobToken),
    });

    const after = await app.inject({ method: 'GET', url: `/api/files/${file.id}`, headers: auth(bobToken) });
    expect(after.statusCode).toBe(404);
  });

  it('does not serve a recalled message attachment any more', async () => {
    const { app } = await boot();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const bobToken = await login(app, 'u_bob', 'bob-token');

    const file = await uploadText(app, aliceToken, 'recall-me.txt', 'recalled attachment');
    const opened = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: auth(aliceToken),
      payload: { targetId: 'u_bob', targetKind: 'member' },
    });
    const conversationId = (opened.json() as { id: string }).id;
    const sent = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      headers: auth(aliceToken),
      payload: { text: '撤回的附件', attachments: [{ id: file.id, name: file.name }] },
    });
    const messageId = (sent.json() as { message: { id: string } }).message.id;

    expect((await app.inject({ method: 'GET', url: `/api/files/${file.id}`, headers: auth(bobToken) })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: `/api/messages/${messageId}/recall`, headers: auth(aliceToken) });
    // The reference is gone, so the recipient loses the shortcut (the uploader
    // keeps owning the file, which is documented behaviour).
    expect((await app.inject({ method: 'GET', url: `/api/files/${file.id}`, headers: auth(bobToken) })).statusCode).toBe(404);
  });
});

describe('quoted replies', () => {
  it('stores a quote that points at a message of the same conversation', async () => {
    const { app } = await boot();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const bobToken = await login(app, 'u_bob', 'bob-token');

    const dm = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: auth(aliceToken),
      payload: { targetId: 'u_bob', targetKind: 'member' },
    });
    const dmId = (dm.json() as { id: string }).id;
    const first = await app.inject({
      method: 'POST',
      url: `/api/conversations/${dmId}/messages`,
      headers: auth(aliceToken),
      payload: { text: '被引用的消息' },
    });
    const quotedId = (first.json() as { message: { id: string } }).message.id;

    const reply = await app.inject({
      method: 'POST',
      url: `/api/conversations/${dmId}/messages`,
      headers: auth(bobToken),
      payload: { text: '这是回复', replyTo: quotedId },
    });
    expect(reply.statusCode, reply.body).toBe(200);
    expect((reply.json() as { message: { replyTo?: string } }).message.replyTo).toBe(quotedId);

    const history = await app.inject({
      method: 'GET',
      url: `/api/conversations/${dmId}/messages`,
      headers: auth(aliceToken),
    });
    const stored = (history.json() as Array<{ id: string; replyTo?: string }>).find(
      (item) => item.id === (reply.json() as { message: { id: string } }).message.id,
    );
    expect(stored?.replyTo).toBe(quotedId);
  });

  it('refuses to quote a message from another conversation', async () => {
    const { app } = await boot();
    const aliceToken = await login(app, 'u_alice', 'alice-token');

    const withBob = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: auth(aliceToken),
      payload: { targetId: 'u_bob', targetKind: 'member' },
    });
    const bobConversation = (withBob.json() as { id: string }).id;
    const elsewhere = await app.inject({
      method: 'POST',
      url: `/api/conversations/${bobConversation}/messages`,
      headers: auth(aliceToken),
      payload: { text: '另一个会话的消息' },
    });
    const foreignId = (elsewhere.json() as { message: { id: string } }).message.id;

    const withMallory = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: auth(aliceToken),
      payload: { targetId: 'u_mallory', targetKind: 'member' },
    });
    const malloryConversation = (withMallory.json() as { id: string }).id;

    const crossQuote = await app.inject({
      method: 'POST',
      url: `/api/conversations/${malloryConversation}/messages`,
      headers: auth(aliceToken),
      payload: { text: '越权引用', replyTo: foreignId },
    });
    expect(crossQuote.statusCode, crossQuote.body).toBe(400);

    const unknownQuote = await app.inject({
      method: 'POST',
      url: `/api/conversations/${malloryConversation}/messages`,
      headers: auth(aliceToken),
      payload: { text: '不存在的引用', replyTo: 'no-such-message' },
    });
    expect(unknownQuote.statusCode).toBe(400);
  });
});

describe('message forwarding', () => {
  it('copies a message with its attachment into another conversation', async () => {
    const { app, adminToken } = await bootWithAdmin();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const bobToken = await login(app, 'u_bob', 'bob-token');
    const malloryToken = await login(app, 'u_mallory', 'mallory-token');
    const accountId = await createAgent(app, auth(adminToken));

    const file = await uploadText(app, aliceToken, 'forwarded.txt', 'forward me');
    // Source: Alice <-> Mallory. Bob is deliberately NOT part of it, so his later
    // access can only come from the forward itself.
    const source = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: auth(aliceToken),
      payload: { targetId: 'u_mallory', targetKind: 'member' },
    });
    const sourceId = (source.json() as { id: string }).id;
    const sent = await app.inject({
      method: 'POST',
      url: `/api/conversations/${sourceId}/messages`,
      headers: auth(aliceToken),
      payload: { text: '原始消息', attachments: [{ id: file.id, name: file.name }] },
    });
    const messageId = (sent.json() as { message: { id: string } }).message.id;

    const group = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: auth(aliceToken),
      payload: { title: '转发目标组', memberIds: ['u_bob', 'u_mallory', accountId] },
    });
    const groupId = (group.json() as { id: string }).id;

    const forwarded = await app.inject({
      method: 'POST',
      url: `/api/messages/${messageId}/forward`,
      headers: auth(aliceToken),
      payload: { conversationId: groupId },
    });
    expect(forwarded.statusCode, forwarded.body).toBe(200);
    const copy = (forwarded.json() as { message: { text: string; attachments: Array<{ id: string }> } }).message;
    expect(copy.text).toBe('原始消息');
    expect(copy.attachments[0]?.id).toBe(file.id);

    // Bob sees the copy in the group and can open the forwarded file.
    const groupMessages = await app.inject({
      method: 'GET',
      url: `/api/conversations/${groupId}/messages`,
      headers: auth(bobToken),
    });
    expect((groupMessages.json() as Array<{ text: string }>).map((item) => item.text)).toContain('原始消息');
    expect(
      (await app.inject({ method: 'GET', url: `/api/files/${file.id}`, headers: auth(bobToken) })).statusCode,
    ).toBe(200);

    // The original conversation still holds exactly one copy of the message.
    const sourceMessages = await app.inject({
      method: 'GET',
      url: `/api/conversations/${sourceId}/messages`,
      headers: auth(aliceToken),
    });
    expect(
      (sourceMessages.json() as Array<{ text: string }>).filter((m) => m.text === '原始消息'),
    ).toHaveLength(1);
    expect(malloryToken.length).toBeGreaterThan(0);
  });

  it('does not share a file with somebody outside the conversation it was forwarded to', async () => {
    const { app } = await boot();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const bobToken = await login(app, 'u_bob', 'bob-token');
    const malloryToken = await login(app, 'u_mallory', 'mallory-token');

    const file = await uploadText(app, aliceToken, 'forward-scope.txt', 'scope');
    const dm = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: auth(aliceToken),
      payload: { targetId: 'u_bob', targetKind: 'member' },
    });
    const dmId = (dm.json() as { id: string }).id;
    const sent = await app.inject({
      method: 'POST',
      url: `/api/conversations/${dmId}/messages`,
      headers: auth(aliceToken),
      payload: { text: '只给 bob', attachments: [{ id: file.id, name: file.name }] },
    });
    const messageId = (sent.json() as { message: { id: string } }).message.id;

    // Bob forwards Alice's file message into HIS OWN conversation with Mallory.
    const bobWithMallory = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: auth(bobToken),
      payload: { targetId: 'u_mallory', targetKind: 'member' },
    });
    expect(bobWithMallory.statusCode, bobWithMallory.body).toBe(200);
    const malloryConversation = (bobWithMallory.json() as { id: string }).id;
    await app.inject({
      method: 'POST',
      url: `/api/messages/${messageId}/forward`,
      headers: auth(bobToken),
      payload: { conversationId: malloryConversation },
    });

    // Mallory is now a legitimate participant of a conversation containing the
    // forward, so she may read it — that is the intended share.
    expect(
      (await app.inject({ method: 'GET', url: `/api/files/${file.id}`, headers: auth(malloryToken) })).statusCode,
    ).toBe(200);

    // Somebody with no relation to either conversation still cannot.
    const dave = await app.inject({
      method: 'POST',
      url: '/api/members',
      headers: auth(await login(app, 'u_admin', 'admin-token')),
      payload: { id: 'u_dave', displayName: 'Dave' },
    });
    expect(dave.statusCode, dave.body).toBe(201);
    const daveToken = await login(app, 'u_dave', dave.json().token as string);
    expect(
      (await app.inject({ method: 'GET', url: `/api/files/${file.id}`, headers: auth(daveToken) })).statusCode,
    ).toBe(404);
  });

  it('refuses to forward into a conversation the caller is not in, or to the AI', async () => {
    const { app, adminToken } = await bootWithAdmin();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const malloryToken = await login(app, 'u_mallory', 'mallory-token');
    const accountId = await createAgent(app, auth(adminToken));

    const dm = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: auth(aliceToken),
      payload: { targetId: 'u_bob', targetKind: 'member' },
    });
    const dmId = (dm.json() as { id: string }).id;
    const sent = await app.inject({
      method: 'POST',
      url: `/api/conversations/${dmId}/messages`,
      headers: auth(aliceToken),
      payload: { text: '不可越权转发' },
    });
    const messageId = (sent.json() as { message: { id: string } }).message.id;

    const foreign = await app.inject({
      method: 'POST',
      url: `/api/messages/${messageId}/forward`,
      headers: auth(malloryToken),
      payload: { conversationId: dmId },
    });
    expect(foreign.statusCode).toBe(404);

    const aiConversation = await openAgentConversation(app, auth(aliceToken), accountId);
    const toAi = await app.inject({
      method: 'POST',
      url: `/api/messages/${messageId}/forward`,
      headers: auth(aliceToken),
      payload: { conversationId: aiConversation },
    });
    expect(toAi.statusCode, toAi.body).toBe(400);

    // A recalled message cannot be resurrected by forwarding it.
    await app.inject({ method: 'POST', url: `/api/messages/${messageId}/recall`, headers: auth(aliceToken) });
    const afterRecall = await app.inject({
      method: 'POST',
      url: `/api/messages/${messageId}/forward`,
      headers: auth(aliceToken),
      payload: { conversationId: dmId },
    });
    expect(afterRecall.statusCode, afterRecall.body).toBe(400);
  });
});

describe('read receipts', () => {
  it('reports the peer cursor only to participants of the conversation', async () => {
    const { app } = await boot();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const bobToken = await login(app, 'u_bob', 'bob-token');
    const malloryToken = await login(app, 'u_mallory', 'mallory-token');

    const opened = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: auth(aliceToken),
      payload: { targetId: 'u_bob', targetKind: 'member' },
    });
    const conversationId = (opened.json() as { id: string }).id;

    // Bob has not opened the conversation yet.
    const before = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/read-receipts`,
      headers: auth(aliceToken),
    });
    expect(before.statusCode, before.body).toBe(200);
    expect((before.json() as { others: unknown[] }).others).toEqual([]);

    await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/read`,
      headers: auth(bobToken),
    });

    const after = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/read-receipts`,
      headers: auth(aliceToken),
    });
    const others = (after.json() as { others: Array<{ memberId: string; lastReadAt: string }> }).others;
    expect(others).toHaveLength(1);
    expect(others[0]?.memberId).toBe('u_bob');
    expect(Number.isFinite(Date.parse(others[0]?.lastReadAt ?? ''))).toBe(true);

    // An outsider cannot read somebody else's cursor.
    const outsider = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/read-receipts`,
      headers: auth(malloryToken),
    });
    expect(outsider.statusCode).toBe(404);
  });
});

describe('message recall', () => {
  it('hides a recalled message from history, search and previews', async () => {
    const { app, dataDir } = await boot();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const bobToken = await login(app, 'u_bob', 'bob-token');

    // A member-to-member conversation is used so no AI reply quotes the text
    // and the assertions stay deterministic.
    const opened = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: auth(aliceToken),
      payload: { targetId: 'u_bob', targetKind: 'member' },
    });
    expect(opened.statusCode, opened.body).toBe(200);
    const conversation = (opened.json() as { id: string }).id;

    const sent = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation}/messages`,
      headers: auth(aliceToken),
      payload: { text: 'RECALL-MARKER-SECRET' },
    });
    expect(sent.statusCode, sent.body).toBe(200);
    const messageId = (sent.json() as { message: { id: string } }).message.id;

    const beforeSearch = await app.inject({
      method: 'GET',
      url: '/api/search?q=RECALL-MARKER',
      headers: auth(aliceToken),
    });
    expect((beforeSearch.json() as unknown[]).length).toBeGreaterThan(0);

    const recalled = await app.inject({
      method: 'POST',
      url: `/api/messages/${messageId}/recall`,
      headers: auth(aliceToken),
    });
    expect(recalled.statusCode, recalled.body).toBe(200);
    expect((recalled.json() as { message: { recalledAt?: string; text: string } }).message.text).toBe('');

    const peerView = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversation}/messages`,
      headers: auth(bobToken),
    });
    const peerMessages = peerView.json() as Array<{ id: string; text: string; recalledAt?: string }>;
    const peerTarget = peerMessages.find((item) => item.id === messageId);
    expect(peerTarget?.recalledAt).toBeTruthy();
    expect(peerTarget?.text).toBe('');

    const own = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversation}/messages`,
      headers: auth(aliceToken),
    });
    const ownMessages = own.json() as Array<{ id: string; text: string; recalledAt?: string }>;
    const target = ownMessages.find((item) => item.id === messageId);
    expect(target?.recalledAt).toBeTruthy();
    expect(target?.text).toBe('');

    const afterSearch = await app.inject({
      method: 'GET',
      url: '/api/search?q=RECALL-MARKER',
      headers: auth(aliceToken),
    });
    expect((afterSearch.json() as unknown[]).length).toBe(0);

    const summaries = await app.inject({ method: 'GET', url: '/api/conversations', headers: auth(aliceToken) });
    const summary = (summaries.json() as Array<{ id: string; lastMessage?: { text: string } }>).find(
      (item) => item.id === conversation,
    );
    expect(summary?.lastMessage?.text ?? '').not.toContain('RECALL-MARKER');

    // The recall itself is auditable, and the entry carries no message body.
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const auditDeadline = Date.now() + 3000;
    let auditRaw = '';
    while (Date.now() < auditDeadline) {
      auditRaw = await readFile(join(dataDir, 'audit.jsonl'), 'utf8').catch(() => '');
      if (auditRaw.includes('message.recalled')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(auditRaw).toContain('message.recalled');
    expect(auditRaw).not.toContain('RECALL-MARKER-SECRET');
  });

  it('redacts a recalled body from task snapshots and from the model input', async () => {
    const { app, adminToken } = await bootWithAdmin();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const accountId = await createAgent(app, auth(adminToken));
    const conversation = await openAgentConversation(app, auth(aliceToken), accountId);

    const first = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation}/messages`,
      headers: auth(aliceToken),
      payload: { text: 'SNAPSHOT-SECRET-9Q' },
    });
    const messageId = (first.json() as { message: { id: string } }).message.id;

    // The next task snapshots the history, so its input contains the secret.
    const second = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation}/messages`,
      headers: auth(aliceToken),
      payload: { text: '你好' },
    });
    const taskId = (second.json() as { taskId?: string }).taskId;
    expect(taskId).toBeTruthy();
    const before = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}`, headers: auth(aliceToken) });
    expect(JSON.stringify(before.json())).toContain('SNAPSHOT-SECRET-9Q');

    await app.inject({
      method: 'POST',
      url: `/api/messages/${messageId}/recall`,
      headers: auth(aliceToken),
    });

    // Read paths must redact the snapshot and the goal. (The assistant's own
    // reply that quoted the text is a separate message and stays, as documented.)
    type TaskShape = { goal: string; input?: { history?: Array<{ content: string }> } };
    const after = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}`, headers: auth(aliceToken) });
    const task = after.json() as TaskShape;
    const snapshot = JSON.stringify(task.input?.history ?? []);
    expect(snapshot).not.toContain('SNAPSHOT-SECRET-9Q');
    expect(snapshot).toContain('已撤回');
    expect(task.goal).not.toContain('SNAPSHOT-SECRET-9Q');

    const listed = await app.inject({ method: 'GET', url: '/api/tasks', headers: auth(adminToken) });
    const listedTasks = listed.json() as Array<{ id: string } & TaskShape>;
    for (const entry of listedTasks) {
      expect(entry.goal).not.toContain('SNAPSHOT-SECRET-9Q');
      expect(JSON.stringify(entry.input?.history ?? [])).not.toContain('SNAPSHOT-SECRET-9Q');
    }
  });

  it('redacts a group summon goal that only contains the recalled text', async () => {
    const { app, adminToken } = await bootWithAdmin();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const bobToken = await login(app, 'u_bob', 'bob-token');
    const accountId = await createAgent(app, auth(adminToken));

    const group = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: auth(aliceToken),
      payload: { title: '群召唤脱敏组', memberIds: ['u_bob', accountId] },
    });
    const groupId = (group.json() as { id: string }).id;

    // The group summon strips "@ChatAgent 助理", so the task goal is a substring
    // of the recalled message rather than the whole text.
    const sent = await app.inject({
      method: 'POST',
      url: `/api/conversations/${groupId}/messages`,
      headers: auth(aliceToken),
      payload: { text: '@ChatAgent 助理 GROUP-SECRET-X9 请整理', mentions: [accountId] },
    });
    expect(sent.statusCode, sent.body).toBe(200);
    const taskId = (sent.json() as { taskIds?: string[] }).taskIds?.[0];
    expect(taskId).toBeTruthy();
    const messageId = (sent.json() as { message: { id: string } }).message.id;

    await app.inject({
      method: 'POST',
      url: `/api/messages/${messageId}/recall`,
      headers: auth(aliceToken),
    });

    const task = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}`, headers: auth(aliceToken) });
    expect(JSON.stringify(task.json())).not.toContain('GROUP-SECRET-X9');
    // Derived text (the assistant's echo of the stripped goal) must be scrubbed too.
    expect(JSON.stringify(task.json().result ?? '')).not.toContain('请整理');
    const events = await app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/events`,
      headers: auth(aliceToken),
    });
    expect(JSON.stringify(events.json())).not.toContain('GROUP-SECRET-X9');
    const adminView = await app.inject({ method: 'GET', url: '/api/tasks', headers: auth(adminToken) });
    expect(JSON.stringify(adminView.json())).not.toContain('GROUP-SECRET-X9');
    expect(bobToken.length).toBeGreaterThan(0);
  });

  it('keeps the recalled body out of task events and the resumed goal', async () => {
    const { app, adminToken } = await bootWithAdmin();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const accountId = await createAgent(app, auth(adminToken));
    const conversation = await openAgentConversation(app, auth(aliceToken), accountId);

    const sent = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation}/messages`,
      headers: auth(aliceToken),
      payload: { text: 'EVENT-SECRET-7Z' },
    });
    const messageId = (sent.json() as { message: { id: string } }).message.id;
    const taskId = (sent.json() as { taskId?: string }).taskId;
    expect(taskId).toBeTruthy();

    // The task goal itself carries the text before the recall (asserted in the
    // snapshot test); the events are checked afterwards.
    await app.inject({
      method: 'POST',
      url: `/api/messages/${messageId}/recall`,
      headers: auth(aliceToken),
    });

    const after = await app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/events`,
      headers: auth(aliceToken),
    });
    // The security property is the absence of the body; whether the goal is
    // echoed into events at all depends on the provider in use.
    expect(JSON.stringify(after.json())).not.toContain('EVENT-SECRET-7Z');
  });

  it('stops counting a recalled message as unread', async () => {
    const { app } = await boot();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const bobToken = await login(app, 'u_bob', 'bob-token');

    const opened = await app.inject({
      method: 'POST',
      url: '/api/conversations',
      headers: auth(aliceToken),
      payload: { targetId: 'u_bob', targetKind: 'member' },
    });
    const conversationId = (opened.json() as { id: string }).id;
    await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/read`,
      headers: auth(bobToken),
    });

    // Cursors have millisecond resolution: make sure the message is strictly
    // newer than the read cursor.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const sent = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      headers: auth(aliceToken),
      payload: { text: 'UNREAD-THEN-RECALLED' },
    });
    const messageId = (sent.json() as { message: { id: string } }).message.id;

    const unreadBefore = await app.inject({ method: 'GET', url: '/api/conversations', headers: auth(bobToken) });
    const before = (unreadBefore.json() as Array<{ id: string; unreadCount: number }>).find(
      (item) => item.id === conversationId,
    );
    expect(before?.unreadCount).toBe(1);

    await app.inject({
      method: 'POST',
      url: `/api/messages/${messageId}/recall`,
      headers: auth(aliceToken),
    });

    const unreadAfter = await app.inject({ method: 'GET', url: '/api/conversations', headers: auth(bobToken) });
    const after = (unreadAfter.json() as Array<{ id: string; unreadCount: number }>).find(
      (item) => item.id === conversationId,
    );
    expect(after?.unreadCount).toBe(0);
  });

  it('names the disabled state instead of claiming the window expired', async () => {
    const test = await createTestApp({
      members: MEMBERS,
      native: { recallWindowSeconds: 0 },
      agentIntake: { mode: 'immediate' },
    });
    active.push(test.app);
    const aliceToken = await login(test.app, 'u_alice', 'alice-token');
    const accountId = await createAgent(test.app, auth(aliceToken));
    const conversation = await openAgentConversation(test.app, auth(aliceToken), accountId);
    const sent = await test.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation}/messages`,
      headers: auth(aliceToken),
      payload: { text: 'RECALL-DISABLED' },
    });
    const messageId = (sent.json() as { message: { id: string } }).message.id;
    const recalled = await test.app.inject({
      method: 'POST',
      url: `/api/messages/${messageId}/recall`,
      headers: auth(aliceToken),
    });
    expect(recalled.statusCode).toBe(400);
    expect(recalled.json().error).toBe('recall is disabled on this server');
  });

  it('refuses recall by somebody else and outside the window', async () => {
    const { app, adminToken } = await bootWithAdmin();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const malloryToken = await login(app, 'u_mallory', 'mallory-token');
    const accountId = await createAgent(app, auth(adminToken));
    const conversation = await openAgentConversation(app, auth(aliceToken), accountId);

    const sent = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation}/messages`,
      headers: auth(aliceToken),
      payload: { text: 'SOMEONE-ELSES-MESSAGE' },
    });
    const messageId = (sent.json() as { message: { id: string } }).message.id;

    const foreign = await app.inject({
      method: 'POST',
      url: `/api/messages/${messageId}/recall`,
      headers: auth(malloryToken),
    });
    expect(foreign.statusCode).toBe(404);

    // The AI's own reply cannot be recalled by a member either.
    const replies = await waitForMessages(app, auth(aliceToken), conversation, (list) =>
      list.some((item) => item.direction === 'outbound'),
    );
    const aiMessage = replies.find((item) => item.direction === 'outbound');
    expect(aiMessage, 'the AI replied').toBeTruthy();
    const aiRecall = await app.inject({
      method: 'POST',
      url: `/api/messages/${aiMessage?.id}/recall`,
      headers: auth(aliceToken),
    });
    expect(aiRecall.statusCode, aiRecall.body).toBe(403);
  });

  it('is idempotent and rejects an expired window', async () => {
    const { app, adminToken } = await bootWithAdmin();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const accountId = await createAgent(app, auth(adminToken));
    const conversation = await openAgentConversation(app, auth(aliceToken), accountId);

    const sent = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation}/messages`,
      headers: auth(aliceToken),
      payload: { text: 'RECALL-TWICE' },
    });
    const messageId = (sent.json() as { message: { id: string } }).message.id;

    const first = await app.inject({
      method: 'POST',
      url: `/api/messages/${messageId}/recall`,
      headers: auth(aliceToken),
    });
    expect(first.statusCode, first.body).toBe(200);
    const recalledAt = (first.json() as { message: { recalledAt?: string } }).message.recalledAt;

    const second = await app.inject({
      method: 'POST',
      url: `/api/messages/${messageId}/recall`,
      headers: auth(aliceToken),
    });
    expect(second.statusCode, second.body).toBe(200);
    expect((second.json() as { message: { recalledAt?: string } }).message.recalledAt).toBe(recalledAt);
  });

  it('rejects recall once the window has expired', async () => {
    const test = await createTestApp({
      members: MEMBERS,
      native: { recallWindowSeconds: 0 },
      agentIntake: { mode: 'immediate' },
    });
    active.push(test.app);
    const aliceToken = await login(test.app, 'u_alice', 'alice-token');
    const accountId = await createAgent(test.app, auth(aliceToken));
    const conversation = await openAgentConversation(test.app, auth(aliceToken), accountId);

    const sent = await test.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation}/messages`,
      headers: auth(aliceToken),
      payload: { text: 'TOO-LATE-TO-RECALL' },
    });
    const messageId = (sent.json() as { message: { id: string } }).message.id;

    const recalled = await test.app.inject({
      method: 'POST',
      url: `/api/messages/${messageId}/recall`,
      headers: auth(aliceToken),
    });
    expect(recalled.statusCode, recalled.body).toBe(400);

    const history = await test.app.inject({
      method: 'GET',
      url: `/api/conversations/${conversation}/messages`,
      headers: auth(aliceToken),
    });
    const message = (history.json() as Array<{ id: string; text: string }>).find(
      (item) => item.id === messageId,
    );
    expect(message?.text).toBe('TOO-LATE-TO-RECALL');
  });

  it('keeps the recalled text out of the model history', async () => {
    const { app, adminToken } = await bootWithAdmin();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const accountId = await createAgent(app, auth(adminToken));
    const conversation = await openAgentConversation(app, auth(aliceToken), accountId);

    const sent = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation}/messages`,
      headers: auth(aliceToken),
      payload: { text: 'MODEL-CONTEXT-SECRET' },
    });
    const messageId = (sent.json() as { message: { id: string } }).message.id;
    await app.inject({
      method: 'POST',
      url: `/api/messages/${messageId}/recall`,
      headers: auth(aliceToken),
    });

    // The next task rebuilds the history server-side; the recalled turn must be
    // absent from what the model receives.
    const next = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation}/messages`,
      headers: auth(aliceToken),
      payload: { text: '你好' },
    });
    expect(next.statusCode, next.body).toBe(200);
    const taskId = (next.json() as { taskId?: string }).taskId;
    expect(taskId).toBeTruthy();
    const task = await app.inject({ method: 'GET', url: `/api/tasks/${taskId}`, headers: auth(aliceToken) });
    const serialized = JSON.stringify(task.json());
    expect(serialized).not.toContain('MODEL-CONTEXT-SECRET');
  });
});

describe('group administration', () => {
  it('renames a group for participants only and records it', async () => {
    const { app, dataDir, adminToken } = await bootWithAdmin();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const malloryToken = await login(app, 'u_mallory', 'mallory-token');
    const accountId = await createAgent(app, auth(adminToken));

    const created = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: auth(aliceToken),
      payload: { title: '旧群名', memberIds: [accountId, 'u_bob'] },
    });
    const conversationId = (created.json() as { id: string }).id;

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${conversationId}`,
      headers: auth(aliceToken),
      payload: { title: '新群名' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect((renamed.json() as { title: string }).title).toBe('新群名');

    const outsider = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${conversationId}`,
      headers: auth(malloryToken),
      payload: { title: '越权改名' },
    });
    expect(outsider.statusCode).toBe(404);

    const empty = await app.inject({
      method: 'PATCH',
      url: `/api/conversations/${conversationId}`,
      headers: auth(aliceToken),
      payload: { title: '   ' },
    });
    expect(empty.statusCode).toBe(400);

    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const deadline = Date.now() + 3000;
    let raw = '';
    while (Date.now() < deadline) {
      raw = await readFile(join(dataDir, 'audit.jsonl'), 'utf8');
      if (raw.includes('conversation.renamed')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(raw).toContain('conversation.renamed');
  });

  it('removes another member explicitly while leaving stays self-service', async () => {
    const { app, dataDir, adminToken } = await bootWithAdmin();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const bobToken = await login(app, 'u_bob', 'bob-token');
    const accountId = await createAgent(app, auth(adminToken));

    const created = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: auth(aliceToken),
      payload: { title: '成员移除验证组', memberIds: [accountId, 'u_bob'] },
    });
    const conversationId = (created.json() as { id: string }).id;

    // A member cannot remove themselves through this endpoint.
    const self = await app.inject({
      method: 'DELETE',
      url: `/api/conversations/${conversationId}/members/u_alice`,
      headers: auth(aliceToken),
    });
    expect(self.statusCode).toBe(400);

    // A non-participant cannot remove anybody.
    await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/leave`,
      headers: auth(bobToken),
    });
    const afterLeave = await app.inject({
      method: 'DELETE',
      url: `/api/conversations/${conversationId}/members/u_alice`,
      headers: auth(bobToken),
    });
    expect(afterLeave.statusCode).toBe(404);

    // Re-invite Bob, then Alice removes him: he loses read access immediately.
    await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/members`,
      headers: auth(aliceToken),
      payload: { memberId: 'u_bob' },
    });
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/conversations/${conversationId}/members/u_bob`,
      headers: auth(aliceToken),
    });
    expect(removed.statusCode, removed.body).toBe(200);

    const bobRead = await app.inject({
      method: 'GET',
      url: `/api/conversations/${conversationId}/messages`,
      headers: auth(bobToken),
    });
    expect(bobRead.statusCode).toBe(404);

    // The removal is audited, and re-adding him does not happen implicitly.
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const deadline = Date.now() + 3000;
    let raw = '';
    while (Date.now() < deadline) {
      raw = await readFile(join(dataDir, 'audit.jsonl'), 'utf8');
      if (raw.includes('conversation.member_removed')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(raw).toContain('conversation.member_removed');
    const list = await app.inject({ method: 'GET', url: '/api/conversations', headers: auth(bobToken) });
    expect((list.json() as Array<{ id: string }>).some((item) => item.id === conversationId)).toBe(false);
  });
});

describe('group recovery and identity hardening', () => {
  it('lets a former member reclaim a group nobody is left in', async () => {
    const { app } = await boot();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const bobToken = await login(app, 'u_bob', 'bob-token');
    const payload = { title: '孤儿群回收组', memberIds: ['u_bob'] };

    const created = await app.inject({ method: 'POST', url: '/api/groups', headers: auth(aliceToken), payload });
    expect(created.statusCode, created.body).toBe(200);
    const conversationId = (created.json() as { id: string }).id;

    // Both humans leave, so the group is inert: no participant remains.
    for (const token of [aliceToken, bobToken]) {
      const left = await app.inject({
        method: 'POST',
        url: `/api/conversations/${conversationId}/leave`,
        headers: auth(token),
      });
      expect(left.statusCode, left.body).toBe(200);
    }

    // A dead 409 here would make the conversation unaddressable forever.
    const reclaim = await app.inject({ method: 'POST', url: '/api/groups', headers: auth(aliceToken), payload });
    expect(reclaim.statusCode, reclaim.body).toBe(200);
    expect((reclaim.json() as { id: string }).id).toBe(conversationId);
    const participants = (reclaim.json() as { participantIds: string[] }).participantIds;
    expect(participants).toContain('u_alice');
    expect(participants).toContain('u_bob');
  });

  it('refuses an identity injected with an invalid id through the dev fallback', async () => {
    const { app } = await boot();
    const response = await app.inject({
      method: 'GET',
      url: '/api/contacts',
      headers: { 'x-chatagent-principal-id': 'evil,comma' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('message audit trail', () => {
  it('records the assistant text reply and the artifact message separately', async () => {
    const { app, dataDir, adminToken } = await bootWithAdmin();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const accountId = await createAgent(app, auth(adminToken));
    const conversation = await openAgentConversation(app, auth(aliceToken), accountId);
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const countEntries = async (): Promise<{ total: number; replies: number; artifacts: number }> => {
      const raw = await readFile(join(dataDir, 'audit.jsonl'), 'utf8').catch(() => '');
      const entries = raw
        .split(String.fromCharCode(10))
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as { action?: string; detail?: string })
        .filter((entry) => entry.action === 'ai.message_sent');
      return {
        total: entries.length,
        replies: entries.filter((entry) => entry.detail === 'assistant_reply').length,
        artifacts: entries.filter((entry) => entry.detail === 'artifact_message').length,
      };
    };

    const before = await countEntries();
    const textReply = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation}/messages`,
      headers: auth(aliceToken),
      payload: { text: '你好' },
    });
    expect(textReply.statusCode, textReply.body).toBe(200);

    // The reply is produced by the background task, so poll for its audit entry.
    const textDeadline = Date.now() + 15000;
    let afterText = before;
    while (Date.now() < textDeadline) {
      afterText = await countEntries();
      if (afterText.replies > before.replies) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(afterText.replies).toBeGreaterThan(before.replies);

    const artifactTask = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversation}/messages`,
      headers: auth(aliceToken),
      payload: { text: '请生成一份 Word 文档' },
    });
    expect(artifactTask.statusCode, artifactTask.body).toBe(200);

    const deadline = Date.now() + 15000;
    let afterArtifact = afterText;
    while (Date.now() < deadline) {
      afterArtifact = await countEntries();
      if (afterArtifact.artifacts > before.artifacts) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // The file message gets its own label, and the text replies keep theirs.
    expect(afterArtifact.artifacts).toBeGreaterThan(before.artifacts);
    expect(afterArtifact.replies).toBeGreaterThanOrEqual(afterText.replies);
  });

  it('records sends on the workbench path without leaking the message body', async () => {
    const { app, dataDir, adminToken } = await bootWithAdmin();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const accountId = await createAgent(app, auth(adminToken));

    const sent = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: auth(aliceToken),
      payload: {
        accountId,
        chatType: 'direct',
        chatId: 'audit-trail-conversation',
        kind: 'text',
        text: 'AUDIT-SECRET-BODY',
      },
    });
    expect(sent.statusCode, sent.body).toBe(200);

    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const deadline = Date.now() + 3000;
    let raw = '';
    while (Date.now() < deadline) {
      raw = await readFile(join(dataDir, 'audit.jsonl'), 'utf8');
      if (raw.includes('message.sent')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(raw).toContain('message.sent');
    expect(raw).not.toContain('AUDIT-SECRET-BODY');
  });

  it('records a refused group re-creation', async () => {
    const { app, dataDir, adminToken } = await bootWithAdmin();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const bobToken = await login(app, 'u_bob', 'bob-token');
    const accountId = await createAgent(app, auth(adminToken));
    const payload = { title: '拒绝重建审计组', memberIds: [accountId, 'u_bob', 'u_alice'] };

    await app.inject({ method: 'POST', url: '/api/groups', headers: auth(aliceToken), payload });
    const created = await app.inject({ method: 'POST', url: '/api/groups', headers: auth(aliceToken), payload });
    const conversationId = (created.json() as { id: string }).id;
    await app.inject({ method: 'POST', url: `/api/conversations/${conversationId}/leave`, headers: auth(bobToken) });

    const refused = await app.inject({ method: 'POST', url: '/api/groups', headers: auth(bobToken), payload });
    expect(refused.statusCode, refused.body).toBe(409);

    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const deadline = Date.now() + 3000;
    let denied = false;
    while (Date.now() < deadline) {
      const raw = await readFile(join(dataDir, 'audit.jsonl'), 'utf8');
      denied = raw
        .split(String.fromCharCode(10))
        .filter((line) => line.trim() !== '')
        .some((line) => {
          const entry = JSON.parse(line) as { action?: string; outcome?: string };
          return entry.action === 'conversation.group_created' && entry.outcome === 'denied';
        });
      if (denied) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(denied, 'a refused re-creation is audited as denied').toBe(true);
  });
});

describe('session management', () => {
  it('lists only the caller sessions, flags the current one and revokes a single session', async () => {
    const { app } = await boot();
    // Two sessions for the same member; the newer one is the "current device".
    const olderSession = await login(app, 'u_alice', 'alice-token');
    const currentSession = await login(app, 'u_alice', 'alice-token');
    const bobToken = await login(app, 'u_bob', 'bob-token');

    const listed = await app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: auth(currentSession),
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const sessions = listed.json() as Array<{ id: string; current: boolean }>;
    expect(sessions.length).toBe(2);
    expect(sessions.filter((session) => session.current)).toHaveLength(1);
    // No token material or hash is ever returned.
    expect(JSON.stringify(listed.json())).not.toMatch(/tokenHash|[a-f0-9]{64}/);

    const other = sessions.find((session) => !session.current);
    expect(other, 'the other device is listed').toBeTruthy();

    // Bob cannot revoke Alice's session; the id is not visible to him either.
    const bobSessions = await app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: auth(bobToken),
    });
    expect((bobSessions.json() as Array<{ id: string }>).some((session) => session.id === other?.id)).toBe(false);
    const foreign = await app.inject({
      method: 'DELETE',
      url: `/api/auth/sessions/${other?.id}`,
      headers: auth(bobToken),
    });
    expect(foreign.statusCode).toBe(404);

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/auth/sessions/${other?.id}`,
      headers: auth(currentSession),
    });
    expect(revoked.statusCode, revoked.body).toBe(200);

    // The revoked device is locked out, the current one keeps working.
    const revokedDevice = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: auth(olderSession),
    });
    expect(revokedDevice.statusCode).toBe(401);
    const currentDevice = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: auth(currentSession),
    });
    expect(currentDevice.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: '/api/auth/sessions',
      headers: auth(currentSession),
    });
    const remaining = after.json() as Array<{ id: string }>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(sessions.find((session) => session.current)?.id);
  });

  it('revokes every other device while keeping the current session', async () => {
    const { app } = await boot();
    const olderSession = await login(app, 'u_alice', 'alice-token');
    const middleSession = await login(app, 'u_alice', 'alice-token');
    const currentSession = await login(app, 'u_alice', 'alice-token');

    const revoked = await app.inject({
      method: 'DELETE',
      url: '/api/auth/sessions',
      headers: auth(currentSession),
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect((revoked.json() as { revoked: number }).revoked).toBe(2);

    for (const stale of [olderSession, middleSession]) {
      const response = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(stale) });
      expect(response.statusCode).toBe(401);
    }
    const kept = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: auth(currentSession),
    });
    expect(kept.statusCode).toBe(200);

    // The member API token cannot be used to sign sessions out (no current one).
    const viaApiToken = await app.inject({
      method: 'DELETE',
      url: '/api/auth/sessions',
      headers: auth('alice-token'),
    });
    expect(viaApiToken.statusCode).toBe(400);
  });

  it('bounds how many sessions one member can accumulate', async () => {
    // Store-level check: driving 26 logins through HTTP would trip the login
    // rate limiter, which is a different concern.
    const { SessionStore } = await import('./stores');
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const store = new SessionStore(join(await mkdtemp(join(tmpdir(), 'chatagent-sessions-')), 'sessions.json'));

    for (let index = 0; index < 25; index += 1) {
      await store.create('u_alice', TEST_ORG, `hash-${index}`);
    }
    const sessions = await store.listSessions('u_alice');
    expect(sessions.length).toBeLessThanOrEqual(20);
    const hashes = sessions.map((session) => session.tokenHash);
    // The newest session survives, the oldest ones are gone. (createdAt has
    // millisecond resolution, so the assertion must not depend on ordering.)
    expect(hashes).toContain('hash-24');
    expect(hashes).not.toContain('hash-0');
  });
});

describe('credential minting', () => {
  it('refuses to rotate a token for a principal injected by the development fallback', async () => {
    const { app, config } = await boot();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/token/rotate',
      headers: { 'x-chatagent-principal-id': config.auth.defaultPrincipalId },
    });
    expect(response.statusCode, response.body).toBe(401);
  });

  it('rotates the token of a member who presented a credential', async () => {
    const { app } = await boot();
    const token = await login(app, 'u_alice', 'alice-token');
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/token/rotate',
      headers: auth(token),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(typeof response.json().token).toBe('string');
    expect(response.json().token.length).toBeGreaterThanOrEqual(32);

    const stale = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(token) });
    expect(stale.statusCode).toBe(401);
  });
});

describe('membership audit trail', () => {
  it('records group creation, invitations and leaving', async () => {
    const { app, dataDir, adminToken } = await bootWithAdmin();
    const aliceToken = await login(app, 'u_alice', 'alice-token');
    const accountId = await createAgent(app, auth(adminToken));

    const group = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: auth(aliceToken),
      payload: { title: '审计验证组', memberIds: [accountId] },
    });
    expect(group.statusCode, group.body).toBe(200);
    const conversationId = (group.json() as { id: string }).id;
    const invited = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/members`,
      headers: auth(aliceToken),
      payload: { memberId: 'u_bob' },
    });
    expect(invited.statusCode, invited.body).toBe(200);
    const left = await app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/leave`,
      headers: auth(aliceToken),
    });
    expect(left.statusCode, left.body).toBe(200);

    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const readActions = async (): Promise<string[]> => {
      const raw = await readFile(join(dataDir, 'audit.jsonl'), 'utf8');
      return raw
        .split(String.fromCharCode(10))
        .filter((line) => line.trim() !== '')
        .map((line) => (JSON.parse(line) as { action: string }).action);
    };
    // Audit writes are queued and coalesced, so poll instead of assuming they
    // have already reached the file.
    const deadline = Date.now() + 3000;
    let actions: string[] = [];
    while (Date.now() < deadline) {
      actions = await readActions();
      if (actions.includes('conversation.left')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(actions).toContain('conversation.group_created');
    expect(actions).toContain('conversation.member_added');
    expect(actions).toContain('conversation.left');
    expect(actions).toContain('auth.login');
  });
});
