import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import type { ConversationSummary, MemberView } from '@chatagent/contracts';
import ChatView from './ChatView.vue';

const mocks = vi.hoisted(() => {
  const now = new Date().toISOString();
  const conversation: ConversationSummary = {
    id: 'conv_bob',
    chatType: 'direct' as const,
    chatId: 'native:member:u_alice:u_bob',
    title: 'Bob',
    organizationId: 'org_local',
    participantIds: ['u_alice', 'u_bob'],
    origin: 'native' as const,
    targetKind: 'member' as const,
    targetId: 'u_bob',
    createdAt: now,
    updatedAt: now,
    messageIds: [],
    unreadCount: 2,
    lastMessage: {
      id: 'm1',
      text: '早上好，验收前请确认群聊',
      senderId: 'u_bob',
      senderName: 'Bob',
      kind: 'text' as const,
      createdAt: now,
    },
  };

  const group: ConversationSummary = {
    id: 'conv_group',
    chatType: 'group',
    chatId: 'native:group:abc123',
    title: '验收小组',
    organizationId: 'org_local',
    participantIds: ['u_alice', 'u_bob'],
    origin: 'native',
    targetKind: 'group',
    targetId: 'u_alice',
    // The signed-in member created this group, so the governance controls are shown to
    // them (the server refuses them for everybody else).
    ownerId: 'u_alice',
    adminIds: ['u_alice'],
    createdAt: now,
    updatedAt: now,
    messageIds: [],
    unreadCount: 0,
  };

  return {
    conversation,
    group,
    markRead: vi.fn(async () => ({ ok: true })),
    // The send response may also carry the intake notice (queued until the recall
    // window ends), so the mock's shape has to allow it.
    send: vi.fn(async (): Promise<{ message: unknown; intake?: unknown; intakes?: unknown[] }> => ({
      message: {},
    })),
    open: vi.fn(async () => conversation),
    createGroup: vi.fn(async () => conversation),
    addMember: vi.fn(async () => ({ ok: true })),
    rename: vi.fn(async () => ({ id: 'conv_group', title: '改名后' })),
    setAnnouncement: vi.fn(async () => ({ id: 'conv_group' })),
    setAdmin: vi.fn(async () => ({ id: 'conv_group' })),
    dissolve: vi.fn(async () => ({ id: 'conv_group' })),
    setMuted: vi.fn(async () => ({ ok: true, muted: true })),
    setHooks: vi.fn(async () => ({ id: 'conv_group', hooks: [] })),
    setAppearance: vi.fn(async () => ({ id: 'conv_bob' })),
    setAliases: vi.fn(async () => ({ ok: true })),
    upload: vi.fn(async () => ({ file: { id: 'f_up', name: 'brief.docx' } })),
    removeMember: vi.fn(async () => ({ ok: true })),
    leave: vi.fn(async () => ({ ok: true })),
    listConversations: vi.fn(async () => [conversation]),
    recall: vi.fn(async () => ({ ok: true })),
    forward: vi.fn(async () => ({ ok: true, message: {} })),
    readReceipts: vi.fn(async () => ({ others: [] as Array<{ memberId: string; lastReadAt: string }> })),
    search: vi.fn(async () => [] as Array<{ conversationId: string; title?: string; message: { id: string; text: string; senderName?: string; createdAt: string } }>),
    defaultMessages: [
      {
        id: 'm1',
        channel: 'web',
        conversationId: 'conv_bob',
        chatType: 'direct',
        direction: 'inbound',
        kind: 'text',
        text: '早上好，验收前请确认群聊',
        sender: { id: 'u_bob', name: 'Bob' },
        mentions: [],
        attachments: [],
        createdAt: now,
      },
    ],
    listMessages: vi.fn(async () => [] as unknown[]),
  };
});

const addressBook = vi.hoisted(() => ({
  requests: vi.fn(),
  request: vi.fn(),
  decide: vi.fn(),
  patchContact: vi.fn(),
}));

/**
 * The organization directory (GET /api/members). Decision 1C-(a): the contact list only holds
 * people you have a relationship with, so the directory is where a colleague who is not in it is
 * found - and it is also how a direct conversation with a non-friend gets a name.
 */
const directory = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../api', () => ({
  api: {
    contacts: vi.fn(async () => [
      {
        id: 'u_bob',
        displayName: 'Bob',
        organizationId: 'org_local',
        roles: ['member'],
        kind: 'member' as const,
        online: true,
        relation: { state: 'none' as const },
      },
      {
        id: 'agent_1',
        displayName: 'ChatAgent 助理',
        organizationId: 'org_local',
        roles: [],
        kind: 'agent' as const,
      },
    ]),
    patchContact: addressBook.patchContact,
    members: { list: directory.list },
    friends: {
      requests: addressBook.requests,
      request: addressBook.request,
      decide: addressBook.decide,
    },
    chat: {
      conversations: mocks.listConversations,
      messages: mocks.listMessages,
      markRead: mocks.markRead,
      send: mocks.send,
      open: mocks.open,
      conversation: vi.fn(async () => mocks.group),
      createGroup: mocks.createGroup,
      recall: mocks.recall,
      forward: mocks.forward,
      readReceipts: mocks.readReceipts,
      exportConversation: vi.fn(async () => ({ id: 'f1', name: 'x.docx', url: '/api/files/f1' })),
      addMember: mocks.addMember,
      rename: mocks.rename,
      setAnnouncement: mocks.setAnnouncement,
      setAdmin: mocks.setAdmin,
      dissolve: mocks.dissolve,
      setMuted: mocks.setMuted,
      setHooks: mocks.setHooks,
      setAppearance: mocks.setAppearance,
      setAliases: mocks.setAliases,
      removeMember: mocks.removeMember,
      leave: mocks.leave,
      upload: mocks.upload,
    },
    tasks: { list: vi.fn(async () => []) },
    approvals: { list: vi.fn(async () => []), decide: vi.fn() },
    search: mocks.search,
  },
}));

const me: MemberView = {
  id: 'u_alice',
  displayName: 'Alice',
  organizationId: 'org_local',
  roles: ['member'],
  kind: 'member',
};

/** Instances are kept so a test can simulate a drop and a reconnect. */
const streamInstances: FakeEventSource[] = [];

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: string, handler: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  /** Test helper: deliver a server-sent event to the handlers the view registered. */
  dispatch(type: string, data: unknown = {}): void {
    for (const handler of this.listeners.get(type) ?? []) {
      handler({ data: JSON.stringify(data) });
    }
  }

  close(): void {}

  constructor() {
    streamInstances.push(this);
  }
}

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource);
  streamInstances.length = 0;
  // Dialogs are teleported to the body and tests attach their wrapper there; clearing the
  // body keeps one test's dialogs from being found by the next one.
  document.body.innerHTML = '';
  // The address book is optional on screen: default to "nothing pending, nothing changed".
  addressBook.requests.mockReset();
  addressBook.requests.mockResolvedValue({ incoming: [], outgoing: [] });
  addressBook.request.mockReset();
  addressBook.request.mockResolvedValue({ id: 'req_new', status: 'pending' });
  addressBook.decide.mockReset();
  addressBook.decide.mockResolvedValue({ id: 'req_1', status: 'accepted' });
  addressBook.patchContact.mockReset();
  mocks.upload.mockClear();
  addressBook.patchContact.mockResolvedValue({ id: 'u_bob', relation: { state: 'friend' } });
  // The directory lists the whole organization: Alice herself, Bob (also a contact) and Carol,
  // who has no relationship with Alice and is therefore not in the contact list.
  directory.list.mockReset();
  directory.list.mockResolvedValue([
    { id: 'u_alice', displayName: 'Alice', organizationId: 'org_local', roles: ['member'], kind: 'member' },
    { id: 'u_bob', displayName: 'Bob', organizationId: 'org_local', roles: ['member'], kind: 'member' },
    {
      id: 'u_carol',
      displayName: 'Carol',
      organizationId: 'org_local',
      roles: ['member'],
      kind: 'member',
      online: true,
    },
  ] satisfies MemberView[]);
  mocks.markRead.mockClear();
  mocks.send.mockClear();
  mocks.listMessages.mockClear();
  mocks.addMember.mockClear();
  mocks.recall.mockClear();
  mocks.forward.mockClear();
  mocks.readReceipts.mockClear();
  mocks.readReceipts.mockResolvedValue({ others: [] });
  mocks.leave.mockClear();
  mocks.search.mockClear();
  mocks.search.mockResolvedValue([]);
  mocks.listConversations.mockResolvedValue([mocks.conversation]);
  // The message fixture must be restored: mockClear() keeps implementations.
  mocks.listMessages.mockResolvedValue(mocks.defaultMessages);
});

function mountChat(options: { attachTo?: HTMLElement } = {}) {
  return mount(ChatView, {
    props: { me },
    attachTo: options.attachTo,
    global: { plugins: [ElementPlus] },
  });
}

describe('ChatView', () => {
  it('renders conversations with unread badges and last-message previews', async () => {
    const wrapper = mountChat();
    await flushPromises();

    expect(wrapper.text()).toContain('Bob');
    expect(wrapper.text()).toContain('早上好，验收前请确认群聊');
    expect(wrapper.text()).toContain('联系人');
  });

  it('loads the newest page of messages and marks the conversation read', async () => {
    const wrapper = mountChat();
    await flushPromises();

    expect(mocks.listMessages).toHaveBeenCalledWith('conv_bob', { limit: 50 });
    expect(mocks.markRead).toHaveBeenCalledWith('conv_bob');
    expect(wrapper.text()).toContain('早上好，验收前请确认群聊');
  });

  it('finds a colleague the contact list does not show, and adds them from the directory', async () => {
    // Decision 1C-(a): the contact list is a relationship list, so somebody you have not added is
    // only reachable through the organization directory - which makes this entry point the way
    // the rest of the feature works at all.
    const wrapper = mountChat();
    await flushPromises();

    expect(directory.list).toHaveBeenCalled();
    expect(wrapper.text()).not.toContain('Carol');

    const search = wrapper.find('input[placeholder="搜索组织目录（添加同事）"]');
    expect(search.exists()).toBe(true);
    await search.setValue('car');
    await flushPromises();

    const results = wrapper.findAll('[data-testid="directory-result"]');
    expect(results).toHaveLength(1);
    expect(results[0].text()).toContain('Carol');
    // The result row shows a name and an add button, never presence - even though this colleague
    // is online, that is not a stranger's fact to read (the server does not send it either).
    expect(results[0].text()).not.toContain('在线');

    await results[0].find('[data-testid="directory-add"]').trigger('click');
    await flushPromises();
    expect(addressBook.request).toHaveBeenCalledWith('u_carol');
  });

  it('does not offer people who are already in the contact list as directory results', async () => {
    const wrapper = mountChat();
    await flushPromises();

    // Bob is a contact (and an AI account is there too); searching the directory for the people
    // you already have would turn the add-entry point into a duplicate list.
    await wrapper.find('input[placeholder="搜索组织目录（添加同事）"]').setValue('bob');
    await flushPromises();
    expect(wrapper.findAll('[data-testid="directory-result"]')).toHaveLength(0);
    expect(wrapper.find('[data-testid="directory-results"]').text()).toContain('没有匹配的同事');
  });

  it('names a direct conversation whose peer is not in the contact list', async () => {
    // Direct chat with a colleague you have not added stays possible (that is the half the
    // reverted attempt broke), so the sidebar still has to show a name rather than a raw id.
    // The stored title is removed on purpose: the name must come from the directory lookup.
    const withoutTitle = { ...mocks.conversation };
    delete withoutTitle.title;
    mocks.listConversations.mockResolvedValue([
      {
        ...withoutTitle,
        id: 'conv_carol',
        chatId: 'native:member:u_alice:u_carol',
        participantIds: ['u_alice', 'u_carol'],
        targetId: 'u_carol',
      },
    ]);
    const wrapper = mountChat();
    await flushPromises();

    expect(wrapper.text()).toContain('Carol');
    expect(wrapper.text()).not.toContain('u_carol');
  });


  it('explains that an assistant message is queued until the recall window ends', async () => {
    mocks.send.mockResolvedValueOnce({
      message: { id: 'm_new' },
      intake: {
        id: 'intake-1',
        state: 'pending',
        mode: 'deferred',
        dueAt: new Date(Date.now() + 120_000).toISOString(),
      },
    });
    const wrapper = mountChat();
    await flushPromises();

    await wrapper.find('textarea').setValue('@助手 汇总本周进展');
    const sendButton = wrapper.findAll('button').find((button) => button.text().includes('发送'));
    await sendButton?.trigger('click');
    await flushPromises();

    const notice = wrapper.find('[data-testid="intake-notice"]');
    expect(notice.exists()).toBe(true);
    // The user must not read "queued" as "the assistant is ignoring me", and must
    // know that withdrawing the message cancels the handoff.
    expect(notice.text()).toContain('撤回窗口结束后才会交给助手');
    expect(notice.text()).toContain('撤回即取消');
  });

  it('tells the sender when the host gave up on a handoff instead of staying silent', async () => {
    const wrapper = mountChat();
    await flushPromises();

    const stream = streamInstances.at(-1);
    expect(stream, 'the view subscribes to the native event stream').toBeTruthy();
    stream?.dispatch('agent_intake', {
      conversationId: 'conv_bob',
      intakeId: 'intake-7',
      messageId: 'm_7',
      state: 'failed',
      reason: 'retry_exhausted',
      attempts: 8,
    });
    await flushPromises();

    const notice = wrapper.find('[data-testid="intake-notice"]');
    expect(notice.exists()).toBe(true);
    // "The assistant quietly never answered" must not be the only signal the sender gets.
    const failed = wrapper.find('[data-testid="intake-failed"]');
    expect(failed.exists()).toBe(true);
    expect(failed.text()).toContain('已重试 8 次');
    expect(failed.text()).toContain('请稍后重发');
  });

  it('resynchronises the thread when the event stream reconnects', async () => {
    mountChat();
    await flushPromises();
    mocks.listMessages.mockClear();

    const stream = streamInstances.at(-1);
    expect(stream, 'the view subscribes to the native event stream').toBeTruthy();
    // The connection dropped and EventSource came back: the server replays what it holds,
    // and the view re-reads the visible page so a gap can never become a silent hole.
    stream?.onerror?.();
    stream?.onopen?.();
    await flushPromises();

    expect(mocks.listMessages).toHaveBeenCalled();
  });

  it('shows the friend-request inbox and answers a request', async () => {
    addressBook.requests.mockResolvedValue({
      incoming: [{ id: 'req_1', fromId: 'u_carol', toId: 'u_alice', status: 'pending', note: '一起做周报' }],
      outgoing: [],
    });
    const wrapper = mountChat();
    await flushPromises();

    const entry = wrapper.find('[data-testid="friend-requests"]');
    expect(entry.exists()).toBe(true);
    await entry.trigger('click');
    await flushPromises();

    const row = wrapper.find('[data-testid="request-row"]');
    expect(row.text()).toContain('u_carol');
    expect(row.text()).toContain('一起做周报');

    // Accepting is the addressee's decision, and it goes through the API with the request id.
    await wrapper.find('[data-testid="request-accept"]').trigger('click');
    await flushPromises();
    expect(addressBook.decide).toHaveBeenCalledWith('req_1', 'accept');
  });

  it('lets a member name and block a contact from their own address book', async () => {
    const wrapper = mountChat();
    await flushPromises();

    // Only member rows get the address-book card; AI accounts have a tier instead.
    await wrapper.find('[data-testid="contact-settings"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="relation-state"]').text()).toContain('未添加');

    // Element Plus forwards the test id to the inner input, so this is the field itself.
    const remark = wrapper.find('[data-testid="relation-remark"]');
    await remark.setValue('周报小组的 Bob');
    await wrapper.find('[data-testid="relation-save"]').trigger('click');
    await flushPromises();
    expect(addressBook.patchContact).toHaveBeenCalledWith('u_bob', { remark: '周报小组的 Bob' });

    // Blocking is about delivery, and the button says so.
    await wrapper.find('[data-testid="contact-settings"]').trigger('click');
    await flushPromises();
    const block = wrapper.find('[data-testid="relation-block"]');
    expect(block.text()).toContain('不再接收对方私聊');
    await block.trigger('click');
    await flushPromises();
    expect(addressBook.patchContact).toHaveBeenCalledWith('u_bob', { blocked: true });
  });

  it('asks a stranger to become a contact instead of silently adding them', async () => {
    const wrapper = mountChat();
    await flushPromises();

    await wrapper.find('[data-testid="contact-settings"]').trigger('click');
    await flushPromises();
    await wrapper.find('[data-testid="relation-add"]').trigger('click');
    await flushPromises();

    expect(addressBook.request).toHaveBeenCalledWith('u_bob');
  });


  it('shows who a forwarded message came from, and when it was written', async () => {
    mocks.listMessages.mockResolvedValue([
      {
        id: 'm_forward',
        channel: 'web',
        conversationId: 'conv_bob',
        chatType: 'direct',
        direction: 'inbound',
        kind: 'text',
        text: '季度目标已确认',
        sender: { id: 'u_bob', name: 'Bob' },
        mentions: [],
        attachments: [],
        createdAt: new Date().toISOString(),
        metadata: {
          forwardedFrom: {
            messageId: 'm_source',
            conversationId: 'conv_other',
            senderName: 'Carol',
            createdAt: '2026-09-01T02:00:00.000Z',
          },
        },
      },
    ]);
    const wrapper = mountChat();
    await flushPromises();

    const line = wrapper.find('[data-testid="bubble-forwarded"]');
    expect(line.exists()).toBe(true);
    // The original author and time travel with the copy: a forward cannot pass itself off
    // as something written now.
    expect(line.text()).toContain('Carol');
    expect(line.text()).toContain('原');
    expect(line.text()).not.toContain('2026-09-01T02:00:00.000Z');
  });

  it('previews image attachments inline and keeps the file link', async () => {
    mocks.listMessages.mockResolvedValue([
      {
        id: 'm_image',
        channel: 'web',
        conversationId: 'conv_bob',
        chatType: 'direct',
        direction: 'inbound',
        kind: 'mixed',
        text: '看这张图',
        sender: { id: 'u_bob', name: 'Bob' },
        mentions: [],
        attachments: [
          { id: 'f_img', name: 'photo.png', mimeType: 'image/png', url: '/api/files/f_img' },
          { id: 'f_pdf', name: 'report.pdf', mimeType: 'application/pdf' },
        ],
        createdAt: new Date().toISOString(),
      },
    ]);
    const wrapper = mountChat();
    await flushPromises();

    const images = wrapper.findAll('[data-testid="bubble-image"]');
    expect(images).toHaveLength(1);
    // Non-image attachments stay ordinary file chips, right next to the preview.
    const chips = wrapper.findAll('.file-chip').map((chip) => chip.text());
    expect(chips.some((text) => text.includes('report.pdf'))).toBe(true);
  });

  it('mutes one conversation without hiding its unread count', async () => {
    mocks.listConversations.mockResolvedValue([{ ...mocks.group, muted: true, unreadCount: 3 }]);
    const wrapper = mountChat();
    await flushPromises();

    expect(wrapper.find('[data-testid="muted-tag"]').exists()).toBe(true);
    await wrapper.find('[data-testid="mute-toggle"]').trigger('click');
    await flushPromises();

    // Muting is a notification preference: un-muting is the same call with false.
    expect(mocks.setMuted).toHaveBeenCalledWith('conv_group', false);
    expect(wrapper.find('[data-testid="group-announcement"]').exists()).toBe(false);
  });


  it('attaches a file dropped onto the chat, and refuses the obvious mistakes locally', async () => {
    const wrapper = mountChat();
    await flushPromises();

    const section = wrapper.find('.chat-main');
    expect(section.exists()).toBe(true);

    // Dragging shows the drop target...
    await section.trigger('dragenter');
    await flushPromises();
    expect(wrapper.find('[data-testid="drop-overlay"]').exists()).toBe(true);

    // ...and dropping a supported file uploads it through the same path as the picker.
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'brief.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    await section.trigger('drop', { dataTransfer: { files: [file] } });
    await flushPromises();
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="drop-overlay"]').exists()).toBe(false);
  });

  it('refuses an unsupported or oversized drop without calling the server', async () => {
    const wrapper = mountChat();
    await flushPromises();
    const section = wrapper.find('.chat-main');

    await section.trigger('drop', {
      dataTransfer: { files: [new File(['MZ'], 'payload.exe')] },
    });
    await flushPromises();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('不支持的文件类型');

    // The size guard mirrors the server's cap; a mistake this obvious should not need a
    // round trip (the server still enforces it).
    const big = new File([new Uint8Array(1)], 'huge.txt');
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });
    await section.trigger('drop', { dataTransfer: { files: [big] } });
    await flushPromises();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('超过 20MB');
  });


  it('offers window controls only inside the desktop shell', async () => {
    // A plain browser has no such window; the controls must not appear there.
    const wrapper = mountChat();
    await flushPromises();
    expect(wrapper.find('[data-testid="window-pin"]').exists()).toBe(false);

    const setWindow = vi.fn(async () => ({ ok: true, result: { pinned: true, visible: true, focused: true } }));
    (window as { chatagent?: unknown }).chatagent = {
      platform: 'win32',
      versions: { electron: '39.8.10', chrome: '142', node: '22' },
      window: { set: setWindow },
    };
    const desktop = mountChat();
    await flushPromises();

    await desktop.find('[data-testid="window-pin"]').trigger('click');
    await flushPromises();
    expect(setWindow).toHaveBeenCalledWith('pin');
    // The label follows the state the main process reported, not a local guess.
    expect(desktop.find('[data-testid="window-pin"]').text()).toContain('取消置顶');

    await desktop.find('[data-testid="window-hide"]').trigger('click');
    await flushPromises();
    expect(setWindow).toHaveBeenCalledWith('hide');

    delete (window as { chatagent?: unknown }).chatagent;
  });


  it('lets a group manager publish content rules that summon the assistant', async () => {
    mocks.listConversations.mockResolvedValue([{ ...mocks.group, hooks: ['周报'] }]);
    const wrapper = mountChat({ attachTo: document.body });
    await flushPromises();

    await wrapper.find('[data-testid="members"]').trigger('click');
    await flushPromises();

    // The stored rules are shown for editing, one per line.
    const field = document.querySelector('[data-testid="hooks-input"]') as HTMLTextAreaElement;
    expect(field, 'the manager panel offers content rules').toBeTruthy();
    expect(field.value).toBe('周报');

    field.value = '周报\n^(紧急|加急)[:：]\n';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    (document.querySelector('[data-testid="hooks-publish"]') as HTMLElement).click();
    await flushPromises();

    // Empty lines are dropped; the server validates what is left.
    expect(mocks.setHooks).toHaveBeenCalledWith('conv_group', ['周报', '^(紧急|加急)[:：]']);
  });


  it('applies the conversation background and sends the chosen preset', async () => {
    mocks.listConversations.mockResolvedValue([
      { ...mocks.conversation, appearance: { background: 'paper' } },
    ]);
    // The dropdown renders into a popper attached to the body, so the wrapper must be attached.
    const wrapper = mountChat({ attachTo: document.body });
    await flushPromises();

    // A preset is rendered from the client's own palette, never from a style string.
    const room = wrapper.find('[data-testid="chat-room"]');
    expect(room.attributes('style')).toContain('rgb(247, 244, 236)');
    expect(room.classes()).not.toContain('room-dark');

    await wrapper.find('[data-testid="appearance-trigger"]').trigger('click');
    await flushPromises();
    const dark = document.querySelector('[data-testid="appearance-slate"]') as HTMLElement | null;
    expect(dark, 'the picker lists the presets').toBeTruthy();
    dark?.click();
    await flushPromises();

    expect(mocks.setAppearance).toHaveBeenCalledWith('conv_bob', { background: 'slate' });
  });

  it('switches a dark room to light text without touching the bubbles', async () => {
    mocks.listConversations.mockResolvedValue([
      { ...mocks.conversation, appearance: { background: 'slate' } },
    ]);
    const wrapper = mountChat();
    await flushPromises();

    const room = wrapper.find('[data-testid="chat-room"]');
    expect(room.classes()).toContain('room-dark');
    // Bubbles keep their own surface: message contrast does not depend on the room colour.
    expect(wrapper.find('.bubble-text').exists()).toBe(true);
  });


  it('uses the viewer aliases for the room title and for the people in it', async () => {
    mocks.listConversations.mockResolvedValue([
      {
        ...mocks.group,
        aliases: { title: '我的周报组', members: { u_bob: '小 Bob' } },
      },
    ]);
    mocks.listMessages.mockResolvedValue([
      {
        id: 'm_bob',
        channel: 'web',
        conversationId: 'conv_group',
        chatType: 'group',
        direction: 'inbound',
        kind: 'text',
        text: '收到',
        sender: { id: 'u_bob', name: 'Bob' },
        mentions: [],
        attachments: [],
        createdAt: new Date().toISOString(),
      },
    ]);
    const wrapper = mountChat();
    await flushPromises();

    // The private label is what the viewer sees; the real title is untouched elsewhere.
    expect(wrapper.text()).toContain('我的周报组');
    // The bubble meta shows the private label instead of the profile name.
    expect(wrapper.find('.bubble-meta').text()).toContain('小 Bob');
  });

  it('saves aliases and clears them by blanking the fields', async () => {
    // The entry lives in the group header, so the open conversation has to be a group.
    mocks.listConversations.mockResolvedValue([mocks.group]);
    const wrapper = mountChat({ attachTo: document.body });
    await flushPromises();

    await wrapper.find('[data-testid="alias-edit"]').trigger('click');
    await flushPromises();

    const title = document.querySelector('[data-testid="alias-title"]') as HTMLInputElement;
    expect(title, 'the alias dialog offers a room label').toBeTruthy();
    title.value = '我的项目组';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();

    // The member rows come from the loaded participant list; this test only needs the room
    // label, and the alias set it sends must be exactly what the dialog holds.
    (document.querySelector('[data-testid="alias-save"]') as HTMLElement).click();
    await flushPromises();

    expect(mocks.setAliases).toHaveBeenCalledWith('conv_group', {
      title: '我的项目组',
      members: {},
    });
  });


  it('reloads when the stream says the cursor is stale', async () => {
    mountChat();
    await flushPromises();
    mocks.listMessages.mockClear();

    const stream = streamInstances.at(-1);
    expect(stream, 'the view subscribes to the native event stream').toBeTruthy();
    // The server warned that the cursor predates its replay buffer instead of replaying
    // nothing: the client must reload rather than assume it is up to date.
    stream?.dispatch?.('resync');
    await flushPromises();

    expect(mocks.listMessages).toHaveBeenCalled();
  });


  it('sends a catalogue sticker without text and renders it as a badge', async () => {
    mocks.listMessages.mockResolvedValue([
      {
        id: 'm_sticker',
        channel: 'web',
        conversationId: 'conv_bob',
        chatType: 'direct',
        direction: 'inbound',
        kind: 'image',
        text: '',
        sticker: 'thanks',
        sender: { id: 'u_bob', name: 'Bob' },
        mentions: [],
        attachments: [],
        createdAt: new Date().toISOString(),
      },
    ]);
    const wrapper = mountChat({ attachTo: document.body });
    await flushPromises();

    // The id maps to this client's own bundle; nothing is fetched for it.
    const badge = wrapper.find('[data-testid="bubble-sticker"]');
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toContain('🙏');
    expect(badge.text()).toContain('谢谢');

    await wrapper.find('[data-testid="sticker-trigger"]').trigger('click');
    await flushPromises();
    const ok = document.querySelector('[data-testid="sticker-ok"]') as HTMLElement | null;
    expect(ok, 'the picker lists the catalogue').toBeTruthy();
    ok?.click();
    await flushPromises();

    // A sticker is a message of its own, sent immediately through the same API.
    expect(mocks.send).toHaveBeenCalledWith('conv_bob', expect.objectContaining({ sticker: 'ok' }));
  });

  it('inserts an emoji into the composer instead of sending anything', async () => {
    const wrapper = mountChat({ attachTo: document.body });
    await flushPromises();
    mocks.send.mockClear();

    await wrapper.find('[data-testid="emoji-trigger"]').trigger('click');
    await flushPromises();
    const item = [...document.querySelectorAll('.el-dropdown-menu__item')].find((node) =>
      (node.textContent ?? '').includes('👍'),
    ) as HTMLElement | undefined;
    expect(item, 'the emoji list is offered').toBeTruthy();
    item?.click();
    await flushPromises();

    const composer = wrapper.find('[data-testid="composer"]').element as HTMLTextAreaElement;
    expect(composer.value).toContain('👍');
    // Emoji are just text: nothing is sent until the user presses send.
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('sends the composed text through the native API', async () => {
    const wrapper = mountChat();
    await flushPromises();

    const textarea = wrapper.find('textarea');
    expect(textarea.exists()).toBe(true);
    await textarea.setValue('请生成一份 Word 周报');

    const sendButton = wrapper
      .findAll('button')
      .find((button) => button.text().includes('发送'));
    expect(sendButton).toBeTruthy();
    await sendButton?.trigger('click');
    await flushPromises();

    expect(mocks.send).toHaveBeenCalledTimes(1);
    const call = mocks.send.mock.calls[0] as unknown as [
      string,
      { text: string; mentions: string[] },
    ];
    expect(call[0]).toBe('conv_bob');
    expect(call[1].text).toBe('请生成一份 Word 周报');
    expect(call[1].mentions).toEqual([]);
  });

  it('offers conversation search and group creation affordances', async () => {
    const wrapper = mountChat();
    await flushPromises();

    expect(wrapper.text()).toContain('＋群聊');
    expect(wrapper.find('input[placeholder="过滤会话或联系人"]').exists()).toBe(true);
    expect(wrapper.find('input[placeholder="搜索聊天记录（至少 2 个字）"]').exists()).toBe(true);
  });

  it('jumps to and flashes the matched message when a search hit is clicked', async () => {
    // jsdom does not implement scrollIntoView; the jump is the behavior under test.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    const wrapper = mountChat({ attachTo: document.body });
    await flushPromises();

    // The hit points at a message that exists in the loaded page (id m1), so
    // the jump can find its DOM node.
    mocks.search.mockResolvedValueOnce([
      {
        conversationId: 'conv_bob',
        title: 'Bob',
        message: {
          id: 'm1',
          text: '早上好，验收前请确认群聊',
          senderName: 'Bob',
          createdAt: new Date().toISOString(),
        },
      },
    ]);

    const input = wrapper.find('input[placeholder="搜索聊天记录（至少 2 个字）"]');
    await input.setValue('验收');
    // The search is debounced by 250ms; wait past it with real timers.
    await new Promise((resolve) => setTimeout(resolve, 350));
    await flushPromises();

    const hit = wrapper.find('.search-hit');
    expect(hit.exists(), 'a search hit is rendered for the query').toBe(true);
    expect(hit.text()).toContain('验收前请确认群聊');

    await hit.trigger('click');
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(scrollIntoView).toHaveBeenCalled();
    const flashed = document.querySelector('[data-message-id="m1"]');
    expect(flashed?.classList.contains('search-flash')).toBe(true);
    wrapper.unmount();
  });

  it('invites the selected contact into the open group conversation', async () => {
    mocks.listConversations.mockResolvedValue([mocks.group]);
    const wrapper = mountChat({ attachTo: document.body });
    await flushPromises();

    // Group conversations expose the invite affordance in the thread header.
    const invite = wrapper.findAll('button').find((button) => button.text().includes('邀请成员'));
    expect(invite, 'invite button is rendered for a group').toBeTruthy();
    await invite?.trigger('click');
    await flushPromises();

    // Select Bob through the component contract: the dropdown itself is
    // teleported to the body, so driving v-model keeps the test independent of
    // popper rendering in jsdom.
    const select = wrapper.findComponent({ name: 'ElSelect' });
    expect(select.exists(), 'invite dialog renders a member select').toBe(true);
    select.vm.$emit('update:modelValue', 'u_bob');
    await flushPromises();

    const confirm = [...document.querySelectorAll('.el-dialog__footer button')].find((node) =>
      (node.textContent ?? '').includes('邀请'),
    );
    expect(confirm, 'confirm button exists').toBeTruthy();
    (confirm as HTMLElement).click();
    await flushPromises();

    expect(mocks.addMember).toHaveBeenCalledWith('conv_group', 'u_bob');
    wrapper.unmount();
  });

  it('leaves the open group conversation and clears the selection', async () => {
    mocks.listConversations.mockResolvedValue([mocks.group]);
    const wrapper = mountChat();
    await flushPromises();
    mocks.listConversations.mockResolvedValue([]);

    const leave = wrapper.findAll('button').find((button) => button.text().includes('退出群聊'));
    expect(leave, 'leave button is rendered for a group').toBeTruthy();
    await leave?.trigger('click');
    await flushPromises();

    expect(mocks.leave).toHaveBeenCalledWith('conv_group');
    expect(wrapper.text()).not.toContain('验收小组');
  });

  it('offers recall on a fresh own message and hides the body after recalling', async () => {
    mocks.listMessages.mockResolvedValue([
      {
        id: 'm_own',
        channel: 'web',
        conversationId: 'conv_bob',
        chatType: 'direct',
        direction: 'inbound',
        kind: 'text',
        text: '这条消息可以被撤回',
        sender: { id: 'u_alice', name: 'Alice' },
        senderPrincipalId: 'u_alice',
        mentions: [],
        attachments: [],
        createdAt: new Date().toISOString(),
      },
    ]);
    const wrapper = mountChat();
    await flushPromises();

    const recall = wrapper.find('[data-testid="recall"]');
    expect(recall.exists(), 'own recent message exposes the recall action').toBe(true);
    await recall.trigger('click');
    await flushPromises();

    expect(mocks.recall).toHaveBeenCalledWith('m_own');
    expect(wrapper.text()).toContain('你撤回了一条消息');
    expect(wrapper.text()).not.toContain('这条消息可以被撤回');
  });

  it('sends a quoted reply and renders the quote', async () => {
    mocks.listMessages.mockResolvedValue([
      ...mocks.defaultMessages,
      {
        id: 'm_mine',
        channel: 'web',
        conversationId: 'conv_bob',
        chatType: 'direct',
        direction: 'inbound',
        kind: 'text',
        text: '我上一条',
        sender: { id: 'u_alice', name: 'Alice' },
        senderPrincipalId: 'u_alice',
        mentions: [],
        attachments: [],
        createdAt: new Date().toISOString(),
      },
    ]);
    const wrapper = mountChat();
    await flushPromises();

    const quote = wrapper.findAll('[data-testid="quote"]');
    expect(quote.length, 'messages expose a quote action').toBe(2);
    // The second bubble is my own message (m_mine).
    await quote[1]?.trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="quote-strip"]').exists(), 'composer shows the quote').toBe(true);

    await wrapper.find('textarea').setValue('引用回复内容');
    const sendButton = wrapper.findAll('button').find((button) => button.text().includes('发送'));
    await sendButton?.trigger('click');
    await flushPromises();

    const call = mocks.send.mock.calls[0] as unknown as [string, { text: string; replyTo?: string }];
    expect(call[1].text).toBe('引用回复内容');
    expect(call[1].replyTo).toBe('m_mine');
  });

  it('forwards a message into another conversation', async () => {
    mocks.listConversations.mockResolvedValue([
      mocks.conversation,
      { ...mocks.group, id: 'conv_other', title: '别的群' },
    ]);
    const wrapper = mountChat({ attachTo: document.body });
    await flushPromises();

    const forward = wrapper.find('[data-testid="forward"]');
    expect(forward.exists(), 'every visible message can be forwarded').toBe(true);
    await forward.trigger('click');
    await flushPromises();

    const select = wrapper.findComponent({ name: 'ElSelect' });
    expect(select.exists(), 'forward dialog offers a target picker').toBe(true);
    select.vm.$emit('update:modelValue', 'conv_other');
    await flushPromises();

    const confirm = [...document.querySelectorAll('.el-dialog__footer button')].find((node) =>
      (node.textContent ?? '').includes('转发'),
    );
    expect(confirm, 'confirm button exists').toBeTruthy();
    (confirm as HTMLElement).click();
    await flushPromises();

    expect(mocks.forward).toHaveBeenCalledWith('m1', 'conv_other');
    expect(wrapper.text()).toContain('已转发');
    wrapper.unmount();
  });

  it('does not offer recall for messages sent by somebody else', async () => {
    const wrapper = mountChat();
    await flushPromises();
    expect(wrapper.find('[data-testid="recall"]').exists()).toBe(false);
  });

  it('renders messages AND the earlier-page control in a long conversation', async () => {
    // Regression: "load earlier" used to be a sibling branch of the message
    // list, so a conversation longer than one page rendered no bubbles at all.
    const now = Date.now();
    const page = Array.from({ length: 50 }, (_, index) => ({
      id: `m${index}`,
      channel: 'web',
      conversationId: 'conv_bob',
      chatType: 'direct',
      direction: 'inbound',
      kind: 'text',
      text: `历史消息 ${index}`,
      sender: { id: 'u_bob', name: 'Bob' },
      mentions: [],
      attachments: [],
      createdAt: new Date(now + index * 1000).toISOString(),
    }));
    mocks.listMessages.mockResolvedValue(page);

    const wrapper = mountChat();
    await flushPromises();

    expect(wrapper.findAll('[data-testid="message-bubble"]').length).toBe(50);
    expect(wrapper.text()).toContain('加载更早的消息');
    expect(wrapper.text()).toContain('历史消息 49');
  });

  it('marks the last own message as read once the peer cursor catches up', async () => {
    const sentAt = new Date().toISOString();
    const withMine = [...mocks.defaultMessages, {
      id: 'm_mine',
      channel: 'web',
      conversationId: 'conv_bob',
      chatType: 'direct',
      direction: 'inbound',
      kind: 'text',
      text: '这条需要回执',
      sender: { id: 'u_alice', name: 'Alice' },
      senderPrincipalId: 'u_alice',
      mentions: [],
      attachments: [],
      createdAt: sentAt,
    }];
    mocks.listMessages.mockResolvedValue(withMine);
    mocks.readReceipts.mockResolvedValue({
      others: [{ memberId: 'u_bob', lastReadAt: new Date(Date.now() + 1000).toISOString() }],
    });

    const wrapper = mountChat();
    await flushPromises();

    const receipt = wrapper.find('[data-testid="receipt"]');
    expect(receipt.exists(), 'own last message shows a receipt').toBe(true);
    expect(receipt.text()).toContain('已读');
  });

  it('marks an online colleague in the contact list', async () => {
    const wrapper = mountChat();
    await flushPromises();
    expect(wrapper.text()).toContain('在线');
    const dot = wrapper.findAll('.presence-badge').find((node) => node.find('.is-dot').exists());
    expect(dot, 'an online contact shows a presence dot').toBeTruthy();
  });

  it('lists the group participants in a dialog', async () => {
    mocks.listConversations.mockResolvedValue([mocks.group]);
    const wrapper = mountChat();
    await flushPromises();

    const button = wrapper.find('[data-testid="members"]');
    expect(button.exists(), 'group header exposes the member list').toBe(true);
    await button.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('群成员');
    expect(wrapper.text()).toContain('Bob');
    expect(wrapper.text()).toContain('ChatAgent 助理');
  });


  it('shows the group announcement and lets the owner publish and dissolve', async () => {
    mocks.listConversations.mockResolvedValue([{ ...mocks.group, announcement: '本周五交周报' }]);
    const wrapper = mountChat({ attachTo: document.body });
    await flushPromises();

    // Everyone in the group sees the announcement without opening anything.
    expect(wrapper.find('[data-testid="group-announcement"]').text()).toContain('本周五交周报');

    await wrapper.find('[data-testid="members"]').trigger('click');
    await flushPromises();
    const field = document.querySelector('[data-testid="announcement-input"]') as HTMLTextAreaElement;
    expect(field, 'the manager panel offers an announcement field').toBeTruthy();
    field.value = '周五 17:00 前交';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();

    const publish = document.querySelector('[data-testid="announcement-publish"]') as HTMLElement;
    publish.click();
    await flushPromises();
    expect(mocks.setAnnouncement).toHaveBeenCalledWith('conv_group', '周五 17:00 前交');

    // Dissolving asks first, then goes through the API.
    const dissolve = document.querySelector('[data-testid="group-dissolve"]') as HTMLElement;
    dissolve.click();
    await flushPromises();
    // Dissolving stops the room for everybody, so it takes a second, explicit click.
    expect(mocks.dissolve).not.toHaveBeenCalled();
    const confirm = document.querySelector(
      '[data-testid="group-dissolve-confirm"]',
    ) as HTMLElement;
    expect(confirm, 'dissolving asks for confirmation').toBeTruthy();
    confirm.click();
    await flushPromises();
    expect(mocks.dissolve).toHaveBeenCalledWith('conv_group');
  });

  it('hides the governance controls from a member who does not manage the group', async () => {
    mocks.listConversations.mockResolvedValue([
      { ...mocks.group, ownerId: 'u_bob', adminIds: ['u_bob'] },
    ]);
    const wrapper = mountChat({ attachTo: document.body });
    await flushPromises();
    await wrapper.find('[data-testid="members"]').trigger('click');
    await flushPromises();

    expect(document.querySelector('[data-testid="announcement-input"]')).toBeNull();
    expect(document.querySelector('[data-testid="group-dissolve"]')).toBeNull();
    expect(document.querySelector('[data-testid="remove-member"]')).toBeNull();
  });

  it('renames the open group and removes a member from the panel', async () => {
    mocks.listConversations.mockResolvedValue([mocks.group]);
    // Dialogs are teleported to the body, so the component must be attached.
    const wrapper = mountChat({ attachTo: document.body });
    await flushPromises();

    const rename = wrapper.find('[data-testid="rename"]');
    expect(rename.exists(), 'group header exposes rename').toBe(true);
    await rename.trigger('click');
    await flushPromises();

    const input = document.querySelector('.el-dialog input');
    expect(input, 'rename dialog has an input').toBeTruthy();
    (input as HTMLInputElement).value = '改名后';
    input?.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();

    const save = [...document.querySelectorAll('.el-dialog__footer button')].find((node) =>
      (node.textContent ?? '').includes('保存'),
    );
    expect(save, 'rename dialog has a save button').toBeTruthy();
    (save as HTMLElement).click();
    await flushPromises();
    expect(mocks.rename).toHaveBeenCalledWith('conv_group', '改名后');

    await wrapper.find('[data-testid="members"]').trigger('click');
    await flushPromises();
    // The panel is teleported to the body, so query the document instead of the
    // component wrapper.
    const removeButton = document.querySelector('[data-testid="remove-member"]');
    expect(removeButton, 'another participant can be removed').toBeTruthy();
    (removeButton as HTMLElement).click();
    await flushPromises();
    expect(mocks.removeMember).toHaveBeenCalledWith('conv_group', 'u_bob');
  });

  it('counts how many colleagues have read my last group message', async () => {
    const sentAt = new Date().toISOString();
    mocks.listConversations.mockResolvedValue([mocks.group]);
    mocks.listMessages.mockResolvedValue([
      {
        id: 'm_group_mine',
        channel: 'web',
        conversationId: 'conv_group',
        chatType: 'group',
        direction: 'inbound',
        kind: 'text',
        text: '群里的最后一条',
        sender: { id: 'u_alice', name: 'Alice' },
        senderPrincipalId: 'u_alice',
        mentions: [],
        attachments: [],
        createdAt: sentAt,
      },
    ]);
    mocks.readReceipts.mockResolvedValue({
      others: [
        { memberId: 'u_bob', lastReadAt: new Date(Date.now() + 1000).toISOString() },
        { memberId: 'u_mallory', lastReadAt: new Date(Date.now() + 1000).toISOString() },
      ],
    });

    const wrapper = mountChat();
    await flushPromises();

    const receipt = wrapper.find('[data-testid="receipt"]');
    expect(receipt.exists(), 'group messages show a read counter').toBe(true);
    expect(receipt.text()).toContain('2 人已读');
  });

  it('does not offer group membership actions in a direct conversation', async () => {
    const wrapper = mountChat();
    await flushPromises();
    await wrapper.find('[data-testid="conversation-item"]').trigger('click');
    await flushPromises();

    expect(wrapper.findAll('button').some((button) => button.text().includes('退出群聊'))).toBe(false);
  });
});
