import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import type { ApprovalRecord, MemberView } from '@chatagent/contracts';
import ApprovalsView from './ApprovalsView.vue';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  decide: vi.fn(),
  outbox: vi.fn(),
  resume: vi.fn(),
}));

vi.mock('../api', () => ({
  api: {
    approvals: { list: mocks.list, decide: mocks.decide },
    outbox: { list: mocks.outbox },
    tasks: { resume: mocks.resume },
  },
}));

const now = new Date().toISOString();

function approval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: 'ap_1',
    organizationId: 'org_local',
    taskId: 'task_1',
    status: 'pending',
    // The action carries the tool, the recipient and the exact payload the
    // digest covers; the card summarises all three.
    action: {
      tool: 'send_message',
      target: 'chat:c-1',
      chatType: 'direct',
      kind: 'message',
      text: '季度汇报',
    },
    digest: 'a'.repeat(64),
    requesterId: 'u_alice',
    createdAt: now,
    expiresAt: now,
    ...overrides,
  } as ApprovalRecord;
}

const owner: MemberView = {
  id: 'u_owner',
  displayName: 'Owner',
  organizationId: 'org_local',
  roles: ['owner'],
  kind: 'member',
};

const member: MemberView = {
  id: 'u_alice',
  displayName: 'Alice',
  organizationId: 'org_local',
  roles: ['member'],
  kind: 'member',
};

beforeEach(() => {
  mocks.list.mockReset();
  mocks.decide.mockReset();
  mocks.outbox.mockReset();
  mocks.resume.mockReset();
  mocks.list.mockResolvedValue([approval()]);
  mocks.decide.mockResolvedValue(approval({ status: 'approved' }));
  mocks.resume.mockResolvedValue({ ok: true });
  mocks.outbox.mockResolvedValue([]);
});

describe('ApprovalsView', () => {
  it('renders the pending action and its requester', async () => {
    const wrapper = mount(ApprovalsView, { props: { me: owner }, global: { plugins: [ElementPlus] } });
    await flushPromises();

    expect(mocks.list).toHaveBeenCalled();
    const text = wrapper.text();
    expect(text).toContain('u_alice');
    expect(text).toContain('send_message → chat:c-1：季度汇报');
    wrapper.unmount();
  });

  it('approves through the API and resumes the gated task', async () => {
    const wrapper = mount(ApprovalsView, { props: { me: owner }, global: { plugins: [ElementPlus] } });
    await flushPromises();

    const approve = wrapper.findAll('button').find((button) => button.text().includes('批准并继续'));
    expect(approve, 'the approve control is offered to an owner').toBeTruthy();
    await approve?.trigger('click');
    await flushPromises();

    expect(mocks.decide).toHaveBeenCalledWith('ap_1', 'approved');
    // Approving must continue the task that was parked, not only flip a flag.
    expect(mocks.resume).toHaveBeenCalledWith('task_1');
    wrapper.unmount();
  });

  it('rejects without resuming the task', async () => {
    const wrapper = mount(ApprovalsView, { props: { me: owner }, global: { plugins: [ElementPlus] } });
    await flushPromises();

    const reject = wrapper.findAll('button').find((button) => button.text().trim() === '驳回');
    expect(reject, 'the reject control is offered to an owner').toBeTruthy();
    await reject?.trigger('click');
    await flushPromises();

    expect(mocks.decide).toHaveBeenCalledWith('ap_1', 'rejected');
    expect(mocks.resume).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('disables the decision controls for a member who cannot approve', async () => {
    const wrapper = mount(ApprovalsView, { props: { me: member }, global: { plugins: [ElementPlus] } });
    await flushPromises();

    const approve = wrapper.findAll('button').find((button) => button.text().includes('批准并继续'));
    expect(approve?.attributes('disabled')).toBeDefined();
    expect(wrapper.text()).toContain('只有组织所有者/管理员可以审批');
    expect(mocks.decide).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('surfaces a decision failure instead of pretending it worked', async () => {
    mocks.decide.mockRejectedValueOnce(new Error('403 Forbidden: 发起人不能自审'));
    const wrapper = mount(ApprovalsView, { props: { me: owner }, global: { plugins: [ElementPlus] } });
    await flushPromises();

    const approve = wrapper.findAll('button').find((button) => button.text().includes('批准并继续'));
    await approve?.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('发起人不能自审');
    wrapper.unmount();
  });
});
