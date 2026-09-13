import type { ChannelType, InboundMessageInput } from '@chatagent/contracts';
import type {
  ImGateway,
  NormalizedInbound,
  OutboundRecord,
  SendFileInput,
  SendMessageInput,
  SendResult,
  WebhookVerificationResult,
} from './types';

export class MemoryImGateway implements ImGateway {
  readonly channel: ChannelType = 'memory';
  readonly name = 'memory';
  private readonly listeners = new Set<(message: InboundMessageInput) => void>();
  private readonly outbound: OutboundRecord[] = [];
  private started = false;

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  async handleWebhook(payload: unknown): Promise<NormalizedInbound | NormalizedInbound[]> {
    // For the memory gateway, a payload is already a normalized inbound shape.
    return payload as NormalizedInbound | NormalizedInbound[];
  }

  verify(): WebhookVerificationResult {
    // The in-process dev/test gateway has no external transport to verify.
    return { ok: true, mode: 'simulated' };
  }

  accept(message: InboundMessageInput): void {
    if (!this.started) void this.start();
    for (const listener of this.listeners) listener(message);
  }

  async sendMessage(input: SendMessageInput): Promise<SendResult> {
    const record: OutboundRecord = {
      id: crypto.randomUUID(),
      channel: this.channel,
      accountId: input.accountId,
      to: input.to,
      chatType: input.chatType,
      kind: 'message',
      text: input.text,
      sentAt: new Date().toISOString(),
    };
    this.outbound.push(record);
    // Local record only: no transport exists, so this is explicitly `simulated`.
    return { ok: false, state: 'simulated', gatewayMessageId: record.id };
  }

  async sendFile(input: SendFileInput): Promise<SendResult> {
    const record: OutboundRecord = {
      id: crypto.randomUUID(),
      channel: this.channel,
      accountId: input.accountId,
      to: input.to,
      chatType: input.chatType,
      kind: 'file',
      name: input.name,
      url: input.url,
      localPath: input.localPath,
      sentAt: new Date().toISOString(),
    };
    this.outbound.push(record);
    // Local record only: no transport exists, so this is explicitly `simulated`.
    return { ok: false, state: 'simulated', gatewayMessageId: record.id };
  }

  onMessage(listener: (message: InboundMessageInput) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listOutbound(): OutboundRecord[] {
    return [...this.outbound];
  }
}
