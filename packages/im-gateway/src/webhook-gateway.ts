import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ChannelType, InboundMessageInput } from '@chatagent/contracts';
import type {
  ImGateway,
  NormalizedInbound,
  OutboundRecord,
  PlatformNormalizer,
  SendFileInput,
  SendMessageInput,
  SendResult,
  WebhookVerificationInput,
  WebhookVerificationResult,
} from './types';

export interface WebhookImGatewayOptions {
  channel: ChannelType;
  name: string;
  normalizer: PlatformNormalizer;
  sendUrl?: string;
  verificationToken?: string;
  /** When set, inbound requests must carry a valid HMAC signature. */
  signingSecret?: string;
  /**
   * Allows inbound traffic without any verification material. Only for an
   * explicit development/test profile; production must keep this false and
   * configure a token or signing secret.
   */
  allowUnverified?: boolean;
  /** Rejects payloads whose embedded timestamp is older/newer than this. 0 disables. */
  maxSkewSeconds?: number;
  /** Outbound HTTP timeout; a timeout is reported as `unknown`, never retried blindly. */
  requestTimeoutMs?: number;
}

export class WebhookImGateway implements ImGateway {
  readonly channel: ChannelType;
  readonly name: string;
  private readonly normalizer: PlatformNormalizer;
  private readonly sendUrl?: string;
  private readonly verificationToken?: string;
  private readonly signingSecret?: string;
  private readonly allowUnverified: boolean;
  private readonly maxSkewSeconds: number;
  private readonly requestTimeoutMs: number;
  private readonly listeners = new Set<(message: InboundMessageInput) => void>();
  private readonly outbound: OutboundRecord[] = [];
  private started = false;

  constructor(options: WebhookImGatewayOptions) {
    this.channel = options.channel;
    this.name = options.name;
    this.normalizer = options.normalizer;
    this.sendUrl = options.sendUrl;
    this.verificationToken = options.verificationToken;
    this.signingSecret = options.signingSecret;
    this.allowUnverified = options.allowUnverified ?? false;
    this.maxSkewSeconds = options.maxSkewSeconds ?? 300;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10000;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
  }

  /**
   * Fail-closed inbound verification. Without a signing secret or token the
   * request is only accepted when the caller explicitly opted into the
   * development/test profile, and the result is labelled `simulated`.
   */
  verify(input: WebhookVerificationInput): WebhookVerificationResult {
    if (this.signingSecret) {
      const signature = input.signature;
      if (!signature || !input.rawBody) {
        return { ok: false, mode: 'rejected', reason: 'missing_signature' };
      }
      if (!verifyHmac(input.rawBody, this.signingSecret, signature)) {
        return { ok: false, mode: 'rejected', reason: 'bad_signature' };
      }
      return this.checkTimestamp(input.payload, 'signature');
    }

    if (this.verificationToken) {
      if (!input.token || !safeEqual(input.token, this.verificationToken)) {
        return { ok: false, mode: 'rejected', reason: 'bad_token' };
      }
      return this.checkTimestamp(input.payload, 'token');
    }

    if (!this.allowUnverified) {
      return { ok: false, mode: 'rejected', reason: 'no_verification_material' };
    }
    return this.checkTimestamp(input.payload, 'simulated');
  }

  async handleWebhook(payload: unknown): Promise<NormalizedInbound | NormalizedInbound[]> {
    return this.normalizer(payload);
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

    if (this.sendUrl) {
      return this.post(this.sendUrl, { ...input, msgtype: 'text' });
    }
    // No delivery endpoint configured: recorded locally only.
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

    if (this.sendUrl) {
      return this.post(this.sendUrl, { ...input, msgtype: 'file' });
    }
    return { ok: false, state: 'simulated', gatewayMessageId: record.id };
  }

  onMessage(listener: (message: InboundMessageInput) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listOutbound(): OutboundRecord[] {
    return [...this.outbound];
  }

  private checkTimestamp(
    payload: unknown,
    mode: WebhookVerificationResult['mode'],
  ): WebhookVerificationResult {
    if (this.maxSkewSeconds <= 0) return { ok: true, mode };
    const timestamp = extractTimestamp(payload);
    if (timestamp === undefined) return { ok: true, mode };

    const skewSeconds = Math.abs(Date.now() - timestamp) / 1000;
    if (skewSeconds > this.maxSkewSeconds) {
      return { ok: false, mode: 'rejected', reason: 'timestamp_out_of_window' };
    }
    return { ok: true, mode };
  }

  /**
   * Outbound delivery. HTTP status alone is not a delivery receipt:
   * - 2xx without a business error -> `accepted` (no receipt verification yet)
   * - non-2xx or business error    -> `failed`
   * - timeout / transport error    -> `unknown` (the peer may have received it)
   */
  private async post(url: string, body: unknown): Promise<SendResult> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'gateway transport error';
      return { ok: false, state: 'unknown', error: message };
    }

    const text = await response.text().catch(() => '');

    if (!response.ok) {
      // 5xx / 408 / 429 may mean the peer accepted before failing to answer;
      // treating them as `failed` would allow a blind resend.
      const ambiguous =
        response.status >= 500 || response.status === 408 || response.status === 429;
      return ambiguous
        ? { ok: false, state: 'unknown', error: `gateway HTTP ${response.status}` }
        : { ok: false, state: 'failed', error: `gateway HTTP ${response.status}` };
    }
    if (reportsBusinessError(text)) {
      return { ok: false, state: 'failed', error: 'gateway reported a business error' };
    }
    return { ok: true, state: 'accepted' };
  }
}

/** Detects common business-error envelopes in a 2xx response body. */
function reportsBusinessError(body: string): boolean {
  if (!body.trim()) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  if (record.ok === false) return true;
  for (const key of ['errcode', 'errCode', 'code']) {
    const value = record[key];
    if (typeof value === 'number' && value !== 0) return true;
    if (typeof value === 'string' && value !== '' && value !== '0' && value !== 'ok') return true;
  }
  return false;
}

function verifyHmac(rawBody: Buffer, secret: string, signature: string): boolean {
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
  return safeEqual(provided, expected);
}

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/** Reads a platform timestamp (epoch seconds or milliseconds) when present. */
function extractTimestamp(payload: unknown): number | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  const candidate = record.timestamp ?? record.create_time ?? record.createTime;
  if (typeof candidate === 'string' && candidate.trim() !== '') {
    const parsed = Number(candidate);
    return Number.isFinite(parsed) ? normalizeEpoch(parsed) : undefined;
  }
  if (typeof candidate === 'number' && Number.isFinite(candidate)) {
    return normalizeEpoch(candidate);
  }
  return undefined;
}

function normalizeEpoch(value: number): number {
  // Heuristic: 10-digit values are seconds, 13-digit values are milliseconds.
  return value < 1e11 ? value * 1000 : value;
}
