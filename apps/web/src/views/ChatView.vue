<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type {
  ApprovalRecord,
  ChatMessage,
  ConversationSummary,
  MemberView,
  TaskRecord,
} from '@chatagent/contracts';
import { api } from '../api';

const props = defineProps<{ me: MemberView | null }>();
const emit = defineEmits<{ 'unread-total': [count: number] }>();

const contacts = ref<MemberView[]>([]);
const conversations = ref<ConversationSummary[]>([]);
const activeId = ref('');
const messages = ref<ChatMessage[]>([]);
const text = ref('');
const attachments = ref<ChatMessage['attachments']>([]);
const error = ref('');
const sending = ref(false);
const uploading = ref(false);
const loadingMessages = ref(false);
const loadingEarlier = ref(false);
const hasEarlier = ref(false);
const streamState = ref<'connecting' | 'open' | 'closed'>('connecting');
const PAGE_SIZE = 50;
const activeTask = ref<TaskRecord | null>(null);
const pendingApproval = ref<ApprovalRecord | null>(null);
const threadRef = ref<HTMLElement | null>(null);
const filter = ref('');
const searchQuery = ref('');
const searchResults = ref<
  Array<{
    conversationId: string;
    title?: string;
    message: { id: string; text: string; senderName: string; createdAt: string };
  }>
>([]);
const searching = ref(false);
const groupDialog = ref(false);
const groupTitle = ref('');
const groupMembers = ref<string[]>([]);
const mentions = ref<string[]>([]);
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let stream: EventSource | undefined;

const meId = computed(() => props.me?.id ?? '');
const canApprove = computed(() => {
  const roles = props.me?.roles ?? [];
  return roles.includes('owner') || roles.includes('admin');
});

const activeConversation = computed(
  () => conversations.value.find((item) => item.id === activeId.value) ?? null,
);

const totalUnread = computed(() =>
  conversations.value.reduce((sum, item) => sum + item.unreadCount, 0),
);

const visibleConversations = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  if (!needle) return conversations.value;
  return conversations.value.filter((item) => titleOf(item).toLowerCase().includes(needle));
});

const visibleContacts = computed(() => {
  const needle = filter.value.trim().toLowerCase();
  const list = contacts.value.filter((contact) => contact.id !== meId.value);
  if (!needle) return list;
  return list.filter((contact) => contact.displayName.toLowerCase().includes(needle));
});

const isAgentConversation = computed(() => activeConversation.value?.targetKind === 'agent');

const QUICK_PROMPTS = [
  '帮我生成一份本周工作周报（Word）',
  '把上面讨论整理成 Excel 表格',
  '解析我刚发的文件并总结要点',
];

function peerOf(conversation: ConversationSummary): MemberView | undefined {
  const peerId = conversation.participantIds.find((id) => id !== meId.value);
  return contacts.value.find((contact) => contact.id === peerId);
}

function titleOf(conversation: ConversationSummary): string {
  if (conversation.targetKind === 'group') return conversation.title ?? '群聊';
  return peerOf(conversation)?.displayName ?? conversation.title ?? conversation.chatId;
}

function avatarLabel(conversation: ConversationSummary): string {
  if (conversation.targetKind === 'agent') return 'AI';
  if (conversation.targetKind === 'group') return '群';
  return titleOf(conversation).slice(0, 1);
}

function isMine(message: ChatMessage): boolean {
  return message.sender.id === meId.value;
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return '今天';
  if (sameDay(date, yesterday)) return '昨天';
  return date.toLocaleDateString();
}

function needsDayDivider(index: number): boolean {
  if (index === 0) return true;
  const current = messages.value[index];
  const previous = messages.value[index - 1];
  if (!current || !previous) return false;
  return dayLabel(current.createdAt) !== dayLabel(previous.createdAt);
}

function isCompact(index: number): boolean {
  if (index === 0) return false;
  const current = messages.value[index];
  const previous = messages.value[index - 1];
  if (!current || !previous) return false;
  if (current.sender.id !== previous.sender.id) return false;
  if (dayLabel(current.createdAt) !== dayLabel(previous.createdAt)) return false;
  return Date.parse(current.createdAt) - Date.parse(previous.createdAt) < 5 * 60 * 1000;
}

/** Fallback when the server has not reported its recall window yet. */
const DEFAULT_RECALL_WINDOW_MS = 120000;
const recallWindowMs = ref(DEFAULT_RECALL_WINDOW_MS);

/** The server is authoritative about the recall window. */
async function loadRecallWindow() {
  try {
    const status = await api.status();
    if (typeof status.recallWindowSeconds === 'number') {
      recallWindowMs.value = Math.max(0, status.recallWindowSeconds) * 1000;
    }
  } catch {
    // Keep the fallback; the server still enforces its own window.
  }
}

const peerReadAt = ref<string | undefined>(undefined);
const peerReadCursors = ref<Array<{ memberId: string; lastReadAt: string }>>([]);
const myLastMessageId = ref<string | undefined>(undefined);

/**
 * In a 1:1 conversation the peer's read cursor answers "did they see it?".
 * Groups are intentionally not summarised here: showing a partial count would
 * be misleading without per-member receipts.
 */
const receiptState = computed<'read' | 'unread' | undefined>(() => {
  if (activeConversation.value?.targetKind !== 'member') return undefined;
  if (!myLastMessageId.value) return undefined;
  if (!peerReadAt.value) return 'unread';
  const mine = messages.value.find((message) => message.id === myLastMessageId.value);
  if (!mine) return undefined;
  return Date.parse(peerReadAt.value) >= Date.parse(mine.createdAt) ? 'read' : 'unread';
});

/**
 * How many colleagues have seen my last message in a group. A partial count is
 * honest here because every reader is reported individually by the server; the
 * AI account never counts as a reader.
 */
const groupReadCount = computed<number | undefined>(() => {
  if (activeConversation.value?.targetKind !== 'group') return undefined;
  if (!myLastMessageId.value) return undefined;
  const mine = messages.value.find((message) => message.id === myLastMessageId.value);
  if (!mine) return undefined;
  return peerReadCursors.value.filter((entry) => Date.parse(entry.lastReadAt) >= Date.parse(mine.createdAt))
    .length;
});

async function loadReadReceipts(conversationId: string) {
  peerReadAt.value = undefined;
  peerReadCursors.value = [];
  try {
    const receipts = await api.chat.readReceipts(conversationId);
    peerReadCursors.value = receipts.others;
    peerReadAt.value = receipts.others[0]?.lastReadAt;
  } catch {
    // Receipts are a nicety: never block the conversation on them.
    peerReadAt.value = undefined;
  }
}

const exporting = ref(false);

/** Exports the open conversation as a Word transcript and opens the download. */
async function exportConversation() {
  if (!activeId.value) return;
  exporting.value = true;
  error.value = '';
  try {
    const file = await api.chat.exportConversation(activeId.value);
    const url = file.url ?? `/api/files/${file.id}`;
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.click();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    exporting.value = false;
  }
}

const memberPanel = ref(false);
const forwardDialog = ref(false);
const forwardTarget = ref('');
const forwardSource = ref<ChatMessage | null>(null);
const notice = ref('');

/** Conversations a message can be forwarded into (never the AI assistant). */
const forwardTargets = computed(() =>
  conversations.value.filter(
    (conversation) =>
      conversation.id !== activeId.value &&
      (conversation.targetKind === 'member' || conversation.targetKind === 'group'),
  ),
);

function openForwardDialog(message: ChatMessage) {
  forwardSource.value = message;
  forwardTarget.value = '';
  notice.value = '';
  forwardDialog.value = true;
}

async function forwardMessage() {
  if (!forwardSource.value || forwardTarget.value === '') return;
  try {
    await api.chat.forward(forwardSource.value.id, forwardTarget.value);
    forwardDialog.value = false;
    notice.value = '已转发';
    await loadConversations(true);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}
const renameDialog = ref(false);
const renameTitle = ref('');

function openRenameDialog() {
  renameTitle.value = activeConversation.value?.title ?? '';
  renameDialog.value = true;
}

async function renameGroup() {
  if (!activeId.value || renameTitle.value.trim() === '') return;
  try {
    await api.chat.rename(activeId.value, renameTitle.value.trim());
    renameDialog.value = false;
    await loadConversations(true);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function removeMember(memberId: string) {
  if (!activeId.value) return;
  try {
    await api.chat.removeMember(activeId.value, memberId);
    await loadGroupMembers(activeId.value);
    await loadConversations(true);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}
const participantList = ref<Array<{ id: string; displayName: string; kind: string }>>([]);

/** Names of the current participants, resolved from the contact list. */
async function loadGroupMembers(conversationId: string) {
  try {
    // Read the conversation from the server: the cached list can be stale after
    // somebody else invited a member.
    const [contacts, fresh] = await Promise.all([
      api.contacts(),
      api.chat.conversation(conversationId).catch(() => undefined),
    ]);
    const conversation = fresh ?? conversations.value.find((item) => item.id === conversationId);
    const ids = conversation?.participantIds ?? [];
    participantList.value = ids.map((id) => {
      const contact = contacts.find((item) => item.id === id);
      return { id, displayName: contact?.displayName ?? id, kind: contact?.kind ?? 'member' };
    });
  } catch {
    participantList.value = [];
  }
}

const inviteDialog = ref(false);
const inviteTarget = ref('');

function canRecall(message: ChatMessage): boolean {
  if (message.recalledAt) return false;
  if (message.direction !== 'inbound') return false;
  if (message.sender.id !== meId.value) return false;
  if (recallWindowMs.value <= 0) return false;
  return Date.now() - new Date(message.createdAt).getTime() <= recallWindowMs.value;
}

function rememberOwnLastMessage() {
  const mine = [...messages.value].reverse().find((message) => message.sender.id === meId.value);
  myLastMessageId.value = mine?.id;
}

async function recallMessage(message: ChatMessage) {
  error.value = '';
  try {
    await api.chat.recall(message.id);
    const recalledAt = new Date().toISOString();
    messages.value = messages.value.map((item) =>
      item.id === message.id ? { ...item, text: '', attachments: [], recalledAt } : item,
    );
    await loadConversations(true);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function inviteMember() {
  if (!activeId.value || !inviteTarget.value) return;
  error.value = '';
  try {
    await api.chat.addMember(activeId.value, inviteTarget.value);
    inviteDialog.value = false;
    inviteTarget.value = '';
    await loadConversations(true);
    await loadActiveTask();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function leaveGroup() {
  if (!activeId.value) return;
  error.value = '';
  try {
    await api.chat.leave(activeId.value);
    activeId.value = '';
    messages.value = [];
    await loadConversations(false);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

const groupCandidates = computed(() =>
  contacts.value.filter((contact) => contact.id !== meId.value),
);

/** AI accounts that participate in the active group and can be summoned. */
const groupAgents = computed(() => {
  const conversation = activeConversation.value;
  if (!conversation || conversation.targetKind !== 'group') return [];
  return conversation.participantIds
    .map((id) => contacts.value.find((contact) => contact.id === id))
    .filter((contact): contact is MemberView => contact?.kind === 'agent');
});

function summon(agent: MemberView) {
  if (!mentions.value.includes(agent.id)) mentions.value = [...mentions.value, agent.id];
  if (!text.value.includes(`@${agent.displayName}`)) {
    text.value = `${text.value}${text.value && !text.value.endsWith(' ') ? ' ' : ''}@${agent.displayName} `;
  }
}

async function createGroup() {
  error.value = '';
  if (!groupTitle.value.trim() || groupMembers.value.length === 0) {
    error.value = '请填写群名称并至少选择一位成员';
    return;
  }
  try {
    const conversation = await api.chat.createGroup(groupTitle.value.trim(), groupMembers.value);
    groupDialog.value = false;
    groupTitle.value = '';
    groupMembers.value = [];
    await loadConversations(true);
    await select(conversation.id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function previewOf(conversation: ConversationSummary): string {
  const last = conversation.lastMessage;
  if (!last) return '还没有消息';
  const prefix = last.senderId === meId.value ? '我：' : `${last.senderName}：`;
  return `${prefix}${last.text || '（附件）'}`;
}

async function scrollToBottom() {
  await nextTick();
  const element = threadRef.value;
  if (element) element.scrollTop = element.scrollHeight;
}

function runSearch() {
  if (searchTimer) clearTimeout(searchTimer);
  const query = searchQuery.value.trim();
  if (query.length < 2) {
    searchResults.value = [];
    searching.value = false;
    return;
  }
  searching.value = true;
  searchTimer = setTimeout(() => {
    void api
      .search(query)
      .then((hits) => {
        searchResults.value = hits;
      })
      .catch(() => {
        searchResults.value = [];
      })
      .finally(() => {
        searching.value = false;
      });
  }, 250);
}

async function openSearchHit(conversationId: string) {
  searchQuery.value = '';
  searchResults.value = [];
  if (!conversations.value.some((item) => item.id === conversationId)) {
    await loadConversations(true);
  }
  await select(conversationId);
}

async function loadContacts() {
  try {
    contacts.value = await api.contacts();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function loadConversations(keepActive = true) {
  try {
    conversations.value = await api.chat.conversations();
    if (!keepActive || !activeId.value) {
      const first = conversations.value[0];
      if (first) await select(first.id);
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function select(id: string) {
  activeId.value = id;
  attachments.value = [];
  loadingMessages.value = true;
  try {
    const page = await api.chat.messages(id, { limit: PAGE_SIZE });
    messages.value = page;
    hasEarlier.value = page.length === PAGE_SIZE;
    rememberOwnLastMessage();
    void loadReadReceipts(id);
    await api.chat.markRead(id);
    const target = conversations.value.find((item) => item.id === id);
    if (target) target.unreadCount = 0;
    await scrollToBottom();
    await loadActiveTask();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loadingMessages.value = false;
  }
}

async function loadEarlier() {
  const first = messages.value[0];
  if (!first || loadingEarlier.value) return;
  loadingEarlier.value = true;
  try {
    const page = await api.chat.messages(activeId.value, {
      limit: PAGE_SIZE,
      before: first.id,
    });
    if (page.length > 0) messages.value = [...page, ...messages.value];
    hasEarlier.value = page.length === PAGE_SIZE;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loadingEarlier.value = false;
  }
}

async function loadActiveTask() {
  if (!activeId.value) return;
  try {
    const tasks = await api.tasks.list();
    const scoped = tasks
      .filter((task) => task.conversationId === activeId.value)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    activeTask.value = scoped[0] ?? null;

    if (activeTask.value?.state === 'waiting_approval') {
      const approvals = await api.approvals.list();
      pendingApproval.value =
        approvals.find(
          (approval) => approval.taskId === activeTask.value?.id && approval.status === 'pending',
        ) ?? null;
    } else {
      pendingApproval.value = null;
    }
  } catch {
    activeTask.value = null;
    pendingApproval.value = null;
  }
}

async function openContact(contact: MemberView) {
  error.value = '';
  try {
    const conversation = await api.chat.open(
      contact.id,
      contact.kind === 'agent' ? 'agent' : 'member',
    );
    await loadConversations(false);
    await select(conversation.id);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function send() {
  if (!activeId.value) return;
  if (text.value.trim() === '' && attachments.value.length === 0) return;
  sending.value = true;
  error.value = '';
  try {
    await api.chat.send(activeId.value, {
      text: text.value,
      attachments: attachments.value,
      mentions: mentions.value,
    });
    text.value = '';
    attachments.value = [];
    mentions.value = [];
    messages.value = await api.chat.messages(activeId.value, { limit: PAGE_SIZE });
    rememberOwnLastMessage();
    void loadReadReceipts(activeId.value);
    await scrollToBottom();
    await loadConversations(false);
    await loadActiveTask();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    sending.value = false;
  }
}

function usePrompt(prompt: string) {
  text.value = prompt;
}

async function onFileChange(uploadFile: { raw?: File }) {
  const file = uploadFile.raw;
  if (!file) return;
  uploading.value = true;
  error.value = '';
  try {
    const result = await api.chat.upload(file);
    attachments.value = [
      ...attachments.value,
      { id: result.file.id, name: result.file.name, mimeType: result.file.mimeType },
    ];
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    uploading.value = false;
  }
}

async function decide(decision: 'approved' | 'rejected') {
  if (!pendingApproval.value) return;
  const approval = pendingApproval.value;
  const task = activeTask.value;
  error.value = '';
  try {
    await api.approvals.decide(approval.id, decision);
    if (decision === 'approved' && task) await api.tasks.resume(task.id);
    await loadActiveTask();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function taskTagType(state: string): 'success' | 'danger' | 'warning' | 'info' | 'primary' {
  if (state === 'completed') return 'success';
  if (state === 'failed' || state === 'cancelled') return 'danger';
  if (state === 'waiting_approval' || state === 'waiting_input' || state === 'incomplete') {
    return 'warning';
  }
  if (state === 'running') return 'primary';
  return 'info';
}

function connectStream() {
  stream = new EventSource('/api/events/stream');
  stream.onopen = () => {
    streamState.value = 'open';
  };
  stream.onerror = () => {
    // EventSource reconnects on its own; surface the gap to the user.
    streamState.value = 'closed';
  };
  stream.addEventListener('message', (raw) => {
    const event = JSON.parse((raw as MessageEvent).data) as {
      conversationId: string;
      message: ChatMessage;
    };
    if (event.conversationId === activeId.value) {
      if (!messages.value.some((item) => item.id === event.message.id)) {
        messages.value = [...messages.value, event.message];
      }
      if (event.message.sender.id !== meId.value) void api.chat.markRead(activeId.value);
      void scrollToBottom();
    } else if (event.message.sender.id !== meId.value) {
      notify(event.conversationId, event.message);
    }
    void loadConversations(true);
  });
  stream.addEventListener('message_recalled', (raw) => {
    const event = JSON.parse((raw as MessageEvent).data) as {
      conversationId: string;
      messageId: string;
      recalledAt: string;
    };
    if (event.conversationId === activeId.value) {
      messages.value = messages.value.map((item) =>
        item.id === event.messageId
          ? { ...item, text: '', attachments: [], recalledAt: event.recalledAt }
          : item,
      );
    }
    void loadConversations(true);
  });
  stream.addEventListener('conversation_updated', (raw) => {
    const event = JSON.parse((raw as MessageEvent).data) as { conversationId: string; title: string };
    conversations.value = conversations.value.map((item) =>
      item.id === event.conversationId ? { ...item, title: event.title } : item,
    );
  });
  stream.addEventListener('task', (raw) => {
    const event = JSON.parse((raw as MessageEvent).data) as { conversationId?: string };
    if (event.conversationId === activeId.value) void loadActiveTask();
  });
  stream.addEventListener('approval', () => {
    void loadActiveTask();
  });
}

watch(
  () => messages.value.length,
  () => {
    void scrollToBottom();
  },
);

watch(totalUnread, (count) => {
  emit('unread-total', count);
  document.title = count > 0 ? `(${count}) ChatAgent` : 'ChatAgent';
});

/** Desktop notification for messages that arrive while the tab is hidden. */
function notify(conversationId: string, message: ChatMessage) {
  if (typeof Notification === 'undefined') return;
  if (document.visibilityState === 'visible') return;
  if (conversationId === activeId.value) return;
  if (Notification.permission !== 'granted') return;
  const conversation = conversations.value.find((item) => item.id === conversationId);
  try {
    new Notification(titleOf(conversation ?? ({ title: 'ChatAgent' } as ConversationSummary)), {
      body: `${message.sender.name}：${message.text || '（附件）'}`.slice(0, 120),
      tag: conversationId,
    });
  } catch {
    // Notification construction can fail on restricted platforms; ignore.
  }
}

function requestNotificationPermission() {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'default') void Notification.requestPermission();
}

function onGlobalKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    const input = document.querySelector<HTMLInputElement>('.chat-side input');
    input?.focus();
  }
}

onMounted(async () => {
  void loadRecallWindow();
  await loadContacts();
  await loadConversations();
  connectStream();
  window.addEventListener('keydown', onGlobalKeydown);
  requestNotificationPermission();
});

onUnmounted(() => {
  stream?.close();
  window.removeEventListener('keydown', onGlobalKeydown);
});
</script>

<template>
  <div class="chat">
    <el-dialog v-model="forwardDialog" title="转发消息" width="380px">
      <p class="muted">转发到同事或群聊（不转发给 AI 助手，避免意外触发任务）。</p>
      <el-select v-model="forwardTarget" filterable style="width: 100%" placeholder="选择会话">
        <el-option
          v-for="target in forwardTargets"
          :key="target.id"
          :label="`${titleOf(target)}（${target.targetKind === 'group' ? '群聊' : '同事'}）`"
          :value="target.id"
        />
      </el-select>
      <el-empty
        v-if="forwardTargets.length === 0"
        description="还没有可转发的会话，先和同事聊一句"
        :image-size="60"
      />
      <template #footer>
        <el-button @click="forwardDialog = false">取消</el-button>
        <el-button type="primary" :disabled="forwardTarget === ''" @click="forwardMessage">
          转发
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="renameDialog" title="修改群名" width="360px">
      <el-input v-model="renameTitle" maxlength="64" placeholder="新的群名" />
      <template #footer>
        <el-button @click="renameDialog = false">取消</el-button>
        <el-button type="primary" @click="renameGroup">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="memberPanel" title="群成员" width="360px" data-testid="member-panel">
      <el-empty v-if="participantList.length === 0" description="暂无成员" :image-size="60" />
      <ul v-else class="member-list">
        <li v-for="member in participantList" :key="member.id">
          <span class="member-name">{{ member.displayName }}</span>
          <span>
            <el-tag v-if="member.kind === 'agent'" size="small" type="primary">AI</el-tag>
            <el-button
              v-if="member.id !== meId"
              size="small"
              text
              type="danger"
              data-testid="remove-member"
              @click="removeMember(member.id)"
            >
              移出
            </el-button>
          </span>
        </li>
      </ul>
    </el-dialog>

    <el-dialog v-model="inviteDialog" title="邀请成员" width="380px">
      <el-select v-model="inviteTarget" filterable style="width: 100%" placeholder="选择同事或 AI 助手">
        <el-option
          v-for="contact in groupCandidates.filter(
            (item) => !activeConversation?.participantIds.includes(item.id),
          )"
          :key="contact.id"
          :label="contact.kind === 'agent' ? `${contact.displayName}（AI 助手）` : contact.displayName"
          :value="contact.id"
        />
      </el-select>
      <template #footer>
        <el-button @click="inviteDialog = false">取消</el-button>
        <el-button type="primary" @click="inviteMember">邀请</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="groupDialog" title="新建群聊" width="420px">
      <el-form label-position="top">
        <el-form-item label="群名称">
          <el-input v-model="groupTitle" placeholder="例如 项目周会" />
        </el-form-item>
        <el-form-item label="成员">
          <el-select v-model="groupMembers" multiple filterable style="width: 100%" placeholder="选择同事">
            <el-option
              v-for="contact in groupCandidates"
              :key="contact.id"
              :label="contact.kind === 'agent' ? `${contact.displayName}（AI 助手）` : contact.displayName"
              :value="contact.id"
            />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="groupDialog = false">取消</el-button>
        <el-button type="primary" @click="createGroup">创建</el-button>
      </template>
    </el-dialog>

    <el-alert
      v-if="streamState === 'closed'"
      title="实时连接已断开，正在自动重连…（消息可能需要手动刷新）"
      type="warning"
      show-icon
      class="card"
    />

    <el-alert
      v-if="error"
      :title="error"
      type="error"
      show-icon
      closable
      class="card"
      @close="error = ''"
    />

    <div class="chat-body">
      <aside class="chat-side">
        <el-card shadow="never" class="side-card">
          <template #header>
            <div class="side-title">
              <span>
                会话
                <el-badge v-if="totalUnread > 0" :value="totalUnread" class="unread-badge" />
              </span>
              <span class="side-actions">
                <el-tag size="small" type="info">{{ conversations.length }}</el-tag>
                <el-button size="small" text @click="groupDialog = true">＋群聊</el-button>
              </span>
            </div>
          </template>
          <el-input v-model="filter" size="small" placeholder="过滤会话或联系人" clearable />
          <el-input
            v-model="searchQuery"
            size="small"
            style="margin-top: 8px"
            placeholder="搜索聊天记录（至少 2 个字）"
            clearable
            :loading="searching"
            @input="runSearch"
          />
          <div v-if="searchResults.length > 0" class="search-results">
            <div
              v-for="hit in searchResults"
              :key="hit.message.id"
              class="search-hit"
              @click="openSearchHit(hit.conversationId)"
            >
              <div class="search-hit-title">
                {{ hit.title ?? hit.conversationId.slice(0, 8) }}
                <span class="stat-label">{{ new Date(hit.message.createdAt).toLocaleDateString() }}</span>
              </div>
              <div class="search-hit-text ellipsis">
                {{ hit.message.senderName }}：{{ hit.message.text }}
              </div>
            </div>
          </div>

          <el-empty
            v-if="visibleConversations.length === 0"
            description="从联系人开始会话"
            :image-size="60"
          />
          <div v-else class="side-list">
            <div
              v-for="conversation in visibleConversations"
              :key="conversation.id"
              class="side-item"
              data-testid="conversation-item"
              :class="{ active: conversation.id === activeId }"
              @click="select(conversation.id)"
            >
              <el-avatar
                :size="34"
                :style="{ background: conversation.targetKind === 'agent' ? '#409eff' : '#909399' }"
              >
                {{ avatarLabel(conversation) }}
              </el-avatar>
              <div class="side-item-main">
                <div class="side-item-title">
                  <span class="ellipsis">{{ titleOf(conversation) }}</span>
                  <el-badge v-if="conversation.unreadCount > 0" :value="conversation.unreadCount" />
                </div>
                <div class="side-item-sub ellipsis">{{ previewOf(conversation) }}</div>
              </div>
            </div>
          </div>
        </el-card>

        <el-card shadow="never" class="side-card">
          <template #header>
            <div class="side-title">
              <span>联系人</span>
              <el-tag size="small" type="info">{{ visibleContacts.length }}</el-tag>
            </div>
          </template>
          <div class="side-list">
            <div
              v-for="contact in visibleContacts"
              :key="contact.id"
              class="side-item"
              @click="openContact(contact)"
            >
              <el-badge
                :is-dot="contact.kind === 'member' && contact.online === true"
                type="success"
                class="presence-badge"
              >
                <el-avatar
                  :size="34"
                  :style="{ background: contact.kind === 'agent' ? '#409eff' : '#909399' }"
                >
                  {{ contact.kind === 'agent' ? 'AI' : contact.displayName.slice(0, 1) }}
                </el-avatar>
              </el-badge>
              <div class="side-item-main">
                <div class="side-item-title">
                  <span class="ellipsis">{{ contact.displayName }}</span>
                  <el-tag v-if="contact.kind === 'agent'" size="small" type="primary">AI</el-tag>
                </div>
                <div class="side-item-sub ellipsis">
                  {{
                    contact.kind === 'agent'
                      ? `AI 账号 · ${contact.accountStatus ?? 'offline'}`
                      : `成员 · ${contact.roles.join('/') || 'member'}${contact.online ? ' · 在线' : ''}`
                  }}
                </div>
              </div>
            </div>
          </div>
        </el-card>
      </aside>

      <section class="chat-main">
        <el-alert
          v-if="notice"
          :title="notice"
          type="success"
          show-icon
          class="notice"
          data-testid="notice"
          @close="notice = ''"
        />
        <el-card shadow="never" class="thread-card">
          <template #header>
            <div class="side-title">
              <span>{{ activeConversation ? titleOf(activeConversation) : '选择会话' }}</span>
              <el-tag v-if="isAgentConversation" size="small" type="primary">AI 助手</el-tag>
              <span
                v-else-if="activeConversation?.targetKind === 'group'"
                class="side-actions"
              >
                <el-tag size="small" type="success">
                  {{ activeConversation.participantIds.length }} 人
                </el-tag>
                <el-button size="small" text @click="inviteDialog = true">邀请成员</el-button>
                <el-button
                  size="small"
                  text
                  data-testid="members"
                  @click="
                    memberPanel = true;
                    void loadGroupMembers(activeConversation?.id ?? '');
                  "
                >
                  成员
                </el-button>
                <el-button
                  size="small"
                  text
                  data-testid="rename"
                  @click="openRenameDialog"
                >
                  改名
                </el-button>
                <el-button size="small" text type="danger" @click="leaveGroup">退出群聊</el-button>
              </span>
              <el-button
                v-if="activeConversation"
                size="small"
                text
                data-testid="export"
                :loading="exporting"
                @click="exportConversation"
              >
                导出记录
              </el-button>
            </div>
          </template>

          <div ref="threadRef" class="thread" role="log" aria-live="polite" aria-label="消息记录">
            <el-skeleton v-if="loadingMessages" :rows="6" animated />
            <template v-else>
              <!-- "Load earlier" belongs INSIDE the thread: as a sibling branch
                   of the message list it hides every bubble in a conversation
                   longer than one page. -->
              <div v-if="hasEarlier" class="load-earlier">
                <el-button size="small" text :loading="loadingEarlier" @click="loadEarlier">
                  加载更早的消息
                </el-button>
              </div>
              <el-empty
                v-if="messages.length === 0"
                description="还没有消息，打个招呼吧"
                :image-size="70"
              />
              <template v-else>
              <template v-for="(message, index) in messages" :key="message.id">
                <div v-if="needsDayDivider(index)" class="day-divider">
                  <span>{{ dayLabel(message.createdAt) }}</span>
                </div>
                <div class="bubble-row" :class="{ mine: isMine(message), compact: isCompact(index) }">
                  <el-avatar
                    v-if="!isCompact(index)"
                    :size="30"
                    :style="{ background: isMine(message) ? '#36cfc9' : '#409eff' }"
                  >
                    {{ isMine(message) ? (props.me?.displayName ?? '我').slice(0, 1) : 'AI' }}
                  </el-avatar>
                  <div v-else class="avatar-spacer" />
                  <div class="bubble" data-testid="message-bubble">
                    <div v-if="!isCompact(index)" class="bubble-meta">
                      {{ message.sender.name }} ·
                      {{ new Date(message.createdAt).toLocaleTimeString() }}
                    </div>
                    <div v-if="message.recalledAt" class="bubble-recalled">
                      {{ isMine(message) ? '你撤回了一条消息' : '对方撤回了一条消息' }}
                    </div>
                    <div v-else-if="message.text" class="bubble-text">{{ message.text }}</div>
                    <div v-if="!message.recalledAt && message.attachments.length" class="bubble-files">
                      <a
                        v-for="file in message.attachments"
                        :key="file.id"
                        class="file-chip"
                        :href="`/api/files/${file.id}`"
                        target="_blank"
                        rel="noopener"
                      >📎 {{ file.name }}</a>
                    </div>
                    <button
                      v-if="!message.recalledAt && message.conversationId"
                      class="bubble-recall"
                      data-testid="forward"
                      type="button"
                      @click="openForwardDialog(message)"
                    >
                      转发
                    </button>
                    <button
                      v-if="canRecall(message)"
                      class="bubble-recall"
                      data-testid="recall"
                      type="button"
                      @click="recallMessage(message)"
                    >
                      撤回
                    </button>
                    <span
                      v-if="
                        isMine(message) &&
                        message.id === myLastMessageId &&
                        (receiptState || groupReadCount !== undefined) &&
                        !message.recalledAt
                      "
                      class="bubble-receipt"
                      data-testid="receipt"
                    >
                      {{
                        receiptState
                          ? receiptState === 'read'
                            ? '已读'
                            : '未读'
                          : `${groupReadCount ?? 0} 人已读`
                      }}
                    </span>
                  </div>
                </div>
              </template>
            </template>
            </template>
          </div>

          <div v-if="activeTask" class="task-bar">
            <el-tag size="small" :type="taskTagType(activeTask.state)">
              <span v-if="activeTask.state === 'running'" class="pulse">●</span>
              任务 {{ activeTask.state }}
            </el-tag>
            <span class="task-text">{{ activeTask.result ?? activeTask.goal }}</span>
            <template v-if="pendingApproval && canApprove">
              <el-button size="small" type="primary" @click="decide('approved')">批准并发起</el-button>
              <el-button size="small" @click="decide('rejected')">驳回</el-button>
            </template>
            <span v-else-if="pendingApproval" class="task-hint">等待有权限的成员审批</span>
          </div>

          <div v-if="isAgentConversation && messages.length === 0" class="quick-prompts">
            <el-button
              v-for="prompt in QUICK_PROMPTS"
              :key="prompt"
              size="small"
              round
              @click="usePrompt(prompt)"
            >{{ prompt }}</el-button>
          </div>

          <div v-if="groupAgents.length > 0" class="summon-row">
            <span class="stat-label">召唤 AI：</span>
            <el-button
              v-for="agent in groupAgents"
              :key="agent.id"
              size="small"
              round
              :type="mentions.includes(agent.id) ? 'primary' : 'default'"
              @click="summon(agent)"
            >@{{ agent.displayName }}</el-button>
          </div>

          <div class="composer">
            <div v-if="attachments.length" class="composer-files">
              <el-tag
                v-for="(file, index) in attachments"
                :key="file.id"
                closable
                size="small"
                @close="attachments.splice(index, 1)"
              >📎 {{ file.name }}</el-tag>
            </div>
            <div class="composer-row">
              <el-upload :auto-upload="false" :show-file-list="false" :on-change="onFileChange">
                <el-button :loading="uploading" :disabled="!activeId">附件</el-button>
              </el-upload>
              <el-input
                v-model="text"
                data-testid="composer"
                type="textarea"
                :autosize="{ minRows: 1, maxRows: 5 }"
                resize="none"
                :disabled="!activeId"
                placeholder="发送消息给 AI 助手或同事（Enter 发送，Shift+Enter 换行）"
                @keydown.enter.exact.prevent="send"
              />
              <el-button
                type="primary"
                data-testid="send"
                :loading="sending"
                :disabled="!activeId"
                @click="send"
              >
                发送
              </el-button>
            </div>
          </div>
        </el-card>
      </section>
    </div>
  </div>
</template>

<style scoped>
.chat-body {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 16px;
  align-items: start;
}

.chat-side {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.side-card {
  margin: 0;
}

.side-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.side-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.unread-badge {
  margin-left: 10px;
}

.side-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 280px;
  overflow: auto;
  margin-top: 8px;
}

.side-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.side-item:hover {
  background: var(--ca-hover);
}

.side-item.active {
  background: var(--ca-active);
}

.side-item-main {
  min-width: 0;
  flex: 1;
}

.side-item-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 14px;
}

.notice {
  margin-bottom: 8px;
}

.presence-badge {
  line-height: 0;
}

.member-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.member-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 2px;
  border-bottom: 1px solid var(--ca-border);
}

.member-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bubble-receipt {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: var(--ca-muted);
  text-align: right;
}

.bubble-recalled {
  color: var(--ca-muted);
  font-style: italic;
}

.bubble-recall {
  margin-top: 4px;
  padding: 0;
  border: none;
  background: none;
  color: var(--ca-muted);
  font-size: 12px;
  cursor: pointer;
}

.bubble-recall:hover {
  color: #409eff;
}

.side-item-sub {
  font-size: 12px;
  color: var(--ca-muted);
  margin-top: 2px;
}

.ellipsis {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-results {
  margin-top: 8px;
  max-height: 180px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.search-hit {
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid var(--ca-border);
}

.search-hit:hover {
  background: var(--ca-hover);
}

.search-hit-title {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
}

.search-hit-text {
  font-size: 12px;
  color: var(--ca-muted);
}

.thread-card {
  margin: 0;
}

.load-earlier {
  display: flex;
  justify-content: center;
  padding: 2px 0 6px;
}

.thread {
  height: calc(100vh - 340px);
  min-height: 320px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 6px 4px 2px;
  scroll-behavior: smooth;
}

.day-divider {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--ca-muted);
  font-size: 12px;
  margin: 6px 0;
}

.day-divider::before,
.day-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--ca-border);
}

.bubble-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}

.bubble-row.mine {
  flex-direction: row-reverse;
}

.bubble-row.compact {
  margin-top: -4px;
}

.avatar-spacer {
  width: 30px;
}

.bubble {
  max-width: 68%;
  background: var(--ca-bubble-in);
  border-radius: 10px;
  padding: 8px 12px;
  transition: background 0.2s ease;
}

.bubble-row.mine .bubble {
  background: var(--ca-bubble-out);
}

.bubble-meta {
  font-size: 12px;
  color: var(--ca-muted);
  margin-bottom: 4px;
}

.bubble-text {
  white-space: pre-wrap;
  line-height: 1.6;
  word-break: break-word;
}

.bubble-files {
  margin-top: 6px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.file-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--ca-border);
  border-radius: 999px;
  font-size: 12px;
  color: #409eff;
  text-decoration: none;
  background: var(--ca-panel);
}

.file-chip:hover {
  border-color: #409eff;
}

.task-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-top: 1px solid var(--ca-border);
  font-size: 13px;
}

.pulse {
  animation: pulse 1.2s infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

.task-text {
  flex: 1;
  color: var(--ca-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-hint {
  color: var(--ca-muted);
  font-size: 12px;
}

.summon-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 8px 0 2px;
  border-top: 1px solid var(--ca-border);
}

.quick-prompts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 0 10px;
}

.composer {
  border-top: 1px solid var(--ca-border);
  padding-top: 10px;
}

.composer-files {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.composer-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}

@media (max-width: 900px) {
  .chat-body {
    grid-template-columns: 1fr;
  }

  .load-earlier {
  display: flex;
  justify-content: center;
  padding: 2px 0 6px;
}

.thread {
    height: 50vh;
  }

  .side-list {
    max-height: 200px;
  }
}
</style>
