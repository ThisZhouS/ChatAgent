/**
 * The tier editor is where an operator decides what an assistant may do with a person's
 * messages. It is a controlled component: rows and the default come from the parent and
 * every edit is emitted, so the saved map can never drift from what was shown.
 *
 * The assertions stay on the component's own contract (hints, emitted rows) rather than on
 * Element Plus internals, which render differently in jsdom than in a browser.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ElementPlus from 'element-plus';
import AccountTierEditor from './AccountTierEditor.vue';

type Tier = 'confirm' | 'chat' | 'ignore';

function mountEditor(defaultTier: Tier = 'confirm', tiers: Array<{ memberId: string; tier: Tier }> = []) {
  return mount(AccountTierEditor, {
    props: { defaultTier, tiers },
    global: { plugins: [ElementPlus] },
  });
}

describe('AccountTierEditor', () => {
  it('explains what the selected default tier actually permits', () => {
    const confirm = mountEditor('confirm');
    expect(confirm.find('[data-testid="default-tier-hint"]').text()).toContain('副作用需负责人确认');

    const chat = mountEditor('chat');
    expect(chat.find('[data-testid="default-tier-hint"]').text()).toContain('仅会话与读文档');

    const ignore = mountEditor('ignore');
    expect(ignore.find('[data-testid="default-tier-hint"]').text()).toContain('不交给助手');
  });

  it('says that an empty row is not saved and that the owner keeps full rights', () => {
    const wrapper = mountEditor();
    const text = wrapper.text();
    expect(text).toContain('留空的成员 ID 不会保存');
    expect(text).toContain('负责人本人与组织管理员始终按主权限处理');
    // One row editor per explicit contact, and none by default.
    expect(wrapper.findAll('.tier-row')).toHaveLength(0);
    expect(wrapper.find('[data-testid="tier-add"]').exists()).toBe(true);
  });

  it('emits a new row instead of mutating the prop', async () => {
    const wrapper = mountEditor();
    await wrapper.find('[data-testid="tier-add"]').trigger('click');
    const emitted = wrapper.emitted('update:tiers');
    expect(emitted).toBeTruthy();
    expect(emitted?.at(-1)?.[0]).toEqual([{ memberId: '', tier: 'confirm' }]);
    // The parent still owns the list: nothing was added locally.
    expect(wrapper.findAll('.tier-row')).toHaveLength(0);
  });

  it('emits the remaining rows when one is removed', async () => {
    const wrapper = mountEditor('confirm', [
      { memberId: 'u_alice', tier: 'confirm' },
      { memberId: 'u_bob', tier: 'chat' },
    ]);
    expect(wrapper.findAll('.tier-row')).toHaveLength(2);
    await wrapper.findAll('[data-testid="tier-remove"]')[0]?.trigger('click');
    const emitted = wrapper.emitted('update:tiers');
    expect(emitted?.at(-1)?.[0]).toEqual([{ memberId: 'u_bob', tier: 'chat' }]);
  });

  it('renders one editor row per explicit contact', () => {
    const wrapper = mountEditor('confirm', [
      { memberId: 'u_alice', tier: 'ignore' },
      { memberId: 'u_bob', tier: 'chat' },
    ]);
    expect(wrapper.findAll('.tier-row')).toHaveLength(2);
    expect(wrapper.findAll('[data-testid="tier-member"]')).toHaveLength(2);
    expect(wrapper.findAll('[data-testid="tier-select"]')).toHaveLength(2);
  });
});
