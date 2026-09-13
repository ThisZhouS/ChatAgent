import type { NormalizedInbound } from './types';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  return {};
}

function readString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return globalThis.String(value);
  return undefined;
}

function pickString(record: JsonRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readString(record[key]);
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function normalizeDingTalk(payload: unknown): NormalizedInbound {
  const data = asRecord(payload);
  const textBlock = asRecord(data.text);
  const text = pickString(textBlock, ['content']) ?? pickString(data, ['content']) ?? '';
  const chatType = pickString(data, ['conversationType', 'chatType']) === '2' ? 'group' : 'direct';
  return {
    chatType,
    chatId: pickString(data, ['conversationId', 'chatId']) ?? 'dingtalk',
    senderId: pickString(data, ['senderStaffId', 'senderId']) ?? 'dingtalk-sender',
    senderName: pickString(data, ['senderNick', 'senderName']) ?? 'DingTalk User',
    kind: text ? 'text' : 'system',
    text,
    mentions: readArray(data.atUserIds)
      .map((item) => readString(item))
      .filter((item): item is string => item !== undefined),
    attachments: normalizeAttachments(data.attachments ?? data.file),
    replyTo: pickString(data, ['msgId']),
  };
}

export function normalizeFeishu(payload: unknown): NormalizedInbound {
  const data = asRecord(payload);
  const event = asRecord(data.event);
  const message = asRecord(event.message);
  const sender = asRecord(event.sender);
  const senderId = asRecord(sender.sender_id);
  const content = parseFeishuContent(message.content);
  const chatType = pickString(message, ['chat_type']) === 'group' ? 'group' : 'direct';
  return {
    chatType,
    chatId: pickString(message, ['chat_id']) ?? 'feishu',
    senderId: pickString(senderId, ['open_id', 'user_id']) ?? 'feishu-sender',
    senderName: pickString(senderId, ['open_id', 'user_id']) ?? 'Feishu User',
    kind: content.kind,
    text: content.text,
    mentions: readArray(message.mentions)
      .map((item) => pickString(asRecord(item), ['name', 'id']) ?? '')
      .filter((item) => item !== ''),
    attachments: normalizeAttachments(message.file_key ? [{ fileKey: message.file_key }] : []),
    replyTo: pickString(message, ['message_id']),
  };
}

export function normalizeWechatWork(payload: unknown): NormalizedInbound {
  const data = asRecord(payload);
  const textBlock = asRecord(data.Text);
  const msgType = pickString(data, ['MsgType', 'msgType']) ?? 'text';
  const text = pickString(data, ['Content']) ?? pickString(textBlock, ['Content']) ?? '';
  const isGroup =
    pickString(data, ['ChatType']) === 'group' ||
    pickString(data, ['ChatId', 'chatId']) !== undefined;
  return {
    chatType: isGroup ? 'group' : 'direct',
    chatId:
      pickString(data, ['ChatId', 'chatId', 'FromUserName', 'fromUserName']) ?? 'wechat-work',
    senderId: pickString(data, ['FromUserName', 'fromUserName']) ?? 'wechat-work-sender',
    senderName: pickString(data, ['FromUserName', 'fromUserName']) ?? 'WeCom User',
    kind: msgType === 'text' ? 'text' : 'system',
    text,
    mentions: [],
    attachments: [],
    replyTo: pickString(data, ['MsgId']),
  };
}

export function normalizeQQ(payload: unknown): NormalizedInbound {
  const data = asRecord(payload);
  const messageType = pickString(data, ['message_type', 'messageType']) ?? 'private';
  const chatType = messageType === 'group' ? 'group' : 'direct';
  const sender = asRecord(data.sender);
  const text = extractQQText(data.message, data.raw_message);
  return {
    chatType,
    chatId: pickString(data, ['group_id']) ?? pickString(data, ['user_id']) ?? 'qq',
    senderId: pickString(data, ['user_id']) ?? pickString(sender, ['user_id']) ?? 'qq-sender',
    senderName: pickString(sender, ['nickname', 'card']) ?? 'QQ User',
    kind: text ? 'text' : 'system',
    text,
    mentions: [],
    attachments: [],
    replyTo: pickString(data, ['message_id']),
  };
}

function parseFeishuContent(content: unknown): { kind: 'text' | 'file'; text: string } {
  const raw = readString(content) ?? '';
  if (!raw) return { kind: 'text', text: '' };
  try {
    const record = asRecord(JSON.parse(raw) as unknown);
    const text = pickString(record, ['text']);
    if (text !== undefined) return { kind: 'text', text };
  } catch {
    // Not JSON: treat the raw payload as plain text.
  }
  return { kind: 'text', text: raw };
}

function extractQQText(message: unknown, rawMessage: unknown): string {
  const raw = readString(rawMessage);
  if (raw !== undefined && raw !== '') return raw;
  if (Array.isArray(message)) {
    return message
      .map((segment) => {
        const record = asRecord(segment);
        const type = pickString(record, ['type']);
        const data = asRecord(record.data);
        if (type === 'text') return pickString(data, ['text']) ?? '';
        if (type === 'image') return '[图片]';
        if (type === 'file') return `[文件: ${pickString(data, ['name']) ?? ''}]`;
        return '';
      })
      .filter((item) => item !== '')
      .join(' ');
  }
  return '';
}

function normalizeAttachments(value: unknown): NormalizedInbound['attachments'] {
  const items = readArray(value);
  const list = items.length > 0 ? items : value ? [value] : [];
  return list
    .map((item) => asRecord(item))
    .filter((item) => pickString(item, ['name', 'fileName', 'fileKey', 'url']) !== undefined)
    .map((item) => ({
      id: crypto.randomUUID(),
      name: pickString(item, ['name', 'fileName', 'fileKey']) ?? 'attachment',
      mimeType: pickString(item, ['mimeType']),
      sizeBytes: readNumber(item.size),
      url: pickString(item, ['url']),
      localPath: pickString(item, ['localPath']),
    }));
}
