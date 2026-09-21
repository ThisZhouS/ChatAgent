import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { ApprovalRecord, ChannelType, OutboxRecord } from '@chatagent/contracts';
import type { Tool, ToolContext } from '@chatagent/hermes';
import type { ImGateway, SendResult } from '@chatagent/im-gateway';
import { buildMessageTools } from './agent';
import { ApprovalStore, OutboxStore } from './approvals';
import { MemberDirectory } from './auth';
import { AccountStore, ArtifactStore, UploadedFileStore, DEFAULT_STORE_DEFAULTS } from './stores';
import { createTestApp, devHeaders, poll } from './test-helpers';

const ORG = DEFAULT_STORE_DEFAULTS.organizationId;
const REQUESTER = 'u_req';
const APPROVER = 'u_boss';

class FakeGateway implements ImGateway {
  readonly name = 'fake';
  readonly channel: ChannelType = 'memory';
  messageCalls = 0;
  fileCalls = 0;
  private readonly results: SendResult[];

  constructor(results: SendResult[] = []) {
    this.results = [...results];
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  verify() {
    return { ok: true, mode: 'simulated' as const };
  }
  async handleWebhook(): Promise<never> {
    throw new Error('not used');
  }
  accept(): void {}
  onMessage(): () => void {
    return () => undefined;
  }
  listOutbound() {
    return [];
  }

  async sendMessage(): Promise<SendResult> {
    this.messageCalls += 1;
    return this.results.shift() ?? { ok: true, state: 'delivered' };
  }

  async sendFile(): Promise<SendResult> {
    this.fileCalls += 1;
    return this.results.shift() ?? { ok: true, state: 'delivered' };
  }
}

interface Harness {
  send: Tool;
  approvals: ApprovalStore;
  outbox: OutboxStore;
  directory: MemberDirectory;
  gateway: FakeGateway;
  context: ToolContext;
}

async function makeHarness(options: { gatewayResults?: SendResult[]; ttlSeconds?: number } = {}): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'chatagent-gate4-'));
  const accounts = new AccountStore(join(dataDir, 'accounts.json'), DEFAULT_STORE_DEFAULTS);
  const uploads = new UploadedFileStore(dataDir, DEFAULT_STORE_DEFAULTS);
  const artifacts = new ArtifactStore(dataDir, DEFAULT_STORE_DEFAULTS);
  const approvals = new ApprovalStore(join(dataDir, 'approvals.json'));
  const outbox = new OutboxStore(join(dataDir, 'outbox.json'));
  const directory = new MemberDirectory({
    filePath: join(dataDir, 'members.json'),
    organizationId: ORG,
    ownerId: DEFAULT_STORE_DEFAULTS.legacyOwnerId,
    ownerName: 'Owner',
  });
  await directory.ensureOwner();
  await directory.upsert({ id: REQUESTER, organizationId: ORG, displayName: 'Requester' });
  await directory.upsert({ id: APPROVER, organizationId: ORG, displayName: 'Boss', roles: ['owner'] });

  const gateway = new FakeGateway(options.gatewayResults ?? []);
  const account = await accounts.create(
    {
      name: 'assistant',
      displayName: 'Assistant',
      channel: 'memory',
      persona: 'p',
      allowlist: [],
    },
    { organizationId: ORG, ownerId: REQUESTER },
  );

  const tools = buildMessageTools({
    accounts,
    gateways: [gateway],
    uploads,
    artifacts,
    approvals,
    outbox,
    directory,
    approvalTtlSeconds: options.ttlSeconds ?? 1800,
  });
  const send = tools.find((tool) => tool.definition.name === 'send_message');
  if (!send) throw new Error('send_message tool missing');

  return {
    send,
    approvals,
    outbox,
    directory,
    gateway,
    context: {
      runId: 'run_1',
      accountId: account.id,
      conversationId: 'conv_1',
      taskId: 'task_1',
      organizationId: ORG,
      ownerId: REQUESTER,
      log: () => undefined,
    },
  };
}

function approvalIdOf(result: { output: unknown }): string {
  const output = result.output as { approvalRequired?: { approvalId?: string } } | null;
  const id = output?.approvalRequired?.approvalId;
  if (!id) throw new Error('approval id missing from tool result');
  return id;
}

function deliveryOf(result: { output: unknown }): { state: string; replayed: boolean } {
  const output = result.output as { delivery?: { state?: string; replayed?: boolean } } | null;
  const state = output?.delivery?.state;
  if (!state) throw new Error('delivery state missing from tool result');
  return { state, replayed: output?.delivery?.replayed === true };
}

let active: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of active) {
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  active = [];
});

describe('Gate 4: approval gate', () => {
  it('performs zero gateway calls before an approval exists', async () => {
    const harness = await makeHarness();

    const result = await harness.send.execute({ to: 'self', text: '你好' }, harness.context);

    expect(result.ok).toBe(false);
    expect(harness.gateway.messageCalls).toBe(0);
    expect(await harness.outbox.list()).toHaveLength(0);

    const pending = await harness.approvals.list(ORG);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe('pending');
    expect(pending[0]?.digest).toHaveLength(64);
    expect(approvalIdOf(result)).toBe(pending[0]?.id);
  });

  it('sends exactly once after approval and never repeats the side effect', async () => {
    const harness = await makeHarness();
    const request = await harness.send.execute({ to: 'self', text: '通知：发布' }, harness.context);
    const approvalId = approvalIdOf(request);

    await harness.approvals.decide(approvalId, 'approved', APPROVER);

    const first = await harness.send.execute({ to: 'self', text: '通知：发布' }, harness.context);
    expect(first.ok).toBe(true);
    expect(deliveryOf(first)).toEqual({ state: 'delivered', replayed: false });
    expect(harness.gateway.messageCalls).toBe(1);

    const second = await harness.send.execute({ to: 'self', text: '通知：发布' }, harness.context);
    expect(deliveryOf(second)).toEqual({ state: 'delivered', replayed: true });
    expect(harness.gateway.messageCalls).toBe(1);

    const records = await harness.outbox.list(ORG);
    expect(records).toHaveLength(1);
    expect(records[0]?.state).toBe('delivered');
    expect(records[0]?.attempts).toBe(1);
  });

  it('gives each task its own pending approval for the same action', async () => {
    const harness = await makeHarness();

    const firstRun = await harness.send.execute({ to: 'self', text: '重复动作' }, harness.context);
    const secondRun = await harness.send.execute(
      { to: 'self', text: '重复动作' },
      { ...harness.context, taskId: 'task_2', runId: 'run_2' },
    );

    const firstId = approvalIdOf(firstRun);
    const secondId = approvalIdOf(secondRun);
    expect(secondId).not.toBe(firstId);

    // Approving the first must not unblock the second, and vice versa.
    await harness.approvals.decide(firstId, 'approved', APPROVER);
    const first = await harness.send.execute({ to: 'self', text: '重复动作' }, harness.context);
    expect(deliveryOf(first).state).toBe('delivered');

    const secondBlocked = await harness.send.execute(
      { to: 'self', text: '重复动作' },
      { ...harness.context, taskId: 'task_2', runId: 'run_3' },
    );
    expect(secondBlocked.ok).toBe(false);
    expect(harness.gateway.messageCalls).toBe(1);
  });

  it('rejects an approval whose payload changed', async () => {
    const harness = await makeHarness();
    const request = await harness.send.execute({ to: 'self', text: '内容 A' }, harness.context);
    await harness.approvals.decide(approvalIdOf(request), 'approved', APPROVER);

    const changed = await harness.send.execute({ to: 'self', text: '内容 B' }, harness.context);

    expect(changed.ok).toBe(false);
    expect(harness.gateway.messageCalls).toBe(0);

    const all = await harness.approvals.list(ORG);
    expect(all).toHaveLength(2);
    const pending = all.find((approval) => approval.status === 'pending');
    expect(pending?.action.text).toBe('内容 B');
    expect(approvalIdOf(changed)).toBe(pending?.id);
  });

  it('rejects the send when the approver lost the role', async () => {
    const harness = await makeHarness();
    const request = await harness.send.execute({ to: 'self', text: '撤权测试' }, harness.context);
    const approvalId = approvalIdOf(request);
    await harness.approvals.decide(approvalId, 'approved', APPROVER);

    await harness.directory.upsert({
      id: APPROVER,
      organizationId: ORG,
      displayName: 'Boss',
      roles: ['member'],
    });

    const result = await harness.send.execute({ to: 'self', text: '撤权测试' }, harness.context);

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('approver_revoked');
    expect(harness.gateway.messageCalls).toBe(0);
    expect(await harness.outbox.list(ORG)).toHaveLength(0);
  });

  it('rejects an expired approval', async () => {
    const harness = await makeHarness({ ttlSeconds: -60 });
    const request = await harness.send.execute({ to: 'self', text: '过期测试' }, harness.context);
    await harness.approvals.decide(approvalIdOf(request), 'approved', APPROVER);

    const result = await harness.send.execute({ to: 'self', text: '过期测试' }, harness.context);

    expect(result.ok).toBe(false);
    expect(harness.gateway.messageCalls).toBe(0);
  });
});

describe('Gate 4: outbox receipts', () => {
  it('records unknown delivery and never retries it automatically', async () => {
    const harness = await makeHarness({
      gatewayResults: [{ ok: false, state: 'unknown', error: 'socket hang up' }],
    });
    const request = await harness.send.execute({ to: 'self', text: '未知结果' }, harness.context);
    await harness.approvals.decide(approvalIdOf(request), 'approved', APPROVER);

    const first = await harness.send.execute({ to: 'self', text: '未知结果' }, harness.context);
    expect(deliveryOf(first).state).toBe('unknown');
    expect(first.ok).toBe(false);
    expect(harness.gateway.messageCalls).toBe(1);

    const second = await harness.send.execute({ to: 'self', text: '未知结果' }, harness.context);
    expect(deliveryOf(second)).toEqual({ state: 'unknown', replayed: true });
    expect(harness.gateway.messageCalls).toBe(1);

    const records = await harness.outbox.list(ORG);
    expect(records).toHaveLength(1);
    expect(records[0]?.state).toBe('unknown');
  });

  it('simulated delivery is recorded but never reported as delivered', async () => {
    const harness = await makeHarness({
      gatewayResults: [{ ok: false, state: 'simulated', gatewayMessageId: 'local-1' }],
    });
    const request = await harness.send.execute({ to: 'self', text: '模拟' }, harness.context);
    await harness.approvals.decide(approvalIdOf(request), 'approved', APPROVER);

    const result = await harness.send.execute({ to: 'self', text: '模拟' }, harness.context);

    expect(result.ok).toBe(false);
    expect(deliveryOf(result).state).toBe('simulated');
    expect(result.summary).toContain('simulated');
  });

  it('never resends when the receipt could not be written', async () => {
    const harness = await makeHarness();
    const request = await harness.send.execute({ to: 'self', text: '写回执失败' }, harness.context);
    await harness.approvals.decide(approvalIdOf(request), 'approved', APPROVER);

    let saves = 0;
    const originalSave = harness.outbox.save.bind(harness.outbox);
    harness.outbox.save = async (record) => {
      saves += 1;
      // The write-ahead intent succeeds; the receipt write fails.
      if (saves === 2) throw new Error('disk full');
      return originalSave(record);
    };

    await expect(
      harness.send.execute({ to: 'self', text: '写回执失败' }, harness.context),
    ).rejects.toThrow('disk full');
    expect(harness.gateway.messageCalls).toBe(1);

    const records = await harness.outbox.list(ORG);
    expect(records).toHaveLength(1);
    expect(records[0]?.state).toBe('unknown');

    // The intent blocks any automatic resend: the retry replays.
    const retry = await harness.send.execute({ to: 'self', text: '写回执失败' }, harness.context);
    expect(deliveryOf(retry)).toEqual({ state: 'unknown', replayed: true });
    expect(harness.gateway.messageCalls).toBe(1);
  });

  it('allows a retry after an explicit failed delivery using the same approval', async () => {
    const harness = await makeHarness({
      gatewayResults: [
        { ok: false, state: 'failed', error: 'HTTP 502' },
        { ok: true, state: 'accepted' },
      ],
    });
    const request = await harness.send.execute({ to: 'self', text: '重试' }, harness.context);
    await harness.approvals.decide(approvalIdOf(request), 'approved', APPROVER);

    const failed = await harness.send.execute({ to: 'self', text: '重试' }, harness.context);
    expect(deliveryOf(failed).state).toBe('failed');
    expect(harness.gateway.messageCalls).toBe(1);

    const retried = await harness.send.execute({ to: 'self', text: '重试' }, harness.context);
    expect(deliveryOf(retried).state).toBe('accepted');
    expect(harness.gateway.messageCalls).toBe(2);

    const records = await harness.outbox.list(ORG);
    expect(records).toHaveLength(1);
    expect(records[0]?.attempts).toBe(2);
  });
});

describe('Gate 4: approval path end to end', () => {
  it('blocks the task, rejects self-approval, and completes the send once approved', async () => {
    const test = await createTestApp({ agentIntake: { mode: 'immediate' } });
    active.push(test.app);
    const app = test.app;

    const account = (await app.inject({ method: 'GET', url: '/api/accounts' })).json()[0];

    const sent = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: devHeaders('u_alice', ORG, 'Alice'),
      payload: { accountId: account.id, chatId: 'gate4-chat', text: '请发送通知给李四' },
    });
    const taskId = sent.json().taskId as string;

    const blocked = await poll(
      async () =>
        (await app.inject({
          method: 'GET',
          url: `/api/tasks/${taskId}`,
          headers: devHeaders('u_alice'),
        })).json(),
      (task: { state?: string }) => task.state === 'waiting_approval',
    );
    expect(blocked.state).toBe('waiting_approval');

    const outboxBefore = (
      await app.inject({ method: 'GET', url: '/api/outbox', headers: devHeaders('u_alice') })
    ).json() as OutboxRecord[];
    expect(outboxBefore).toHaveLength(0);

    const approvals = (
      await app.inject({ method: 'GET', url: '/api/approvals', headers: devHeaders('u_alice') })
    ).json() as ApprovalRecord[];
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.status).toBe('pending');
    const approvalId = approvals[0]?.id as string;

    // The requester may not approve their own outbound action.
    const selfApproval = await app.inject({
      method: 'POST',
      url: `/api/approvals/${approvalId}/decision`,
      headers: devHeaders('u_alice'),
      payload: { decision: 'approved' },
    });
    expect(selfApproval.statusCode).toBe(403);

    // An org owner (different principal) approves.
    const approved = await app.inject({
      method: 'POST',
      url: `/api/approvals/${approvalId}/decision`,
      payload: { decision: 'approved' },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe('approved');

    const resumed = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/resume`,
      headers: devHeaders('u_alice'),
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().ok).toBe(true);

    const finished = await poll(
      async () =>
        (await app.inject({
          method: 'GET',
          url: `/api/tasks/${taskId}`,
          headers: devHeaders('u_alice'),
        })).json(),
      (task: { state?: string }) => task.state === 'incomplete' || task.state === 'completed',
    );
    // The built-in native channel delivers into the member inbox, so this is a
    // real in-product delivery rather than a simulated echo.
    expect(finished.state).toBe('completed');

    const outboxAfter = (
      await app.inject({ method: 'GET', url: '/api/outbox', headers: devHeaders('u_alice') })
    ).json() as OutboxRecord[];
    expect(outboxAfter).toHaveLength(1);
    expect(outboxAfter[0]?.state).toBe('delivered');
    expect(outboxAfter[0]?.stepKey).toBeTruthy();

    // A second resume must not re-execute a terminal task.
    const secondResume = await app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/resume`,
      headers: devHeaders('u_alice'),
    });
    expect(secondResume.json().ok).toBe(false);

    const outboxFinal = (
      await app.inject({ method: 'GET', url: '/api/outbox', headers: devHeaders('u_alice') })
    ).json() as OutboxRecord[];
    expect(outboxFinal).toHaveLength(1);
  });
});
