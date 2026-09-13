import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChannelType, InboundMessageInput } from '@chatagent/contracts';
import type { ImGateway, SendResult } from '@chatagent/im-gateway';
import { buildMessageTools, resolveDeliveryGateway } from './agent';
import { MemberDirectory } from './auth';
import { NativeEventHub } from './events';
import { NativeImGateway } from './native-gateway';
import {
  AccountStore,
  ArtifactStore,
  ConversationStore,
  DEFAULT_STORE_DEFAULTS,
  MessageStore,
  UploadedFileStore,
} from './stores';
import { TEST_ORG } from './test-helpers';

async function makeGateway() {
  const dataDir = await mkdtemp(join(tmpdir(), 'chatagent-native-'));
  const accounts = new AccountStore(join(dataDir, 'accounts.json'), DEFAULT_STORE_DEFAULTS);
  const conversations = new ConversationStore(
    join(dataDir, 'conversations.json'),
    DEFAULT_STORE_DEFAULTS,
  );
  const messages = new MessageStore(join(dataDir, 'messages.json'));
  const directory = new MemberDirectory({
    filePath: join(dataDir, 'members.json'),
    organizationId: TEST_ORG,
    ownerId: DEFAULT_STORE_DEFAULTS.legacyOwnerId,
    ownerName: 'Owner',
  });
  await directory.ensureOwner();
  await directory.upsert({ id: 'u_alice', organizationId: TEST_ORG, displayName: 'Alice' });
  await directory.upsert({ id: 'u_bob', organizationId: TEST_ORG, displayName: 'Bob' });
  await directory.upsert({ id: 'u_eve', organizationId: 'org_other', displayName: 'Eve' });

  const account = await accounts.create(
    { name: 'assistant', displayName: 'Assistant', channel: 'native', persona: 'p', allowlist: [] },
    { organizationId: TEST_ORG, ownerId: 'u_alice' },
  );

  const events = new NativeEventHub();
  const gateway = new NativeImGateway({ accounts, conversations, messages, directory, events });
  await gateway.start();

  return { gateway, account, conversations, messages, events };
}

describe('forward_file payloads', () => {
  it('sends the stored artifact id and never a filesystem path', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'chatagent-forward-'));
    const accounts = new AccountStore(join(dataDir, 'accounts.json'), DEFAULT_STORE_DEFAULTS);
    const uploads = new UploadedFileStore(dataDir, DEFAULT_STORE_DEFAULTS);
    const artifacts = new ArtifactStore(dataDir, DEFAULT_STORE_DEFAULTS);
    const directory = new MemberDirectory({
      filePath: join(dataDir, 'members.json'),
      organizationId: TEST_ORG,
      ownerId: DEFAULT_STORE_DEFAULTS.legacyOwnerId,
      ownerName: 'Owner',
    });
    await directory.ensureOwner();
    await directory.upsert({ id: 'u_alice', organizationId: TEST_ORG, displayName: 'Alice' });

    const account = await accounts.create(
      { name: 'assistant', displayName: 'Assistant', channel: 'native', persona: 'p', allowlist: [] },
      { organizationId: TEST_ORG, ownerId: 'u_alice' },
    );

    const upload = await uploads.save(Buffer.from('hello', 'utf8'), 'notes.txt', 'text/plain', {
      organizationId: TEST_ORG,
      ownerId: 'u_alice',
    });

    const captured: Array<Record<string, unknown>> = [];
    const gateway: ImGateway = {
      name: 'native',
      channel: 'native',
      start: async () => undefined,
      stop: async () => undefined,
      verify: () => ({ ok: true, mode: 'delivered' as never }),
      handleWebhook: async () => {
        throw new Error('unused');
      },
      accept: () => undefined,
      onMessage: () => () => undefined,
      listOutbound: () => [],
      sendMessage: async () => ({ ok: true, state: 'delivered' }),
      sendFile: async (input) => {
        captured.push({ ...input });
        return { ok: true, state: 'delivered' };
      },
    };

    const { ApprovalStore, OutboxStore } = await import('./approvals');
    const approvals = new ApprovalStore(join(dataDir, 'approvals.json'));
    const tools = buildMessageTools({
      accounts,
      gateways: [gateway],
      uploads,
      artifacts,
      approvals,
      outbox: new OutboxStore(join(dataDir, 'outbox.json')),
      directory,
      approvalTtlSeconds: 600,
    });
    const forward = tools.find((tool) => tool.definition.name === 'forward_file');
    if (!forward) throw new Error('forward_file missing');

    const context = {
      runId: 'run_1',
      accountId: account.id,
      conversationId: 'conv_1',
      taskId: 'task_1',
      organizationId: TEST_ORG,
      ownerId: 'u_alice',
      log: () => undefined,
    };

    const blocked = await forward.execute({ to: 'self', fileName: 'notes.txt' }, context);
    expect(blocked.ok).toBe(false);
    expect(captured).toHaveLength(0);

    const approvalId = (blocked.output as { approvalRequired?: { approvalId?: string } })
      ?.approvalRequired?.approvalId;
    if (!approvalId) throw new Error('approval missing');

    await approvals.decide(approvalId, 'approved', DEFAULT_STORE_DEFAULTS.legacyOwnerId);

    const sent = await forward.execute({ to: 'self', fileName: 'notes.txt' }, context);
    expect(sent.ok).toBe(true);
    expect(captured).toHaveLength(1);
    const payload = captured[0] ?? {};
    expect(payload.artifactId).toBe(upload.id);
    expect(payload.url).toBe(`/api/files/${upload.id}`);
    expect(JSON.stringify(payload)).not.toContain('localPath');
    expect(JSON.stringify(payload)).not.toContain(dataDir);
  });
});

class StubGateway implements ImGateway {
  readonly name: string;
  readonly channel: ChannelType;
  calls = 0;

  constructor(channel: ChannelType) {
    this.channel = channel;
    this.name = channel;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  verify() {
    return { ok: true, mode: 'simulated' as const };
  }
  async handleWebhook(): Promise<never> {
    throw new Error('unused');
  }
  accept(_message: InboundMessageInput): void {}
  onMessage(): () => void {
    return () => undefined;
  }
  listOutbound() {
    return [];
  }
  async sendMessage(): Promise<SendResult> {
    this.calls += 1;
    return { ok: true, state: 'delivered' };
  }
  async sendFile(): Promise<SendResult> {
    this.calls += 1;
    return { ok: true, state: 'delivered' };
  }
}

describe('native delivery channel', () => {
  it('delivers an AI message into the requester conversation as delivered', async () => {
    const { gateway, account, conversations, messages } = await makeGateway();

    const result = await gateway.sendMessage({
      accountId: account.id,
      to: 'self',
      chatType: 'direct',
      text: '周报已生成，请查收。',
      requesterId: 'u_alice',
    });

    expect(result.state).toBe('delivered');
    expect(result.ok).toBe(true);
    expect(result.gatewayMessageId).toBeTruthy();

    const conversation = await conversations.findByTarget(TEST_ORG, 'agent', account.id);
    expect(conversation).toBeDefined();
    expect(conversation?.chatId).toBe(`native:agent:${account.id}:u_alice`);
    expect(conversation?.participantIds).toContain('u_alice');

    const stored = await messages.list(conversation?.id ?? '');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.direction).toBe('outbound');
    expect(stored[0]?.channel).toBe('native');
    expect(stored[0]?.text).toBe('周报已生成，请查收。');
    expect(stored[0]?.sender.id).toBe(account.id);
  });

  it('delivers to another organization member', async () => {
    const { gateway, account, conversations, messages } = await makeGateway();

    const result = await gateway.sendMessage({
      accountId: account.id,
      to: 'u_bob',
      chatType: 'direct',
      text: '你好 Bob',
      requesterId: 'u_alice',
    });

    expect(result.state).toBe('delivered');
    const conversation = await conversations.findByTarget(TEST_ORG, 'agent', account.id);
    // findByTarget returns the first agent conversation; check the peer thread.
    const all = await conversations.list();
    const bobThread = all.find((item) => item.chatId.endsWith(':u_bob'));
    expect(bobThread).toBeDefined();
    expect(bobThread?.participantIds).toContain('u_bob');
    expect(conversation).toBeDefined();

    const stored = await messages.list(bobThread?.id ?? '');
    expect(stored[0]?.text).toBe('你好 Bob');
  });

  it('rejects unknown or cross-organization recipients without writing a message', async () => {
    const { gateway, account, conversations, messages } = await makeGateway();

    const unknown = await gateway.sendMessage({
      accountId: account.id,
      to: 'u_nobody',
      chatType: 'direct',
      text: 'hi',
      requesterId: 'u_alice',
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.state).toBe('failed');

    const crossOrg = await gateway.sendMessage({
      accountId: account.id,
      to: 'u_eve',
      chatType: 'direct',
      text: 'hi',
      requesterId: 'u_alice',
    });
    expect(crossOrg.ok).toBe(false);

    const selfWithoutRequester = await gateway.sendMessage({
      accountId: account.id,
      to: 'self',
      chatType: 'direct',
      text: 'hi',
    });
    expect(selfWithoutRequester.ok).toBe(false);

    expect(await conversations.list()).toHaveLength(0);
    expect(await messages.list('anything')).toHaveLength(0);
  });

  it('prefers the native channel over the local echo gateway', () => {
    const native = new StubGateway('native');
    const memory = new StubGateway('memory');
    const dingtalk = new StubGateway('dingtalk');

    expect(resolveDeliveryGateway([memory, native], 'memory')).toBe(native);
    expect(resolveDeliveryGateway([native, dingtalk], 'dingtalk')).toBe(dingtalk);
    expect(resolveDeliveryGateway([memory], 'memory')).toBe(memory);
    expect(resolveDeliveryGateway([dingtalk], 'unknown')).toBeUndefined();
  });
});
