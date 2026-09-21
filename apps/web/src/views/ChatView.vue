<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type {
  ApprovalRecord,
  ChatMessage,
  ConversationSummary,
  ForwardedFrom,
  FriendRequestRecord,
  MemberView,
  TaskRecord,
} from '@chatagent/contracts';
import { api } from '../api';
import AccountTierEditor from '../components/AccountTierEditor.vue';
import { decideNotification } from '../notifications';

const props = defineProps<{ me: MemberView | null }>();
const emit = defineEmits<{ 'unread-total': [count: number] }>();

const desktopWindow = computed(() => window.chatagent?.window);
/** Local mirror of the main process' window state, refreshed from its reply. */
const windowPinned = ref(false);
const windowVisible = ref(true);

async function windowAction(action: 'pin' | 'unpin' | 'toggle-pin' | 'hide' | 'show') {
  const bridge = desktopWindow.value;
  if (!bridge) return;
  try {
    const response = await bridge.set(action);
    if (response.ok && response.result) {
      windowPinned.value = response.result.pinned;
      windowVisible.value = response.result.visible;
    } else if (!response.ok) {
      error.value = `窗口操作失败：${response.error ?? 'unknown'}`;
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function refreshWindowState() {
  const bridge = desktopWindow.value;
  if (!bridge) return;
  // Ask the main process rather than assuming: the OS can change always-on-top too.
  const response = await bridge.set('show').catch(() => undefined);
  if (response?.ok && response.result) {
    windowPinned.value = response.result.pinned;
    windowVisible.value = response.result.visible;
  }
}
const contacts = ref<MemberView[]>([]);
const conversations = ref<ConversationSummary[]>([]);
const activeId = ref('');
const messages = ref<ChatMessage[]>([]);
const text = ref('');
const attachments = ref<ChatMessage['attachments']>([]);
const error = ref('');
const sending = ref(false);
/**
   * Set while this conversation has a message waiting for the recall window. The
   * assistant has not read it yet, and a recall cancels the handoff entirely.
   */
/** Idempotency key of the last failed send, so a retry reuses it (see send()). */
let lastDraft: { key: string; id: string } | undefined;

const intakeNotice = ref<{ dueAt?: string; count: number; cancelled?: boolean } | null>(null);
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
  // The viewer's own label wins: it is what they called the room, and only they see it.
  if (conversation.aliases?.title) return conversation.aliases.title;
  if (conversation.targetKind === 'group') return conversation.title ?? '群聊';
  const peer = peerOf(conversation);
  // A private label for the person beats their profile name, in the sidebar and the header.
  return peer ? nameOf(peer) : conversation.title ?? conversation.chatId;
}

/**
 * How a member is shown in the active conversation: the viewer's alias for them, else their
 * own nickname for themselves, else their profile name.
 */
function nameOf(contact: MemberView): string {
  const aliases = activeConversation.value?.aliases?.members;
  return aliases?.[contact.id] ?? contact.displayName;
}

function nameOfId(memberId: string, fallback: string): string {
  return activeConversation.value?.aliases?.members?.[memberId] ?? fallback;
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
const quoted = ref<ChatMessage | null>(null);
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

function startQuote(message: ChatMessage) {
  quoted.value = message;
  notice.value = '';
}

/** Short preview of a quoted message; recalled bodies stay hidden. */
function quotePreviewOf(message: ChatMessage): string {
  if (message.recalledAt) return '已撤回的消息';
  const text = message.text.trim();
  if (text !== '') return text.length > 60 ? `${text.slice(0, 60)}…` : text;
  if (message.attachments.length > 0) return `附件：${message.attachments.map((file) => file.name).join('、')}`;
  return '（无正文）';
}

/** Resolve the message a bubble quotes, if it is inside the loaded page. */
function quotedMessageOf(message: ChatMessage): ChatMessage | undefined {
  if (!message.replyTo) return undefined;
  return messages.value.find((item) => item.id === message.replyTo);
}

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

const announcementDraft = ref('');
/**
 * Appearance presets. The client owns the colours, the server only stores the id: that keeps a
 * background from ever being a style string coming off the network.
 */
const APPEARANCES: Array<{ id: string; label: string; background: string }> = [
  { id: 'default', label: '默认', background: '' },
  { id: 'paper', label: '纸张', background: '#f7f4ec' },
  { id: 'mint', label: '薄荷', background: '#eef7f1' },
  { id: 'sky', label: '天蓝', background: '#eef3fb' },
  { id: 'slate', label: '石板', background: '#2b2f36' },
];

/** The inline background style for the active conversation, if it has one. */
const conversationBackground = computed(() => {
  const appearance = activeConversation.value?.appearance;
  if (!appearance) return undefined;
  const preset = APPEARANCES.find((item) => item.id === appearance.background);
  // A hex colour wins over the preset; both are validated server-side before they arrive.
  const color = appearance.color ?? preset?.background;
  return color ? { background: color } : undefined;
});

/** True when the chosen background is dark, so the room can switch text to light. */
const conversationBackgroundIsDark = computed(() => {
  const color = activeConversation.value?.appearance?.color;
  if (!color) return activeConversation.value?.appearance?.background === 'slate';
  const value = Number.parseInt(color.slice(1), 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  // Perceived luminance, the same weighting the contrast checks use.
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
});

async function setAppearance(background: string) {
  if (!activeId.value) return;
  error.value = '';
  try {
    await api.chat.setAppearance(
      activeId.value,
      background === 'default' ? {} : { background },
    );
    await loadConversations(true);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}
const groupBusy = ref(false);
/** Dissolving takes two clicks: the first arms it, the second does it. */
const dissolveArmed = ref(false);
/** Content-hook patterns being edited, one per line. */
const hooksDraft = ref('');
/** Private labels for the active conversation: my name for the room and for each member. */
const aliasDialog = ref(false);
const aliasTitle = ref('');
const aliasDraft = ref<Record<string, string>>({});

function openAliasDialog() {
  aliasTitle.value = activeConversation.value?.aliases?.title ?? '';
  aliasDraft.value = { ...(activeConversation.value?.aliases?.members ?? {}) };
  aliasDialog.value = true;
}

async function saveAliases() {
  if (!activeId.value) return;
  error.value = '';
  try {
    // Blanks are dropped server-side, so clearing a label is just emptying the field.
    await api.chat.setAliases(activeId.value, {
      title: aliasTitle.value.trim(),
      members: aliasDraft.value,
    });
    aliasDialog.value = false;
    await loadConversations(true);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}


/**
 * Publishes the content hooks. Empty lines are dropped here; the server validates what is
 * left (length, compilation, unsafe shapes) and refuses the whole set if one rule is bad.
 */
async function publishHooks() {
  if (!activeId.value) return;
  groupBusy.value = true;
  error.value = '';
  try {
    const hooks = hooksDraft.value
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    await api.chat.setHooks(activeId.value, hooks);
    hooksDraft.value = hooks.join('\n');
    await loadConversations(true);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    groupBusy.value = false;
  }
}

/** True when the caller may run this group (owner, admin or org admin). */
const canManageGroup = computed(() => {
  const conversation = activeConversation.value;
  if (!conversation || conversation.targetKind !== 'group') return false;
  if (conversation.dissolvedAt) return false;
  return (conversation.adminIds ?? []).includes(meId.value) || conversation.ownerId === meId.value;
});

const isGroupOwner = computed(
  () => activeConversation.value?.targetKind === 'group' && activeConversation.value.ownerId === meId.value,
);

async function publishAnnouncement() {
  if (!activeId.value) return;
  groupBusy.value = true;
  error.value = '';
  try {
    await api.chat.setAnnouncement(activeId.value, announcementDraft.value.trim());
    announcementDraft.value = '';
    await loadConversations(true);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    groupBusy.value = false;
  }
}

/** Mute is per member: it changes notifications, never what other people see. */
async function toggleMuted() {
  if (!activeId.value) return;
  const muted = activeConversation.value?.muted !== true;
  error.value = '';
  try {
    await api.chat.setMuted(activeId.value, muted);
    await loadConversations(true);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function toggleGroupAdmin(memberId: string, admin: boolean) {
  if (!activeId.value) return;
  error.value = '';
  try {
    await api.chat.setAdmin(activeId.value, memberId, admin);
    await loadConversations(true);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function dissolveGroup() {
  if (!activeId.value) return;
  error.value = '';
  try {
    await api.chat.dissolve(activeId.value);
    dissolveArmed.value = false;
    memberPanel.value = false;
    await loadConversations(true);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
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

async function openSearchHit(hit: { conversationId: string; message: { id: string } }) {
  searchQuery.value = '';
  searchResults.value = [];
  if (!conversations.value.some((item) => item.id === hit.conversationId)) {
    await loadConversations(true);
  }
  await select(hit.conversationId);
  // Jump to the matching message and flash it so the hit is findable in a
  // long history instead of only opening the conversation at the newest page.
  await nextTick();
  const node = document.querySelector(`[data-message-id="${hit.message.id}"]`);
  if (node instanceof HTMLElement) {
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.remove('search-flash');
    void node.offsetWidth; // restart the animation on repeated hits
    node.classList.add('search-flash');
    setTimeout(() => node.classList.remove('search-flash'), 1800);
  }
}

async function loadContacts() {
  try {
    contacts.value = await api.contacts();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
  // The address book rides along with the contact list: the same view is what makes the
  // relation state (friend / pending / blocked) visible at a glance.
  await loadFriendRequests();
}

/** Incoming and outgoing friend requests, kept next to the contact list. */
const friendRequests = ref<{
  incoming: FriendRequestRecord[];
  outgoing: FriendRequestRecord[];
}>({ incoming: [], outgoing: [] });

async function loadFriendRequests() {
  try {
    friendRequests.value = await api.friends.requests();
  } catch {
    // The inbox is optional on screen: a failure must not hide the conversation list.
  }
}

async function requestFriend(contact: MemberView) {
  error.value = '';
  try {
    await api.friends.request(contact.id);
    await loadContacts();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function decideFriendRequest(request: FriendRequestRecord, decision: 'accept' | 'decline') {
  error.value = '';
  try {
    await api.friends.decide(request.id, decision);
    await loadContacts();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

const requestsOpen = ref(false);
/** The contact whose address-book card is open, and the remark being edited. */
const relationTarget = ref<MemberView | null>(null);
const relationRemark = ref('');

function openRelation(contact: MemberView) {
  relationTarget.value = contact;
  relationRemark.value = contact.relation?.remark ?? '';
}

function relationLabel(contact: MemberView): string {
  switch (contact.relation?.state) {
    case 'friend':
      return '好友';
    case 'request_in':
      return '待我确认';
    case 'request_out':
      return '待对方确认';
    case 'blocked':
      return '已拉黑';
    default:
      return '未添加';
  }
}

async function saveRelation(patch: { remark?: string | null; blocked?: boolean } = {}) {
  const target = relationTarget.value;
  if (!target) return;
  error.value = '';
  try {
    await api.patchContact(target.id, patch);
    relationTarget.value = null;
    await loadContacts();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

/** Accepts the incoming request shown on the open contact card. */
async function relationAccept() {
  const target = relationTarget.value;
  const requestId = target?.relation?.requestId;
  if (!target || !requestId) return;
  error.value = '';
  try {
    await api.friends.decide(requestId, 'accept');
    relationTarget.value = null;
    await loadContacts();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function toggleBlock(contact: MemberView) {
  // Blocking decides delivery, so the button says what will happen, not just the state.
  const blocked = contact.relation?.state !== 'blocked';
  error.value = '';
  try {
    await api.patchContact(contact.id, { blocked });
    await loadContacts();
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
  // One key per logical message. If this attempt fails (timeout, dropped response, the
  // user pressing send again) the same key is reused, so the server cannot store it twice.
  const draftKey = `${activeId.value}:${text.value}`;
  const clientMsgId =
    lastDraft?.key === draftKey ? lastDraft.id : (globalThis.crypto?.randomUUID?.() ?? String(Date.now()));
  try {
    const result = await api.chat.send(activeId.value, {
      text: text.value,
      attachments: attachments.value,
      mentions: mentions.value,
      replyTo: quoted.value?.id,
      clientMsgId,
    });
    lastDraft = undefined;
    // The host hands a message to an assistant only after the recall window has
    // elapsed. Say so, otherwise "why is the AI not answering" is the user's problem.
    const pending = [result?.intake, ...(result?.intakes ?? [])].filter(
      (notice): notice is NonNullable<typeof notice> => Boolean(notice),
    ).filter((notice) => notice.state === 'pending');
    intakeNotice.value = pending.length > 0 ? { dueAt: pending[0]?.dueAt, count: pending.length } : null;
    quoted.value = null;
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
    // Keep the key with the draft: retrying the same text reuses it instead of posting twice.
    lastDraft = { key: draftKey, id: clientMsgId };
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    sending.value = false;
  }
}

function usePrompt(prompt: string) {
  text.value = prompt;
}

/** Upload limits mirrored from the server, so an obvious mistake fails before the round trip. */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const DROP_EXTENSIONS = ['docx', 'doc', 'xlsx', 'xls', 'csv', 'txt', 'md', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'zip'];

/** True while a file is being dragged over the chat, to show the drop target. */
const draggingFile = ref(false);
/** Set when the app is fullscreen, so Esc can leave it (the browser blocks programmatic exit). */
const fullscreenHint = ref(false);

function isProbablyAllowedFile(file: File): boolean {
  const dot = file.name.lastIndexOf('.');
  if (dot < 0) return false;
  return DROP_EXTENSIONS.includes(file.name.slice(dot + 1).toLowerCase());
}

/** Shared entry point for the picker and for a drop: the server validates the bytes. */
async function acceptFile(file: File) {
  if (!isProbablyAllowedFile(file)) {
    error.value = `不支持的文件类型：${file.name}（允许：${DROP_EXTENSIONS.join('、')}）`;
    return;
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    error.value = `文件超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB：${file.name}`;
    return;
  }
  await onFileChange({ raw: file });
}

function onDropFiles(event: DragEvent) {
  draggingFile.value = false;
  const files = event.dataTransfer?.files;
  if (!files || files.length === 0) return;
  // The server accepts one file per request; extra files are refused with a reason
  // instead of being silently dropped.
  if (files.length > 1) {
    error.value = '一次只能发送一个文件（当前拖入了 ' + files.length + ' 个）';
    return;
  }
  const [file] = Array.from(files);
  if (file) void acceptFile(file);
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

/** True once the stream has dropped, so a reconnect knows to resynchronise. */
let streamWasDown = false;

/**
 * Merges the newest page back in after a reconnect. Messages are keyed by id, so the
 * replay and this re-read can overlap without duplicating bubbles.
 */
async function resyncAfterReconnect() {
  if (!activeId.value) return;
  try {
    const latest = await api.chat.messages(activeId.value, { limit: PAGE_SIZE });
    const merged = new Map(messages.value.map((item) => [item.id, item]));
    for (const item of latest) merged.set(item.id, item);
    if (merged.size !== messages.value.length) {
      messages.value = [...merged.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      await scrollToBottom();
    }
    void loadConversations(true);
  } catch {
    // Best effort: EventSource keeps retrying, and the next reconnect tries again.
  }
}

function connectStream() {
  stream = new EventSource('/api/events/stream');
  stream.onopen = () => {
    streamState.value = 'open';
    // The server replays what it still holds (Last-Event-ID) and this re-reads the visible
    // page: after a gap the thread must not keep a silent hole, whatever the reason the
    // stream dropped.
    if (streamWasDown) {
      streamWasDown = false;
      void resyncAfterReconnect();
    }
  };
  stream.onerror = () => {
    // EventSource reconnects on its own; surface the gap to the user.
    streamState.value = 'closed';
    streamWasDown = true;
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
      // A quoted message that was just recalled must not stay in the composer
      // strip: the captured object still holds the body.
      if (quoted.value?.id === event.messageId) quoted.value = null;
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
  stream.addEventListener('resync', () => {
    // The cursor was older than the server's replay buffer: reload instead of believing the
    // (empty) stream means "nothing happened while you were away".
    void resyncAfterReconnect();
  });

  stream.addEventListener('agent_intake', (raw) => {
    const event = JSON.parse((raw as MessageEvent).data) as {
      conversationId: string;
      state: 'pending' | 'submitted' | 'cancelled';
      dueAt?: string;
    };
    if (event.conversationId !== activeId.value) return;
    if (event.state === 'cancelled') {
      intakeNotice.value = { count: 0, cancelled: true };
      return;
    }
    if (event.state === 'submitted') {
      intakeNotice.value = null;
      void loadActiveTask();
      return;
    }
    intakeNotice.value = { dueAt: event.dueAt, count: intakeNotice.value?.count ?? 1 };
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
  const conversation = conversations.value.find((item) => item.id === conversationId);
  // The rules live in notifications.ts: muting silences a conversation, but a mention of
  // the signed-in member still gets through, because being addressed is not noise.
  const decision = decideNotification({
    muted: conversation?.muted === true,
    mentioned: message.mentions.includes(meId.value),
    isActiveConversation: conversationId === activeId.value,
    windowVisible: typeof document !== 'undefined' && document.visibilityState === 'visible',
    permission:
      typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
    conversationTitle: titleOf(conversation ?? ({ title: 'ChatAgent' } as ConversationSummary)),
    senderName: message.sender.name,
    text: message.text,
  });
  if (!decision.notify) return;
  try {
    new Notification(decision.title, { body: decision.body, tag: conversationId });
  } catch {
    // Notification construction can fail on restricted platforms; ignore.
  }
}

/** The `forwardedFrom` block of a message, if it is a forward. */
function forwardedFromOf(message: ChatMessage): ForwardedFrom | undefined {
  const forward = message.metadata?.forwardedFrom;
  if (!forward || typeof forward !== 'object') return undefined;
  const candidate = forward as ForwardedFrom;
  return typeof candidate.senderName === 'string' ? candidate : undefined;
}

/** Attachments that are images, i.e. the ones worth previewing inline. */
function imageAttachments(message: ChatMessage): ChatMessage['attachments'] {
  return message.attachments.filter((file) => {
    if (file.mimeType?.startsWith('image/')) return true;
    // Some uploads carry no mime type; the extension is the fallback, not the rule.
    return !file.mimeType && /[.](png|jpe?g|gif|webp|bmp)$/i.test(file.name);
  });
}

function formatTime(value: string): string {
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? value : at.toLocaleString();
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

    <el-dialog v-model="memberPanel" title="群成员与治理" width="420px" data-testid="member-panel">
      <template v-if="canManageGroup">
        <label class="tier-label">内容规则（每行一个正则；命中即召唤本群助手，无需 @）</label>
        <el-input
          v-model="hooksDraft"
          type="textarea"
          :rows="2"
          data-testid="hooks-input"
          placeholder="例如：周报&#10;^(紧急|加急)[:：]"
        />
        <div class="relation-actions">
          <el-button
            :loading="groupBusy"
            data-testid="hooks-publish"
            @click="publishHooks"
          >
            保存内容规则
          </el-button>
        </div>
        <label class="tier-label">群公告（所有人可见）</label>
        <el-input
          v-model="announcementDraft"
          type="textarea"
          :rows="2"
          maxlength="500"
          data-testid="announcement-input"
          placeholder="例如：本周五 17:00 前提交周报"
        />
        <div class="relation-actions">
          <el-button
            type="primary"
            :loading="groupBusy"
            data-testid="announcement-publish"
            @click="publishAnnouncement"
          >
            发布公告
          </el-button>
          <el-button
            v-if="activeConversation?.announcement"
            data-testid="announcement-clear"
            @click="announcementDraft = '' ; publishAnnouncement()"
          >
            清除公告
          </el-button>
          <!-- Two explicit steps instead of a popover: dissolving stops the room for
               everybody, so the second click is the confirmation. -->
          <el-button
            v-if="!dissolveArmed"
            type="danger"
            data-testid="group-dissolve"
            @click="dissolveArmed = true"
          >
            解散群聊
          </el-button>
          <el-button
            v-else
            type="danger"
            plain
            data-testid="group-dissolve-confirm"
            @click="dissolveGroup"
          >
            确认解散（不可恢复，历史保留）
          </el-button>
        </div>
      </template>
      <el-empty v-if="participantList.length === 0" description="暂无成员" :image-size="60" />
      <ul v-else class="member-list">
        <li v-for="member in participantList" :key="member.id">
          <span class="member-name">{{ member.displayName }}</span>
          <span>
            <el-tag v-if="member.kind === 'agent'" size="small" type="primary">AI</el-tag>
            <el-tag
              v-if="activeConversation?.ownerId === member.id"
              size="small"
              type="warning"
              data-testid="member-owner"
            >
              群主
            </el-tag>
            <el-tag
              v-else-if="activeConversation?.adminIds?.includes(member.id)"
              size="small"
              type="info"
              data-testid="member-admin"
            >
              管理员
            </el-tag>
            <el-button
              v-if="isGroupOwner && member.kind === 'member' && member.id !== meId"
              size="small"
              text
              data-testid="toggle-admin"
              @click="toggleGroupAdmin(member.id, !(activeConversation?.adminIds ?? []).includes(member.id))"
            >
              {{ (activeConversation?.adminIds ?? []).includes(member.id) ? '取消管理员' : '设为管理员' }}
            </el-button>
            <el-button
              v-if="canManageGroup && member.id !== meId && member.id !== activeConversation?.ownerId"
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
              @click="openSearchHit(hit)"
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
                <el-tag
                  v-if="conversation.muted"
                  size="small"
                  type="info"
                  data-testid="muted-tag"
                >
                  已免打扰
                </el-tag>
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
              <el-badge
                v-if="friendRequests.incoming.length > 0"
                :value="friendRequests.incoming.length"
                class="request-badge"
              >
                <el-button
                  size="small"
                  text
                  data-testid="friend-requests"
                  @click="requestsOpen = true"
                >
                  好友申请
                </el-button>
              </el-badge>
              <el-button
                v-else
                size="small"
                text
                data-testid="friend-requests"
                @click="requestsOpen = true"
              >
                好友申请
              </el-button>
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
                  <span class="ellipsis">
                  {{ activeConversation?.aliases?.members?.[contact.id] ?? contact.relation?.remark ?? contact.displayName }}
                </span>
                  <el-tag v-if="contact.kind === 'agent'" size="small" type="primary">AI</el-tag>
                  <el-tag
                    v-if="contact.kind === 'member' && contact.relation && contact.relation.state !== 'none'"
                    size="small"
                    :type="contact.relation.state === 'blocked' ? 'danger' : contact.relation.state === 'friend' ? 'success' : 'warning'"
                    data-testid="contact-relation"
                  >
                    {{ relationLabel(contact) }}
                  </el-tag>
                  <el-button
                    v-if="contact.kind === 'member'"
                    size="small"
                    text
                    data-testid="contact-settings"
                    @click.stop="openRelation(contact)"
                  >
                    ⋯
                  </el-button>
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

      <section
        class="chat-main"
        :class="{ 'room-dark': conversationBackgroundIsDark }"
        :style="conversationBackground"
        data-testid="chat-room"
        @dragenter.prevent="activeId && (draggingFile = true)"
        @dragover.prevent
        @drop.prevent="onDropFiles"
      >
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
              <!-- Room appearance: a preset, so the stored value is never a style string. -->
              <el-dropdown trigger="click" @command="setAppearance">
                <el-button size="small" text data-testid="appearance-trigger">外观</el-button>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item
                      v-for="item in APPEARANCES"
                      :key="item.id"
                      :command="item.id"
                      :data-testid="`appearance-${item.id}`"
                    >
                      {{ item.label }}
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
              <!-- Desktop-only window controls; the browser has no such window. -->
              <span v-if="desktopWindow" class="side-actions">
                <el-button
                  size="small"
                  text
                  data-testid="window-pin"
                  @click="windowAction(windowPinned ? 'unpin' : 'pin')"
                >
                  {{ windowPinned ? '取消置顶' : '窗口置顶' }}
                </el-button>
                <el-button
                  size="small"
                  text
                  data-testid="window-hide"
                  @click="windowAction('hide')"
                >
                  隐藏窗口
                </el-button>
              </span>
              <span
                v-else-if="activeConversation?.targetKind === 'group'"
                class="side-actions"
              >
                <el-tag size="small" type="success">
                  {{ activeConversation.participantIds.length }} 人
                </el-tag>
                <el-button size="small" text @click="inviteDialog = true">邀请成员</el-button>
                <el-button size="small" text data-testid="alias-edit" @click="openAliasDialog">别名</el-button>
                <el-button
                  size="small"
                  text
                  data-testid="members"
                  @click="
                    memberPanel = true;
                    hooksDraft = (activeConversation?.hooks ?? []).join('\n');
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
                <el-button
                  size="small"
                  text
                  data-testid="mute-toggle"
                  @click="toggleMuted"
                >
                  {{ activeConversation?.muted ? '取消免打扰' : '免打扰' }}
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
                <div
                  class="bubble-row"
                  :class="{ mine: isMine(message), compact: isCompact(index) }"
                  :data-message-id="message.id"
                >
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
                      {{ nameOfId(message.sender.id, message.sender.name) }} ·
                      {{ new Date(message.createdAt).toLocaleTimeString() }}
                    </div>
                    <div
                      v-if="message.replyTo"
                      class="bubble-quote"
                      data-testid="bubble-quote"
                    >
                      <template v-if="quotedMessageOf(message)">
                        <span class="quote-label">{{ quotedMessageOf(message)?.sender.name }}</span>
                        <span class="quote-text">{{ quotePreviewOf(quotedMessageOf(message) as ChatMessage) }}</span>
                      </template>
                      <template v-else>
                        <span class="quote-text">引用了一条更早的消息</span>
                      </template>
                    </div>
                    <div v-if="message.recalledAt" class="bubble-recalled">
                      {{ isMine(message) ? '你撤回了一条消息' : '对方撤回了一条消息' }}
                    </div>
                    <div v-else-if="message.text" class="bubble-text">{{ message.text }}</div>
                    <div
                      v-if="!message.recalledAt && forwardedFromOf(message) as ForwardedFrom | undefined"
                      class="bubble-forwarded"
                      data-testid="bubble-forwarded"
                    >
                      转发自 {{ (forwardedFromOf(message) as ForwardedFrom).senderName }}
                      <template v-if="(forwardedFromOf(message) as ForwardedFrom).createdAt">
                        · 原 {{ formatTime((forwardedFromOf(message) as ForwardedFrom).createdAt as string) }}
                      </template>
                    </div>
                    <div v-if="!message.recalledAt && message.attachments.length" class="bubble-files">
                      <!-- Images get a thumbnail with a full-size preview; the file link
                           stays for everything else (and for downloading). -->
                      <div v-if="imageAttachments(message).length" class="bubble-images">
                        <el-image
                          v-for="file in imageAttachments(message)"
                          :key="file.id"
                          class="bubble-image"
                          :src="`/api/files/${file.id}`"
                          :preview-src-list="imageAttachments(message).map((item) => `/api/files/${item.id}`)"
                          :initial-index="imageAttachments(message).findIndex((item) => item.id === file.id)"
                          fit="cover"
                          preview-teleported
                          data-testid="bubble-image"
                        />
                      </div>
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
                      v-if="!message.recalledAt"
                      class="bubble-recall"
                      data-testid="quote"
                      type="button"
                      @click="startQuote(message)"
                    >
                      引用
                    </button>
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
            <div v-if="quoted" class="quote-strip" data-testid="quote-strip">
              <span class="quote-label">引用 {{ quoted.sender.name }}</span>
              <span class="quote-text">{{ quotePreviewOf(quoted) }}</span>
              <el-button size="small" text @click="quoted = null">取消</el-button>
            </div>
            <el-alert
              v-if="activeConversation?.targetKind === 'group' && activeConversation.announcement"
              type="info"
              show-icon
              :closable="false"
              class="group-announcement"
              data-testid="group-announcement"
            >
              <template #title>群公告</template>
              {{ activeConversation.announcement }}
            </el-alert>
            <el-alert
              v-if="activeConversation?.dissolvedAt"
              type="warning"
              show-icon
              :closable="false"
              data-testid="group-dissolved"
              title="该群已解散，不能再发送消息（历史仍可查看）"
            />
            <p
              v-if="intakeNotice"
              class="intake-notice"
              data-testid="intake-notice"
            >
              <el-tag size="small" type="info">助手待读</el-tag>
              <template v-if="intakeNotice.cancelled">
                消息已撤回，未交给助手
              </template>
              <template v-else>
                已排队 {{ intakeNotice.count }} 条：撤回窗口结束后才会交给助手，撤回即取消
              </template>
            </p>
            <div class="composer-row">
              <el-upload
                :auto-upload="false"
                :show-file-list="false"
                :on-change="onFileChange"
                :accept="DROP_EXTENSIONS.map((item) => '.' + item).join(',')"
              >
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
    <!-- Address book: the request inbox and one contact's private card. -->
    <!-- Aliases are the viewer's own labels; nothing here is visible to anybody else. -->
    <el-dialog v-model="aliasDialog" title="别名（只有自己可见）" width="420px">
      <label class="tier-label">这个会话叫什么</label>
      <el-input v-model="aliasTitle" maxlength="32" data-testid="alias-title" placeholder="例如：我的周报组" />
      <label class="tier-label">成员称呼</label>
      <div class="relation-actions alias-rows">
        <div v-for="member in participantList" :key="member.id" class="tier-row">
          <span class="alias-origin">{{ member.displayName }}</span>
          <el-input
            :model-value="aliasDraft[member.id] ?? ''"
            maxlength="32"
            :placeholder="member.id === meId ? '我在本群的昵称' : '我给他的称呼'"
            data-testid="alias-member"
            @update:model-value="aliasDraft = { ...aliasDraft, [member.id]: $event }"
          />
        </div>
      </div>
      <template #footer>
        <el-button @click="aliasDialog = false">取消</el-button>
        <el-button type="primary" data-testid="alias-save" @click="saveAliases">保存</el-button>
      </template>
    </el-dialog>
    <el-dialog v-model="requestsOpen" title="好友申请" width="420px">
      <p v-if="friendRequests.incoming.length === 0" class="muted" data-testid="requests-empty">
        没有待处理的申请。
      </p>
      <div
        v-for="request in friendRequests.incoming"
        :key="request.id"
        class="request-row"
        data-testid="request-row"
      >
        <div class="request-main">
          <strong>{{ request.fromId }}</strong>
          <span v-if="request.note" class="muted">：{{ request.note }}</span>
        </div>
        <el-button
          size="small"
          type="primary"
          data-testid="request-accept"
          @click="decideFriendRequest(request, 'accept')"
        >
          同意
        </el-button>
        <el-button
          size="small"
          data-testid="request-decline"
          @click="decideFriendRequest(request, 'decline')"
        >
          拒绝
        </el-button>
      </div>
      <template #footer>
        <span class="muted">对方同意后才会成为好友；拒绝不会通知对方。</span>
      </template>
    </el-dialog>

    <el-dialog
      :model-value="relationTarget !== null"
      :title="'联系人设置：' + (relationTarget?.displayName ?? '')"
      width="420px"
      @close="relationTarget = null"
    >
      <p class="muted" data-testid="relation-state">当前状态：{{ relationTarget ? relationLabel(relationTarget) : '' }}</p>
      <label class="tier-label">备注（只有自己可见）</label>
      <el-input v-model="relationRemark" data-testid="relation-remark" placeholder="例如：周报小组的 Bob" />
      <div class="relation-actions">
        <el-button
          v-if="relationTarget?.relation?.state === 'none'"
          type="primary"
          data-testid="relation-add"
          @click="relationTarget && requestFriend(relationTarget)"
        >
          加为好友
        </el-button>
        <el-button
          v-if="relationTarget?.relation?.state === 'request_in' && relationTarget.relation.requestId"
          type="primary"
          data-testid="relation-accept"
          @click="relationAccept()"
        >
          同意对方的申请
        </el-button>
        <el-button
          :type="relationTarget?.relation?.state === 'blocked' ? 'default' : 'danger'"
          data-testid="relation-block"
          @click="relationTarget && toggleBlock(relationTarget)"
        >
          {{ relationTarget?.relation?.state === 'blocked' ? '解除拉黑' : '拉黑（不再接收对方私聊）' }}
        </el-button>
      </div>
      <template #footer>
        <el-button @click="relationTarget = null">取消</el-button>
        <el-button type="primary" data-testid="relation-save" @click="saveRelation({ remark: relationRemark.trim() || null })">
          保存备注
        </el-button>
      </template>
    </el-dialog>

    <!-- Drop target: dragging a file over the chat offers to attach it. The server still
         validates the bytes, so this only saves a round trip on an obvious mistake. -->
    <div
      v-if="draggingFile"
      class="drop-overlay"
      data-testid="drop-overlay"
      @dragover.prevent
      @dragleave.self="draggingFile = false"
      @drop.prevent="onDropFiles"
    >
      <div class="drop-hint">松手即可作为附件发送（单文件，≤20MB）</div>
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

.quote-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  margin-bottom: 6px;
  border-left: 3px solid #409eff;
  background: var(--ca-panel-2);
  border-radius: 4px;
  font-size: 12px;
}

.bubble-quote {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 8px;
  margin-bottom: 4px;
  border-left: 3px solid var(--ca-border);
  background: var(--ca-panel-2);
  border-radius: 4px;
  font-size: 12px;
  color: var(--ca-muted);
}

.quote-label {
  font-weight: 600;
}

.quote-text {
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

/* Search-hit jump: a brief outline flash so the matched message is findable. */
@keyframes search-flash {
  0% {
    box-shadow: 0 0 0 2px #409eff;
    background: var(--ca-active);
  }
  100% {
    box-shadow: 0 0 0 2px transparent;
    background: transparent;
  }
}

.bubble-row.search-flash {
  animation: search-flash 1.8s ease forwards;
  border-radius: 8px;
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

/* A dark room switches the room text to light; bubbles keep their own solid surfaces, so
   message contrast never depends on the background someone picked. */
.room-dark {
  color: #f5f5f5;
}

.room-dark .side-title,
.room-dark .muted {
  color: #d8d8d8;
}

.drop-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(64, 158, 255, 0.08);
  border: 2px dashed var(--el-color-primary);
}

.drop-hint {
  padding: 12px 20px;
  border-radius: 8px;
  background: var(--el-bg-color);
  color: var(--el-text-color-primary);
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
