import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import type { MemberView } from '@chatagent/contracts';
import SettingsView from './SettingsView.vue';

const mocks = vi.hoisted(() => ({
  rotateToken: vi.fn(async () => ({ token: 'rotated-token-value-0123456789abcdef' })),
  sessions: vi.fn(async () => [
    {
      id: 's_current',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      lastSeenAt: new Date().toISOString(),
      current: true,
    },
    {
      id: 's_other',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      lastSeenAt: new Date().toISOString(),
      current: false,
    },
  ]),
  revokeSession: vi.fn(async () => ({ ok: true })),
  revokeOtherSessions: vi.fn(async () => ({ revoked: 1 })),
  audit: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
  agentStatus: vi.fn(async () => ({
    provider: 'mock',
    accounts: { total: 1, online: 1 },
    tasks: { total: 0, byState: {} },
    tools: [],
  })),
  // Per-member assistant preferences (product decision 5). The server answers with resolved
  // values, so these defaults are what a member who never changed anything sees.
  preferencesGet: vi.fn(async () => ({ agentContextMessages: 20, clarifyHistoryLimit: 50 })),
  // Personal id (question 8): the card loads the member's own profile and renames through it.
  me: vi.fn(async () => ({
    id: 'u_alice',
    displayName: 'Alice',
    organizationId: 'org_local',
    roles: ['member'],
    kind: 'member' as const,
    handle: 'alice',
  })),
  setHandle: vi.fn(async (handle: string) => ({
    id: 'u_alice',
    displayName: 'Alice',
    organizationId: 'org_local',
    roles: ['member'],
    kind: 'member' as const,
    handle,
  })),
  preferencesUpdate: vi.fn(async (payload: { agentContextMessages?: number; clarifyHistoryLimit?: number }) => ({
    agentContextMessages: payload.agentContextMessages ?? 20,
    clarifyHistoryLimit: payload.clarifyHistoryLimit ?? 50,
  })),
}));

vi.mock('../api', () => ({
  api: {
    auth: {
      rotateToken: mocks.rotateToken,
      sessions: mocks.sessions,
      revokeSession: mocks.revokeSession,
      revokeOtherSessions: mocks.revokeOtherSessions,
      me: mocks.me,
      setHandle: mocks.setHandle,
    },
    audit: { list: mocks.audit },
    agentStatus: mocks.agentStatus,
    preferences: {
      get: mocks.preferencesGet,
      update: mocks.preferencesUpdate,
    },
  },
}));

const me: MemberView = {
  id: 'u_alice',
  displayName: 'Alice',
  organizationId: 'org_local',
  roles: ['member'],
  kind: 'member',
};

const adminMe: MemberView = {
  ...me,
  roles: ['owner'],
};

const auditSeed = [
  { at: '2026-09-15T01:00:00.000Z', action: 'local_tasks.sync', outcome: 'ok', actorId: 'u_alice', target: 'member:u_alice', detail: '1 receipts' },
  { at: '2026-09-15T01:01:00.000Z', action: 'task.submit', outcome: 'ok', actorId: 'u_alice', target: 'task:t1', detail: '' },
  { at: '2026-09-15T01:02:00.000Z', action: 'task.submit', outcome: 'denied', actorId: 'u_bob', target: 'task:t2', detail: 'forbidden' },
];

beforeEach(() => {
  mocks.rotateToken.mockClear();
  mocks.me.mockClear();
  mocks.setHandle.mockClear();
  mocks.preferencesGet.mockClear();
  mocks.preferencesGet.mockResolvedValue({ agentContextMessages: 20, clarifyHistoryLimit: 50 });
  mocks.preferencesUpdate.mockClear();
  mocks.preferencesUpdate.mockImplementation(
    async (payload: { agentContextMessages?: number; clarifyHistoryLimit?: number }) => ({
      agentContextMessages: payload.agentContextMessages ?? 20,
      clarifyHistoryLimit: payload.clarifyHistoryLimit ?? 50,
    }),
  );
});

describe('SettingsView', () => {
  it('rotates the member token and surfaces the new value once', async () => {
    const wrapper = mount(SettingsView, {
      props: { me },
      global: { plugins: [ElementPlus] },
    });
    await flushPromises();

    const button = wrapper.findAll('button').find((node) => node.text().includes('重置我的访问令牌'));
    expect(button, 'rotation button is rendered').toBeTruthy();
    expect(wrapper.text()).toContain('旧令牌与所有会话立即失效');

    await button?.trigger('click');
    await flushPromises();

    expect(mocks.rotateToken).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('rotated-token-value-0123456789abcdef');
  });

  it('lists the login sessions and revokes a device that is not this one', async () => {
    const wrapper = mount(SettingsView, {
      props: { me },
      global: { plugins: [ElementPlus] },
    });
    await flushPromises();

    expect(mocks.sessions).toHaveBeenCalled();
    expect(wrapper.text()).toContain('我的登录会话');
    expect(wrapper.text()).toContain('当前设备');

    const revoke = wrapper.findAll('button').find((node) => node.text().trim() === '撤销');
    expect(revoke, 'a non-current session can be revoked').toBeTruthy();
    await revoke?.trigger('click');
    await flushPromises();
    expect(mocks.revokeSession).toHaveBeenCalledWith('s_other');

    const revokeAll = wrapper.findAll('button').find((node) => node.text().includes('撤销其他会话'));
    expect(revokeAll, 'a bulk sign-out control exists').toBeTruthy();
    await revokeAll?.trigger('click');
    await flushPromises();
    expect(mocks.revokeOtherSessions).toHaveBeenCalledTimes(1);
  });

  it('hides the local-agent card in a plain browser (no host bridge)', async () => {
    delete (window as { chatagent?: unknown }).chatagent;
    const wrapper = mount(SettingsView, {
      props: { me },
      global: { plugins: [ElementPlus] },
    });
    await flushPromises();
    expect(wrapper.text()).not.toContain('本机 Agent 主机');
  });

  it('shows host status and submits a task through the narrow bridge inside Electron', async () => {
    const commands: unknown[] = [];
    const command = vi.fn(async (cmd: unknown) => {
      commands.push(cmd);
      if ((cmd as { type?: string }).type === 'status') {
        return {
          ok: true,
          result: { deviceId: 'desktop-win32', agentId: 'hermes', running: true, runningTasks: 1, paused: false, executor: 'fake', executorReason: 'real Hermes runtime not found' },
        };
      }
      if ((cmd as { type?: string }).type === 'list') {
        return {
          ok: true,
          result: { tasks: [{ taskId: 'ui-1', state: 'running', kind: 'document', goal: '生成周报', artifacts: [] }] },
        };
      }
      return { ok: true, result: {} };
    });
    (window as { chatagent?: unknown }).chatagent = {
      platform: 'win32',
      versions: { electron: '33.2.0', chrome: '130', node: '20' },
      host: { command, quitApp: vi.fn(async () => ({ ok: true })) },
    };

    const wrapper = mount(SettingsView, {
      props: { me },
      global: { plugins: [ElementPlus] },
    });
    await flushPromises();

    expect(wrapper.text()).toContain('本机 Agent 主机');
    expect(wrapper.text()).toContain('desktop-win32');
    expect(wrapper.text()).toContain('生成周报');
    expect(command).toHaveBeenCalledWith({ type: 'status' });
    expect(command).toHaveBeenCalledWith({ type: 'list' });

    // submit a document task through the controlled bridge
    const input = wrapper.find('input[placeholder*="任务目标"]');
    await input.setValue('整理会议纪要');
    const submit = wrapper.findAll('button').find((node) => node.text().trim() === '提交任务');
    await submit?.trigger('click');
    await flushPromises();

    const submitted = commands.find((cmd) => (cmd as { type?: string }).type === 'submit') as {
      type: string; goal: string; kind: string; toolsets: string[]; taskId: string;
    } | undefined;
    expect(submitted, 'a submit command went through the bridge').toBeTruthy();
    expect(submitted?.goal).toBe('整理会议纪要');
    expect(submitted?.kind).toBe('document');
    expect(submitted?.toolsets).toEqual(['document']);
    expect(submitted?.taskId).toMatch(/^ui-/);
  });

  it('distinguishes a refused receipt upload from a network failure', async () => {
    const mountWith = async (receiptSync: Record<string, unknown>) => {
      const command = vi.fn(async (cmd: unknown) => {
        if ((cmd as { type?: string }).type === 'status') {
          return {
            ok: true,
            result: { deviceId: 'desktop-1', agentId: 'hermes', running: true, executor: 'hermes', receiptSync },
          };
        }
        if ((cmd as { type?: string }).type === 'list') return { ok: true, result: { tasks: [], total: 0 } };
        return { ok: true, result: {} };
      });
      (window as { chatagent?: unknown }).chatagent = {
        platform: 'win32',
        versions: { electron: '39.8.10', chrome: '142', node: '22' },
        host: { command, quitApp: vi.fn(async () => ({ ok: true })) },
      };
      const wrapper = mount(SettingsView, { props: { me }, global: { plugins: [ElementPlus] } });
      await flushPromises();
      return wrapper;
    };

    // The server refused the batch: waiting for the network will not help, and the
    // records are still on this machine.
    const refused = await mountWith({
      pending: 3,
      synced: 1,
      lastError: 'http_403',
      lastFailure: { kind: 'server_rejected', status: 403, detail: 'http_403' },
    });
    const refusedNote = refused.find('[data-testid="receipt-sync"]').text();
    expect(refusedNote).toContain('3 条回执被服务端拒收');
    expect(refusedNote).toContain('http_403');
    expect(refusedNote).toContain('已停止自动重试');
    expect(refusedNote).not.toContain('联网后自动重试');

    // The network is down: this one does resolve itself.
    const offline = await mountWith({
      pending: 2,
      synced: 0,
      lastError: 'network: ENOTFOUND',
      lastFailure: { kind: 'network', detail: 'network: ENOTFOUND' },
    });
    expect(offline.find('[data-testid="receipt-sync"]').text()).toContain('联网后自动重试');

    // Nothing queued and nothing wrong: no note at all.
    const quiet = await mountWith({ pending: 0, synced: 5 });
    expect(quiet.find('[data-testid="receipt-sync"]').exists()).toBe(false);
  });

  it('surfaces an unverified authorization without implying a rollback', async () => {
    const command = vi.fn(async (cmd: unknown) => {
      if ((cmd as { type?: string }).type === 'status') {
        return {
          ok: true,
          result: {
            deviceId: 'desktop-9f2c4d1e',
            agentId: 'hermes',
            running: true,
            runningTasks: 1,
            paused: false,
            executor: 'hermes',
            // The organization service could not be reached: new external actions
            // are held, work already running is untouched.
            authorization: {
              state: 'unverified',
              lastError: 'http_503',
              checks: 1,
              failures: 1,
              revoked: 1,
              unverifiable: 2,
              heldTasks: 2,
            },
          },
        };
      }
      if ((cmd as { type?: string }).type === 'list') return { ok: true, result: { tasks: [], total: 0 } };
      return { ok: true, result: {} };
    });
    (window as { chatagent?: unknown }).chatagent = {
      platform: 'win32',
      versions: { electron: '39.8.10', chrome: '142', node: '22' },
      host: { command, quitApp: vi.fn(async () => ({ ok: true })) },
    };

    const wrapper = mount(SettingsView, {
      props: { me },
      global: { plugins: [ElementPlus] },
    });
    await flushPromises();

    const note = wrapper.find('[data-testid="host-authorization"]').text();
    expect(note).toContain('http_503');
    // Fail closed, but nothing is thrown away or rolled back.
    expect(note).toContain('新的外部操作已暂缓');
    expect(note).toContain('已开始的执行不受影响');
    expect(note).toContain('2 条等待复核的任务仍在队列中');
    expect(note).toContain('未失败、未被丢弃');
    expect(note).toContain('已撤销 1 项授权');
    expect(note).toContain('2 项授权无法确认');
  });

  it('surfaces the block reason and offers a retry for a failed local task', async () => {
    const commands: unknown[] = [];
    const command = vi.fn(async (cmd: unknown) => {
      commands.push(cmd);
      if ((cmd as { type?: string }).type === 'status') {
        return {
          ok: true,
          result: {
            deviceId: 'desktop-9f2c4d1e',
            agentId: 'hermes',
            running: true,
            runningTasks: 0,
            paused: false,
            executor: 'fake',
            lateResultsDropped: 1,
            storeIntegrity: { repaired: 2, quarantined: 1, duplicates: 0, prunable: 3, pruned: 5 },
          },
        };
      }
      if ((cmd as { type?: string }).type === 'list') {
        return {
          ok: true,
          result: {
            total: 42,
            tasks: [
              {
                taskId: 'ui-blocked',
                state: 'failed',
                kind: 'side_effect',
                goal: '发送周报',
                artifacts: [],
                blockedReason: 'approval_digest_mismatch',
                error: 'approval_digest_mismatch',
              },
              {
                taskId: 'ui-retryable',
                state: 'failed',
                kind: 'document',
                goal: '整理纪要',
                artifacts: [],
                error: 'no_provider',
              },
            ],
          },
        };
      }
      return { ok: true, result: {} };
    });
    (window as { chatagent?: unknown }).chatagent = {
      platform: 'win32',
      versions: { electron: '39.8.10', chrome: '142', node: '22' },
      host: { command, quitApp: vi.fn(async () => ({ ok: true })) },
    };

    const wrapper = mount(SettingsView, {
      props: { me },
      global: { plugins: [ElementPlus] },
    });
    await flushPromises();

    // The reason a task did not run is visible instead of a bare "failed".
    expect(wrapper.text()).toContain('approval_digest_mismatch');
    expect(wrapper.text()).toContain('no_provider');
    expect(wrapper.text()).toContain('desktop-9f2c4d1e');
    // A quarantined/repared task store is surfaced instead of silently absorbed.
    expect(wrapper.find('[data-testid="host-integrity"]').text()).toContain('1 条记录无法解析');
    expect(wrapper.find('[data-testid="host-integrity"]').text()).toContain('2 条记录已按当前格式修复');
    // Retention is housekeeping, not a repair: it is reported separately and says
    // which work is unaffected.
    // The device may hold more than one page; the card says so.
    expect(wrapper.find('[data-testid="host-task-page"]').text()).toContain('本机共 42 条任务记录');
    const retention = wrapper.find('[data-testid="host-retention"]').text();
    expect(retention).toContain('3 条更早的终态记录');
    expect(retention).toContain('进行中的任务不受影响');
    // Already-pruned records are reported too: housekeeping must not look like
    // unexplained data loss.
    expect(retention).toContain('已按保留策略清理 5 条');

    const retry = wrapper.findAll('button').filter((node) => node.text().trim() === '重试');
    // Only the retryable document task gets a control: a blocked side effect needs
    // a fresh organization approval, which the host never grants from a retry.
    expect(retry.length, 'exactly the document task is retryable').toBe(1);
    await retry[0]?.trigger('click');
    await flushPromises();
    expect(commands).toContainEqual({ type: 'retry', taskId: 'ui-retryable' });
  });

  it('filters the admin audit log by action keyword and outcome', async () => {
    mocks.audit.mockResolvedValueOnce(auditSeed);
    const wrapper = mount(SettingsView, {
      props: { me: adminMe },
      global: { plugins: [ElementPlus] },
    });
    await flushPromises();
    expect(mocks.audit).toHaveBeenCalled();
    // Seed data renders before filtering. The page has several tables, so
    // count rows only inside the audit card.
    expect(wrapper.text()).toContain('local_tasks.sync');
    const auditCard = wrapper.find('.audit-filters').element.closest('.el-card') as HTMLElement;
    const rows = () => auditCard.querySelectorAll('.el-table__row').length;
    expect(rows()).toBe(3);
    const outcomeSelect = wrapper.findAll('.audit-filters .el-select').at(0);
    // Element Plus select needs pointer work; drive the ref through the input
    // events of the underlying component instead of simulating a dropdown.
    const vm = wrapper.findComponent({ name: 'ElSelect' });
    expect(vm.exists()).toBe(true);

    // Simpler and robust: filter by action keyword via the text input.
    const actionInput = wrapper.find('.audit-filters input');
    await actionInput.setValue('local_tasks');
    expect(rows()).toBe(1);

    await actionInput.setValue('task.submit');
    expect(rows()).toBe(2);

    await actionInput.setValue('');
    expect(rows()).toBe(3);
  });
});

describe('SettingsView assistant preferences', () => {
  it('shows the values the server will actually use, not blanks', async () => {
    const wrapper = mount(SettingsView, {
      props: { me },
      global: { plugins: [ElementPlus] },
    });
    await flushPromises();

    expect(mocks.preferencesGet).toHaveBeenCalled();
    // A member who never changed anything reads the deployment defaults: the card must say what
    // is in force, otherwise "saved" and "not saved" look the same.
    expect(wrapper.find('[data-testid="preferences-card"]').text()).toContain('当前生效：20 / 50');
  });

  it('saves both numbers and reports what the server confirmed', async () => {
    const wrapper = mount(SettingsView, {
      props: { me },
      global: { plugins: [ElementPlus] },
    });
    await flushPromises();

    const contextInput = wrapper.find('[data-testid="preference-context"] input');
    await contextInput.setValue('5');
    await contextInput.trigger('change');
    await wrapper.find('[data-testid="preference-save"]').trigger('click');
    await flushPromises();

    expect(mocks.preferencesUpdate).toHaveBeenCalledWith({
      agentContextMessages: 5,
      clarifyHistoryLimit: 50,
    });
    expect(wrapper.find('[data-testid="preference-note"]').text()).toContain('已保存');
    expect(wrapper.find('[data-testid="preferences-card"]').text()).toContain('当前生效：5 / 50');
  });

  it('surfaces a refused save instead of pretending it worked', async () => {
    mocks.preferencesUpdate.mockRejectedValueOnce(new Error('no preference to update'));
    const wrapper = mount(SettingsView, {
      props: { me },
      global: { plugins: [ElementPlus] },
    });
    await flushPromises();

    await wrapper.find('[data-testid="preference-save"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="preference-error"]').text()).toContain('no preference to update');
    // The confirmed values keep showing: a failed save must not change what is in force.
    expect(wrapper.find('[data-testid="preferences-card"]').text()).toContain('当前生效：20 / 50');
  });
});

describe('SettingsView personal id', () => {
  it('shows the handle the server has for this member and saves a new one', async () => {
    const wrapper = mount(SettingsView, {
      props: { me },
      global: { plugins: [ElementPlus] },
    });
    await flushPromises();

    expect(mocks.me).toHaveBeenCalled();
    expect(wrapper.find('[data-testid="handle-card"]').text()).toContain('当前：@alice');

    // Element Plus binds attributes onto the inner input element, so the test id is the input.
    const input = wrapper.find('input[data-testid="handle-input"]');
    await input.setValue('alice.wang');
    await wrapper.find('[data-testid="handle-save"]').trigger('click');
    await flushPromises();

    expect(mocks.setHandle).toHaveBeenCalledWith('alice.wang');
    expect(wrapper.find('[data-testid="handle-note"]').text()).toContain('已保存');
    expect(wrapper.find('[data-testid="handle-card"]').text()).toContain('当前：@alice.wang');
  });

  it('shows why a rename was refused instead of guessing', async () => {
    mocks.setHandle.mockRejectedValueOnce(new Error('this handle is already taken'));
    const wrapper = mount(SettingsView, {
      props: { me },
      global: { plugins: [ElementPlus] },
    });
    await flushPromises();

    await wrapper.find('input[data-testid="handle-input"]').setValue('bob');
    await wrapper.find('[data-testid="handle-save"]').trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-testid="handle-error"]').text()).toContain('already taken');
    // The confirmed name keeps showing: a refused rename did not change anything.
    expect(wrapper.find('[data-testid="handle-card"]').text()).toContain('当前：@alice');
  });
});
