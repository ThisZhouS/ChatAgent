export const DEFAULT_ORGANIZATION_ID = 'org_local';
export const LEGACY_OWNER_ID = 'dev-owner';

export type ChannelType =
  /** Built-in channel: delivery inside ChatAgent itself. */
  | 'native'
  | 'qq'
  | 'wechat'
  | 'wechat-work'
  | 'dingtalk'
  | 'feishu'
  | 'web'
  | 'cli'
  | 'memory';

export type ChatType = 'direct' | 'group';
export type MessageDirection = 'inbound' | 'outbound';
export type MessageKind = 'text' | 'file' | 'image' | 'mixed' | 'system';
export type AccountStatus = 'online' | 'offline' | 'busy';

/**
 * Task lifecycle. `waiting_approval` and `incomplete` are explicit non-success
 * outcomes: a run that needs approval, ran out of steps or hit an output limit
 * must never be reported as `completed`.
 */
export type TaskState =
  | 'pending'
  | 'running'
  | 'waiting_input'
  | 'waiting_approval'
  | 'incomplete'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** States that must not be overwritten by a late writer (CAS guard). */
export const TERMINAL_TASK_STATES: readonly TaskState[] = [
  'completed',
  'failed',
  'cancelled',
  'incomplete',
];

export type PrincipalKind = 'anonymous' | 'member' | 'agent';

/** Authenticated caller. Never derived from request body fields. */
export interface Principal {
  id: string;
  kind: PrincipalKind;
  organizationId: string;
  displayName: string;
  roles: string[];
  agentIds: string[];
  /**
   * True when the identity came from the development fallback instead of a
   * presented credential. Endpoints that mint credentials must reject it.
   */
  viaDevFallback?: boolean;
  /** Session this principal was resolved from, when a session token was used. */
  sessionId?: string;
}

/** Persisted member directory entry. Tokens are stored as sha256 hashes only. */
export interface MemberRecord {
  id: string;
  organizationId: string;
  displayName: string;
  roles: string[];
  agentIds: string[];
  tokenHash?: string;
  createdAt: string;
  updatedAt: string;
}

export type RunOutcomeStatus =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'waiting_input'
  | 'waiting_approval'
  | 'incomplete';

export interface RunOutcomeSummary {
  status: RunOutcomeStatus;
  code?: string;
  message: string;
  retryable?: boolean;
}

// ---------------------------------------------------------------------------
// Gate 4: outbound approval, outbox and delivery receipts
// ---------------------------------------------------------------------------

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';

/** Canonical outbound action; the approval digest is computed over these fields only. */
export interface ApprovalAction {
  tool: string;
  target: string;
  chatType: 'direct' | 'group';
  kind: 'message' | 'file';
  text?: string;
  artifactId?: string;
  artifactVersion?: string;
  artifactName?: string;
}

export interface ApprovalRecord {
  id: string;
  organizationId: string;
  requesterId: string;
  taskId?: string;
  runId?: string;
  action: ApprovalAction;
  /** sha256 over the canonical action; any payload/target change yields a new digest. */
  digest: string;
  status: ApprovalStatus;
  reason?: string;
  approverId?: string;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  consumedAt?: string;
  consumedByStepKey?: string;
}

export type DeliveryState = 'simulated' | 'accepted' | 'delivered' | 'failed' | 'unknown';

/** Persistent outbox entry; `stepKey` is the idempotency key. */
export interface OutboxRecord {
  id: string;
  stepKey: string;
  organizationId: string;
  ownerId: string;
  taskId?: string;
  runId?: string;
  tool: string;
  target: string;
  chatType: 'direct' | 'group';
  kind: 'message' | 'file';
  digest: string;
  approvalId?: string;
  state: DeliveryState;
  attempts: number;
  gatewayMessageId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatParticipant {
  id: string;
  name: string;
  displayName?: string;
}

export interface FileAttachment {
  id: string;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  url?: string;
  localPath?: string;
}

export interface ChatMessage {
  id: string;
  channel: ChannelType;
  channelMessageId?: string;
  /** Set when the message belongs to a conversation with an AI account. */
  accountId?: string;
  conversationId: string;
  chatType: ChatType;
  direction: MessageDirection;
  kind: MessageKind;
  text: string;
  sender: ChatParticipant;
  /** Authenticated principal that produced an inbound message, when known. */
  senderPrincipalId?: string;
  mentions: string[];
  attachments: FileAttachment[];
  replyTo?: string;
  createdAt: string;
  /**
   * Set when the sender recalled the message. The body and attachments must not
   * be exposed to readers, search results, previews or the model history.
   */
  recalledAt?: string;
  metadata?: Record<string, unknown>;
}

export interface InboundMessageInput {
  accountId: string;
  channel?: ChannelType;
  channelMessageId?: string;
  chatType: ChatType;
  chatId: string;
  kind: MessageKind;
  text: string;
  sender: ChatParticipant;
  mentions: string[];
  attachments: FileAttachment[];
  replyTo?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentAccount {
  id: string;
  name: string;
  displayName: string;
  channel: ChannelType;
  channelUserId?: string;
  status: AccountStatus;
  persona: string;
  allowlist: string[];
  organizationId: string;
  /** Member id accountable for this AI account (owner or delegating owner). */
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  /** Set when the conversation targets an AI account. */
  accountId?: string;
  chatType: ChatType;
  chatId: string;
  title?: string;
  organizationId: string;
  /** Member ids and/or AI account ids that may read this conversation. */
  participantIds: string[];
  /** `native` = created inside ChatAgent; `external` = imported from an IM adapter. */
  origin: ConversationOrigin;
  targetKind: ConversationTargetKind;
  targetId: string;
  createdAt: string;
  updatedAt: string;
  messageIds: string[];
}

export interface ConversationSummary extends Conversation {
  /** Messages newer than the caller's read cursor. */
  unreadCount: number;
  lastMessage?: {
    id: string;
    text: string;
    senderId: string;
    senderName: string;
    kind: MessageKind;
    createdAt: string;
  };
}

export type ConversationOrigin = 'native' | 'external';
export type ConversationTargetKind = 'agent' | 'member' | 'group';

/** Native client login session. Only the token hash is persisted. */
export interface SessionRecord {
  id: string;
  memberId: string;
  organizationId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
}

/** Session metadata safe to show to its owner (never the token or its hash). */
export interface SessionView {
  id: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  current: boolean;
}

/** Directory entry used by the native client contact list. */
export interface MemberView {
  /** True while the member has at least one authenticated event stream open. */
  online?: boolean;
  id: string;
  displayName: string;
  organizationId: string;
  roles: string[];
  kind: 'member' | 'agent';
  /** Present for `agent` entries. */
  accountId?: string;
  accountStatus?: AccountStatus;
}

export type NativeEvent =
  | { type: 'message'; conversationId: string; message: ChatMessage; at: string }
  | {
      type: 'message_recalled';
      conversationId: string;
      messageId: string;
      recalledAt: string;
      at: string;
    }
  | {
      type: 'task';
      taskId: string;
      conversationId?: string;
      state: TaskState;
      message: string;
      at: string;
    }
  | {
      type: 'conversation_updated';
      conversationId: string;
      title: string;
      at: string;
    }
  | {
      type: 'approval';
      approvalId: string;
      taskId?: string;
      status: ApprovalStatus;
      at: string;
    };

export interface TaskArtifact {
  id: string;
  kind: 'file' | 'text' | 'link';
  name: string;
  mimeType?: string;
  url?: string;
  localPath?: string;
  summary?: string;
  organizationId?: string;
  ownerId?: string;
  taskId?: string;
  runId?: string;
}

export interface TaskRecord {
  id: string;
  accountId: string;
  conversationId?: string;
  organizationId: string;
  requesterId: string;
  goal: string;
  state: TaskState;
  input?: Record<string, unknown>;
  result?: string;
  artifacts: TaskArtifact[];
  outcome?: RunOutcomeSummary;
  runId?: string;
  error?: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

export type TaskEventType =
  | 'queued'
  | 'started'
  | 'progress'
  | 'waiting_input'
  | 'waiting_approval'
  | 'incomplete'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TaskEvent {
  taskId: string;
  type: TaskEventType;
  message: string;
  at: string;
  data?: Record<string, unknown>;
}

export type AgentEvent =
  | { type: 'turn_start'; runId: string; goal: string; at: string }
  | { type: 'thinking'; runId: string; text: string; at: string }
  | { type: 'tool_call_start'; runId: string; tool: string; args: Record<string, unknown>; at: string }
  | { type: 'tool_call_result'; runId: string; tool: string; ok: boolean; summary: string; at: string }
  | { type: 'assistant_message'; runId: string; text: string; at: string }
  | { type: 'turn_end'; runId: string; result: string; at: string }
  | { type: 'turn_error'; runId: string; error: string; at: string };

export interface DocumentSummary {
  fileId: string;
  fileName: string;
  kind: 'word' | 'excel' | 'csv' | 'text' | 'unknown';
  textPreview: string;
  sheets?: {
    name: string;
    rows: number;
    columns: number;
    preview: Record<string, unknown>[];
  }[];
  paragraphs?: string[];
  tables?: string[][][];
}

export interface LocalTaskReceipt {
  deviceId: string;
  agentId: string;
  taskId: string;
  goal: string;
  kind: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  executor: 'hermes' | 'fake';
  error?: string;
  summary?: string;
  artifacts: { name: string; sha256: string; bytes?: number }[];
  createdAt: string;
  updatedAt: string;
}
