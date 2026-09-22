import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_ORGANIZATION_ID, LEGACY_OWNER_ID } from '@chatagent/contracts';
import { buildApp } from './app';
import { hashToken } from './auth';
import type {
  AgentIntakeConfig,
  HandleConfig,
  NativeConfig,
  ServerConfig,
  WebhookConfig,
} from './config';

export interface TestApp {
  app: FastifyInstance;
  config: ServerConfig;
  dataDir: string;
}

export const TEST_ORG = DEFAULT_ORGANIZATION_ID;
export const OTHER_ORG = 'org_other';
export const OWNER_ID = LEGACY_OWNER_ID;

export interface TestMemberSeed {
  id: string;
  displayName: string;
  organizationId?: string;
  token?: string;
  roles?: string[];
  agentIds?: string[];
}

export async function createTestApp(
  overrides: Partial<Omit<ServerConfig, 'auth' | 'webhook' | 'native' | 'agentIntake' | 'handles'>> & {
    auth?: Partial<ServerConfig['auth']>;
    webhook?: Partial<Omit<WebhookConfig, 'channels'>> & { channels?: WebhookConfig['channels'] };
    native?: Partial<NativeConfig>;
    agentIntake?: Partial<AgentIntakeConfig>;
    handles?: Partial<HandleConfig>;
    /** Members written to the directory before the app boots. */
    members?: TestMemberSeed[];
  } = {},
): Promise<TestApp> {
  const dataDir = overrides.dataDir ?? (await mkdtemp(join(tmpdir(), 'chatagent-test-')));

  const base: ServerConfig = {
    auditFilePath: join(dataDir, 'audit.jsonl'),
    port: 0,
    host: '127.0.0.1',
    webOrigin: 'http://localhost:5173',
    dataDir,
    maxToolSteps: 4,
    model: {},
    auth: {
      mode: 'development',
      defaultOrganizationId: TEST_ORG,
      legacyOwnerId: OWNER_ID,
      defaultPrincipalId: OWNER_ID,
      defaultPrincipalName: 'Local Owner',
      allowDevAuth: true,
    },
    webhook: {
      allowUnverified: false,
      maxSkewSeconds: 0,
      channels: {},
    },
    approval: {
      ttlSeconds: 1800,
    },
    native: {
      sessionTtlSeconds: 3600,
      recallWindowSeconds: 120,
      externalChannels: false,
    },
    // Tests exercise the shipped default: a message reaches an agent only after the
    // recall window. Suites that assert immediate task creation ask for `immediate`.
    agentIntake: {
      mode: 'deferred',
      contextMessages: 20,
      maxAttempts: 8,
    },
    handles: {
      changeCooldownDays: 30,
      retentionDays: 90,
    },
  };

  const config: ServerConfig = {
    ...base,
    ...overrides,
    auth: { ...base.auth, ...(overrides.auth ?? {}) },
    webhook: {
      ...base.webhook,
      ...(overrides.webhook ?? {}),
      channels: { ...(overrides.webhook?.channels ?? {}) },
    },
    native: { ...base.native, ...(overrides.native ?? {}) },
    agentIntake: { ...base.agentIntake, ...(overrides.agentIntake ?? {}) },
    handles: { ...base.handles, ...(overrides.handles ?? {}) },
  };

  if (overrides.members && overrides.members.length > 0) {
    await writeMembers(
      dataDir,
      overrides.members.map((member) => ({
        id: member.id,
        organizationId: member.organizationId ?? config.auth.defaultOrganizationId,
        displayName: member.displayName,
        roles: member.roles ?? ['member'],
        agentIds: member.agentIds ?? [],
        token: member.token,
      })),
    );
  }

  const app = await buildApp(config);
  await app.ready();
  return { app, config, dataDir };
}

/**
 * Writes members before the app boots. Existing entries are preserved so
 * multiple members can be seeded into the same directory.
 */
export async function writeMembers(
  dataDir: string,
  members: Array<{
    id: string;
    organizationId: string;
    displayName: string;
    token?: string;
    roles?: string[];
    agentIds?: string[];
  }>,
): Promise<void> {
  const filePath = join(dataDir, 'members.json');
  let existing: Array<Record<string, unknown>> = [];
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) existing = parsed as Array<Record<string, unknown>>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  for (const member of members) {
    const now = new Date().toISOString();
    const index = existing.findIndex((item) => item.id === member.id);
    const record: Record<string, unknown> = {
      id: member.id,
      organizationId: member.organizationId,
      displayName: member.displayName,
      roles: member.roles ?? ['member'],
      agentIds: member.agentIds ?? [],
      tokenHash: member.token ? hashToken(member.token) : undefined,
      createdAt: index >= 0 ? existing[index]?.createdAt : now,
      updatedAt: now,
    };
    if (index >= 0) existing[index] = record;
    else existing.push(record);
  }

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(existing, null, 2), 'utf8');
}

/** Seeds a single member (convenience wrapper around {@link writeMembers}). */
export async function seedMember(
  dataDir: string,
  member: {
    id: string;
    organizationId: string;
    displayName: string;
    token?: string;
    roles?: string[];
    agentIds?: string[];
  },
): Promise<void> {
  await writeMembers(dataDir, [member]);
}

export function devHeaders(
  id: string,
  organizationId: string = TEST_ORG,
  displayName: string = id,
): Record<string, string> {
  return {
    'x-chatagent-principal-id': id,
    'x-chatagent-principal-org': organizationId,
    'x-chatagent-principal-name': displayName,
  };
}

export function ownerHeaders(): Record<string, string> {
  // No header: development mode maps the request to the configured owner.
  return {};
}

export async function poll<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 6000,
  intervalMs = 25,
): Promise<T> {
  const start = Date.now();
  let latest = await read();
  while (Date.now() - start < timeoutMs) {
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    latest = await read();
  }
  return latest;
}
