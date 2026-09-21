import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  AgentAccount,
  ChatMessage,
  ChatType,
  Conversation,
  ConversationOrigin,
  ConversationTargetKind,
  CreateAccountInput,
  SessionRecord,
  UpdateAccountInput,
  LocalTaskReceipt,
} from '@chatagent/contracts';
import { DEFAULT_ORGANIZATION_ID, LEGACY_OWNER_ID } from '@chatagent/contracts';

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return fallback;
  }
}

async function writeJson<T>(filePath: string, value: T): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

/**
 * Coalescing writer for hot paths (messages, conversations, read cursors).
 * Writing the whole file on every message is O(n^2); this batches bursts and
 * still guarantees a flush on graceful shutdown.
 */
export interface StorageHealth {
  dirty: boolean;
  lastError?: string;
}

export class JsonFileWriter<T> {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private latest: T | undefined;
  private lastError: string | undefined;
  private chain: Promise<void> = Promise.resolve();

  get health(): StorageHealth {
    return {
      dirty: this.latest !== undefined || this.timer !== undefined,
      lastError: this.lastError,
    };
  }

  constructor(
    private readonly filePath: string,
    private readonly delayMs = 150,
    private readonly onError?: (error: unknown) => void,
  ) {}

  schedule(value: T): void {
    this.latest = value;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.delayMs);
    // Do not keep the process alive just for a pending flush.
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const value = this.latest;
    if (value === undefined) return this.chain;
    this.latest = undefined;
    this.chain = this.chain.then(async () => {
      try {
        await writeJson(this.filePath, value);
        this.lastError = undefined;
      } catch (error) {
        // Keep the batch so the next schedule retries, and surface the failure
        // instead of silently dropping messages.
        this.latest = value;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.onError?.(error);
      }
    });
    await this.chain;
  }
}

/**
 * File names come from untrusted uploads and model output; keep them to a
 * single safe path segment so they can never escape the data directory.
 */
export function sanitizeFileName(name: string): string {
  const backslash = String.fromCharCode(92);
  const base = name.split('/').pop()?.split(backslash).pop() ?? 'file';
  const cleaned = base
    .split('')
    .map((char) => (char.charCodeAt(0) < 32 || '<>:"|?*'.includes(char) ? '_' : char))
    .join('')
    .replace(/\.+$/, '')
    .trim();
  const safe = cleaned === '' || cleaned === '.' || cleaned === '..' ? 'file' : cleaned;
  return safe.slice(0, 120);
}

export interface OwnershipScope {
  organizationId: string;
  ownerId: string;
}

export interface StoreDefaults {
  organizationId: string;
  legacyOwnerId: string;
}

export const DEFAULT_STORE_DEFAULTS: StoreDefaults = {
  organizationId: DEFAULT_ORGANIZATION_ID,
  legacyOwnerId: LEGACY_OWNER_ID,
};

function cloneAccount(account: AgentAccount): AgentAccount {
  return { ...account, allowlist: [...account.allowlist] };
}

export class AccountStore {
  private readonly accounts = new Map<string, AgentAccount>();
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly defaults: StoreDefaults = DEFAULT_STORE_DEFAULTS,
  ) {}

  async list(): Promise<AgentAccount[]> {
    await this.load();
    return [...this.accounts.values()].map(cloneAccount);
  }

  async get(id: string): Promise<AgentAccount | undefined> {
    await this.load();
    const account = this.accounts.get(id);
    return account ? cloneAccount(account) : undefined;
  }

  async findByChannel(channel: string): Promise<AgentAccount | undefined> {
    await this.load();
    for (const account of this.accounts.values()) {
      if (account.channel === channel) return cloneAccount(account);
    }
    return undefined;
  }

  async create(input: CreateAccountInput, scope: OwnershipScope): Promise<AgentAccount> {
    await this.load();
    const now = new Date().toISOString();
    const account: AgentAccount = {
      id: crypto.randomUUID(),
      name: input.name,
      displayName: input.displayName,
      channel: input.channel,
      channelUserId: input.channelUserId,
      status: 'online',
      persona: input.persona,
      allowlist: input.allowlist,
      organizationId: scope.organizationId,
      ownerId: scope.ownerId,
      createdAt: now,
      updatedAt: now,
    };
    this.accounts.set(account.id, account);
    await this.persist();
    return cloneAccount(account);
  }

  async update(id: string, patch: UpdateAccountInput): Promise<AgentAccount | undefined> {
    await this.load();
    const existing = this.accounts.get(id);
    if (!existing) return undefined;
    const updated: AgentAccount = {
      ...existing,
      ...patch,
      allowlist: patch.allowlist ?? existing.allowlist,
      updatedAt: new Date().toISOString(),
    };
    this.accounts.set(id, updated);
    await this.persist();
    return cloneAccount(updated);
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const list = await readJson<AgentAccount[]>(this.filePath, []);
    for (const account of list) {
      this.accounts.set(account.id, migrateAccount(account, this.defaults));
    }
  }

  private async persist(): Promise<void> {
    await writeJson(this.filePath, [...this.accounts.values()]);
  }
}

/** Legacy JSON written before Gate 1/2 has no organization/owner fields. */
function migrateAccount(account: AgentAccount, defaults: StoreDefaults): AgentAccount {
  return {
    ...account,
    allowlist: account.allowlist ?? [],
    organizationId: account.organizationId ?? defaults.organizationId,
    ownerId: account.ownerId ?? defaults.legacyOwnerId,
  };
}

function cloneConversation(conversation: Conversation): Conversation {
  return {
    ...conversation,
    messageIds: [...conversation.messageIds],
    participantIds: [...conversation.participantIds],
  };
}

export interface FindOrCreateConversationInput {
  accountId?: string;
  chatType: 'direct' | 'group';
  chatId: string;
  organizationId: string;
  participantId: string;
  origin?: ConversationOrigin;
  targetKind?: ConversationTargetKind;
  targetId?: string;
  title?: string;
}

export class ConversationStore {
  private readonly conversations = new Map<string, Conversation>();
  private readonly writer: JsonFileWriter<Conversation[]>;
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly defaults: StoreDefaults = DEFAULT_STORE_DEFAULTS,
    writerDelayMs = 150,
    onWriteError?: (error: unknown) => void,
  ) {
    this.writer = new JsonFileWriter<Conversation[]>(filePath, writerDelayMs, onWriteError);
  }

  /** Persists any pending change immediately (shutdown/tests). */
  async flush(): Promise<void> {
    await this.writer.flush();
  }

  /** Coalesced write state, surfaced by /health. */
  get health(): StorageHealth {
    return this.writer.health;
  }

  async list(accountId?: string): Promise<Conversation[]> {
    await this.load();
    return [...this.conversations.values()]
      .filter((conversation) => !accountId || conversation.accountId === accountId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(cloneConversation);
  }

  async get(id: string): Promise<Conversation | undefined> {
    await this.load();
    const conversation = this.conversations.get(id);
    return conversation ? cloneConversation(conversation) : undefined;
  }

  /** Finds an existing direct conversation with the given peer. */
  async findByTarget(
    organizationId: string,
    targetKind: ConversationTargetKind,
    targetId: string,
  ): Promise<Conversation | undefined> {
    await this.load();
    for (const conversation of this.conversations.values()) {
      if (
        conversation.organizationId === organizationId &&
        conversation.chatType === 'direct' &&
        conversation.targetKind === targetKind &&
        conversation.targetId === targetId
      ) {
        return cloneConversation(conversation);
      }
    }
    return undefined;
  }

  async findOrCreate(input: FindOrCreateConversationInput): Promise<Conversation> {
    await this.load();
    for (const conversation of this.conversations.values()) {
      if (
        conversation.chatType === input.chatType &&
        conversation.chatId === input.chatId &&
        conversation.accountId === input.accountId
      ) {
        // Never join an existing conversation implicitly: a caller-supplied
        // chatId must not grant read access to somebody else's history.
        // Legitimate joins go through addParticipant() after an authorization
        // check in the service layer.
        return cloneConversation(conversation);
      }
    }
    const now = new Date().toISOString();
    const targetId = input.targetId ?? input.accountId ?? input.chatId;
    const conversation: Conversation = {
      id: crypto.randomUUID(),
      accountId: input.accountId,
      chatType: input.chatType,
      chatId: input.chatId,
      title: input.title ?? `${input.chatType === 'group' ? '群聊' : '会话'} · ${targetId.slice(0, 12)}`,
      organizationId: input.organizationId,
      participantIds: [input.participantId],
      origin: input.origin ?? 'external',
      targetKind: input.targetKind ?? 'agent',
      targetId,
      createdAt: now,
      updatedAt: now,
      messageIds: [],
    };
    this.conversations.set(conversation.id, conversation);
    await this.persist();
    return cloneConversation(conversation);
  }

  /** Adds a participant (used when the native client joins a conversation). */
  async addParticipant(conversationId: string, participantId: string): Promise<void> {
    await this.load();
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.participantIds.includes(participantId)) return;
    conversation.participantIds.push(participantId);
    conversation.updatedAt = new Date().toISOString();
    await this.persist();
  }

  /** Finds a conversation by its deterministic key. */
  async findByChatId(chatType: ChatType, chatId: string): Promise<Conversation | undefined> {
    await this.load();
    for (const conversation of this.conversations.values()) {
      if (conversation.chatType === chatType && conversation.chatId === chatId) {
        return cloneConversation(conversation);
      }
    }
    return undefined;
  }

  /** Renames a conversation (group title). */
  async rename(conversationId: string, title: string): Promise<void> {
    await this.load();
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    conversation.title = title;
    conversation.updatedAt = new Date().toISOString();
    await this.persist();
  }

  /** Removes a participant (leaving a group). */
  async removeParticipant(conversationId: string, participantId: string): Promise<void> {
    await this.load();
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    const index = conversation.participantIds.indexOf(participantId);
    if (index < 0) return;
    conversation.participantIds.splice(index, 1);
    conversation.updatedAt = new Date().toISOString();
    await this.persist();
  }

  async appendMessage(conversationId: string, messageId: string): Promise<void> {
    await this.load();
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    conversation.messageIds.push(messageId);
    conversation.updatedAt = new Date().toISOString();
    await this.persist();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const list = await readJson<Conversation[]>(this.filePath, []);
    for (const conversation of list) {
      this.conversations.set(conversation.id, migrateConversation(conversation, this.defaults));
    }
  }

  private async persist(): Promise<void> {
    this.writer.schedule([...this.conversations.values()]);
  }
}

function migrateConversation(conversation: Conversation, defaults: StoreDefaults): Conversation {
  const accountId = conversation.accountId;
  return {
    ...conversation,
    messageIds: conversation.messageIds ?? [],
    organizationId: conversation.organizationId ?? defaults.organizationId,
    participantIds: conversation.participantIds ?? [defaults.legacyOwnerId],
    origin: conversation.origin ?? 'external',
    targetKind: conversation.targetKind ?? 'agent',
    targetId: conversation.targetId ?? accountId ?? conversation.chatId,
  };
}

export class MessageStore {
  private readonly messages = new Map<string, ChatMessage[]>();
  private readonly writer: JsonFileWriter<Record<string, ChatMessage[]>>;
  private loaded = false;

  constructor(
    private readonly filePath: string,
    writerDelayMs = 150,
    onWriteError?: (error: unknown) => void,
  ) {
    this.writer = new JsonFileWriter<Record<string, ChatMessage[]>>(
      filePath,
      writerDelayMs,
      onWriteError,
    );
  }

  async flush(): Promise<void> {
    await this.writer.flush();
  }

  get health(): StorageHealth {
    return this.writer.health;
  }

  /** Full-text search inside the given conversations (case-insensitive). */
  async search(
    conversationIds: string[],
    query: string,
    limit: number,
  ): Promise<ChatMessage[]> {
    await this.load();
    const needle = query.trim().toLowerCase();
    if (needle === '') return [];

    const hits: ChatMessage[] = [];
    for (const conversationId of conversationIds) {
      const list = this.messages.get(conversationId) ?? [];
      // Newest first, bounded so a huge history cannot stall the request.
      for (let index = list.length - 1; index >= 0 && hits.length < limit; index -= 1) {
        const message = list[index];
        if (!message) continue;
        // A recalled message must disappear from search as well.
        if (message.recalledAt) continue;
        if (message.text.toLowerCase().includes(needle)) hits.push(message);
      }
      if (hits.length >= limit) break;
    }
    return hits;
  }

  async list(conversationId: string): Promise<ChatMessage[]> {
    await this.load();
    return [...(this.messages.get(conversationId) ?? [])];
  }

  /** Finds one message by id (used by recall and outbox reconciliation). */
  async findById(messageId: string): Promise<ChatMessage | undefined> {
    await this.load();
    for (const list of this.messages.values()) {
      const hit = list.find((message) => message.id === messageId);
      if (hit) return { ...hit };
    }
    return undefined;
  }

  /**
   * Marks a message as recalled. The body stays in storage for auditability but
   * every read path strips it, so members and the model can no longer see it.
   */
  async markRecalled(messageId: string, recalledAt: string): Promise<ChatMessage | undefined> {
    await this.load();
    for (const list of this.messages.values()) {
      const index = list.findIndex((message) => message.id === messageId);
      if (index < 0) continue;
      const current = list[index];
      if (!current) return undefined;
      const updated: ChatMessage = { ...current, recalledAt: current.recalledAt ?? recalledAt };
      list[index] = updated;
      await this.persist();
      return { ...updated };
    }
    return undefined;
  }

  async append(message: ChatMessage): Promise<void> {
    await this.load();
    const list = this.messages.get(message.conversationId) ?? [];
    list.push(message);
    this.messages.set(message.conversationId, list);
    await this.persist();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const data = await readJson<Record<string, ChatMessage[]>>(this.filePath, {});
    for (const [conversationId, list] of Object.entries(data)) {
      this.messages.set(conversationId, list);
    }
  }

  private async persist(): Promise<void> {
    this.writer.schedule(Object.fromEntries(this.messages.entries()));
  }
}

export interface StoredFileMeta {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  localPath: string;
  organizationId: string;
  ownerId: string;
  createdAt: string;
}

export interface StoredFile extends StoredFileMeta {
  buffer: Buffer;
}

export class UploadedFileStore {
  private readonly files = new Map<string, StoredFileMeta>();
  private loaded = false;

  constructor(
    private readonly dataDir: string,
    private readonly defaults: StoreDefaults = DEFAULT_STORE_DEFAULTS,
  ) {}

  async save(
    buffer: Buffer,
    name: string,
    mimeType: string,
    scope: OwnershipScope,
  ): Promise<StoredFileMeta> {
    await this.load();
    const id = crypto.randomUUID();
    const localDir = join(this.dataDir, 'uploads');
    await mkdir(localDir, { recursive: true });
    const localPath = join(localDir, `${id}-${sanitizeFileName(name)}`);
    await writeFile(localPath, buffer);
    const meta: StoredFileMeta = {
      id,
      name,
      mimeType,
      sizeBytes: buffer.byteLength,
      localPath,
      organizationId: scope.organizationId,
      ownerId: scope.ownerId,
      createdAt: new Date().toISOString(),
    };
    this.files.set(id, meta);
    await this.persist();
    return meta;
  }

  async get(id: string): Promise<StoredFile | undefined> {
    await this.load();
    const meta = this.files.get(id);
    if (!meta) return undefined;
    return { ...meta, buffer: await readFile(meta.localPath) };
  }

  async getMeta(id: string): Promise<StoredFileMeta | undefined> {
    await this.load();
    const meta = this.files.get(id);
    return meta ? { ...meta } : undefined;
  }

  async resolve(ref: string): Promise<StoredFile | undefined> {
    await this.load();
    const byId = this.files.get(ref);
    if (byId) return this.get(byId.id);
    const lower = ref.toLowerCase();
    for (const meta of this.files.values()) {
      if (meta.name.toLowerCase() === lower) return this.get(meta.id);
    }
    return undefined;
  }

  /**
   * Organization-scoped resolution. Name lookups never cross an organization
   * boundary, so an AI run can only read files of its own tenant.
   */
  async resolveInOrg(
    ref: string,
    organizationId: string,
    access: { ownerId?: string; isAdmin?: boolean } = {},
  ): Promise<StoredFile | undefined> {
    await this.load();
    const allowed = (meta: StoredFileMeta): boolean => {
      if (meta.organizationId !== organizationId) return false;
      if (access.isAdmin) return true;
      return access.ownerId !== undefined && meta.ownerId === access.ownerId;
    };

    const byId = this.files.get(ref);
    if (byId) return allowed(byId) ? this.get(byId.id) : undefined;

    const lower = ref.toLowerCase();
    for (const meta of this.files.values()) {
      if (!allowed(meta)) continue;
      if (meta.name.toLowerCase() === lower) return this.get(meta.id);
    }
    return undefined;
  }

  async list(): Promise<StoredFileMeta[]> {
    await this.load();
    return [...this.files.values()].map((meta) => ({ ...meta }));
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const list = await readJson<StoredFileMeta[]>(join(this.dataDir, 'uploads.json'), []);
    for (const meta of list) this.files.set(meta.id, migrateUpload(meta, this.defaults));
  }

  private async persist(): Promise<void> {
    await writeJson(join(this.dataDir, 'uploads.json'), [...this.files.values()]);
  }
}

function migrateUpload(meta: StoredFileMeta, defaults: StoreDefaults): StoredFileMeta {
  return {
    ...meta,
    organizationId: meta.organizationId ?? defaults.organizationId,
    ownerId: meta.ownerId ?? defaults.legacyOwnerId,
  };
}

export interface ArtifactScope extends OwnershipScope {
  taskId?: string;
  runId?: string;
}

export interface StoredArtifactMeta {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  localPath: string;
  organizationId: string;
  ownerId: string;
  taskId?: string;
  runId?: string;
  createdAt: string;
}

export interface StoredArtifact extends StoredArtifactMeta {
  buffer: Buffer;
}

export class ArtifactStore {
  private readonly artifacts = new Map<string, StoredArtifactMeta>();
  private loaded = false;

  constructor(
    private readonly dataDir: string,
    private readonly defaults: StoreDefaults = DEFAULT_STORE_DEFAULTS,
  ) {}

  async save(
    buffer: Buffer,
    name: string,
    mimeType: string,
    scope: ArtifactScope,
  ): Promise<StoredArtifactMeta> {
    await this.load();
    const id = crypto.randomUUID();
    const localDir = join(this.dataDir, 'artifacts');
    await mkdir(localDir, { recursive: true });
    const localPath = join(localDir, `${id}-${sanitizeFileName(name)}`);
    await writeFile(localPath, buffer);
    const meta: StoredArtifactMeta = {
      id,
      name,
      mimeType,
      sizeBytes: buffer.byteLength,
      url: `/api/files/${id}`,
      localPath,
      organizationId: scope.organizationId,
      ownerId: scope.ownerId,
      taskId: scope.taskId,
      runId: scope.runId,
      createdAt: new Date().toISOString(),
    };
    this.artifacts.set(id, meta);
    await this.persist();
    return meta;
  }

  async get(id: string): Promise<StoredArtifact | undefined> {
    await this.load();
    const meta = this.artifacts.get(id);
    if (!meta) return undefined;
    return { ...meta, buffer: await readFile(meta.localPath) };
  }

  async getMeta(id: string): Promise<StoredArtifactMeta | undefined> {
    await this.load();
    const meta = this.artifacts.get(id);
    return meta ? { ...meta } : undefined;
  }

  async list(): Promise<StoredArtifactMeta[]> {
    await this.load();
    return [...this.artifacts.values()].map((meta) => ({ ...meta }));
  }

  /** Strict ownership lookup; replaces the previous global list-diff claim. */
  async listByTask(taskId: string): Promise<StoredArtifactMeta[]> {
    await this.load();
    return [...this.artifacts.values()]
      .filter((meta) => meta.taskId === taskId)
      .map((meta) => ({ ...meta }));
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const list = await readJson<StoredArtifactMeta[]>(join(this.dataDir, 'artifacts.json'), []);
    for (const meta of list) {
      this.artifacts.set(meta.id, migrateArtifact(meta, this.defaults));
    }
  }

  private async persist(): Promise<void> {
    await writeJson(join(this.dataDir, 'artifacts.json'), [...this.artifacts.values()]);
  }
}

function migrateArtifact(meta: StoredArtifactMeta, defaults: StoreDefaults): StoredArtifactMeta {
  return {
    ...meta,
    organizationId: meta.organizationId ?? defaults.organizationId,
    ownerId: meta.ownerId ?? defaults.legacyOwnerId,
  };
}

export interface DedupeRecord {
  key: string;
  firstSeenAt: string;
}/** Inbound webhook replay protection with a retention window. */
export class WebhookDedupeStore {
  private readonly seen = new Map<string, string>();
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly retentionMs = 7 * 24 * 60 * 60 * 1000,
  ) {}

  async has(key: string): Promise<boolean> {
    await this.load();
    this.prune();
    return this.seen.has(key);
  }

  async remember(key: string): Promise<void> {
    await this.load();
    this.seen.set(key, new Date().toISOString());
    this.prune();
    await this.persist();
  }

  private prune(): void {
    const cutoff = Date.now() - this.retentionMs;
    for (const [key, at] of this.seen.entries()) {
      if (Date.parse(at) < cutoff) this.seen.delete(key);
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const records = await readJson<DedupeRecord[]>(this.filePath, []);
    for (const record of records) this.seen.set(record.key, record.firstSeenAt);
  }

  private async persist(): Promise<void> {
    const records: DedupeRecord[] = [...this.seen.entries()].map(([key, firstSeenAt]) => ({
      key,
      firstSeenAt,
    }));
    await writeJson(this.filePath, records);
  }
}

export interface AgentIntakeRecord {
  id: string;
  conversationId: string;
  /** The message that carried the request; the handoff dies with it. */
  messageId: string;
  accountId: string;
  organizationId: string;
  requesterId: string;
  chatType: 'direct' | 'group';
  goal: string;
  state: 'pending' | 'submitted' | 'cancelled';
  /** When the agent may see the message (recall window elapses first). */
  dueAt: string;
  createdAt: string;
  updatedAt: string;
  taskId?: string;
  cancelReason?: 'recalled' | 'message_missing' | 'conversation_missing';
  /** Delivery attempts of the handoff itself (not of the task). */
  attempts: number;
  lastError?: string;
}

/**
 * Queue of messages that are waiting for the recall window to elapse before they
 * are handed to an agent. Persisted so a restart neither drops a request nor
 * replays one that was already submitted.
 */
export class AgentIntakeStore {
  private readonly records = new Map<string, AgentIntakeRecord>();
  private readonly writer: JsonFileWriter<AgentIntakeRecord[]>;
  private loaded = false;

  constructor(
    private readonly filePath: string,
    onError?: (error: unknown) => void,
    /** Terminal records kept for the operator; pending ones are never pruned. */
    private readonly terminalRetention = 200,
  ) {
    this.writer = new JsonFileWriter<AgentIntakeRecord[]>(filePath, 150, onError);
  }

  get health(): StorageHealth {
    return this.writer.health;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const rows = await readJson<AgentIntakeRecord[]>(this.filePath, []);
    for (const row of rows) {
      if (row && typeof row.id === 'string') this.records.set(row.id, row);
    }
  }

  async get(id: string): Promise<AgentIntakeRecord | undefined> {
    await this.load();
    return this.records.get(id);
  }

  async list(): Promise<AgentIntakeRecord[]> {
    await this.load();
    return [...this.records.values()];
  }

  async save(record: AgentIntakeRecord): Promise<void> {
    await this.load();
    this.records.set(record.id, record);
    this.prune();
    this.writer.schedule([...this.records.values()]);
    await this.writer.flush();
  }

  private prune(): void {
    const terminal = [...this.records.values()]
      .filter((record) => record.state !== 'pending')
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    for (const record of terminal.slice(this.terminalRetention)) this.records.delete(record.id);
  }
}

/**
 * Native client login sessions. The plaintext session token is returned to the
 * caller exactly once; only its sha256 hash is persisted.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly ttlSeconds = 12 * 60 * 60,
    /** Oldest sessions beyond this per-member cap are dropped on login. */
    private readonly maxSessionsPerMember = 20,
  ) {}

  async create(
    memberId: string,
    organizationId: string,
    tokenHash: string,
  ): Promise<SessionRecord> {
    await this.load();
    const now = new Date();
    const record: SessionRecord = {
      id: crypto.randomUUID(),
      memberId,
      organizationId,
      tokenHash,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlSeconds * 1000).toISOString(),
      lastSeenAt: now.toISOString(),
    };
    this.sessions.set(record.id, record);

    // Bound the session table: a client that logs in repeatedly would otherwise
    // accumulate rows forever.
    const mine = [...this.sessions.values()]
      .filter((session) => session.memberId === memberId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const stale of mine.slice(this.maxSessionsPerMember)) {
      this.sessions.delete(stale.id);
    }

    await this.persist();
    return { ...record };
  }

  /** Revokes every session of the member except the one given. */
  async revokeOtherSessions(memberId: string, keepSessionId: string): Promise<number> {
    await this.load();
    let revoked = 0;
    for (const session of [...this.sessions.values()]) {
      if (session.memberId !== memberId || session.id === keepSessionId) continue;
      this.sessions.delete(session.id);
      revoked += 1;
    }
    if (revoked > 0) await this.persist();
    return revoked;
  }

  async findByTokenHash(tokenHash: string): Promise<SessionRecord | undefined> {
    await this.load();
    let changed = false;
    let found: SessionRecord | undefined;
    for (const session of this.sessions.values()) {
      if (Date.parse(session.expiresAt) <= Date.now()) {
        this.sessions.delete(session.id);
        changed = true;
        continue;
      }
      if (session.tokenHash === tokenHash) {
        session.lastSeenAt = new Date().toISOString();
        found = { ...session };
      }
    }
    if (changed) await this.persist();
    return found;
  }

  async revokeByTokenHash(tokenHash: string): Promise<boolean> {
    await this.load();
    for (const session of this.sessions.values()) {
      if (session.tokenHash === tokenHash) {
        this.sessions.delete(session.id);
        await this.persist();
        return true;
      }
    }
    return false;
  }

  /** Sessions of one member, newest first. Token hashes never leave the store. */
  async listSessions(memberId: string): Promise<SessionRecord[]> {
    await this.load();
    const now = Date.now();
    return [...this.sessions.values()]
      .filter((session) => session.memberId === memberId && Date.parse(session.expiresAt) > now)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((session) => ({ ...session }));
  }

  /** Revokes one session; returns false when it does not belong to the member. */
  async revokeSession(memberId: string, sessionId: string): Promise<boolean> {
    await this.load();
    const session = this.sessions.get(sessionId);
    if (!session || session.memberId !== memberId) return false;
    this.sessions.delete(sessionId);
    await this.persist();
    return true;
  }

  async listByMember(memberId: string): Promise<number> {
    await this.load();
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.memberId === memberId && Date.parse(session.expiresAt) > Date.now()) count += 1;
    }
    return count;
  }

  async revokeMember(memberId: string): Promise<void> {
    await this.load();
    let changed = false;
    for (const session of this.sessions.values()) {
      if (session.memberId === memberId) {
        this.sessions.delete(session.id);
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const list = await readJson<SessionRecord[]>(this.filePath, []);
    for (const session of list) this.sessions.set(session.id, session);
  }

  private async persist(): Promise<void> {
    await writeJson(this.filePath, [...this.sessions.values()]);
  }
}

export interface ReadStateRecord {
  memberId: string;
  conversationId: string;
  lastReadAt: string;
}

/** Per-member read cursor, used for unread badges in the native client. */
export class ReadStateStore {
  private readonly states = new Map<string, ReadStateRecord>();
  private readonly writer: JsonFileWriter<ReadStateRecord[]>;
  private loaded = false;

  constructor(
    private readonly filePath: string,
    writerDelayMs = 150,
    onWriteError?: (error: unknown) => void,
  ) {
    this.writer = new JsonFileWriter<ReadStateRecord[]>(filePath, writerDelayMs, onWriteError);
  }

  async flush(): Promise<void> {
    await this.writer.flush();
  }

  get health(): StorageHealth {
    return this.writer.health;
  }

  async lastReadAt(memberId: string, conversationId: string): Promise<string | undefined> {
    await this.load();
    return this.states.get(`${memberId}:${conversationId}`)?.lastReadAt;
  }

  /** Read cursors of everybody who has opened the conversation. */
  async listForConversation(conversationId: string): Promise<ReadStateRecord[]> {
    await this.load();
    return [...this.states.values()]
      .filter((record) => record.conversationId === conversationId)
      .map((record) => ({ ...record }));
  }

  async markRead(memberId: string, conversationId: string): Promise<ReadStateRecord> {
    await this.load();
    const record: ReadStateRecord = {
      memberId,
      conversationId,
      lastReadAt: new Date().toISOString(),
    };
    this.states.set(`${memberId}:${conversationId}`, record);
    await this.persist();
    return { ...record };
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const list = await readJson<ReadStateRecord[]>(this.filePath, []);
    for (const record of list) {
      this.states.set(`${record.memberId}:${record.conversationId}`, record);
    }
  }

  private async persist(): Promise<void> {
    this.writer.schedule([...this.states.values()]);
  }
}

/**
 * Server-side mirror of tasks executed by on-device agent hosts. The device is
 * authoritative: receipts arrive through authenticated member sessions and are
 * scoped to the uploading member, so one member can never see another device's
 * work. In-memory by design — a restarted server simply waits for the next
 * device sync instead of becoming a second source of truth.
 */
export interface LocalTaskReceiptRecord extends LocalTaskReceipt {
  memberId: string;
  syncedAt: string;
}

export interface ReceiptUpsertResult {
  /** Receipts that were stored (a re-send of the newest version counts again). */
  accepted: number;
  /** Receipts ignored because the store already had a newer version. */
  stale: number;
}

export class LocalTaskReceiptStore {
  private readonly receipts = new Map<string, LocalTaskReceiptRecord>();

  constructor(private readonly maxPerMember = 500) {}

  /**
   * Stores receipts, newest version wins.
   *
   * A device that was offline queues receipts and may deliver them out of order
   * (or retry a batch it already sent). Without a monotonic guard an older
   * receipt could overwrite a newer outcome — e.g. a queued "running" copy
   * landing after the "succeeded" one and making the workbench show a task that
   * never finished. Receipts carrying an older `updatedAt` for the same
   * (device, taskId) are therefore ignored and counted, never applied.
   */
  async upsert(receipts: LocalTaskReceipt[], memberId: string): Promise<ReceiptUpsertResult> {
    const syncedAt = new Date().toISOString();
    let accepted = 0;
    let stale = 0;
    for (const receipt of receipts) {
      const key = this.key(memberId, receipt.deviceId, receipt.taskId);
      const existing = this.receipts.get(key);
      if (existing && Date.parse(existing.updatedAt) > Date.parse(receipt.updatedAt)) {
        stale += 1;
        continue;
      }
      this.receipts.set(key, { ...receipt, memberId, syncedAt });
      accepted += 1;
    }
    this.prune(memberId);
    return { accepted, stale };
  }

  async list(memberId: string, limit = 200): Promise<LocalTaskReceipt[]> {
    // Internal scoping fields (memberId/syncedAt) never leave the server.
    return [...this.receipts.values()]
      .filter((record) => record.memberId === memberId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, limit)
      .map(({ memberId: _m, syncedAt: _s, ...receipt }) => receipt);
  }

  count(): number {
    return this.receipts.size;
  }

  private key(memberId: string, deviceId: string, taskId: string): string {
    return [memberId, deviceId, taskId].join('|');
  }

  /** Keeps each member's mirror bounded; oldest syncs are dropped first. */
  private prune(memberId: string): void {
    const own = [...this.receipts.entries()].filter(([, r]) => r.memberId === memberId);
    if (own.length <= this.maxPerMember) return;
    own.sort((a, b) => Date.parse(a[1].syncedAt) - Date.parse(b[1].syncedAt));
    for (const [key] of own.slice(0, own.length - this.maxPerMember)) this.receipts.delete(key);
  }
}
