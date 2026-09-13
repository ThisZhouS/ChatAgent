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
  audit: vi.fn(async () => []),
  agentStatus: vi.fn(async () => ({
    provider: 'mock',
    accounts: { total: 1, online: 1 },
    tasks: { total: 0, byState: {} },
    tools: [],
  })),
}));

vi.mock('../api', () => ({
  api: {
    auth: {
      rotateToken: mocks.rotateToken,
      sessions: mocks.sessions,
      revokeSession: mocks.revokeSession,
      revokeOtherSessions: mocks.revokeOtherSessions,
    },
    audit: mocks.audit,
    agentStatus: mocks.agentStatus,
  },
}));

const me: MemberView = {
  id: 'u_alice',
  displayName: 'Alice',
  organizationId: 'org_local',
  roles: ['member'],
  kind: 'member',
};

beforeEach(() => {
  mocks.rotateToken.mockClear();
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
});
