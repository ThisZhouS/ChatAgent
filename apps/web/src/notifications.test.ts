import { describe, expect, it } from 'vitest';
import { decideNotification, type NotificationInput } from './notifications';

function input(overrides: Partial<NotificationInput> = {}): NotificationInput {
  return {
    muted: false,
    mentioned: false,
    isActiveConversation: false,
    windowVisible: false,
    permission: 'granted',
    conversationTitle: '周报小组',
    senderName: 'Bob',
    text: '周报我改好了',
    ...overrides,
  };
}

describe('notification decision', () => {
  it('notifies for an ordinary message in the background', () => {
    const decision = decideNotification(input());
    expect(decision.notify).toBe(true);
    expect(decision.strong).toBe(false);
    expect(decision.title).toBe('周报小组');
    expect(decision.body).toContain('Bob');
  });

  it('stays quiet for the open conversation and for a visible window', () => {
    expect(decideNotification(input({ isActiveConversation: true })).notify).toBe(false);
    expect(decideNotification(input({ windowVisible: true })).notify).toBe(false);
    expect(decideNotification(input({ permission: 'denied' })).notify).toBe(false);
  });

  it('silences a muted conversation', () => {
    expect(decideNotification(input({ muted: true })).notify).toBe(false);
  });

  it('lets a mention break through a mute, and says so', () => {
    const decision = decideNotification(input({ muted: true, mentioned: true }));
    // Being addressed is not background noise: the mute does not swallow it.
    expect(decision.notify).toBe(true);
    expect(decision.strong).toBe(true);
    expect(decision.title).toContain('[@我]');
  });

  it('describes an attachment-only message instead of an empty body', () => {
    expect(decideNotification(input({ text: '' })).body).toContain('（附件）');
  });
});
