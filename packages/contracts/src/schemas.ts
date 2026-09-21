import { z } from 'zod';

export const channelTypeSchema = z.enum([
  'native',
  'qq',
  'wechat',
  'wechat-work',
  'dingtalk',
  'feishu',
  'web',
  'cli',
  'memory',
]);

export const accountStatusSchema = z.enum(['online', 'offline', 'busy']);

/** Tiers a human may assign to a contact (`owner` is derived, never assigned). */
export const agentContactTierSchema = z.enum(['confirm', 'chat', 'ignore']);

/**
 * Per-contact tiers are a capability map, so they are validated as data: bounded size,
 * member-id-shaped keys, known tiers only. An unknown tier must never fall back to a
 * permissive default.
 */
export const agentContactTiersSchema = z
  .record(z.string().min(1).max(128), agentContactTierSchema)
  .refine((value) => Object.keys(value).length <= 1000, {
    message: 'too many contact tiers (max 1000)',
  });

export const createAccountSchema = z.object({
  name: z.string().min(1).max(64),
  displayName: z.string().min(1).max(64),
  channel: channelTypeSchema,
  channelUserId: z.string().max(128).optional(),
  persona: z.string().max(4000).default('You are a diligent enterprise assistant.'),
  allowlist: z.array(z.string()).default([]),
  defaultTier: agentContactTierSchema.optional(),
  contactTiers: agentContactTiersSchema.optional(),
});

export const updateAccountSchema = createAccountSchema.partial().extend({
  status: accountStatusSchema.optional(),
});

export const inboundMessageSchema = z.object({
  accountId: z.string().min(1).max(128),
  chatType: z.enum(['direct', 'group']).default('direct'),
  chatId: z.string().min(1).max(128),
  /**
   * Sender fields are accepted for display/back-compat only. Server-side
   * identity always comes from the authenticated principal, never the body.
   */
  senderId: z.string().min(1).optional(),
  senderName: z.string().min(1).optional(),
  kind: z.enum(['text', 'file', 'image', 'mixed', 'system']).default('text'),
  text: z.string().max(8000).default(''),
  mentions: z.array(z.string().max(128)).max(20).default([]),
  attachments: z
    .array(
      z.object({
        id: z.string().max(128).default(() => crypto.randomUUID()),
        name: z.string().min(1).max(255),
        mimeType: z.string().max(255).optional(),
        sizeBytes: z.number().int().nonnegative().optional(),
        url: z.string().max(2048).optional(),
      }),
    )
    .max(5)
    .default([]),
  replyTo: z.string().max(128).optional(),
});

/**
 * Task submission. Model history is always rebuilt server-side from the
 * conversation: accepting caller-supplied messages would let a member inject
 * `system` turns into another account's run.
 */
export const createTaskSchema = z.object({
  accountId: z.string().min(1).max(128),
  conversationId: z.string().max(128).optional(),
  goal: z.string().min(1).max(4000),
  maxAttempts: z.number().int().min(1).max(5).default(1),
});

export const generateWordSchema = z.object({
  title: z.string().min(1).max(200),
  paragraphs: z.array(z.string().max(8000)).max(500).default([]),
  table: z
    .object({
      header: z.array(z.string()),
      rows: z.array(z.array(z.string())),
    })
    .optional(),
});

export const generateExcelSchema = z.object({
  fileName: z.string().max(200).default('workbook.xlsx'),
  sheets: z
    .array(
      z.object({
        name: z.string().min(1).max(31),
        header: z.array(z.string().max(200)).max(100),
        rows: z
          .array(z.array(z.union([z.string().max(2000), z.number(), z.boolean(), z.null()])).max(100))
          .max(2000),
      }),
    )
    .min(1)
    .max(20),
});

export const parseDocumentUploadSchema = z.object({
  fileName: z.string().optional(),
});

/**
 * Member ids appear inside deterministic conversation keys, so they must not
 * contain the separator characters used to build those keys. The same rule is
 * enforced when an identity is injected by the development fallback.
 */
export const MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidMemberId(value: string): boolean {
  return value.length > 0 && value.length <= 64 && MEMBER_ID_PATTERN.test(value);
}

export const createMemberSchema = z.object({
  // The id is used inside deterministic conversation keys (hashed from the
  // sorted member list), so separators like "," must not survive validation.
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(MEMBER_ID_PATTERN, 'id may only contain letters, digits, dot, dash and underscore'),
  displayName: z.string().min(1).max(64),
  roles: z.array(z.enum(['member', 'owner', 'admin'])).max(5).default(['member']),
  token: z.string().min(8).max(256).optional(),
});

export const updateMemberSchema = z.object({
  displayName: z.string().min(1).max(64).optional(),
  roles: z.array(z.enum(['member', 'owner', 'admin'])).max(5).optional(),
  agentIds: z.array(z.string().max(128)).max(50).optional(),
});

export const loginSchema = z.object({
  memberId: z.string().min(1).max(128),
  token: z.string().min(1).max(256),
});

export const openConversationSchema = z.object({
  targetId: z.string().min(1).max(128),
  targetKind: z.enum(['agent', 'member']),
});

export const createGroupSchema = z.object({
  title: z.string().min(1).max(64),
  memberIds: z.array(z.string().min(1).max(64)).min(1).max(20),
});

export const nativeMessageSchema = z.object({
  text: z.string().max(8000).default(''),
  /** Id of the message being quoted; must belong to the same conversation. */
  replyTo: z.string().min(1).max(128).optional(),
  /** Participant ids the sender addressed; AI accounts in a group are summoned. */
  mentions: z.array(z.string().min(1).max(64)).max(10).default([]),
  attachments: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1).max(255),
        mimeType: z.string().max(255).optional(),
        sizeBytes: z.number().int().nonnegative().optional(),
        url: z.string().max(2048).optional(),
        localPath: z.string().max(2048).optional(),
      }),
    )
    .max(5)
    .default([]),
});

export type CreateMemberInput = z.infer<typeof createMemberSchema>;
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type OpenConversationInput = z.infer<typeof openConversationSchema>;
export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type NativeMessageInput = z.infer<typeof nativeMessageSchema>;
export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
export type InboundMessagePayload = z.infer<typeof inboundMessageSchema>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type GenerateWordInput = z.infer<typeof generateWordSchema>;
export type GenerateExcelInput = z.infer<typeof generateExcelSchema>;

/**
 * Receipt of one locally-executed agent-host task, mirrored to the server by an
 * authenticated member session so the workbench can show on-device work.
 * The device token never appears here; receipts are device-authoritative copies.
 */
export const localTaskReceiptSchema = z.object({
  deviceId: z.string().min(1).max(128),
  agentId: z.string().min(1).max(128),
  taskId: z.string().min(1).max(128),
  goal: z.string().min(1).max(2000),
  kind: z.string().min(1).max(64),
  state: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']),
  executor: z.enum(['hermes', 'fake']),
  error: z.string().max(500).optional(),
  summary: z.string().max(500).optional(),
  artifacts: z
    .array(
      z.object({
        name: z.string().min(1).max(255),
        sha256: z.string().min(8).max(128),
        bytes: z.number().int().nonnegative().optional(),
      }),
    )
    .max(50)
    .default([]),
  createdAt: z.string().min(1).max(40),
  updatedAt: z.string().min(1).max(40),
  /**
   * Owner the device claims this work belongs to (from the delegation the host
   * verified). The server refuses a receipt whose owner is not the authenticated
   * member, so a shared machine cannot mirror one account's local work into
   * another account's workbench. Absent for purely local work.
   */
  ownerId: z.string().min(1).max(128).optional(),
});

export const localTaskSyncSchema = z.object({
  receipts: z.array(localTaskReceiptSchema).min(1).max(100),
});
