import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentAccount,
  ApprovalRecord,
  ChatMessage,
  Conversation,
  ConversationSummary,
  ConversationTargetKind,
  CreateTaskInput,
  GenerateExcelInput,
  GenerateWordInput,
  InboundMessageInput,
  MemberView,
  NativeEvent,
  OutboxRecord,
  Principal,
  SessionView,
  TaskEvent,
  TaskRecord,
} from '@chatagent/contracts';
import type { ImGateway, NormalizedInbound, WebhookVerificationResult } from '@chatagent/im-gateway';
import type { AuditEvent } from './audit';
import type { HermesAgentRuntime, ModelMessage, RunResult, ToolCallRecord } from '@chatagent/hermes';
import { JsonFileTaskStore, TaskEngine } from '@chatagent/task-engine';
import type { TaskContext, TaskHandlerResult } from '@chatagent/task-engine';
import {
  canCancelTask,
  canManageAccount,
  canUseAccount,
  canReadAccount,
  canReadArtifact,
  canReadConversation,
  canReadTask,
  canReadUpload,
  isAuthenticated,
  isOrgAdmin,
  sameOrganization,
} from './auth';
import type { MemberDirectory } from './auth';
import { hashToken } from './auth';
import type { NativeEventHub } from './events';
import { canDecideApproval as canDecideApprovalRecord } from './approvals';
import type { ApprovalStore, OutboxStore } from './approvals';
import type { ServerConfig } from './config';
import type {
  ArtifactStore,
  AccountStore,
  ConversationStore,
  MessageStore,
  StoredArtifactMeta,
  StoredFileMeta,
  UploadedFileStore,
  ReadStateStore,
  SessionStore,
  WebhookDedupeStore,
} from './stores';

export interface InjectMessageResult {
  authorized: boolean;
  conversationId: string;
  taskId?: string;
  reason?: string;
  deduplicated?: boolean;
  /** Present when the inbound message was persisted. */
  message?: ChatMessage;
}

export interface WebhookHandleResult {
  ok: boolean;
  verificationMode: WebhookVerificationResult['mode'];
  results: InjectMessageResult[];
}

export interface BaseFileView {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  url?: string;
  taskId?: string;
}

export interface AuthorizedFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

/** Typed service failure mapped to an HTTP status by the route error handler. */
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

interface GatewayItemContext {
  gateway: ImGateway;
  item: NormalizedInbound;
}

export class ChatAgentService {
  readonly taskEngine: TaskEngine;

  constructor(
    private readonly config: ServerConfig,
    private readonly accounts: AccountStore,
    private readonly conversations: ConversationStore,
    private readonly messages: MessageStore,
    private readonly uploads: UploadedFileStore,
    private readonly artifacts: ArtifactStore,
    private readonly gateways: ImGateway[],
    private readonly runtime: HermesAgentRuntime,
    private readonly dedupe: WebhookDedupeStore,
    private readonly approvals: ApprovalStore,
    private readonly outbox: OutboxStore,
    private readonly directory: MemberDirectory,
    private readonly sessions: SessionStore,
    private readonly events: NativeEventHub,
    private readonly readState: ReadStateStore,
    /**
     * Optional audit sink. AI-originated messages are recorded here without
     * their body text, so "what did the assistant send to whom" is traceable
     * without storing content.
     */
    private readonly audit?: (event: AuditEvent) => void,
  ) {
    const store = new JsonFileTaskStore(join(config.dataDir, 'tasks.json'), {
      legacyOrganizationId: config.auth.defaultOrganizationId,
      legacyRequesterId: config.auth.legacyOwnerId,
    });
    this.taskEngine = new TaskEngine({
      store,
      handler: (task, context) => this.runTask(task, context),
      maxConcurrency: 2,
      retryDelayMs: 500,
    });
    this.taskEngine.onEvent((event) => {
      void this.publishTaskEvent(event);
    });
  }

  // Native client: session, contacts and chat ------------------------------

  /**
   * Exchanges a member API token for a native client session token. The
   * plaintext session token is returned exactly once.
   */
  async login(
    memberId: string,
    token: string,
  ): Promise<{ token: string; expiresAt: string; member: MemberView }> {
    const member = await this.directory.get(memberId);
    if (!member || !member.tokenHash) {
      throw new ServiceError(401, 'invalid credentials');
    }
    const candidate = await this.directory.findByTokenHash(hashToken(token));
    if (!candidate || candidate.id !== member.id) {
      throw new ServiceError(401, 'invalid credentials');
    }

    const sessionToken = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
    const session = await this.sessions.create(
      member.id,
      member.organizationId,
      hashToken(sessionToken),
    );
    return { token: sessionToken, expiresAt: session.expiresAt, member: toMemberView(member) };
  }

  /**
   * Self-service token rotation: the member gets a new API token once and all
   * of their sessions are revoked, so a leaked token can be retired without an
   * administrator.
   */
  async rotateOwnToken(principal: Principal): Promise<{ token: string }> {
    this.requireMember(principal);
    const member = await this.directory.get(principal.id);
    if (!member) throw new ServiceError(401, 'authentication required');

    const token = generateToken();
    await this.directory.upsert({
      id: member.id,
      organizationId: member.organizationId,
      displayName: member.displayName,
      roles: member.roles,
      agentIds: member.agentIds,
      tokenHash: hashToken(token),
    });
    await this.sessions.revokeMember(member.id);
    return { token };
  }

  async logout(token: string | undefined): Promise<{ ok: boolean }> {
    if (!token) return { ok: false };
    return { ok: await this.sessions.revokeByTokenHash(hashToken(token)) };
  }

  /** Revokes every session of the caller. */
  /**
   * Sessions of the caller. `currentSessionId` marks the session that made the
   * request so the user does not revoke the device they are holding.
   */
  async listSessions(
    principal: Principal,
    currentSessionId?: string,
  ): Promise<SessionView[]> {
    this.requireMember(principal);
    const sessions = await this.sessions.listSessions(principal.id);
    return sessions.map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      lastSeenAt: session.lastSeenAt,
      current: session.id === currentSessionId,
    }));
  }

  /** Revokes one of the caller's own sessions (a lost or shared device). */
  async revokeOwnSession(principal: Principal, sessionId: string): Promise<{ ok: boolean }> {
    this.requireMember(principal);
    const revoked = await this.sessions.revokeSession(principal.id, sessionId);
    if (!revoked) throw new ServiceError(404, 'session not found');
    return { ok: true };
  }

  /** Signs out every other device of the caller (keeps the current session). */
  async revokeOtherSessions(
    principal: Principal,
    currentSessionId: string | undefined,
  ): Promise<{ revoked: number }> {
    this.requireMember(principal);
    const revoked = await this.sessions.revokeOtherSessions(principal.id, currentSessionId ?? '');
    return { revoked };
  }

  async revokeSessions(principal: Principal): Promise<number> {
    this.requireMember(principal);
    const before = await this.sessions.listByMember(principal.id);
    await this.sessions.revokeMember(principal.id);
    return before;
  }

  async me(principal: Principal): Promise<MemberView> {
    this.requireMember(principal);
    const member = await this.directory.get(principal.id);
    if (!member) throw new ServiceError(401, 'authentication required');
    return { ...toMemberView(member), online: this.events.onlinePrincipals().includes(member.id) };
  }

  // Members (administration) ------------------------------------------------

  /** Colleagues of the caller's organization. Tokens are never exposed. */
  async listMembers(principal: Principal): Promise<MemberView[]> {
    this.requireMember(principal);
    const online = new Set(this.events.onlinePrincipals());
    const members = await this.directory.list();
    return members
      .filter((member) => member.organizationId === principal.organizationId)
      .map((member) => ({ ...toMemberView(member), online: online.has(member.id) }));
  }

  /**
   * Creates a member. The token is returned exactly once; only its sha256 hash
   * is persisted, so a lost token has to be rotated rather than recovered.
   */
  async createMember(
    principal: Principal,
    input: { id: string; displayName: string; roles: string[]; token?: string },
  ): Promise<{ member: MemberView; token: string }> {
    this.requireOrgAdmin(principal);
    const existing = await this.directory.get(input.id);
    if (existing && existing.organizationId !== principal.organizationId) {
      throw new ServiceError(404, 'member not found');
    }
    // Only an owner may mint another owner; an admin must not be able to
    // escalate (or overwrite an owner's token).
    if (input.roles.includes('owner') && !principal.roles.includes('owner')) {
      throw new ServiceError(403, 'forbidden', 'owner_required');
    }
    if (existing?.roles.includes('owner') && !principal.roles.includes('owner')) {
      throw new ServiceError(403, 'forbidden', 'owner_required');
    }

    const token = input.token && input.token.length >= 8 ? input.token : generateToken();
    const member = await this.directory.upsert({
      id: input.id,
      organizationId: principal.organizationId,
      displayName: input.displayName,
      roles: input.roles.length > 0 ? input.roles : ['member'],
      tokenHash: hashToken(token),
    });
    return { member: toMemberView(member), token };
  }

  async updateMember(
    principal: Principal,
    id: string,
    patch: { displayName?: string; roles?: string[]; agentIds?: string[] },
  ): Promise<MemberView> {
    this.requireOrgAdmin(principal);
    const member = await this.requireMemberInOrg(principal, id);

    const touchesOwnerRole =
      member.roles.includes('owner') || (patch.roles?.includes('owner') ?? false);
    if (touchesOwnerRole && !principal.roles.includes('owner')) {
      throw new ServiceError(403, 'forbidden', 'owner_required');
    }
    if (principal.id === member.id && patch.roles && !principal.roles.includes('owner')) {
      throw new ServiceError(403, 'forbidden', 'cannot_change_own_roles');
    }

    const updated = await this.directory.upsert({
      id: member.id,
      organizationId: member.organizationId,
      displayName: patch.displayName ?? member.displayName,
      roles: patch.roles ?? member.roles,
      agentIds: patch.agentIds ?? member.agentIds,
    });
    return toMemberView(updated);
  }

  /** Issues a new API token and invalidates every session of that member. */
  async rotateMemberToken(
    principal: Principal,
    id: string,
  ): Promise<{ member: MemberView; token: string }> {
    this.requireOrgAdmin(principal);
    const member = await this.requireMemberInOrg(principal, id);
    if (member.roles.includes('owner') && !principal.roles.includes('owner')) {
      throw new ServiceError(403, 'forbidden', 'owner_required');
    }
    const token = generateToken();
    const updated = await this.directory.upsert({
      id: member.id,
      organizationId: member.organizationId,
      displayName: member.displayName,
      roles: member.roles,
      agentIds: member.agentIds,
      tokenHash: hashToken(token),
    });
    await this.sessions.revokeMember(member.id);
    return { member: toMemberView(updated), token };
  }

  private requireOrgAdmin(principal: Principal): void {
    this.requireMember(principal);
    if (!isOrgAdmin(principal)) {
      throw new ServiceError(403, 'forbidden', 'org_admin_required');
    }
  }

  private async requireMemberInOrg(principal: Principal, id: string) {
    const member = await this.directory.get(id);
    if (!member || member.organizationId !== principal.organizationId) {
      throw new ServiceError(404, 'member not found');
    }
    return member;
  }

  /** Contact list for the native client: colleagues plus AI accounts. */
  async listContacts(principal: Principal): Promise<MemberView[]> {
    this.requireMember(principal);
    const members = await this.directory.list();
    const accounts = await this.accounts.list();

    const online = new Set(this.events.onlinePrincipals());
    const contacts: MemberView[] = members
      .filter((member) => member.organizationId === principal.organizationId)
      .map((member) => ({ ...toMemberView(member), online: online.has(member.id) }));

    for (const account of accounts) {
      if (!canReadAccount(principal, account)) continue;
      contacts.push({
        id: account.id,
        displayName: account.displayName,
        organizationId: account.organizationId,
        roles: [],
        kind: 'agent',
        accountId: account.id,
        accountStatus: account.status,
      });
    }
    return contacts;
  }

  /** Opens (or returns) the native direct conversation with a peer. */
  async openConversation(
    principal: Principal,
    targetId: string,
    targetKind: ConversationTargetKind,
  ): Promise<Conversation> {
    this.requireMember(principal);

    if (targetKind === 'agent') {
      const account = await this.accounts.get(targetId);
      if (!account || !canReadAccount(principal, account)) {
        throw new ServiceError(404, 'target not found');
      }
      if (!canUseAccount(principal, account)) {
        throw new ServiceError(403, 'forbidden', 'account_not_granted');
      }
      const conversation = await this.conversations.findOrCreate({
        accountId: account.id,
        chatType: 'direct',
        chatId: `native:agent:${account.id}:${principal.id}`,
        organizationId: principal.organizationId,
        participantId: principal.id,
        origin: 'native',
        targetKind: 'agent',
        targetId: account.id,
        title: account.displayName,
      });
      await this.conversations.addParticipant(conversation.id, account.id);
      return (await this.conversations.get(conversation.id)) ?? conversation;
    }

    const member = await this.directory.get(targetId);
    if (!member || member.organizationId !== principal.organizationId) {
      throw new ServiceError(404, 'target not found');
    }
    const pair = [principal.id, member.id].sort().join(':');
    const conversation = await this.conversations.findOrCreate({
      chatType: 'direct',
      chatId: `native:member:${pair}`,
      organizationId: principal.organizationId,
      participantId: principal.id,
      origin: 'native',
      targetKind: 'member',
      targetId: member.id,
      title: member.displayName,
    });
    await this.conversations.addParticipant(conversation.id, member.id);
    return (await this.conversations.get(conversation.id)) ?? conversation;
  }

  /**
   * Creates a native group conversation with the given colleagues. The caller
   * is always a participant; every id must belong to the same organization.
   */
  async createGroup(
    principal: Principal,
    input: { title: string; memberIds: string[] },
  ): Promise<Conversation> {
    this.requireMember(principal);
    const participantIds = new Set<string>([principal.id]);

    for (const memberId of input.memberIds) {
      const member = await this.directory.get(memberId);
      if (member && member.organizationId === principal.organizationId) {
        participantIds.add(member.id);
        continue;
      }
      // AI accounts can join a group so they can be summoned with @.
      const account = await this.accounts.get(memberId);
      if (account && canUseAccount(principal, account)) {
        participantIds.add(account.id);
        continue;
      }
      throw new ServiceError(404, `member not found: ${memberId}`);
    }
    if (participantIds.size < 2) {
      throw new ServiceError(400, 'a group needs at least one other member');
    }

    const chatId = `native:group:${createHash('sha256')
      .update(`${principal.organizationId}:${[...participantIds].sort().join(',')}:${input.title}`)
      .digest('hex')
      .slice(0, 24)}`;

    // The group key is derived from title + member list, so re-creating an
    // identical group addresses the existing conversation. Two rules keep that
    // from becoming a membership bypass:
    //  - a caller who is not a participant cannot address it at all (a member
    //    who left must be re-invited by somebody who is still in the group);
    //  - re-creation only ever ADDS the requested members, never removes the
    //    ones that were invited in the meantime.
    const existing = await this.conversations.findByChatId('group', chatId);
    if (
      existing &&
      existing.participantIds.length > 0 &&
      !existing.participantIds.includes(principal.id)
    ) {
      // An empty participant list means everybody left: the group is inert and
      // may be reclaimed, otherwise it would be unaddressable forever.
      throw new ServiceError(
        409,
        'this group already exists and you are not a participant; ask a member to invite you',
        `group_membership_required:${existing.id}`,
      );
    }
    const conversation =
      existing ??
      (await this.conversations.findOrCreate({
        chatType: 'group',
        chatId,
        organizationId: principal.organizationId,
        participantId: principal.id,
        origin: 'native',
        targetKind: 'group',
        targetId: principal.id,
        title: input.title,
      }));
    for (const participantId of participantIds) {
      await this.conversations.addParticipant(conversation.id, participantId);
    }
    return (await this.conversations.get(conversation.id)) ?? conversation;
  }

  /**
   * Renames a group. Only a participant may do it, and the new title is what
   * everybody sees from then on (the deterministic key is unaffected, so the
   * conversation identity does not change).
   */
  async renameGroup(
    principal: Principal,
    conversationId: string,
    title: string,
  ): Promise<Conversation> {
    this.requireMember(principal);
    const conversation = await this.conversations.get(conversationId);
    if (!conversation || !canReadConversation(principal, conversation)) {
      throw new ServiceError(404, 'conversation not found');
    }
    if (conversation.targetKind !== 'group') {
      throw new ServiceError(400, 'only group conversations can be renamed');
    }
    if (!conversation.participantIds.includes(principal.id)) {
      throw new ServiceError(403, 'forbidden', 'not_a_participant');
    }
    const clean = title.trim();
    if (clean === '' || clean.length > 64) {
      throw new ServiceError(400, 'title must be between 1 and 64 characters');
    }
    await this.conversations.rename(conversation.id, clean);
    this.events.publish({
      type: 'conversation_updated',
      conversationId: conversation.id,
      title: clean,
      at: new Date().toISOString(),
    });
    return (await this.conversations.get(conversation.id)) ?? conversation;
  }

  /**
   * Forwards a message into another conversation the caller belongs to. The
   * body and its attachments are copied; a recalled source forwards nothing, so
   * a withdrawn message cannot be resurrected by forwarding it.
   */
  async forwardMessage(
    principal: Principal,
    messageId: string,
    targetConversationId: string,
  ): Promise<{ ok: boolean; message: ChatMessage }> {
    this.requireMember(principal);
    const source = await this.messages.findById(messageId);
    if (!source) throw new ServiceError(404, 'message not found');

    const sourceConversation = await this.conversations.get(source.conversationId);
    if (
      !sourceConversation ||
      !canReadConversation(principal, sourceConversation) ||
      !sourceConversation.participantIds.includes(principal.id)
    ) {
      throw new ServiceError(404, 'message not found');
    }

    const target = await this.conversations.get(targetConversationId);
    if (!target || !canReadConversation(principal, target)) {
      throw new ServiceError(404, 'conversation not found');
    }
    if (!target.participantIds.includes(principal.id)) {
      throw new ServiceError(403, 'forbidden', 'not_a_participant');
    }
    if (target.targetKind === 'agent') {
      // Forwarding to the assistant would silently start a task; the sender has
      // to ask the assistant directly instead.
      throw new ServiceError(400, 'forward to a colleague or a group, not to an AI assistant');
    }
    if (source.recalledAt || (source.text.trim() === '' && source.attachments.length === 0)) {
      throw new ServiceError(400, 'this message has nothing to forward');
    }

    const message: ChatMessage = {
      id: crypto.randomUUID(),
      channel: 'web',
      conversationId: target.id,
      chatType: target.chatType,
      direction: 'inbound',
      kind: source.attachments.length > 0 ? 'mixed' : 'text',
      text: source.text,
      sender: { id: principal.id, name: principal.displayName },
      senderPrincipalId: principal.id,
      mentions: [],
      attachments: source.attachments,
      createdAt: new Date().toISOString(),
      metadata: {
        forwardedFrom: {
          messageId: source.id,
          conversationId: source.conversationId,
          senderName: source.sender.name,
        },
      },
    };
    await this.messages.append(message);
    await this.conversations.appendMessage(target.id, message.id);
    this.events.publish({
      type: 'message',
      conversationId: target.id,
      message,
      at: message.createdAt,
    });
    return { ok: true, message };
  }

  /**
   * Removes somebody else from a group. This is the explicit, audited removal
   * the add-only re-creation rule deliberately does not provide. A member can
   * always remove themselves through `leaveConversation`.
   */
  async removeGroupMember(
    principal: Principal,
    conversationId: string,
    memberId: string,
  ): Promise<{ ok: boolean }> {
    this.requireMember(principal);
    const conversation = await this.conversations.get(conversationId);
    if (!conversation || !canReadConversation(principal, conversation)) {
      throw new ServiceError(404, 'conversation not found');
    }
    if (conversation.targetKind !== 'group') {
      throw new ServiceError(400, 'only group conversations accept member changes');
    }
    if (!conversation.participantIds.includes(principal.id)) {
      throw new ServiceError(403, 'forbidden', 'not_a_participant');
    }
    if (memberId === principal.id) {
      throw new ServiceError(400, 'use the leave endpoint to remove yourself');
    }
    if (!conversation.participantIds.includes(memberId)) {
      throw new ServiceError(404, 'member not found');
    }
    await this.conversations.removeParticipant(conversation.id, memberId);
    return { ok: true };
  }

  /** Adds an organization member (or AI account) to a group conversation. */
  async addGroupMember(
    principal: Principal,
    conversationId: string,
    memberId: string,
  ): Promise<{ ok: boolean }> {
    this.requireMember(principal);
    const conversation = await this.conversations.get(conversationId);
    if (!conversation || !canReadConversation(principal, conversation)) {
      throw new ServiceError(404, 'conversation not found');
    }
    if (conversation.targetKind !== 'group') {
      throw new ServiceError(400, 'only group conversations accept new members');
    }
    if (!conversation.participantIds.includes(principal.id)) {
      throw new ServiceError(403, 'forbidden', 'not_a_participant');
    }

    const member = await this.directory.get(memberId);
    if (member && member.organizationId === conversation.organizationId) {
      await this.conversations.addParticipant(conversation.id, member.id);
      return { ok: true };
    }
    const account = await this.accounts.get(memberId);
    if (account && canUseAccount(principal, account)) {
      await this.conversations.addParticipant(conversation.id, account.id);
      return { ok: true };
    }
    throw new ServiceError(404, 'member not found');
  }

  /** Leaves a group conversation (the creator may leave as well). */
  async leaveConversation(principal: Principal, conversationId: string): Promise<{ ok: boolean }> {
    this.requireMember(principal);
    const conversation = await this.conversations.get(conversationId);
    if (!conversation || !canReadConversation(principal, conversation)) {
      throw new ServiceError(404, 'conversation not found');
    }
    if (conversation.targetKind !== 'group') {
      throw new ServiceError(400, 'only group conversations can be left');
    }
    if (!conversation.participantIds.includes(principal.id)) {
      throw new ServiceError(403, 'forbidden', 'not_a_participant');
    }
    await this.conversations.removeParticipant(conversation.id, principal.id);
    return { ok: true };
  }

  /**
   * Native send. AI conversations create a task; member and group
   * conversations are delivered to the participants' inboxes.
   */
  /**
   * Recalls one of the caller's own messages. Only the sender may recall, only
   * inside the configured window, and the result is published so every client
   * replaces the bubble. Recalling twice is idempotent.
   */
  async recallMessage(
    principal: Principal,
    messageId: string,
  ): Promise<{ ok: boolean; message: ChatMessage }> {
    this.requireMember(principal);
    const message = await this.messages.findById(messageId);
    if (!message) throw new ServiceError(404, 'message not found');

    const conversation = await this.conversations.get(message.conversationId);
    if (!conversation || !canReadConversation(principal, conversation)) {
      throw new ServiceError(404, 'message not found');
    }
    if (!conversation.participantIds.includes(principal.id)) {
      throw new ServiceError(403, 'forbidden', 'not_a_participant');
    }
    const isSender =
      message.senderPrincipalId === principal.id || message.sender.id === principal.id;
    if (!isSender) throw new ServiceError(403, 'forbidden', 'sender_only');

    if (!message.recalledAt) {
      const windowMs = this.recallWindowMs;
      const age = Date.now() - Date.parse(message.createdAt);
      if (windowMs <= 0) {
        throw new ServiceError(400, 'recall is disabled on this server', 'recall_disabled');
      }
      if (!Number.isFinite(age) || age > windowMs) {
        throw new ServiceError(400, 'the recall window has expired', 'recall_window_expired');
      }
      const recalledAt = new Date().toISOString();
      const updated = await this.messages.markRecalled(messageId, recalledAt);
      if (!updated) throw new ServiceError(404, 'message not found');
      this.events.publish({
        type: 'message_recalled',
        conversationId: updated.conversationId,
        messageId: updated.id,
        recalledAt: updated.recalledAt ?? recalledAt,
        at: recalledAt,
      });
      return { ok: true, message: hideRecalledContent(updated) };
    }

    return { ok: true, message: hideRecalledContent(message) };
  }

  async sendNativeMessage(
    principal: Principal,
    conversationId: string,
    input: { text: string; attachments: ChatMessage['attachments']; mentions?: string[] },
  ): Promise<{ message: ChatMessage; taskId?: string; taskIds?: string[] }> {
    this.requireMember(principal);
    await this.assertAttachmentsOwned(principal, input.attachments);
    const conversation = await this.conversations.get(conversationId);
    if (!conversation || !canReadConversation(principal, conversation)) {
      throw new ServiceError(404, 'conversation not found');
    }
    if (!conversation.participantIds.includes(principal.id)) {
      throw new ServiceError(403, 'forbidden', 'not_a_participant');
    }

    const kind = input.attachments.length > 0 ? 'mixed' : 'text';

    if (conversation.targetKind === 'agent') {
      const account = conversation.accountId
        ? await this.accounts.get(conversation.accountId)
        : undefined;
      if (!account) throw new ServiceError(404, 'ai account not found');
      if (!canUseAccount(principal, account)) {
        throw new ServiceError(403, 'forbidden', 'account_not_granted');
      }

      const delivered = await this.deliver(
        {
          account,
          organizationId: conversation.organizationId,
          requesterId: principal.id,
          chatId: conversation.chatId,
          chatType: 'direct',
          participantId: principal.id,
          sender: { id: principal.id, name: principal.displayName },
          senderPrincipalId: principal.id,
          channel: 'web',
          kind,
          text: input.text,
          mentions: [],
          attachments: input.attachments,
          metadata: { native: true },
        },
        conversation,
      );
      if (!delivered.message) {
        throw new ServiceError(500, 'message was not persisted');
      }
      return { message: delivered.message, taskId: delivered.taskId };
    }

    if (conversation.targetKind === 'member') {
      const peerId = conversation.participantIds.find((id) => id !== principal.id);
      if (!peerId || peerId === conversation.targetId) {
        await this.conversations.addParticipant(conversation.id, conversation.targetId);
      }
    }

    const mentions = [...new Set(input.mentions ?? [])].filter((id) =>
      conversation.participantIds.includes(id),
    );

    const message: ChatMessage = {
      id: crypto.randomUUID(),
      channel: 'web',
      accountId: conversation.accountId,
      conversationId: conversation.id,
      chatType: conversation.chatType,
      direction: 'inbound',
      kind,
      text: input.text,
      sender: { id: principal.id, name: principal.displayName },
      senderPrincipalId: principal.id,
      mentions,
      attachments: input.attachments,
      createdAt: new Date().toISOString(),
      metadata: { native: true },
    };
    await this.messages.append(message);
    await this.conversations.appendMessage(conversation.id, message.id);
    this.events.publish({
      type: 'message',
      conversationId: conversation.id,
      message,
      at: message.createdAt,
    });

    // Group @AI: every mentioned participant that is an AI account gets a task
    // for this message, with the group conversation as context.
    const taskIds: string[] = [];
    if (conversation.targetKind === 'group' && mentions.length > 0) {
      const history = await this.buildHistory(conversation.id);
      for (const mentionId of mentions.slice(0, 3)) {
        const account = await this.accounts.get(mentionId);
        if (!account || !canUseAccount(principal, account)) continue;
        if (!conversation.participantIds.includes(account.id)) continue;
        // The client inserts "@<displayName>"; strip it so the model sees the
        // instruction alone rather than the mention prefix.
        const goal = stripMention(input.text, [account.displayName, account.name]).trim();
        const task = await this.taskEngine.submit({
          accountId: account.id,
          conversationId: conversation.id,
          organizationId: conversation.organizationId,
          requesterId: principal.id,
          goal: goal === '' ? '（空消息）' : goal,
          input: { history },
          maxAttempts: 1,
        });
        taskIds.push(task.id);
      }
    }

    return { message, taskId: taskIds[0], taskIds };
  }

  /** True when the principal may see this approval (requester or decider). */
  async canSeeApproval(principal: Principal, approvalId: string): Promise<boolean> {
    if (!isAuthenticated(principal)) return false;
    const approval = await this.approvals.get(approvalId);
    if (!approval || !sameOrganization(principal, approval.organizationId)) return false;
    if (approval.requesterId === principal.id) return true;
    const task = approval.taskId ? await this.taskEngine.get(approval.taskId) : undefined;
    const account = task ? await this.accounts.get(task.accountId) : undefined;
    return canDecideApprovalRecord(principal, approval, account);
  }

  private async publishTaskEvent(event: TaskEvent): Promise<void> {
    if (event.type === 'progress') return;
    const task = await this.taskEngine.get(event.taskId);
    if (!task) return;
    this.events.publish({
      type: 'task',
      taskId: event.taskId,
      conversationId: task.conversationId,
      state: task.state,
      message: event.message,
      at: event.at,
    });
  }

  // Accounts ---------------------------------------------------------------

  async listAccounts(principal: Principal): Promise<AgentAccount[]> {
    this.requireMember(principal);
    const accounts = await this.accounts.list();
    return accounts.filter((account) => canReadAccount(principal, account));
  }

  async getAccount(principal: Principal, id: string): Promise<AgentAccount> {
    this.requireMember(principal);
    const account = await this.accounts.get(id);
    if (!account || !canReadAccount(principal, account)) {
      throw new ServiceError(404, 'account not found');
    }
    return account;
  }

  async createAccount(
    principal: Principal,
    input: Parameters<AccountStore['create']>[0],
  ): Promise<AgentAccount> {
    this.requireMember(principal);
    if (!isOrgAdmin(principal)) {
      throw new ServiceError(403, 'forbidden', 'org_admin_required');
    }
    return this.accounts.create(input, {
      organizationId: principal.organizationId,
      ownerId: principal.id,
    });
  }

  async updateAccount(
    principal: Principal,
    id: string,
    patch: Parameters<AccountStore['update']>[1],
  ): Promise<AgentAccount> {
    this.requireMember(principal);
    const account = await this.accounts.get(id);
    if (!account || !canReadAccount(principal, account)) {
      throw new ServiceError(404, 'account not found');
    }
    if (!canManageAccount(principal, account)) {
      throw new ServiceError(403, 'forbidden', 'account_owner_required');
    }
    const updated = await this.accounts.update(id, patch);
    if (!updated) throw new ServiceError(404, 'account not found');
    return updated;
  }

  // Conversations ----------------------------------------------------------

  async listConversations(principal: Principal, accountId?: string): Promise<Conversation[]> {
    this.requireMember(principal);
    if (accountId) await this.getAccount(principal, accountId);
    const conversations = await this.conversations.list(accountId);
    return conversations.filter((conversation) => canReadConversation(principal, conversation));
  }

  async getConversation(principal: Principal, id: string): Promise<Conversation> {
    this.requireMember(principal);
    const conversation = await this.conversations.get(id);
    if (!conversation || !canReadConversation(principal, conversation)) {
      throw new ServiceError(404, 'conversation not found');
    }
    return conversation;
  }

  /**
   * Message history, newest last. `before` is a message id cursor; the client
   * pages backwards through long conversations instead of loading everything.
   */
  async listMessages(
    principal: Principal,
    conversationId: string,
    options: { limit?: number; before?: string } = {},
  ): Promise<ChatMessage[]> {
    await this.getConversation(principal, conversationId);
    const all = await this.messages.list(conversationId);

    const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
    if (!options.before) {
      return all.slice(-limit).map(hideRecalledContent);
    }

    const index = all.findIndex((message) => message.id === options.before);
    // An unknown cursor means the client is paging from a stale state: return
    // nothing rather than the newest page (which would duplicate messages).
    if (index < 0) return [];
    return all.slice(Math.max(0, index - limit), index).map(hideRecalledContent);
  }

  /**
   * Conversation list with unread counts and a last-message preview, which is
   * what a chat client actually needs to render.
   */
  async listConversationSummaries(
    principal: Principal,
    accountId?: string,
  ): Promise<ConversationSummary[]> {
    this.requireMember(principal);
    const conversations = await this.listConversations(principal, accountId);
    const summaries: ConversationSummary[] = [];

    for (const conversation of conversations) {
      const [messages, lastReadAt] = await Promise.all([
        this.messages.list(conversation.id),
        this.readState.lastReadAt(principal.id, conversation.id),
      ]);
      const cursor = lastReadAt ? Date.parse(lastReadAt) : 0;
      const unreadCount = messages.filter(
        (message) =>
          message.sender.id !== principal.id &&
          message.direction === 'inbound' &&
          // A recalled message is not something the reader still has to look at.
          !message.recalledAt &&
          Date.parse(message.createdAt) > cursor,
      ).length;

      // A recalled message must not be previewed, so the newest visible message
      // is used instead.
      const last = [...messages].reverse().find((message) => !message.recalledAt);
      summaries.push({
        ...conversation,
        unreadCount,
        lastMessage: last
          ? {
              id: last.id,
              text: last.text,
              senderId: last.sender.id,
              senderName: last.sender.name,
              kind: last.kind,
              createdAt: last.createdAt,
            }
          : undefined,
      });
    }

    return summaries.sort((a, b) => {
      const left = a.lastMessage?.createdAt ?? a.updatedAt;
      const right = b.lastMessage?.createdAt ?? b.updatedAt;
      return right.localeCompare(left);
    });
  }

  /**
   * Full-text search inside the conversations the caller may read. Results are
   * capped and never cross an organization or a participation boundary.
   */
  /**
   * Read receipts for one conversation. Only human participants are reported,
   * and only to somebody who is already in the conversation: the cursor of a
   * colleague is not public information.
   */
  async readReceipts(
    principal: Principal,
    conversationId: string,
  ): Promise<{ me?: string; others: Array<{ memberId: string; lastReadAt: string }> }> {
    const conversation = await this.getConversation(principal, conversationId);
    if (!conversation.participantIds.includes(principal.id)) {
      throw new ServiceError(403, 'forbidden', 'not_a_participant');
    }
    const states = await this.readState.listForConversation(conversationId);
    const byMember = new Map(states.map((state) => [state.memberId, state.lastReadAt]));
    const others: Array<{ memberId: string; lastReadAt: string }> = [];
    for (const participantId of conversation.participantIds) {
      if (participantId === principal.id) continue;
      const account = await this.accounts.get(participantId);
      if (account) continue; // AI accounts do not read anything
      const lastReadAt = byMember.get(participantId);
      if (lastReadAt) others.push({ memberId: participantId, lastReadAt });
    }
    return { me: byMember.get(principal.id), others };
  }

  /** Presence snapshot: members with an open event stream. */
  async presence(principal: Principal): Promise<{ online: string[] }> {
    this.requireMember(principal);
    const members = await this.directory.list();
    const sameOrg = new Set(
      members
        .filter((member) => member.organizationId === principal.organizationId)
        .map((member) => member.id),
    );
    return { online: this.events.onlinePrincipals().filter((id) => sameOrg.has(id)) };
  }

  async searchMessages(
    principal: Principal,
    query: string,
    limit = 30,
  ): Promise<
    Array<{
      conversationId: string;
      title?: string;
      peerName?: string;
      message: { id: string; text: string; senderName: string; createdAt: string };
    }>
  > {
    this.requireMember(principal);
    const needle = query.trim();
    if (needle.length < 2) return [];

    const capped = Math.min(Math.max(limit, 1), 50);
    const conversations = await this.listConversations(principal);
    const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
    // The store already skips recalled messages.
    const hits = await this.messages.search([...byId.keys()], needle, capped);

    return hits.map((message) => {
      const conversation = byId.get(message.conversationId);
      return {
        conversationId: message.conversationId,
        title: conversation?.title,
        message: {
          id: message.id,
          text: message.text,
          senderName: message.sender.name,
          createdAt: message.createdAt,
        },
      };
    });
  }

  async markConversationRead(
    principal: Principal,
    conversationId: string,
  ): Promise<{ ok: boolean }> {
    await this.getConversation(principal, conversationId);
    if (!(await this.isParticipant(principal, conversationId))) {
      throw new ServiceError(403, 'forbidden', 'not_a_participant');
    }
    await this.readState.markRead(principal.id, conversationId);
    return { ok: true };
  }

  private async isParticipant(principal: Principal, conversationId: string): Promise<boolean> {
    const conversation = await this.conversations.get(conversationId);
    return conversation !== undefined && conversation.participantIds.includes(principal.id);
  }

  // Messages ---------------------------------------------------------------

  /**
   * Workbench/API path. The sender is the authenticated principal; the request
   * body never contributes identity.
   */
  async injectMessage(
    principal: Principal,
    message: InboundMessageInput,
  ): Promise<InjectMessageResult> {
    this.requireMember(principal);
    const account = await this.requireAccountInOrg(principal, message.accountId);

    if (!this.isSenderAllowed(account, principal.id, principal)) {
      return {
        authorized: false,
        conversationId: '',
        reason: 'sender_not_allowed',
      };
    }

    // The conversation key comes from the request body, so the caller must
    // already belong to the conversation it resolves to. Without this check a
    // member could join (and read) a colleague's private AI conversation by
    // presenting its chatId.
    const conversation = await this.conversations.findOrCreate({
      accountId: account.id,
      chatType: message.chatType,
      chatId: message.chatId,
      organizationId: account.organizationId,
      participantId: principal.id,
      origin: message.channel === 'web' ? 'native' : 'external',
      targetKind: 'agent',
      targetId: account.id,
    });
    if (!conversation.participantIds.includes(principal.id)) {
      throw new ServiceError(403, 'forbidden', 'not_a_participant');
    }

    return this.deliver({
      account,
      organizationId: account.organizationId,
      requesterId: principal.id,
      chatId: message.chatId,
      chatType: message.chatType,
      participantId: principal.id,
      sender: { id: principal.id, name: principal.displayName },
      senderPrincipalId: principal.id,
      channel: message.channel ?? 'web',
      channelMessageId: message.channelMessageId,
      kind: message.kind,
      text: message.text,
      mentions: message.mentions,
      attachments: message.attachments,
      replyTo: message.replyTo,
      metadata: message.metadata,
    }, conversation);
  }

  /** Verified gateway path: platform sender, deduplicated, allowlist-checked. */
  async handleWebhook(
    channel: string,
    payload: unknown,
    verificationInput: {
      token?: string;
      signature?: string;
      rawBody?: Buffer;
      dedupeKey?: string;
    },
  ): Promise<WebhookHandleResult> {
    const gateway = this.findGateway(channel);
    if (!gateway) throw new ServiceError(404, 'unknown channel');

    const verification = gateway.verify({
      token: verificationInput.token,
      signature: verificationInput.signature,
      rawBody: verificationInput.rawBody,
      payload,
    });
    if (!verification.ok) {
      throw new ServiceError(401, 'webhook rejected', verification.reason);
    }

    const account = await this.accounts.findByChannel(gateway.channel);
    if (!account) throw new ServiceError(404, 'channel not configured');

    const normalized = await gateway.handleWebhook(payload);
    const items = Array.isArray(normalized) ? normalized : [normalized];

    const results: InjectMessageResult[] = [];
    for (const item of items) {
      const dedupeKey = buildDedupeKey(gateway.name, item, verificationInput.dedupeKey);
      if (dedupeKey && (await this.dedupe.has(dedupeKey))) {
        results.push({
          authorized: true,
          conversationId: '',
          deduplicated: true,
          reason: 'duplicate_message',
        });
        continue;
      }

      if (!this.isSenderAllowed(account, item.senderId, undefined)) {
        results.push({ authorized: false, conversationId: '', reason: 'sender_not_allowed' });
        if (dedupeKey) await this.dedupe.remember(dedupeKey);
        continue;
      }

      const delivered = await this.deliverFromGateway({ gateway, item }, account);
      if (dedupeKey) await this.dedupe.remember(dedupeKey);
      results.push(delivered);
    }

    return { ok: true, verificationMode: verification.mode, results };
  }

  // Tasks ------------------------------------------------------------------

  async submitTask(principal: Principal, input: CreateTaskInput): Promise<TaskRecord> {
    this.requireMember(principal);
    const account = await this.requireUsableAccount(principal, input.accountId);

    // Model history is always rebuilt server-side; callers cannot inject
    // system turns or fabricated tool output into another account's run.
    let history: ModelMessage[] = [];
    if (input.conversationId) {
      const conversation = await this.conversations.get(input.conversationId);
      if (!conversation || !canReadConversation(principal, conversation)) {
        throw new ServiceError(404, 'conversation not found');
      }
      if (conversation.accountId !== account.id) {
        throw new ServiceError(400, 'conversation does not belong to account');
      }
      history = await this.buildHistory(conversation.id);
    }

    return this.taskEngine.submit({
      accountId: input.accountId,
      conversationId: input.conversationId,
      goal: input.goal,
      maxAttempts: input.maxAttempts,
      organizationId: account.organizationId,
      requesterId: principal.id,
      input: { history },
    });
  }

  private get recallWindowMs(): number {
    return Math.max(0, this.config.native.recallWindowSeconds) * 1000;
  }

  /**
   * A task bound to a conversation is only visible to its participants. Leaving
   * a group therefore also revokes the AI results and control of its tasks.
   */
  /**
   * Task records snapshot the model history at submit time, so a message that is
   * recalled later would still be readable there. Recalled bodies are therefore
   * removed both when a task is served and when it is re-run.
   */
  private async withRedactedHistory(task: TaskRecord): Promise<TaskRecord> {
    const history = (task.input?.history as ModelMessage[] | undefined) ?? [];
    // The goal is redacted even when the snapshot is empty (a first message
    // creates a task whose history snapshot has no entries yet).
    if (!task.conversationId) return task;
    const recalled = await this.recalledTextsOf(task);
    if (recalled.length === 0) return task;

    const redacted = history.map((entry) =>
      recalled.some((text) => entry.content.includes(text))
        ? { ...entry, content: '[已撤回]' }
        : entry,
    );
    if (redacted.length === 0 && !recalled.some((text) => task.goal.includes(text))) return task;
    // The task goal is the message text itself, so it has to be redacted too.
    const goal = recalled.some((text) => task.goal.includes(text)) ? '[已撤回]' : task.goal;
    return { ...task, goal, input: { ...(task.input ?? {}), history: redacted } };
  }

  private async assertTaskVisible(principal: Principal, task: TaskRecord): Promise<void> {
    if (!task.conversationId) return;
    if (isOrgAdmin(principal)) return;
    const conversation = await this.conversations.get(task.conversationId);
    if (!conversation) return;
    if (!conversation.participantIds.includes(principal.id)) {
      throw new ServiceError(404, 'task not found');
    }
  }

  async listTasks(principal: Principal): Promise<TaskRecord[]> {
    this.requireMember(principal);
    const tasks = await this.taskEngine.list();
    const allowed: TaskRecord[] = [];
    for (const task of tasks) {
      const account = await this.accounts.get(task.accountId);
      if (!canReadTask(principal, task, account)) continue;
      if (task.conversationId && !isOrgAdmin(principal)) {
        const conversation = await this.conversations.get(task.conversationId);
        if (conversation && !conversation.participantIds.includes(principal.id)) continue;
      }
      allowed.push(await this.withRedactedHistory(task));
    }
    return allowed;
  }

  async getTask(principal: Principal, id: string): Promise<TaskRecord> {
    this.requireMember(principal);
    const task = await this.taskEngine.get(id);
    if (!task) throw new ServiceError(404, 'task not found');
    const account = await this.accounts.get(task.accountId);
    if (!canReadTask(principal, task, account)) throw new ServiceError(404, 'task not found');
    await this.assertTaskVisible(principal, task);
    return this.withRedactedHistory(task);
  }

  async getTaskEvents(principal: Principal, id: string): Promise<TaskEvent[]> {
    const task = await this.getTask(principal, id);
    const events = this.taskEngine.getEvents(id);
    const recalled = await this.recalledTextsOf(task);
    return recalled.length === 0 ? events : redactEventPayloads(events, recalled);
  }

  /** Bodies of messages recalled in the task's conversation. */
  private async recalledTextsOf(task: TaskRecord): Promise<string[]> {
    if (!task.conversationId) return [];
    const messages = await this.messages.list(task.conversationId);
    return messages
      .filter((message) => message.recalledAt && message.text.trim() !== '')
      .map((message) => message.text.trim());
  }

  async cancelTask(
    principal: Principal,
    id: string,
  ): Promise<{ ok: boolean; cancelled: boolean; reason?: string; state?: string }> {
    this.requireMember(principal);
    const task = await this.taskEngine.get(id);
    if (!task) throw new ServiceError(404, 'task not found');
    const account = await this.accounts.get(task.accountId);
    if (!canReadTask(principal, task, account)) throw new ServiceError(404, 'task not found');
    await this.assertTaskVisible(principal, task);
    if (!canCancelTask(principal, task, account)) {
      throw new ServiceError(403, 'forbidden', 'requester_or_owner_required');
    }
    const result = await this.taskEngine.cancel(id);
    return { ok: result.ok, cancelled: result.ok, reason: result.reason, state: result.state };
  }

  /** Re-runs a task blocked on approval or missing input. */
  async resumeTask(
    principal: Principal,
    id: string,
  ): Promise<{ ok: boolean; state?: string; reason?: string }> {
    this.requireMember(principal);
    const task = await this.taskEngine.get(id);
    if (!task) throw new ServiceError(404, 'task not found');
    const account = await this.accounts.get(task.accountId);
    if (!canReadTask(principal, task, account)) throw new ServiceError(404, 'task not found');
    await this.assertTaskVisible(principal, task);
    if (!canCancelTask(principal, task, account)) {
      throw new ServiceError(403, 'forbidden', 'requester_or_owner_required');
    }
    const result = await this.taskEngine.resume(id);
    return { ok: result.ok, state: result.state, reason: result.reason };
  }

  // Approvals --------------------------------------------------------------

  /**
   * Approvals visible to the caller: requests they raised, plus requests they
   * are allowed to decide on.
   */
  async listApprovals(principal: Principal): Promise<ApprovalRecord[]> {
    this.requireMember(principal);
    const approvals = await this.approvals.list(principal.organizationId);
    const visible: ApprovalRecord[] = [];
    for (const approval of approvals) {
      if (approval.requesterId === principal.id) {
        visible.push(approval);
        continue;
      }
      const account = approval.taskId
        ? await this.accounts.get((await this.taskEngine.get(approval.taskId))?.accountId ?? '')
        : undefined;
      if (canDecideApprovalRecord(principal, approval, account)) visible.push(approval);
    }
    return visible;
  }

  /** Records an approve/reject decision; the requester can never self-approve. */
  async decideApproval(
    principal: Principal,
    id: string,
    decision: 'approved' | 'rejected',
    reason?: string,
  ): Promise<ApprovalRecord> {
    this.requireMember(principal);
    const approval = await this.approvals.get(id);
    if (!approval || !sameOrganization(principal, approval.organizationId)) {
      throw new ServiceError(404, 'approval not found');
    }
    const task = approval.taskId ? await this.taskEngine.get(approval.taskId) : undefined;
    const account = task ? await this.accounts.get(task.accountId) : undefined;
    if (!canDecideApprovalRecord(principal, approval, account)) {
      throw new ServiceError(403, 'forbidden', 'approver_not_allowed');
    }
    const updated = await this.approvals.decide(id, decision, principal.id, reason);
    if (!updated) throw new ServiceError(404, 'approval not found');
    this.events.publish({
      type: 'approval',
      approvalId: updated.id,
      taskId: updated.taskId,
      status: updated.status,
      at: updated.decidedAt ?? new Date().toISOString(),
    });
    return updated;
  }

  // Audit ------------------------------------------------------------------

  /**
   * Tail of the audit trail for organization admins. Entries are already
   * truncated at write time and never contain tokens or payloads.
   */
  async listAudit(
    principal: Principal,
    limit = 100,
  ): Promise<Array<Record<string, unknown>>> {
    this.requireOrgAdmin(principal);
    const capped = Math.min(Math.max(limit, 1), 500);
    try {
      const raw = await readFile(this.config.auditFilePath, 'utf8');
      const lines = raw.split('\n').filter((line) => line.trim() !== '');
      return lines
        .slice(-capped)
        .reverse()
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return { action: 'unparsable', outcome: 'failed' };
          }
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  // Outbox ----------------------------------------------------------------

  /**
   * Reconciles an `unknown` delivery after a human checked the peer side.
   * Only `unknown` records can be resolved, and only by an admin or the
   * record owner — this is the counterpart of "never auto-resend".
   */
  async resolveOutbox(
    principal: Principal,
    id: string,
    resolution: 'delivered' | 'failed',
    note?: string,
  ): Promise<OutboxRecord> {
    this.requireMember(principal);
    const record = await this.outbox.get(id);
    if (!record || !sameOrganization(principal, record.organizationId)) {
      throw new ServiceError(404, 'outbox record not found');
    }
    if (!isOrgAdmin(principal) && record.ownerId !== principal.id) {
      throw new ServiceError(403, 'forbidden', 'outbox_owner_required');
    }
    if (record.state !== 'unknown') {
      throw new ServiceError(409, 'only unknown deliveries can be reconciled');
    }

    return this.outbox.save({
      ...record,
      state: resolution,
      error: resolution === 'failed' ? note ?? record.error : undefined,
      updatedAt: new Date().toISOString(),
    });
  }

  async listOutbox(principal: Principal): Promise<OutboxRecord[]> {
    this.requireMember(principal);
    const records = await this.outbox.list(principal.organizationId);
    const visible: OutboxRecord[] = [];
    for (const record of records) {
      if (record.ownerId === principal.id || isOrgAdmin(principal)) {
        visible.push(record);
        continue;
      }
      if (record.taskId) {
        const task = await this.taskEngine.get(record.taskId);
        const account = task ? await this.accounts.get(task.accountId) : undefined;
        if (task && canReadTask(principal, task, account)) visible.push(record);
      }
    }
    return visible;
  }

  // Documents --------------------------------------------------------------

  async parseUploaded(principal: Principal, buffer: Buffer, name: string, mimeType: string) {
    this.requireMember(principal);
    const scope = { organizationId: principal.organizationId, ownerId: principal.id };
    const { parseDocumentBuffer, DocumentLimitError } = await import('@chatagent/document');
    let summary;
    try {
      // Parse BEFORE persisting: a refused document must not consume disk, and
      // a broken one must not leave a half-understood upload behind.
      summary = await parseDocumentBuffer(buffer, name, name);
    } catch (error) {
      // A refused archive is the caller's problem, not a server fault.
      if (error instanceof DocumentLimitError) {
        throw new ServiceError(413, error.message, error.reason);
      }
      throw new ServiceError(400, 'the document could not be parsed', 'document_unreadable');
    }
    const file = await this.uploads.save(buffer, name, mimeType, scope);
    summary.fileId = file.id;
    return { file: fileView(file), summary };
  }

  async generateWord(principal: Principal, input: GenerateWordInput) {
    this.requireMember(principal);
    const { createWordBuffer } = await import('@chatagent/document');
    const buffer = await createWordBuffer(input);
    const name = `${input.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'document'}.docx`;
    const artifact = await this.artifacts.save(
      buffer,
      name,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      { organizationId: principal.organizationId, ownerId: principal.id },
    );
    return artifactView(artifact);
  }

  /**
   * Exports a conversation as a Word transcript. Useful for meeting minutes and
   * archives, and it never exposes anything a participant could not already
   * read: recalled messages appear as "[已撤回]" with no body.
   */
  async exportConversation(principal: Principal, conversationId: string): Promise<BaseFileView> {
    const conversation = await this.getConversation(principal, conversationId);
    if (!conversation.participantIds.includes(principal.id)) {
      throw new ServiceError(403, 'forbidden', 'not_a_participant');
    }
    const all = await this.messages.list(conversationId);
    const capped = all.slice(-EXPORT_MESSAGE_LIMIT).map(hideRecalledContent);

    const paragraphs = capped.map((message) => {
      const stamp = new Date(message.createdAt).toLocaleString('zh-CN');
      if (message.recalledAt) return `[${stamp}] ${message.sender.name}：[已撤回]`;
      const files = message.attachments.map((file) => file.name).join('、');
      const body = message.text.trim() === '' ? '(无正文)' : message.text.trim();
      return `[${stamp}] ${message.sender.name}：${body}${files ? `（附件：${files}）` : ''}`;
    });

    const { createWordBuffer } = await import('@chatagent/document');
    const buffer = await createWordBuffer({
      title: `${conversation.title ?? '会话'} · 聊天记录`,
      paragraphs:
        paragraphs.length > 0
          ? paragraphs
          : ['(该会话暂无消息)'],
      table: {
        header: ['项目', '值'],
        rows: [
          ['会话类型', conversation.targetKind ?? 'agent'],
          ['参与者', String(conversation.participantIds.length)],
          ['消息条数', String(capped.length)],
          ['导出时间', new Date().toLocaleString('zh-CN')],
        ],
      },
    });
    const safeTitle = (conversation.title ?? 'conversation').replace(/[\/:*?"<>|]/g, '_').slice(0, 60);
    const artifact = await this.artifacts.save(
      buffer,
      `${safeTitle || 'conversation'}-transcript.docx`,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      { organizationId: conversation.organizationId, ownerId: principal.id },
    );
    return artifactView(artifact);
  }

  async generateExcel(principal: Principal, input: GenerateExcelInput) {
    this.requireMember(principal);
    const { createExcelBuffer } = await import('@chatagent/document');
    const buffer = createExcelBuffer(input);
    const artifact = await this.artifacts.save(
      buffer,
      input.fileName,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      { organizationId: principal.organizationId, ownerId: principal.id },
    );
    return artifactView(artifact);
  }

  // Files ------------------------------------------------------------------

  /**
   * Files produced inside a conversation are readable by that conversation's
   * participants: when the AI posts a document into a group, every member of
   * the group must be able to open it.
   */
  private async canReadArtifactShared(
    principal: Principal,
    artifact: StoredArtifactMeta,
  ): Promise<boolean> {
    const task = artifact.taskId ? await this.taskEngine.get(artifact.taskId) : undefined;
    if (canReadArtifact(principal, artifact, task)) return true;
    if (!task?.conversationId) return false;
    const conversation = await this.conversations.get(task.conversationId);
    if (!conversation) return false;
    if (!sameOrganization(principal, conversation.organizationId)) return false;
    return conversation.participantIds.includes(principal.id);
  }

  async listFiles(
    principal: Principal,
  ): Promise<{ artifacts: BaseFileView[]; uploads: BaseFileView[] }> {
    this.requireMember(principal);
    const artifactList = await this.artifacts.list();
    const uploadList = await this.uploads.list();

    const allowedArtifacts: BaseFileView[] = [];
    for (const artifact of artifactList) {
      if (await this.canReadArtifactShared(principal, artifact)) allowedArtifacts.push(artifactView(artifact));
    }

    const allowedUploads: BaseFileView[] = [];
    for (const upload of uploadList) {
      if (await this.canReadUploadShared(principal, upload)) allowedUploads.push(fileView(upload));
    }

    return { artifacts: allowedArtifacts, uploads: allowedUploads };
  }

  /**
   * A message may only carry files its sender uploaded. Without this check a
   * member could reference somebody else's upload id and hand out (or gain)
   * access to a file they never received.
   */
  private async assertAttachmentsOwned(
    principal: Principal,
    attachments: ChatMessage['attachments'],
  ): Promise<void> {
    for (const attachment of attachments) {
      if (attachment.id === '') throw new ServiceError(400, 'attachment id is required');
      const meta = await this.uploads.getMeta(attachment.id);
      if (!meta || meta.ownerId !== principal.id || meta.organizationId !== principal.organizationId) {
        throw new ServiceError(400, 'an attachment must be a file you uploaded', 'attachment_not_owned');
      }
    }
  }

  /**
   * An upload is readable by its owner (and admins), and by the members of a
   * conversation in which **the owner** posted it as an attachment. Requiring
   * the referencing message to come from the owner prevents "reference someone
   * else's file id" from becoming a read primitive.
   */
  private async canReadUploadShared(
    principal: Principal,
    upload: { id: string; organizationId: string; ownerId: string },
  ): Promise<boolean> {
    if (canReadUpload(principal, upload)) return true;
    if (!sameOrganization(principal, upload.organizationId)) return false;
    const conversations = await this.listConversations(principal);
    for (const conversation of conversations) {
      if (!conversation.participantIds.includes(principal.id)) continue;
      const messages = await this.messages.list(conversation.id);
      for (const message of messages) {
        if (message.recalledAt) continue;
        const fromOwner =
          message.senderPrincipalId === upload.ownerId || message.sender.id === upload.ownerId;
        if (!fromOwner) continue;
        if (message.attachments.some((attachment) => attachment.id === upload.id)) return true;
      }
    }
    return false;
  }

  async getFile(principal: Principal, id: string): Promise<AuthorizedFile> {
    this.requireMember(principal);

    const artifact = await this.artifacts.getMeta(id);
    if (artifact) {
      if (!(await this.canReadArtifactShared(principal, artifact))) {
        throw new ServiceError(404, 'file not found');
      }
      const stored = await this.artifacts.get(id);
      if (!stored) throw new ServiceError(404, 'file not found');
      return { name: stored.name, mimeType: stored.mimeType, buffer: stored.buffer };
    }

    const upload = await this.uploads.getMeta(id);
    if (upload) {
      if (!(await this.canReadUploadShared(principal, upload))) {
        throw new ServiceError(404, 'file not found');
      }
      const stored = await this.uploads.get(id);
      if (!stored) throw new ServiceError(404, 'file not found');
      return { name: stored.name, mimeType: stored.mimeType, buffer: stored.buffer };
    }

    throw new ServiceError(404, 'file not found');
  }

  // Gateway ----------------------------------------------------------------

  async listOutbound(principal: Principal) {
    this.requireMember(principal);
    const accounts = await this.accounts.list();
    const admin = isOrgAdmin(principal);
    const allowed = new Set(
      accounts
        .filter((account) => sameOrganization(principal, account.organizationId))
        // Non-admin members only see deliveries of the accounts they own.
        .filter((account) => admin || account.ownerId === principal.id)
        .map((account) => account.id),
    );
    return this.gateways
      .flatMap((gateway) => gateway.listOutbound())
      .filter((record) => allowed.has(record.accountId));
  }

  // Agent status -----------------------------------------------------------

  async agentStatus(principal: Principal) {
    this.requireMember(principal);
    const accounts = await this.accounts.list();
    const orgAccounts = accounts.filter((account) => sameOrganization(principal, account.organizationId));
    const tasks = await this.taskEngine.list();
    const orgTasks: TaskRecord[] = [];
    for (const task of tasks) {
      const account = await this.accounts.get(task.accountId);
      if (canReadTask(principal, task, account)) orgTasks.push(task);
    }
    const approvals = await this.approvals.list(principal.organizationId);
    const outbox = await this.outbox.list(principal.organizationId);

    return {
      provider: this.runtime.provider.name,
      uptimeSeconds: Math.round(process.uptime()),
      // Clients need the server's window to decide whether to offer "recall".
      recallWindowSeconds: Math.max(0, this.config.native.recallWindowSeconds),
      accounts: orgAccounts.length,
      onlineAccounts: orgAccounts.filter((account) => account.status === 'online').length,
      tasks: {
        total: orgTasks.length,
        running: orgTasks.filter((task) => task.state === 'running').length,
        pending: orgTasks.filter((task) => task.state === 'pending').length,
        waitingApproval: orgTasks.filter((task) => task.state === 'waiting_approval').length,
        completed: orgTasks.filter((task) => task.state === 'completed').length,
        failed: orgTasks.filter((task) => task.state === 'failed').length,
      },
      approvals: {
        pending: approvals.filter((approval) => approval.status === 'pending').length,
        total: approvals.length,
      },
      outbox: {
        total: outbox.length,
        undelivered: outbox.filter(
          (record) => record.state === 'unknown' || record.state === 'failed',
        ).length,
      },
      runtime: {
        queueDepth: this.taskEngine.queueDepth,
        streams: this.events.subscriberCount,
        conversations: (await this.conversations.list()).filter((conversation) =>
          sameOrganization(principal, conversation.organizationId),
        ).length,
      },
      tools: this.runtime.registry.listDefinitions().map((tool) => tool.name),
    };
  }

  // Internal ---------------------------------------------------------------

  private requireMember(principal: Principal): void {
    if (!isAuthenticated(principal)) {
      throw new ServiceError(401, 'authentication required');
    }
  }

  private async requireAccountInOrg(principal: Principal, accountId: string): Promise<AgentAccount> {
    const account = await this.accounts.get(accountId);
    if (!account || !canReadAccount(principal, account)) {
      throw new ServiceError(404, 'account not found');
    }
    return account;
  }

  /** Same as above plus the per-account usage grant. */
  private async requireUsableAccount(
    principal: Principal,
    accountId: string,
  ): Promise<AgentAccount> {
    const account = await this.requireAccountInOrg(principal, accountId);
    if (!canUseAccount(principal, account)) {
      throw new ServiceError(403, 'forbidden', 'account_not_granted');
    }
    return account;
  }

  private findGateway(channel: string): ImGateway | undefined {
    return this.gateways.find((item) => item.name === channel || item.channel === channel);
  }

  private isSenderAllowed(
    account: AgentAccount,
    senderId: string,
    principal: Principal | undefined,
  ): boolean {
    if (account.allowlist.length === 0) return true;
    if (account.allowlist.includes(senderId)) return true;
    if (senderId === account.ownerId) return true;
    if (principal && isOrgAdmin(principal)) return true;
    return false;
  }

  private async deliverFromGateway(
    context: GatewayItemContext,
    account: AgentAccount,
  ): Promise<InjectMessageResult> {
    return this.deliver({
      account,
      organizationId: account.organizationId,
      requesterId: account.ownerId,
      chatId: context.item.chatId,
      chatType: context.item.chatType,
      participantId: context.item.senderId,
      sender: { id: context.item.senderId, name: context.item.senderName },
      senderPrincipalId: undefined,
      channel: context.gateway.channel,
      channelMessageId: context.item.channelMessageId,
      kind: context.item.kind,
      text: context.item.text,
      mentions: context.item.mentions,
      attachments: context.item.attachments,
      replyTo: context.item.replyTo,
      metadata: { gateway: context.gateway.name },
    });
  }

  private async deliver(
    input: {
      account: AgentAccount;
      organizationId: string;
      requesterId: string;
      chatId: string;
      chatType: 'direct' | 'group';
      participantId: string;
      sender: { id: string; name: string };
      senderPrincipalId?: string;
      channel: ChatMessage['channel'];
      channelMessageId?: string;
      kind: ChatMessage['kind'];
      text: string;
      mentions: string[];
      attachments: ChatMessage['attachments'];
      replyTo?: string;
      metadata?: Record<string, unknown>;
    },
    existing?: Conversation,
  ): Promise<InjectMessageResult> {
    const conversation =
      existing ??
      (await this.conversations.findOrCreate({
        accountId: input.account.id,
        chatType: input.chatType,
        chatId: input.chatId,
        organizationId: input.organizationId,
        participantId: input.participantId,
        origin: input.channel === 'web' ? 'native' : 'external',
        targetKind: 'agent',
        targetId: input.account.id,
      }));

    const history = await this.buildHistory(conversation.id);

    const inbound: ChatMessage = {
      id: crypto.randomUUID(),
      channel: input.channel,
      channelMessageId: input.channelMessageId,
      accountId: input.account.id,
      conversationId: conversation.id,
      chatType: input.chatType,
      direction: 'inbound',
      kind: input.kind,
      text: input.text,
      sender: input.sender,
      senderPrincipalId: input.senderPrincipalId,
      mentions: input.mentions,
      attachments: input.attachments,
      replyTo: input.replyTo,
      createdAt: new Date().toISOString(),
      metadata: input.metadata,
    };
    await this.messages.append(inbound);
    await this.conversations.appendMessage(conversation.id, inbound.id);
    this.events.publish({
      type: 'message',
      conversationId: conversation.id,
      message: inbound,
      at: inbound.createdAt,
    });

    const goal = buildGoal(inbound);
    const task = await this.taskEngine.submit({
      accountId: input.account.id,
      conversationId: conversation.id,
      organizationId: input.organizationId,
      requesterId: input.requesterId,
      goal,
      input: { history },
      maxAttempts: 1,
    });

    return { authorized: true, conversationId: conversation.id, taskId: task.id, message: inbound };
  }

  private async buildHistory(conversationId: string): Promise<ModelMessage[]> {
    // Recalled messages are removed from the model context as well; otherwise
    // the AI would quote text the sender already withdrew.
    const list = (await this.messages.list(conversationId)).filter(
      (message) => !message.recalledAt,
    );
    return list.map((message) => {
      if (message.direction === 'inbound') {
        return { role: 'user', content: buildGoal(message) } satisfies ModelMessage;
      }
      return { role: 'assistant', content: message.text } satisfies ModelMessage;
    });
  }

  private async appendAssistantMessage(
    account: AgentAccount,
    conversation: Conversation,
    text: string,
  ): Promise<void> {
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      channel: account.channel,
      accountId: account.id,
      conversationId: conversation.id,
      chatType: conversation.chatType,
      direction: 'outbound',
      kind: 'text',
      text,
      sender: { id: account.id, name: account.displayName },
      mentions: [],
      attachments: [],
      createdAt: new Date().toISOString(),
    };
    await this.messages.append(message);
    await this.conversations.appendMessage(conversation.id, message.id);
    this.audit?.({ action: 'ai.message_sent', outcome: 'ok', actorId: account.id, organizationId: conversation.organizationId, target: conversation.id, detail: 'assistant_reply' });
    this.events.publish({
      type: 'message',
      conversationId: conversation.id,
      message,
      at: message.createdAt,
    });
  }

  /**
   * Publishes produced files into the conversation. The client renders these
   * attachments as download links, so an artifact is reachable from the chat
   * without hunting through the workspace view.
   */
  private async appendArtifactMessage(
    account: AgentAccount,
    conversation: Conversation,
    artifacts: StoredArtifactMeta[],
    taskId: string,
  ): Promise<void> {
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      channel: account.channel,
      accountId: account.id,
      conversationId: conversation.id,
      chatType: conversation.chatType,
      direction: 'outbound',
      kind: 'file',
      text: `已生成文件：${artifacts.map((artifact) => artifact.name).join('、')}`,
      sender: { id: account.id, name: account.displayName },
      mentions: [],
      attachments: artifacts.map((artifact) => ({
        id: artifact.id,
        name: artifact.name,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        url: artifact.url,
      })),
      createdAt: new Date().toISOString(),
      metadata: { taskId },
    };
    await this.messages.append(message);
    await this.conversations.appendMessage(conversation.id, message.id);
    this.audit?.({
      action: 'ai.message_sent',
      outcome: 'ok',
      actorId: account.id,
      organizationId: conversation.organizationId,
      target: conversation.id,
      detail: 'artifact_message',
    });
    this.events.publish({
      type: 'message',
      conversationId: conversation.id,
      message,
      at: message.createdAt,
    });
  }

  private async runTask(task: TaskRecord, context: TaskContext): Promise<TaskHandlerResult> {
    const account = await this.accounts.get(task.accountId);
    if (!account) throw new Error(`Unknown account ${task.accountId}`);

    const conversation = task.conversationId
      ? await this.conversations.get(task.conversationId)
      : undefined;

    const runId = crypto.randomUUID();
    const pendingMessages: Promise<void>[] = [];
    const requester = await this.directory.get(task.requesterId);
    const requesterIsAdmin = requester
      ? requester.roles.includes('owner') || requester.roles.includes('admin')
      : false;

    const taskWithHistory = await this.withRedactedHistory(task);
    const result: RunResult = await this.runtime.run({
      // The redacted goal: a recalled body must not reach the model on a re-run.
      goal: taskWithHistory.goal,
      history: (taskWithHistory.input?.history as ModelMessage[] | undefined) ?? [],
      account: { displayName: account.displayName, persona: account.persona },
      accountId: account.id,
      conversationId: task.conversationId,
      taskId: task.id,
      runId,
      organizationId: task.organizationId,
      ownerId: task.requesterId,
      isOrgAdmin: requesterIsAdmin,
      signal: context.signal,
      onEvent: (event) => {
        context.emit({
          type: 'progress',
          message: describeAgentEvent(event),
          data: { agentEvent: event },
        });
        if (event.type === 'assistant_message' && conversation && event.text.trim() !== '') {
          pendingMessages.push(this.appendAssistantMessage(account, conversation, event.text));
        }
      },
    });

    // Surface persistence failures instead of dropping them.
    await Promise.all(pendingMessages);

    // A pending approval blocks completion: the side effect has not happened.
    const approvalMarker = findApprovalMarker(result.toolCalls);
    if (approvalMarker) {
      return { kind: 'waiting_approval', approvalId: approvalMarker.approvalId };
    }
    const deliveryStates = collectDeliveryStates(result.toolCalls);
    // Strict artifact binding: only artifacts written with this taskId.
    const bound = await this.artifacts.listByTask(task.id);
    const existing = new Set(task.artifacts.map((artifact) => artifact.id));
    const newlyProduced: StoredArtifactMeta[] = [];
    for (const artifact of bound) {
      if (existing.has(artifact.id)) continue;
      newlyProduced.push(artifact);
      await context.appendArtifact({
        id: artifact.id,
        kind: 'file',
        name: artifact.name,
        mimeType: artifact.mimeType,
        url: artifact.url,
        summary: `Generated ${artifact.name}`,
        organizationId: artifact.organizationId,
        ownerId: artifact.ownerId,
        taskId: artifact.taskId,
        runId: artifact.runId,
      });
    }

    // Files produced by this run are attached to the conversation as a real
    // message, so the requester can download them from the chat itself.
    if (conversation && newlyProduced.length > 0) {
      await this.appendArtifactMessage(account, conversation, newlyProduced, task.id);
    }

    switch (result.outcome.status) {
      case 'succeeded': {
        if (requiresArtifact(task.goal) && bound.length === 0) {
          return {
            kind: 'incomplete',
            reason: 'delivery_unknown',
            message: '任务声明完成，但没有产生可验证的产物。',
          };
        }
        if (deliveryStates.includes('simulated') || deliveryStates.includes('unknown')) {
          return {
            kind: 'incomplete',
            reason: 'delivery_unknown',
            message: '外发仅记录 simulated/unknown，未确认送达，不计为完成。',
          };
        }
        if (deliveryStates.includes('failed')) {
          return {
            kind: 'incomplete',
            reason: 'delivery_failed',
            message: '外发被网关拒绝，任务未完成。',
          };
        }
        return { kind: 'completed', result: result.outcome.summary };
      }
      case 'cancelled':
        return { kind: 'cancelled', reason: result.outcome.reason };
      case 'failed':
        return {
          kind: 'failed',
          error: result.outcome.message,
          retryable: result.outcome.retryable,
        };
      case 'incomplete':
        return {
          kind: 'incomplete',
          reason: result.outcome.reason,
          message: result.outcome.message,
        };
    }
  }
}

/**
 * Replaces any string that contains a recalled body inside an event payload.
 * Task events embed the goal and progress text, so they are a read path too.
 */
function redactEventPayloads(events: TaskEvent[], recalled: string[]): TaskEvent[] {
  const scrub = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return recalled.some((text) => value.includes(text)) ? '[已撤回]' : value;
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, scrub(item)]),
      );
    }
    return value;
  };
  return events.map((event) => scrub(event) as TaskEvent);
}

/** Upper bound on the transcript size (newest messages win). */
const EXPORT_MESSAGE_LIMIT = 500;

/**
 * Removes the body of a recalled message. Storage keeps the original text for
 * auditability, but readers, previews and the API never receive it.
 */
function hideRecalledContent(message: ChatMessage): ChatMessage {
  if (!message.recalledAt) return message;
  return { ...message, text: '', attachments: [] };
}

function buildDedupeKey(
  gatewayName: string,
  item: NormalizedInbound,
  fallback?: string,
): string | undefined {
  if (item.channelMessageId) return `${gatewayName}:${item.channelMessageId}`;
  return fallback ? `${gatewayName}:${fallback}` : undefined;
}

/** Generation-style requests must produce a verifiable artifact. */
function requiresArtifact(goal: string): boolean {
  return /word|docx|excel|xlsx|文档|表格|工作簿|报告/i.test(goal);
}

/** Removes "@Display Name" prefixes for the given mentions. */
function stripMention(text: string, names: string[]): string {
  let result = text;
  for (const name of names) {
    if (!name) continue;
    result = result.split(`@${name}`).join(' ');
  }
  return result.replace(/\s{2,}/g, ' ');
}

function generateToken(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
}

function toMemberView(member: {
  id: string;
  displayName: string;
  organizationId: string;
  roles: string[];
}): MemberView {
  return {
    id: member.id,
    displayName: member.displayName,
    organizationId: member.organizationId,
    roles: [...member.roles],
    kind: 'member',
  };
}

function buildGoal(message: {
  text: string;
  attachments: Array<{ name: string; id: string }>;
}): string {
  const parts: string[] = [];
  const text = message.text.trim();
  if (text) parts.push(text);
  if (message.attachments.length > 0) {
    const files = message.attachments
      .map((attachment) => `${attachment.name} (id=${attachment.id})`)
      .join(', ');
    parts.push(`附件: ${files}`);
  }
  return parts.join('\n') || '(empty message)';
}

function describeAgentEvent(event: {
  type: string;
  [key: string]: unknown;
}): string {
  switch (event.type) {
    case 'turn_start':
      return `开始处理：${readString(event.goal)}`;
    case 'thinking':
      return readString(event.text) || '思考中';
    case 'tool_call_start':
      return `调用工具 ${readString(event.tool)}`;
    case 'tool_call_result':
      return readString(event.summary) || '工具执行完成';
    case 'assistant_message':
      return readString(event.text);
    case 'turn_end':
      return '任务结束';
    case 'turn_error':
      return `错误：${readString(event.error)}`;
    default:
      return event.type;
  }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

type DeliveryStateValue = 'simulated' | 'accepted' | 'delivered' | 'failed' | 'unknown';

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function findApprovalMarker(
  toolCalls: ToolCallRecord[],
): { approvalId: string; digest?: string } | undefined {
  let marker: { approvalId: string; digest?: string } | undefined;
  for (const call of toolCalls) {
    const output = readRecord(call.output);
    const approvalRequired = readRecord(output?.approvalRequired);
    const approvalId = approvalRequired?.approvalId;
    if (typeof approvalId === 'string' && approvalId !== '') {
      marker = {
        approvalId,
        digest: typeof approvalRequired?.digest === 'string' ? approvalRequired.digest : undefined,
      };
    }
  }
  return marker;
}

function collectDeliveryStates(toolCalls: ToolCallRecord[]): DeliveryStateValue[] {
  const states: DeliveryStateValue[] = [];
  for (const call of toolCalls) {
    const output = readRecord(call.output);
    const delivery = readRecord(output?.delivery);
    const state = delivery?.state;
    if (
      state === 'simulated' ||
      state === 'accepted' ||
      state === 'delivered' ||
      state === 'failed' ||
      state === 'unknown'
    ) {
      states.push(state);
    }
  }
  return states;
}

function fileView(file: StoredFileMeta): BaseFileView {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    createdAt: file.createdAt,
  };
}

function artifactView(artifact: StoredArtifactMeta): BaseFileView {
  return {
    id: artifact.id,
    name: artifact.name,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    createdAt: artifact.createdAt,
    url: artifact.url,
    taskId: artifact.taskId,
  };
}
