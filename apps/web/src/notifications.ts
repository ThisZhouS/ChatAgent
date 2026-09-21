/**
 * When a message deserves a desktop notification.
 *
 * Extracted from the view because the rules are the interesting part and they are easy to get
 * subtly wrong: muting silences a conversation, but being addressed by name is not noise, so a
 * mention breaks through a mute. A message in the conversation the user is already looking at,
 * or while the window is visible, raises nothing at all.
 */
export interface NotificationInput {
  /** The recipient muted this conversation. */
  muted: boolean;
  /** The message mentions the recipient. */
  mentioned: boolean;
  /** The conversation is the one currently open. */
  isActiveConversation: boolean;
  /** The window is visible on screen. */
  windowVisible: boolean;
  /** Notification.permission, or 'unsupported' when the platform has none. */
  permission: 'default' | 'granted' | 'denied' | 'unsupported';
  conversationTitle: string;
  senderName: string;
  text: string;
}

export interface NotificationDecision {
  notify: boolean;
  /** A mention: the title says so, and the platform may use it for a stronger alert. */
  strong: boolean;
  title: string;
  body: string;
}

export function decideNotification(input: NotificationInput): NotificationDecision {
  const title = input.mentioned
    ? `[@我] ${input.conversationTitle}`
    : input.conversationTitle;
  const body = `${input.senderName}：${input.text || '（附件）'}`.slice(0, 120);
  const silent =
    input.permission !== 'granted' ||
    input.windowVisible ||
    input.isActiveConversation ||
    (input.muted && !input.mentioned);
  return { notify: !silent, strong: input.mentioned, title, body };
}
