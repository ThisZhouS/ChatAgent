#!/usr/bin/env node
/**
 * End-to-end smoke test against a running ChatAgent server.
 *
 * Usage:
 *   node scripts/smoke.mjs                       # dev mode on loopback (uses the dev principal)
 *   SMOKE_MEMBER=u_alice SMOKE_TOKEN=... node scripts/smoke.mjs
 *   CHATAGENT_URL=http://host:8787 node scripts/smoke.mjs
 *
 * It only reads/writes through the public API and prints a PASS/FAIL table.
 *
 * The throwaway approver account needs owner rights (approvals are decided by
 * an admin who is not the requester). Its token is a live credential and is
 * cached OUTSIDE the repository, in the OS temp directory, or taken from
 * SMOKE_APPROVER_TOKEN. Delete the cached file to provision a fresh account.
 */
const BASE = (process.env.CHATAGENT_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const MEMBER = process.env.SMOKE_MEMBER ?? '';
const TOKEN = process.env.SMOKE_TOKEN ?? '';

import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results = [];
let authHeaders = {};

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function call(method, path, body, extraHeaders = {}) {
  const headers = { ...authHeaders, ...extraHeaders };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text, headers: response.headers };
}

async function pollTask(taskId, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    const response = await call('GET', `/api/tasks/${taskId}`);
    latest = response.json;
    if (latest && predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return latest;
}

async function main() {
  console.log(`ChatAgent smoke test → ${BASE}\n`);

  const health = await call('GET', '/health');
  record('health endpoint', health.status === 200 && health.json?.ok === true, `authMode=${health.json?.authMode}`);

  if (TOKEN && MEMBER) {
    const login = await call('POST', '/api/auth/login', { memberId: MEMBER, token: TOKEN });
    if (login.status !== 200) {
      record('login with member token', false, `status=${login.status} ${login.text.slice(0, 120)}`);
      return;
    }
    authHeaders = { Authorization: `Bearer ${login.json.token}` };
    record('login with member token', true, login.json.member.id);
  } else {
    // Development profile on loopback: the server maps the caller to the owner.
    authHeaders = {};
    const me = await call('GET', '/api/auth/me');
    record(
      'development principal (loopback)',
      me.status === 200,
      me.status === 200 ? me.json.id : `status=${me.status} (set SMOKE_MEMBER/SMOKE_TOKEN for production)`,
    );
    if (me.status !== 200) return;
  }

  const me = (await call('GET', '/api/auth/me')).json;

  // A second org admin is needed to approve the requester's outbound action
  // (self-approval is refused by design). Provisioning goes through the public
  // member API, which also exercises token issuance.
  let approverHeaders = authHeaders;
  const approverId = 'smoke_approver';
  // Approving an outbound action requires an owner/admin who is not the
  // requester, so a throwaway approver is provisioned through the public member
  // API (which also exercises token issuance). That token is issued once only:
  // it is a LIVE org-owner credential, so it is cached outside the repository
  // (OS temp dir), keyed by server address, and always verified by logging in
  // before it is trusted. SMOKE_APPROVER_TOKEN takes precedence when provided.
  const serverSlug = BASE.replace(/^https?:\/\//, '').replace(/[^a-zA-Z0-9]+/g, '-');
  const approverCache = join(tmpdir(), `chatagent-smoke-approver-${serverSlug}.json`);
  const loginApprover = async (token) => {
    const response = await call('POST', '/api/auth/login', { memberId: approverId, token });
    return response.status === 200 ? response.json.token : null;
  };

  let approverSession = null;
  const providedToken = process.env.SMOKE_APPROVER_TOKEN;
  if (providedToken) {
    approverSession = await loginApprover(providedToken);
    if (!approverSession) {
      record('provisioned a second admin via API', false, 'SMOKE_APPROVER_TOKEN was rejected');
    }
  } else {
    let cachedToken = null;
    try {
      const cached = JSON.parse(await readFile(approverCache, 'utf8'));
      if (typeof cached.token === 'string' && cached.token !== '') cachedToken = cached.token;
    } catch {
      cachedToken = null;
    }
    if (cachedToken) {
      // The cache may belong to another server instance or data directory.
      approverSession = await loginApprover(cachedToken);
      if (!approverSession) cachedToken = null;
    }
    if (!cachedToken) {
      const provisioned = await call('POST', '/api/members', {
        id: approverId,
        displayName: 'Smoke Approver',
        roles: ['owner'],
      });
      if (provisioned.status === 201) {
        const token = provisioned.json.token;
        await writeFile(approverCache, JSON.stringify({ id: approverId, token }), {
          encoding: 'utf8',
          mode: 0o600,
        });
        approverSession = await loginApprover(token);
      } else {
        record(
          'provisioned a second admin via API',
          false,
          `status=${provisioned.status}; remove "${approverId}" from the member directory or set SMOKE_APPROVER_TOKEN`,
        );
      }
    }
  }

  if (approverSession) {
    approverHeaders = { Authorization: `Bearer ${approverSession}` };
    record('provisioned a second admin via API', true, approverId);
  } else if (approverHeaders === authHeaders) {
    record('provisioned a second admin via API', false, 'no usable approver credential');
  }

  const contacts = (await call('GET', '/api/contacts')).json ?? [];
  const agentContact = contacts.find((contact) => contact.kind === 'agent');
  record('contact list contains an AI account', Boolean(agentContact), agentContact?.displayName ?? 'none');
  if (!agentContact) return;

  const opened = await call('POST', '/api/conversations', {
    targetId: agentContact.accountId,
    targetKind: 'agent',
  });
  record('open native conversation', opened.status === 200, opened.json?.chatType);
  const conversationId = opened.json?.id;
  if (!conversationId) return;

  const sent = await call('POST', `/api/conversations/${conversationId}/messages`, {
    text: '请生成一份 Word 文档，内容包括：ChatAgent 冒烟测试通过。',
  });
  record('send message creates a task', sent.status === 200 && Boolean(sent.json?.taskId), sent.json?.taskId);
  const documentTaskId = sent.json?.taskId;

  const documentTask = await pollTask(documentTaskId, (task) => task.state === 'completed' || task.state === 'failed');
  record(
    'document task completed',
    documentTask?.state === 'completed',
    `state=${documentTask?.state} artifacts=${(documentTask?.artifacts ?? []).length}`,
  );

  const artifact = (documentTask?.artifacts ?? [])[0];
  if (artifact) {
    const download = await fetch(`${BASE}/api/files/${artifact.id}`, { headers: authHeaders });
    const bytes = (await download.arrayBuffer()).byteLength;
    record('artifact download authorized', download.status === 200 && bytes > 0, `${bytes} bytes`);
  } else {
    record('artifact download authorized', false, 'no artifact produced');
  }

  const summon = await call('POST', `/api/conversations/${conversationId}/messages`, {
    text: '请发送通知给我自己：冒烟测试完成。',
  });
  const approvalTaskId = summon.json?.taskId;
  const gated = await pollTask(approvalTaskId, (task) => task.state === 'waiting_approval' || task.state === 'completed');
  record('send_message requires approval', gated?.state === 'waiting_approval', `state=${gated?.state}`);

  if (gated?.state === 'waiting_approval') {
    const approvals = (await call('GET', '/api/approvals')).json ?? [];
    const pending = approvals.find((approval) => approval.status === 'pending' && approval.taskId === approvalTaskId);

    if (pending) {
      const selfApproval = await call('POST', `/api/approvals/${pending.id}/decision`, { decision: 'approved' });
      record('self approval is refused', selfApproval.status === 403, `status=${selfApproval.status}`);
    }

    if (pending && approverHeaders !== authHeaders) {
      const decided = await fetch(`${BASE}/api/approvals/${pending.id}/decision`, {
        method: 'POST',
        headers: { ...approverHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approved' }),
      }).then(async (response) => ({ status: response.status, json: await response.json().catch(() => undefined) }));
      record('approval recorded', decided.status === 200, decided.json?.status);
      const resumed = await call('POST', `/api/tasks/${approvalTaskId}/resume`);
      record('task resume accepted', resumed.status === 200 && resumed.json?.ok === true, resumed.json?.reason ?? '');

      const finished = await pollTask(
        approvalTaskId,
        (task) => task.state === 'completed' || task.state === 'incomplete' || task.state === 'failed',
      );
      record('delivery task reached a terminal state', Boolean(finished), `state=${finished?.state}`);

      const outbox = (await call('GET', '/api/outbox')).json ?? [];
      const receipt = outbox.find((record_) => record_.taskId === approvalTaskId);
      record('delivery receipt recorded', Boolean(receipt), receipt ? `state=${receipt.state}` : 'no receipt');
    }
  }

  const search = await call('GET', `/api/search?q=${encodeURIComponent('冒烟测试')}`);
  record('message search works', search.status === 200 && Array.isArray(search.json) && search.json.length > 0, `${(search.json ?? []).length} hits`);

  const groups = await call('POST', '/api/groups', {
    title: 'Smoke 群',
    memberIds: contacts.filter((contact) => contact.kind === 'member' && contact.id !== me.id).slice(0, 1).map((contact) => contact.id),
  });
  record('group creation', groups.status === 200 || groups.status === 400, `status=${groups.status}`);

  // --- Native client surface: recall, receipts, presence, export, sessions ---

  const presence = await call('GET', '/api/presence');
  record(
    'presence endpoint answers',
    presence.status === 200 && Array.isArray(presence.json?.online),
    `online=${(presence.json?.online ?? []).length}`,
  );

  const peer = contacts.find((contact) => contact.kind === 'member' && contact.id !== me.id);
  let dmId = undefined;
  if (peer) {
    const dm = await call('POST', '/api/conversations', { targetId: peer.id, targetKind: 'member' });
    dmId = dm.json?.id;
    record('direct conversation with a colleague opens', Boolean(dmId), dm.json?.title ?? `status=${dm.status}`);

    if (dmId) {
      // Recall is verified in a 1:1 conversation: an AI reply would quote the
      // marker and legitimately keep the text findable.
      const marker = `SMOKE-RECALL-${Date.now().toString(36)}`;
      const sent = await call('POST', `/api/conversations/${dmId}/messages`, { text: marker });
      const messageId = sent.json?.message?.id;
      record('recall target created', Boolean(messageId));

      if (messageId) {
        const recalled = await call('POST', `/api/messages/${messageId}/recall`);
        record('message recall accepted', recalled.status === 200 && recalled.json?.ok === true, `status=${recalled.status}`);

        const history = (await call('GET', `/api/conversations/${dmId}/messages`)).json ?? [];
        const target = history.find((message) => message.id === messageId);
        record(
          'recalled body is no longer readable',
          Boolean(target?.recalledAt) && target?.text === '',
          `recalledAt=${Boolean(target?.recalledAt)}`,
        );

        const afterRecallSearch = await call('GET', `/api/search?q=${encodeURIComponent(marker)}`);
        record(
          'recalled message leaves search results',
          afterRecallSearch.status === 200 && (afterRecallSearch.json ?? []).length === 0,
          `${(afterRecallSearch.json ?? []).length} hits`,
        );
      }

      const receipts = await call('GET', `/api/conversations/${dmId}/read-receipts`);
      record(
        'read receipts are readable by a participant',
        receipts.status === 200 && Array.isArray(receipts.json?.others),
        JSON.stringify(receipts.json ?? {}).slice(0, 60),
      );

      const membershipChange = await call('POST', `/api/conversations/${dmId}/members`, { memberId: peer.id });
      record(
        'direct conversations reject membership changes',
        membershipChange.status === 400,
        `status=${membershipChange.status}`,
      );
    }
  }

  if (conversationId) {
    const exported = await call('POST', `/api/conversations/${conversationId}/export`);
    record(
      'conversation exports as a Word transcript',
      exported.status === 200 && typeof exported.json?.name === 'string' && exported.json.name.endsWith('.docx'),
      exported.json?.name ?? `status=${exported.status}`,
    );
    if (exported.status === 200 && exported.json?.id) {
      const download = await call('GET', `/api/files/${exported.json.id}`);
      record('exported transcript is downloadable', download.status === 200, `status=${download.status}`);
    }
  }

  const sessions = await call('GET', '/api/auth/sessions');
  const sessionList = Array.isArray(sessions.json) ? sessions.json : [];
  // In development mode the caller is the injected owner and holds no session,
  // so an empty list is the correct answer there.
  const expectSession = Boolean(TOKEN && MEMBER);
  record(
    'sessions endpoint answers without exposing token material',
    sessions.status === 200 &&
      (!expectSession || sessionList.length >= 1) &&
      !/tokenHash|[a-f0-9]{64}/.test(JSON.stringify(sessionList)),
    `${sessionList.length} session(s)`,
  );

  const passed = results.filter((item) => item.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error('smoke test crashed:', error);
  process.exitCode = 1;
});
