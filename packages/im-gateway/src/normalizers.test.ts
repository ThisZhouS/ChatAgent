import { describe, expect, it } from 'vitest';
import { normalizeDingTalk, normalizeFeishu, normalizeQQ, normalizeWechatWork } from './normalizers';

describe('IM normalizers', () => {
  it('normalizes a DingTalk text message', () => {
    const result = normalizeDingTalk({
      msgId: 'm1',
      conversationType: '2',
      conversationId: 'chat1',
      senderStaffId: 'u1',
      senderNick: '张三',
      text: { content: '你好' },
    });
    expect(result.chatType).toBe('group');
    expect(result.senderName).toBe('张三');
    expect(result.text).toBe('你好');
  });

  it('normalizes a Feishu event', () => {
    const result = normalizeFeishu({
      event: {
        message: {
          chat_id: 'oc_1',
          chat_type: 'group',
          content: JSON.stringify({ text: '飞书消息' }),
        },
        sender: { sender_id: { open_id: 'ou_1' } },
      },
    });
    expect(result.chatType).toBe('group');
    expect(result.text).toBe('飞书消息');
  });

  it('normalizes WeChat Work and QQ payloads', () => {
    expect(normalizeWechatWork({ FromUserName: 'u1', ChatId: 'c1', MsgType: 'text', Content: 'hi' }).chatType).toBe('group');
    expect(normalizeQQ({ message_type: 'private', user_id: 123, raw_message: 'hello' }).chatType).toBe('direct');
  });
});
