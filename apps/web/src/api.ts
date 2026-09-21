import type {
  AgentAccount,
  AgentIntakeNotice,
  ApprovalRecord,
  ChatMessage,
  Conversation,
  ConversationSummary,
  ConversationTargetKind,
  DocumentSummary,
  FriendRequestRecord,
  LocalTaskReceipt,
  MemberView,
  OutboxRecord,
  TaskEvent,
  TaskRecord,
} from '@chatagent/contracts';

const BASE = '/api';
const TOKEN_KEY = 'chatagent.session.token';

let sessionToken: string | null = readStoredToken();
const unauthorizedListeners = new Set<() => void>();

function readStoredToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setSessionToken(token: string | null): void {
  sessionToken = token;
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage can be unavailable (private mode); the in-memory token still works.
  }
}

export function hasSessionToken(): boolean {
  return sessionToken !== null;
}

export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string> | undefined) ?? {}),
  };
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;

  const response = await fetch(`${BASE}${path}`, { ...options, headers, credentials: 'same-origin' });
  if (!response.ok) {
    const body = await response.text();
    if (response.status === 401 && sessionToken) {
      setSessionToken(null);
      for (const listener of unauthorizedListeners) listener();
    }
    throw new ApiError(response.status, `${response.status} ${response.statusText}: ${body}`);
  }
  return (await response.json()) as T;
}

/**
 * Multipart POST with the session credentials attached.
 *
 * Uploads must not go through `request()` (it forces a JSON Content-Type and
 * would break the multipart boundary), but they still have to authenticate: the
 * packaged desktop client loads the UI from file://, so a cross-origin request
 * carries no cookie and a missing Authorization header means a silent 401.
 */
async function postForm<T>(path: string, form: FormData): Promise<T> {
  const headers: Record<string, string> = {};
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    body: form,
    headers,
    credentials: 'same-origin',
  });
  if (!response.ok) {
    const body = await response.text();
    if (response.status === 401 && sessionToken) {
      setSessionToken(null);
      for (const listener of unauthorizedListeners) listener();
    }
    throw new ApiError(response.status, `${response.status} ${response.statusText}: ${body}`);
  }
  return (await response.json()) as T;
}

export interface AgentStatus {
  provider: string;
  uptimeSeconds?: number;
  /** Server-side recall window; the client mirrors it instead of hardcoding. */
  recallWindowSeconds?: number;
  accounts: number;
  onlineAccounts: number;
  tasks: {
    total: number;
    running: number;
    pending: number;
    waitingApproval?: number;
    completed: number;
    failed: number;
  };
  approvals?: { pending: number; total: number };
  outbox?: { total: number; undelivered: number };
  runtime?: { queueDepth: number; streams: number; conversations: number };
  tools: string[];
}

export interface StoredFileView {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  url?: string;
}

export interface FileListView {
  artifacts: StoredFileView[];
  uploads: StoredFileView[];
}

export const api = {
  status: () => request<AgentStatus>('/agent/status'),

  auth: {
    login: (memberId: string, token: string) =>
      request<{ token: string; expiresAt: string; member: MemberView }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ memberId, token }),
      }),
    logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
    sessions: () =>
      request<Array<{ id: string; createdAt: string; expiresAt: string; lastSeenAt: string; current: boolean }>>(
        '/auth/sessions',
      ),
    revokeSession: (id: string) => request<{ ok: boolean }>(`/auth/sessions/${id}`, { method: 'DELETE' }),
    revokeOtherSessions: () =>
      request<{ revoked: number }>('/auth/sessions', { method: 'DELETE' }),
    rotateToken: () => request<{ token: string }>('/auth/token/rotate', { method: 'POST' }),
    me: () => request<MemberView>('/auth/me'),
  },

  contacts: () => request<MemberView[]>('/contacts'),

  /** The caller's own address-book entry for one contact (remark, block). */
  patchContact: (id: string, payload: { remark?: string | null; blocked?: boolean }) =>
    request<MemberView>('/contacts/' + id, { method: 'PATCH', body: JSON.stringify(payload) }),

  /** Friend requests: the inbox, sending one, and deciding one. */
  friends: {
    requests: () =>
      request<{ incoming: FriendRequestRecord[]; outgoing: FriendRequestRecord[] }>('/friend-requests'),
    request: (toMemberId: string, note?: string) =>
      request<FriendRequestRecord>('/friend-requests', {
        method: 'POST',
        body: JSON.stringify({ toMemberId, note }),
      }),
    decide: (id: string, decision: 'accept' | 'decline') =>
      request<FriendRequestRecord>('/friend-requests/' + id + '/decision', {
        method: 'POST',
        body: JSON.stringify({ decision }),
      }),
  },

  search: (query: string) =>
    request<
      Array<{
        conversationId: string;
        title?: string;
        message: { id: string; text: string; senderName: string; createdAt: string };
      }>
    >(`/search?q=${encodeURIComponent(query)}`),

  members: {
    list: () => request<MemberView[]>('/members'),
    create: (payload: { id: string; displayName: string; roles?: string[]; token?: string }) =>
      request<{ member: MemberView; token: string }>('/members', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    update: (id: string, payload: { displayName?: string; roles?: string[] }) =>
      request<MemberView>(`/members/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
    rotateToken: (id: string) =>
      request<{ member: MemberView; token: string }>(`/members/${id}/token`, { method: 'POST' }),
  },

  chat: {
    conversations: () => request<ConversationSummary[]>('/conversations'),
    markRead: (id: string) =>
      request<{ ok: boolean }>(`/conversations/${id}/read`, { method: 'POST' }),
    open: (targetId: string, targetKind: ConversationTargetKind) =>
      request<ConversationSummary>('/conversations', {
        method: 'POST',
        body: JSON.stringify({ targetId, targetKind }),
      }),
    exportConversation: (conversationId: string) =>
      request<{ id: string; name: string; url?: string }>(`/conversations/${conversationId}/export`, {
        method: 'POST',
      }),
    conversation: (conversationId: string) => request<Conversation>(`/conversations/${conversationId}`),
    readReceipts: (conversationId: string) =>
      request<{ me?: string; others: Array<{ memberId: string; lastReadAt: string }> }>(
        `/conversations/${conversationId}/read-receipts`,
      ),
    forward: (messageId: string, conversationId: string) =>
      request<{ ok: boolean; message: unknown }>(`/messages/${messageId}/forward`, {
        method: 'POST',
        body: JSON.stringify({ conversationId }),
      }),
    recall: (messageId: string) =>
      request<{ ok: boolean }>(`/messages/${messageId}/recall`, { method: 'POST' }),
    rename: (conversationId: string, title: string) =>
      request<Conversation>(`/conversations/${conversationId}`, {
        method: 'PATCH',
        body: JSON.stringify({ title }),
      }),
    /** Conversation appearance: a preset id or a plain hex colour. */
    setAppearance: (
      conversationId: string,
      payload: { background?: string; color?: string },
    ) =>
      request<Conversation>('/conversations/' + conversationId + '/appearance', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),

    /** Content hooks: regex rules that summon the group's assistants. */
    setHooks: (conversationId: string, hooks: string[]) =>
      request<Conversation>('/conversations/' + conversationId + '/hooks', {
        method: 'POST',
        body: JSON.stringify({ hooks }),
      }),

    /** Group governance: announcement, admins and dissolution. */
    /** Mute one conversation for the caller (notifications only). */
    setMuted: (conversationId: string, muted: boolean) =>
      request<{ ok: boolean; muted: boolean }>('/conversations/' + conversationId + '/mute', {
        method: 'POST',
        body: JSON.stringify({ muted }),
      }),

    setAnnouncement: (conversationId: string, announcement: string) =>
      request<Conversation>('/conversations/' + conversationId + '/announcement', {
        method: 'POST',
        body: JSON.stringify({ announcement }),
      }),
    setAdmin: (conversationId: string, memberId: string, admin: boolean) =>
      request<Conversation>('/conversations/' + conversationId + '/admins', {
        method: 'POST',
        body: JSON.stringify({ memberId, admin }),
      }),
    dissolve: (conversationId: string) =>
      request<Conversation>('/conversations/' + conversationId + '/dissolve', {
        method: 'POST',
      }),

    removeMember: (conversationId: string, memberId: string) =>
      request<{ ok: boolean }>(`/conversations/${conversationId}/members/${memberId}`, {
        method: 'DELETE',
      }),
    addMember: (conversationId: string, memberId: string) =>
      request<{ ok: boolean }>(`/conversations/${conversationId}/members`, {
        method: 'POST',
        body: JSON.stringify({ memberId }),
      }),
    leave: (conversationId: string) =>
      request<{ ok: boolean }>(`/conversations/${conversationId}/leave`, { method: 'POST' }),
    createGroup: (title: string, memberIds: string[]) =>
      request<ConversationSummary>('/groups', {
        method: 'POST',
        body: JSON.stringify({ title, memberIds }),
      }),
    messages: (id: string, options: { limit?: number; before?: string } = {}) => {
      const params = new URLSearchParams();
      if (options.limit) params.set('limit', String(options.limit));
      if (options.before) params.set('before', options.before);
      const query = params.toString();
      return request<ChatMessage[]>(
        `/conversations/${id}/messages${query ? `?${query}` : ''}`,
      );
    },
    send: (
      id: string,
      payload: {
        text: string;
        attachments?: ChatMessage['attachments'];
        mentions?: string[];
        replyTo?: string;
        /** Retry key: the server returns the existing message for a repeated id. */
        clientMsgId?: string;
      },
    ) =>
      request<{
        message: ChatMessage;
        taskId?: string;
        taskIds?: string[];
        /** Set for an assistant conversation: when the agent may read the message. */
        intake?: AgentIntakeNotice;
        /** One per mentioned assistant in a group. */
        intakes?: AgentIntakeNotice[];
      }>(
        `/conversations/${id}/messages`,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      ),
    upload: async (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return postForm<{ file: StoredFileView; summary: DocumentSummary }>('/documents/parse', form);
    },
  },

  approvals: {
    list: () => request<ApprovalRecord[]>('/approvals'),
    decide: (id: string, decision: 'approved' | 'rejected', reason?: string) =>
      request<ApprovalRecord>(`/approvals/${id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision, reason }),
      }),
  },

  outbox: {
    list: () => request<OutboxRecord[]>('/outbox'),
  },

  accounts: {
    list: () => request<AgentAccount[]>('/accounts'),
    create: (payload: Record<string, unknown>) =>
      request<AgentAccount>('/accounts', { method: 'POST', body: JSON.stringify(payload) }),
    update: (id: string, payload: Record<string, unknown>) =>
      request<AgentAccount>(`/accounts/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  },

  conversations: {
    list: (accountId?: string) =>
      request<ConversationSummary[]>(
        `/conversations${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ''}`,
      ),
    messages: (id: string, options: { limit?: number; before?: string } = {}) => {
      const params = new URLSearchParams();
      if (options.limit) params.set('limit', String(options.limit));
      if (options.before) params.set('before', options.before);
      const query = params.toString();
      return request<ChatMessage[]>(
        `/conversations/${id}/messages${query ? `?${query}` : ''}`,
      );
    },
  },

  messages: {
    send: (payload: Record<string, unknown>) =>
      request<{ ok: boolean; conversationId: string; taskId?: string }>('/messages', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
  },

  tasks: {
    list: () => request<TaskRecord[]>('/tasks'),
    resume: (id: string) =>
      request<{ ok: boolean; state?: string; reason?: string }>(`/tasks/${id}/resume`, {
        method: 'POST',
      }),
    get: (id: string) => request<TaskRecord>(`/tasks/${id}`),
    create: (payload: Record<string, unknown>) =>
      request<TaskRecord>('/tasks', { method: 'POST', body: JSON.stringify(payload) }),
    cancel: (id: string) =>
      request<{ cancelled: boolean }>(`/tasks/${id}/cancel`, { method: 'POST' }),
    events: (id: string) => request<TaskEvent[]>(`/tasks/${id}/events`),
  },

  localTasks: {
    /** Mirror on-device agent-host task receipts into the workbench (auth-scoped). */
    sync: (receipts: LocalTaskReceipt[]) =>
      request<{ accepted: number; stale?: number }>('/local-tasks', {
        method: 'POST',
        body: JSON.stringify({ receipts }),
      }),
    list: () => request<LocalTaskReceipt[]>('/local-tasks'),
  },

  documents: {
    parse: async (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return postForm<{ file: StoredFileView; summary: DocumentSummary }>('/documents/parse', form);
    },
    generateWord: (payload: Record<string, unknown>) =>
      request<StoredFileView>('/documents/generate/word', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    generateExcel: (payload: Record<string, unknown>) =>
      request<StoredFileView>('/documents/generate/excel', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
  },

  files: {
    list: () => request<FileListView>('/files'),
    downloadUrl: (id: string) => `${BASE}/files/${id}`,
  },

  gateway: {
    outbound: () => request<unknown[]>('/gateway/outbound'),
  },

  audit: {
    list: (limit = 100) =>
      request<
        Array<{
          at?: string;
          action?: string;
          outcome?: string;
          actorId?: string;
          target?: string;
          detail?: string;
        }>
      >(`/audit?limit=${limit}`),
  },
};
