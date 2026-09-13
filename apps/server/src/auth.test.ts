import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentAccount, Conversation, Principal, TaskRecord } from '@chatagent/contracts';
import type { AuthConfig } from './config';
import {
  canManageAccount,
  canReadAccount,
  canReadArtifact,
  canReadConversation,
  canReadTask,
  hashToken,
  isAuthenticated,
  MemberDirectory,
  resolvePrincipal,
} from './auth';

const AUTH: AuthConfig = {
  mode: 'development',
  defaultOrganizationId: 'org_test',
  legacyOwnerId: 'u_owner',
  defaultPrincipalId: 'u_owner',
  defaultPrincipalName: 'Owner',
  allowDevAuth: true,
};

async function makeDirectory(): Promise<MemberDirectory> {
  const dir = await mkdtemp(join(tmpdir(), 'chatagent-auth-'));
  return new MemberDirectory({
    filePath: join(dir, 'members.json'),
    organizationId: 'org_test',
    ownerId: 'u_owner',
    ownerName: 'Owner',
  });
}

function account(overrides: Partial<AgentAccount> = {}): AgentAccount {
  return {
    id: 'acc_1',
    name: 'assistant',
    displayName: 'Assistant',
    channel: 'memory',
    status: 'online',
    persona: 'p',
    allowlist: [],
    organizationId: 'org_test',
    ownerId: 'u_alice',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv_1',
    accountId: 'acc_1',
    chatType: 'direct',
    chatId: 'c1',
    organizationId: 'org_test',
    participantIds: ['u_alice'],
    origin: 'external',
    targetKind: 'agent',
    targetId: 'acc_1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messageIds: [],
    ...overrides,
  };
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task_1',
    accountId: 'acc_1',
    organizationId: 'org_test',
    requesterId: 'u_alice',
    goal: 'g',
    state: 'completed',
    artifacts: [],
    attempts: 1,
    maxAttempts: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const member = (id: string, organizationId = 'org_test'): Principal => ({
  id,
  kind: 'member',
  organizationId,
  displayName: id,
  roles: ['member'],
  agentIds: [],
});

const anonymous: Principal = {
  id: 'anonymous',
  kind: 'anonymous',
  organizationId: '',
  displayName: 'Anonymous',
  roles: [],
  agentIds: [],
};

describe('resolvePrincipal', () => {
  it('rejects everything anonymous in production', async () => {
    const directory = await makeDirectory();
    const principal = await resolvePrincipal({
      headers: { 'x-chatagent-principal-id': 'u_alice', 'x-chatagent-principal-org': 'org_test' },
      directory,
      auth: { ...AUTH, mode: 'production' },
      remoteAddress: '127.0.0.1',
    });

    expect(principal.kind).toBe('anonymous');
    expect(isAuthenticated(principal)).toBe(false);
  });

  it('accepts a valid bearer token in production', async () => {
    const directory = await makeDirectory();
    await directory.upsert({
      id: 'u_alice',
      organizationId: 'org_test',
      displayName: 'Alice',
      roles: ['owner'],
      tokenHash: hashToken('secret-token'),
    });

    const principal = await resolvePrincipal({
      headers: { authorization: 'Bearer secret-token' },
      directory,
      auth: { ...AUTH, mode: 'production' },
      remoteAddress: '127.0.0.1',
    });

    expect(principal.id).toBe('u_alice');
    expect(principal.organizationId).toBe('org_test');
    expect(isAuthenticated(principal)).toBe(true);
  });

  it('rejects a wrong bearer token in production', async () => {
    const directory = await makeDirectory();
    await directory.upsert({
      id: 'u_alice',
      organizationId: 'org_test',
      displayName: 'Alice',
      tokenHash: hashToken('secret-token'),
    });

    const principal = await resolvePrincipal({
      headers: { authorization: 'Bearer wrong-token' },
      directory,
      auth: { ...AUTH, mode: 'production' },
      remoteAddress: '127.0.0.1',
    });

    expect(isAuthenticated(principal)).toBe(false);
  });

  it('honours the development principal header only in development mode', async () => {
    const directory = await makeDirectory();
    const principal = await resolvePrincipal({
      headers: {
        'x-chatagent-principal-id': 'u_alice',
        'x-chatagent-principal-org': 'org_test',
        'x-chatagent-principal-name': 'Alice',
      },
      directory,
      auth: AUTH,
      remoteAddress: '127.0.0.1',
    });

    expect(principal.id).toBe('u_alice');
    expect(principal.roles).toEqual(['member']);
  });

  it('falls back to the configured owner principal in development mode', async () => {
    const directory = await makeDirectory();
    const principal = await resolvePrincipal({
      headers: {},
      directory,
      auth: AUTH,
      remoteAddress: '127.0.0.1',
    });

    expect(principal.id).toBe('u_owner');
    expect(principal.roles).toContain('owner');
    expect(isAuthenticated(principal)).toBe(true);
  });

  it('never upgrades an invalid credential to a principal in development mode', async () => {
    const directory = await makeDirectory();

    const bogus = await resolvePrincipal({
      headers: { authorization: 'Bearer not-a-real-token' },
      directory,
      auth: AUTH,
      remoteAddress: '127.0.0.1',
    });
    expect(bogus.kind).toBe('anonymous');
    expect(isAuthenticated(bogus)).toBe(false);
  });

  it('limits development injection to loopback unless explicitly enabled', async () => {
    const directory = await makeDirectory();
    const headers = {
      'x-chatagent-principal-id': 'u_remote',
      'x-chatagent-principal-org': 'org_test',
    };

    const remote = await resolvePrincipal({
      headers,
      directory,
      auth: { ...AUTH, allowDevAuth: false },
      remoteAddress: '10.1.2.3',
    });
    expect(remote.kind).toBe('anonymous');

    const loopback = await resolvePrincipal({
      headers,
      directory,
      auth: { ...AUTH, allowDevAuth: false },
      remoteAddress: '127.0.0.1',
    });
    expect(loopback.id).toBe('u_remote');

    const remoteOptIn = await resolvePrincipal({
      headers,
      directory,
      auth: { ...AUTH, allowDevAuth: true },
      remoteAddress: '10.1.2.3',
    });
    expect(remoteOptIn.id).toBe('u_remote');
  });

  it('does not hand the owner principal to remote callers without credentials', async () => {
    const directory = await makeDirectory();
    const principal = await resolvePrincipal({
      headers: {},
      directory,
      auth: { ...AUTH, allowDevAuth: false },
      remoteAddress: '192.168.1.50',
    });
    expect(principal.kind).toBe('anonymous');
  });

  it('stores only token hashes, never plaintext', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chatagent-auth-'));
    const filePath = join(dir, 'members.json');
    const directory = new MemberDirectory({
      filePath,
      organizationId: 'org_test',
      ownerId: 'u_owner',
      ownerName: 'Owner',
    });
    await directory.upsert({
      id: 'u_alice',
      organizationId: 'org_test',
      displayName: 'Alice',
      tokenHash: hashToken('plaintext-token'),
    });

    const raw = await readFile(filePath, 'utf8');
    expect(raw).not.toContain('plaintext-token');
    expect(raw).toContain(hashToken('plaintext-token'));
  });
});

describe('object authorization', () => {
  it('denies anonymous and cross-organization readers', () => {
    const acc = account();
    expect(canReadAccount(anonymous, acc)).toBe(false);
    expect(canReadAccount(member('u_bob', 'org_other'), acc)).toBe(false);
    expect(canReadConversation(member('u_bob', 'org_other'), conversation())).toBe(false);
    expect(canReadTask(member('u_bob', 'org_other'), task())).toBe(false);
    expect(
      canReadArtifact(member('u_bob', 'org_other'), {
        organizationId: 'org_test',
        ownerId: 'u_alice',
      }),
    ).toBe(false);
  });

  it('allows same-organization members to read accounts but not manage them', () => {
    const acc = account();
    expect(canReadAccount(member('u_carol'), acc)).toBe(true);
    expect(canManageAccount(member('u_carol'), acc)).toBe(false);
    expect(canManageAccount(member('u_alice'), acc)).toBe(true);
  });

  it('restricts conversations to participants', () => {
    const conv = conversation();
    expect(canReadConversation(member('u_alice'), conv)).toBe(true);
    expect(canReadConversation(member('u_carol'), conv)).toBe(false);
    expect(canReadConversation({ ...member('u_dave'), roles: ['owner'] }, conv)).toBe(true);
  });

  it('restricts tasks to the requester, the account owner or an org admin', () => {
    const t = task();
    const acc = account();
    expect(canReadTask(member('u_alice'), t, acc)).toBe(true);
    expect(canReadTask(member('u_carol'), t, acc)).toBe(false);
    expect(canReadTask(member('u_dave', 'org_test'), t, { ...acc, ownerId: 'u_dave' })).toBe(true);
    expect(canReadTask({ ...member('u_erin'), roles: ['owner'] }, t, acc)).toBe(true);
  });

  it('binds artifacts to their task or owner', () => {
    const t = task();
    const artifact = { organizationId: 'org_test', ownerId: 'u_alice', taskId: 'task_1' };
    expect(canReadArtifact(member('u_alice'), artifact, t)).toBe(true);
    expect(canReadArtifact(member('u_carol'), artifact, t)).toBe(false);
    expect(canReadArtifact(member('u_carol'), artifact, { ...t, requesterId: 'u_carol' })).toBe(true);
  });
});
