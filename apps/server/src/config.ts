import { resolve } from 'node:path';
import { DEFAULT_ORGANIZATION_ID, LEGACY_OWNER_ID } from '@chatagent/contracts';

export interface ModelConfig {
  baseUrl?: string;
  apiKey?: string;
  modelName?: string;
}

export type AuthMode = 'development' | 'production';

export interface AuthConfig {
  /**
   * `production` fails closed: requests without a valid bearer token are
   * anonymous and the development principal header is ignored.
   * `development` is the explicit test/dev profile: the principal header is
   * honoured and unauthenticated local calls map to the dev owner.
   */
  mode: AuthMode;
  /** Organization assigned to principals auto-provisioned in development. */
  defaultOrganizationId: string;
  /** Owner attributed to legacy records and to the default dev principal. */
  legacyOwnerId: string;
  defaultPrincipalId: string;
  defaultPrincipalName: string;
  /**
   * Development principal injection (header or owner fallback) is limited to
   * loopback callers unless this is explicitly enabled.
   */
  allowDevAuth: boolean;
}

export interface WebhookChannelConfig {
  token?: string;
  signingSecret?: string;
}

export interface WebhookConfig {
  /** Allows unsigned webhooks. Only valid together with auth mode `development`. */
  allowUnverified: boolean;
  maxSkewSeconds: number;
  channels: Record<string, WebhookChannelConfig>;
}

export interface ApprovalConfig {
  /** Lifetime of an approval request; expired approvals can never authorize a send. */
  ttlSeconds: number;
}

export interface AgentIntakeConfig {
  /**
   * `deferred` (default) hands a message to an agent only after the recall window has
   * elapsed, so a sender who withdraws it inside the window never had it read.
   * `immediate` restores the old behaviour and is only sensible when recall is off.
   */
  mode: 'deferred' | 'immediate';
  /** How many recent messages of a conversation an agent may read per request. */
  contextMessages: number;
}

export interface NativeConfig {
  /** Native client session lifetime. */
  sessionTtlSeconds: number;
  /** How long a sender may recall their own message (0 disables recall). */
  recallWindowSeconds: number;
  /**
   * Third-party IM adapters (DingTalk/Feishu/WeCom/QQ webhooks) are optional.
   * The product is standalone: when disabled only the native channel exists.
   */
  externalChannels: boolean;
}

export interface ServerConfig {
  /** Absolute path of the append-only audit log. */
  auditFilePath: string;
  port: number;
  host: string;
  webOrigin: string;
  dataDir: string;
  maxToolSteps: number;
  model: ModelConfig;
  auth: AuthConfig;
  webhook: WebhookConfig;
  approval: ApprovalConfig;
  native: NativeConfig;
  agentIntake: AgentIntakeConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = resolve(env.CHATAGENT_DATA_DIR ?? './data');
  const baseUrl = env.CHATAGENT_MODEL_BASE_URL?.trim();
  const apiKey = env.CHATAGENT_MODEL_API_KEY?.trim();
  const modelName = env.CHATAGENT_MODEL_NAME?.trim();

  const authMode: AuthMode =
    env.CHATAGENT_AUTH_MODE === 'production' || env.CHATAGENT_AUTH_MODE === 'development'
      ? env.CHATAGENT_AUTH_MODE
      : env.NODE_ENV === 'production'
        ? 'production'
        : 'development';

  const allowUnverified =
    env.CHATAGENT_WEBHOOK_ALLOW_UNVERIFIED === 'true' && authMode === 'development';

  return {
    auditFilePath: resolve(dataDir, 'audit.jsonl'),
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? '0.0.0.0',
    webOrigin: env.WEB_ORIGIN ?? 'http://localhost:5173',
    dataDir,
    maxToolSteps: Number(env.CHATAGENT_MAX_TOOL_STEPS ?? 8),
    model: {
      baseUrl: baseUrl || undefined,
      apiKey: apiKey || undefined,
      modelName: modelName || undefined,
    },
    auth: {
      mode: authMode,
      defaultOrganizationId: env.CHATAGENT_ORGANIZATION_ID?.trim() || DEFAULT_ORGANIZATION_ID,
      legacyOwnerId: env.CHATAGENT_LEGACY_OWNER_ID?.trim() || LEGACY_OWNER_ID,
      defaultPrincipalId: env.CHATAGENT_DEV_PRINCIPAL_ID?.trim() || LEGACY_OWNER_ID,
      defaultPrincipalName: env.CHATAGENT_DEV_PRINCIPAL_NAME?.trim() || 'Local Owner',
      allowDevAuth: env.CHATAGENT_ALLOW_DEV_AUTH === 'true',
    },
    webhook: {
      allowUnverified,
      maxSkewSeconds: Number(env.CHATAGENT_WEBHOOK_MAX_SKEW_SECONDS ?? 300),
      channels: {
        dingtalk: {
          token: env.CHATAGENT_DINGTALK_TOKEN?.trim() || undefined,
          signingSecret: env.CHATAGENT_DINGTALK_SIGNING_SECRET?.trim() || undefined,
        },
        feishu: {
          token: env.CHATAGENT_FEISHU_TOKEN?.trim() || undefined,
          signingSecret: env.CHATAGENT_FEISHU_SIGNING_SECRET?.trim() || undefined,
        },
        'wechat-work': {
          token: env.CHATAGENT_WECHATWORK_TOKEN?.trim() || undefined,
          signingSecret: env.CHATAGENT_WECHATWORK_SIGNING_SECRET?.trim() || undefined,
        },
        qq: {
          token: env.CHATAGENT_QQ_TOKEN?.trim() || undefined,
          signingSecret: env.CHATAGENT_QQ_SIGNING_SECRET?.trim() || undefined,
        },
      },
    },
    approval: {
      ttlSeconds: Number(env.CHATAGENT_APPROVAL_TTL_SECONDS ?? 1800),
    },
    native: {
      sessionTtlSeconds: Number(env.CHATAGENT_SESSION_TTL_SECONDS ?? 12 * 60 * 60),
      recallWindowSeconds: Number(env.CHATAGENT_RECALL_WINDOW_SECONDS ?? 120),
      externalChannels: env.CHATAGENT_ENABLE_EXTERNAL_CHANNELS === 'true',
    },
    agentIntake: {
      // Only the exact string 'immediate' opts out; anything else stays deferred, so a
      // typo cannot silently hand messages to an agent before the recall window ends.
      mode: env.CHATAGENT_AGENT_INTAKE_MODE === 'immediate' ? 'immediate' : 'deferred',
      contextMessages: clampInt(env.CHATAGENT_AGENT_CONTEXT_MESSAGES, 20, 1, 200),
    },
  };
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function hasModelConfig(config: ServerConfig): boolean {
  return Boolean(config.model.baseUrl && config.model.apiKey && config.model.modelName);
}
