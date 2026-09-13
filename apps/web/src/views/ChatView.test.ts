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
    createdAt: now,
    updatedAt: now,
    messageIds: [],
    unreadCount: 0,
  };

  return {
    conversation,
    group,
    markRead: vi.fn(async () => ({ ok: true })),
    send: vi.fn(async () => ({ message: {} })),
    open: vi.fn(async () => conversation),
    createGroup: vi.fn(async () => conversation),
    addMember: vi.fn(async () => ({ ok: true })),
    rename: vi.fn(async () => ({ id: 'conv_group', title: '改名后' })),
    removeMember: vi.fn(async () => ({ ok: true })),
    leave: vi.fn(async () => ({ ok: true })),
    listConversations: vi.fn(async () => [conversation]),
    recall: vi.fn(async () => ({ ok: true })),
    readReceipts: vi.fn(async () => ({ others: [] as Array<{ memberId: string; lastReadAt: string }> })),
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
      },
      {
        id: 'agent_1',
        displayName: 'ChatAgent 助理',
        organizationId: 'org_local',
        roles: [],
        kind: 'agent' as const,
      },
    ]),
    chat: {
      conversations: mocks.listConversations,
      messages: mocks.listMessages,
      markRead: mocks.markRead,
      send: mocks.send,
      open: mocks.open,
      conversation: vi.fn(async () => mocks.group),
      createGroup: mocks.createGroup,
      recall: mocks.recall,
      readReceipts: mocks.readReceipts,
      exportConversation: vi.fn(async () => ({ id: 'f1', name: 'x.docx', url: '/api/files/f1' })),
      addMember: mocks.addMember,
      rename: mocks.rename,
      removeMember: mocks.removeMember,
      leave: mocks.leave,
      upload: vi.fn(),
    },
    tasks: { list: vi.fn(async () => []) },
    approvals: { list: vi.fn(async () => []), decide: vi.fn() },
    search: vi.fn(async () => []),
  },
}));

const me: MemberView = {
  id: 'u_alice',
  displayName: 'Alice',
  organizationId: 'org_local',
  roles: ['member'],
  kind: 'member',
};

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  addEventListener(): void {}
  close(): void {}
}

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource);
  mocks.markRead.mockClear();
  mocks.send.mockClear();
  mocks.listMessages.mockClear();
  mocks.addMember.mockClear();
  mocks.recall.mockClear();
  mocks.readReceipts.mockClear();
  mocks.readReceipts.mockResolvedValue({ others: [] });
  mocks.leave.mockClear();
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
