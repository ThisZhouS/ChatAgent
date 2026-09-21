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

/** Shape of `ChatMessage.metadata.forwardedFrom` for a forwarded message. */
export interface ForwardedFrom {
  messageId: string;
  conversationId: string;
  senderName: string;
  /** When the original was sent. Forwarding must not reset the clock on it. */
  createdAt?: string;
}

/**
 * How much an assistant may do with a message from a given person. `owner` is derived
 * from the account's ownership and cannot be assigned; the rest are set by a human.
 */
export type AgentContactTier = 'confirm' | 'chat' | 'ignore';

/** Tiers a human may assign (documented separately from the derived owner tier). */
export const ASSIGNABLE_AGENT_CONTACT_TIERS: readonly AgentContactTier[] = [
  'confirm',
  'chat',
  'ignore',
];

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
  /** Per-contact tier, keyed by member id. Absent means the default applies. */
  contactTiers?: Record<string, AgentContactTier>;
  /** Tier for contacts without an explicit entry (default `confirm`). */
  defaultTier?: AgentContactTier;
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
  /** Group governance: the creator may rename, announce, kick and dissolve. */
  ownerId?: string;
  /** Members the owner granted admin rights; the owner always counts as one. */
  adminIds?: string[];
  /** Pinned announcement every participant sees; owner/admin only. */
  announcement?: string;
  announcementAt?: string;
  /**
   * Set when a group was dissolved. The history stays readable (it is the record of
   * what was said) but nothing new may be sent into it.
   */
  dissolvedAt?: string;
  createdAt: string;
  updatedAt: string;
  messageIds: string[];
}

export interface ConversationSummary extends Conversation {
  /** Messages newer than the caller's read cursor. */
  unreadCount: number;
  /**
   * The caller muted this conversation: it still counts unread messages, but it does not
   * raise a notification. A message that mentions the caller still does (see the client),
   * because being addressed is not "background noise".
   */
  muted?: boolean;
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
/** A friend request between two members of the same organization. */
export type FriendRequestStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';

export interface FriendRequestRecord {
  id: string;
  organizationId: string;
  fromId: string;
  toId: string;
  status: FriendRequestStatus;
  /** Optional greeting shown to the addressee; the addressee may decline silently. */
  note?: string;
  createdAt: string;
  decidedAt?: string;
}

/**
 * One row per (owner, peer) pair: the owner's own view of a contact. `remark` and
 * `blocked` belong to the owner alone - the peer never sees them, and a remark is never
 * used to address the peer.
 */
export interface ContactRelation {
  ownerId: string;
  peerId: string;
  friend: boolean;
  remark?: string;
  blocked?: boolean;
  updatedAt: string;
}

/** How a contact appears to the caller: their own address book, not the directory. */
export type ContactState = 'none' | 'request_out' | 'request_in' | 'friend' | 'blocked';

export interface ContactRelationView {
  state: ContactState;
  remark?: string;
  /** Pending request id, so the client can accept or decline it directly. */
  requestId?: string;
}

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
  /** The caller's own relation to this contact (absent for AI accounts). */
  relation?: ContactRelationView;
}

/**
 * What happened to a message on its way to an agent. The host hands a message over
 * only after the recall window has elapsed, so `pending` means "not yet read by the
 * agent" and `cancelled` means it never will be (the sender withdrew it).
 */
export interface AgentIntakeNotice {
  id: string;
  state: 'pending' | 'submitted' | 'cancelled';
  mode: 'deferred' | 'immediate';
  /** When the agent may read it (pending only). */
  dueAt?: string;
  taskId?: string;
  reason?: string;
}

export type NativeEvent =
  | { type: 'message'; conversationId: string; message: ChatMessage; at: string }
  | {
      type: 'agent_intake';
      conversationId: string;
      intakeId: string;
      messageId: string;
      state: AgentIntakeNotice['state'];
      dueAt?: string;
      taskId?: string;
      reason?: string;
      at: string;
    }
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
      type: 'conversation_announcement';
      conversationId: string;
      announcement: string;
      at: string;
    }
  | { type: 'conversation_dissolved'; conversationId: string; at: string }
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
  /**
   * Owner the device claims this work belongs to. The server rejects a receipt
   * whose owner is not the authenticated member; absent for local-only work.
   */
  ownerId?: string;
}
