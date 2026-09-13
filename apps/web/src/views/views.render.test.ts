import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import type { MemberView } from '@chatagent/contracts';
import AccountsView from './AccountsView.vue';
import ApprovalsView from './ApprovalsView.vue';
import DashboardView from './DashboardView.vue';
import DocumentsView from './DocumentsView.vue';
import LoginView from './LoginView.vue';
import MembersView from './MembersView.vue';
import TasksView from './TasksView.vue';

/**
 * Every page must render real content. A malformed SFC template still builds
 * and still serves HTTP 200 (vite reports no error), so a render test per view
 * is the only cheap guard against shipping a blank page.
 */

const mocks = vi.hoisted(() => ({
  status: vi.fn(async () => ({
    provider: 'mock',
    accounts: { total: 1, online: 1 },
    tasks: { total: 0, byState: {} },
    tools: ['create_word_document'],
    approvals: { pending: 0 },
    outbox: [],
    conversations: 0,
    streams: 0,
    queueDepth: 0,
  })),
  listTasks: vi.fn(async () => []),
  getTask: vi.fn(async () => undefined),
  taskEvents: vi.fn(async () => []),
  createTask: vi.fn(),
  cancelTask: vi.fn(),
  resumeTask: vi.fn(),
  retryTask: vi.fn(),
  listAccounts: vi.fn(async () => []),
  listApprovals: vi.fn(async () => []),
  listOutbox: vi.fn(async () => []),
  listFiles: vi.fn(async () => ({ artifacts: [], uploads: [] })),
  listMembers: vi.fn(async () => []),
  login: vi.fn(),
}));

vi.mock('../api', () => ({
  ApiError: class ApiError extends Error {
    status = 0;
  },
  setSessionToken: vi.fn(),
  api: {
    status: mocks.status,
    tasks: {
      list: mocks.listTasks,
      get: mocks.getTask,
      events: mocks.taskEvents,
      create: mocks.createTask,
      cancel: mocks.cancelTask,
      resume: mocks.resumeTask,
      retry: mocks.retryTask,
    },
    accounts: { list: mocks.listAccounts, create: vi.fn(), update: vi.fn() },
    approvals: { list: mocks.listApprovals, decide: vi.fn() },
    outbox: { list: mocks.listOutbox, resolve: vi.fn() },
    files: { list: mocks.listFiles, downloadUrl: (id: string) => `/api/files/${id}` },
    members: { list: mocks.listMembers, create: vi.fn(), update: vi.fn(), rotateToken: vi.fn() },
    documents: { parse: vi.fn(), generateWord: vi.fn(), generateExcel: vi.fn() },
    auth: { login: mocks.login, rotateToken: vi.fn() },
    audit: { list: vi.fn(async () => []) },
  },
}));

const me: MemberView = {
  id: 'u_alice',
  displayName: 'Alice',
  organizationId: 'org_local',
  roles: ['member'],
  kind: 'member',
};

interface PageCase {
  name: string;
  component: unknown;
  marker: string;
  props?: Record<string, unknown>;
}

const pages: PageCase[] = [
  { name: 'DashboardView', component: DashboardView, marker: '工作台' },
  { name: 'TasksView', component: TasksView, marker: '任务' },
  { name: 'ApprovalsView', component: ApprovalsView, props: { me }, marker: '审批' },
  { name: 'DocumentsView', component: DocumentsView, marker: '文件' },
  { name: 'AccountsView', component: AccountsView, marker: '账号' },
  { name: 'MembersView', component: MembersView, props: { me }, marker: '成员' },
];

describe('views render', () => {
  for (const page of pages) {
    it(`${page.name} renders its page shell`, async () => {
      const wrapper = mount(page.component as never, {
        props: (page.props ?? {}) as never,
        global: { plugins: [ElementPlus] },
      });
      await flushPromises();
      expect(wrapper.text()).toContain(page.marker);
      expect(wrapper.findAll('.el-card').length).toBeGreaterThan(0);
      wrapper.unmount();
    });
  }

  it('LoginView renders the credential form', async () => {
    const wrapper = mount(LoginView, { global: { plugins: [ElementPlus] } });
    await flushPromises();
    expect(wrapper.text()).toContain('ChatAgent');
    expect(wrapper.find('[data-testid="login-member"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="login-token"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="login-submit"]').exists()).toBe(true);
    wrapper.unmount();
  });
});
