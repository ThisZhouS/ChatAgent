import type { ChannelType, ChatMessage, InboundMessageInput } from '@chatagent/contracts';
import type {
  ImGateway,
  NormalizedInbound,
  OutboundRecord,
  SendFileInput,
  SendMessageInput,
  SendResult,
  WebhookVerificationResult,
} from '@chatagent/im-gateway';
import type { MemberDirectory } from './auth';
import type { NativeEventHub } from './events';
import type { AccountStore, ConversationStore, MessageStore } from './stores';

export interface NativeImGatewayOptions {
  accounts: AccountStore;
  conversations: ConversationStore;
  messages: MessageStore;
  directory: MemberDirectory;
  events: NativeEventHub;
}

/**
 * Built-in delivery channel. AI-initiated messages are written straight into
 * the recipient's native conversation, so a standalone deployment really
 * delivers instead of echoing into a local record.
 *
 * Inbound traffic does not exist here: members write through the native API
 * (`POST /api/conversations/:id/messages`), so `verify()` always rejects.
 */
export class NativeImGateway implements ImGateway {
  readonly name = 'native';
  readonly channel: ChannelType = 'native';
  private started = false;
  private readonly outbound: OutboundRecord[] = [];

  constructor(private readonly options: NativeImGatewayOptions) {}

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  verify(): WebhookVerificationResult {
    return { ok: false, mode: 'rejected', reason: 'native_channel_has_no_inbound_webhook' };
  }

  async handleWebhook(): Promise<NormalizedInbound | NormalizedInbound[]> {
    throw new Error('the native channel has no inbound webhook');
  }

  accept(_message: InboundMessageInput): void {
    // Native inbound messages are handled by ChatAgentService.sendNativeMessage.
  }

  onMessage(): () => void {
    return () => undefined;
  }

  /** Delivery receipts are visible in the admin outbound view. */
  listOutbound(): OutboundRecord[] {
    return [...this.outbound];
  }

  async sendMessage(input: SendMessageInput): Promise<SendResult> {
    const resolved = await this.resolveDelivery(input.accountId, input.to, input.requesterId);
    if (!resolved.ok) return { ok: false, state: 'failed', error: resolved.error };

    return this.append(resolved.account.id, resolved.account.displayName, resolved.memberId, {
      kind: 'text',
      text: input.text,
      attachments: [],
    });
  }

  async sendFile(input: SendFileInput): Promise<SendResult> {
    const resolved = await this.resolveDelivery(input.accountId, input.to, input.requesterId);
    if (!resolved.ok) return { ok: false, state: 'failed', error: resolved.error };

    return this.append(resolved.account.id, resolved.account.displayName, resolved.memberId, {
      kind: 'file',
      text: '',
      attachments: [
        {
          id: input.artifactId ?? crypto.randomUUID(),
          name: input.name,
          mimeType: input.mimeType,
          url: input.url,
          localPath: input.localPath,
        },
      ],
    });
  }

  private async resolveDelivery(
    accountId: string,
    to: string,
    requesterId?: string,
  ): Promise<
    | { ok: true; account: { id: string; displayName: string; organizationId: string }; memberId: string }
    | { ok: false; error: string }
  > {
    const account = await this.options.accounts.get(accountId);
    if (!account) return { ok: false, error: `unknown AI account: ${accountId}` };

    const target = to.trim();
    if (!target) return { ok: false, error: 'recipient is required' };

    const candidate = target === 'self' || target === 'me' ? requesterId : target;
    if (!candidate) {
      return { ok: false, error: 'recipient "self" cannot be resolved without a requester' };
    }

    const member = await this.options.directory.get(candidate);
    if (!member || member.organizationId !== account.organizationId) {
      return { ok: false, error: `unknown recipient in this organization: ${target}` };
    }

    return {
      ok: true,
      account: { id: account.id, displayName: account.displayName, organizationId: account.organizationId },
      memberId: member.id,
    };
  }

  private async append(
    accountId: string,
    accountName: string,
    memberId: string,
    payload: { kind: 'text' | 'file'; text: string; attachments: ChatMessage['attachments'] },
  ): Promise<SendResult> {
    if (!this.started) await this.start();

    const conversation = await this.options.conversations.findOrCreate({
      accountId,
      chatType: 'direct',
      chatId: `native:agent:${accountId}:${memberId}`,
      organizationId: (await this.options.accounts.get(accountId))?.organizationId ?? '',
      participantId: accountId,
      origin: 'native',
      targetKind: 'agent',
      targetId: accountId,
      title: accountName,
    });
    await this.options.conversations.addParticipant(conversation.id, memberId);

    const message: ChatMessage = {
      id: crypto.randomUUID(),
      channel: 'native',
      accountId,
      conversationId: conversation.id,
      chatType: 'direct',
      direction: 'outbound',
      kind: payload.kind,
      text: payload.text,
      sender: { id: accountId, name: accountName },
      mentions: [],
      attachments: payload.attachments,
      createdAt: new Date().toISOString(),
      metadata: { native: true },
    };

    await this.options.messages.append(message);
    await this.options.conversations.appendMessage(conversation.id, message.id);
    this.options.events.publish({
      type: 'message',
      conversationId: conversation.id,
      message,
      at: message.createdAt,
    });
    this.outbound.push({
      id: message.id,
      channel: 'native',
      accountId,
      to: memberId,
      chatType: 'direct',
      kind: payload.kind === 'file' ? 'file' : 'message',
      text: payload.text === '' ? undefined : payload.text,
      name: payload.attachments[0]?.name,
      url: payload.attachments[0]?.url,
      sentAt: message.createdAt,
    });

    return { ok: true, state: 'delivered', gatewayMessageId: message.id };
  }
}
