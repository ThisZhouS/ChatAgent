import type { ChannelType, DeliveryState, InboundMessageInput } from '@chatagent/contracts';

export interface NormalizedInbound {
  chatType: 'direct' | 'group';
  chatId: string;
  channelMessageId?: string;
  senderId: string;
  senderName: string;
  kind: 'text' | 'file' | 'image' | 'mixed' | 'system';
  text: string;
  mentions: string[];
  attachments: Array<{
    id: string;
    name: string;
    mimeType?: string;
    sizeBytes?: number;
    url?: string;
    localPath?: string;
  }>;
  replyTo?: string;
}

export type PlatformNormalizer = (payload: unknown) => NormalizedInbound | NormalizedInbound[];

export interface SendMessageInput {
  accountId: string;
  to: string;
  chatType: 'direct' | 'group';
  text: string;
  mentions?: string[];
  /** Member who asked for this send; used to resolve `to: "self"`. */
  requesterId?: string;
  /** Conversation the run belongs to, when known. */
  conversationId?: string;
}

export interface SendFileInput {
  accountId: string;
  to: string;
  chatType: 'direct' | 'group';
  name: string;
  mimeType?: string;
  url?: string;
  localPath?: string;
  /** Stored artifact/upload id, so the recipient can download it. */
  artifactId?: string;
  requesterId?: string;
  conversationId?: string;
}

export interface SendResult {
  /** True only for `accepted` / `delivered`; `simulated` is never a real delivery. */
  ok: boolean;
  state: DeliveryState;
  gatewayMessageId?: string;
  error?: string;
}

export interface OutboundRecord {
  id: string;
  channel: ChannelType;
  accountId: string;
  to: string;
  chatType: 'direct' | 'group';
  kind: 'message' | 'file';
  text?: string;
  name?: string;
  url?: string;
  localPath?: string;
  sentAt: string;
}

export interface WebhookVerificationInput {
  /** Static token from header/query, when the platform uses one. */
  token?: string;
  /** `sha256=<hex>` HMAC of the raw body, when a signing secret is configured. */
  signature?: string;
  rawBody?: Buffer;
  payload: unknown;
  receivedAt?: Date;
}

export type WebhookVerificationMode =
  | 'signature'
  | 'token'
  | 'simulated'
  | 'rejected';

export interface WebhookVerificationResult {
  ok: boolean;
  mode: WebhookVerificationMode;
  reason?: string;
}

export interface ImGateway {
  readonly name: string;
  readonly channel: ChannelType;
  start(): Promise<void>;
  stop(): Promise<void>;
  verify(input: WebhookVerificationInput): WebhookVerificationResult;
  handleWebhook(payload: unknown): Promise<NormalizedInbound | NormalizedInbound[]>;
  accept(message: InboundMessageInput): void;
  sendMessage(input: SendMessageInput): Promise<SendResult>;
  sendFile(input: SendFileInput): Promise<SendResult>;
  onMessage(listener: (message: InboundMessageInput) => void): () => void;
  listOutbound(): OutboundRecord[];
}
