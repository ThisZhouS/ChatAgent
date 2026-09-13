import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  AgentAccount,
  Conversation,
  MemberRecord,
  Principal,
  TaskArtifact,
  TaskRecord,
} from '@chatagent/contracts';
import { isValidMemberId } from '@chatagent/contracts';
import type { AuthConfig } from './config';
import type { SessionStore } from './stores';

export const ANONYMOUS_PRINCIPAL: Principal = {
  id: 'anonymous',
  kind: 'anonymous',
  organizationId: '',
  displayName: 'Anonymous',
  roles: [],
  agentIds: [],
};

export type RequestHeaders = Record<string, string | string[] | undefined>;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

function headerValue(headers: RequestHeaders, name: string): string | undefined {
  const raw = headers[name];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

export const SESSION_COOKIE = 'chatagent_session';

/**
 * Reads the native session cookie. EventSource cannot send custom headers,
 * so the native event stream authenticates with this HttpOnly cookie.
 */
export function readCookieToken(
  headers: RequestHeaders,
  name: string = SESSION_COOKIE,
): string | undefined {
  const raw = headerValue(headers, 'cookie');
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || undefined;
  }
  return undefined;
}

export function readBearerToken(headers: RequestHeaders): string | undefined {
  const raw = headerValue(headers, 'authorization');
  if (!raw) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match?.[1]?.trim() || undefined;
}

export interface MemberDirectoryOptions {
  filePath: string;
  organizationId: string;
  ownerId: string;
  ownerName: string;
}

/**
 * Minimal single-organization member directory. Tokens are only ever stored
 * as sha256 hashes; plaintext tokens live in the environment of the caller.
 */
export class MemberDirectory {
  private readonly members = new Map<string, MemberRecord>();
  private loaded = false;

  constructor(private readonly options: MemberDirectoryOptions) {}

  async get(id: string): Promise<MemberRecord | undefined> {
    await this.load();
    const member = this.members.get(id);
    return member ? clone(member) : undefined;
  }

  async list(): Promise<MemberRecord[]> {
    await this.load();
    return [...this.members.values()].map(clone);
  }

  async findByTokenHash(tokenHash: string): Promise<MemberRecord | undefined> {
    await this.load();
    for (const member of this.members.values()) {
      if (member.tokenHash && safeEqual(member.tokenHash, tokenHash)) return clone(member);
    }
    return undefined;
  }

  async upsert(
    input: Pick<MemberRecord, 'id' | 'organizationId' | 'displayName'> &
      Partial<Pick<MemberRecord, 'roles' | 'agentIds' | 'tokenHash'>>,
  ): Promise<MemberRecord> {
    await this.load();
    const now = new Date().toISOString();
    const existing = this.members.get(input.id);
    const record: MemberRecord = {
      id: input.id,
      organizationId: input.organizationId,
      displayName: input.displayName,
      roles: input.roles ?? existing?.roles ?? ['member'],
      agentIds: input.agentIds ?? existing?.agentIds ?? [],
      tokenHash: input.tokenHash ?? existing?.tokenHash,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.members.set(record.id, record);
    await this.persist();
    return clone(record);
  }

  /** Ensures the configured owner exists; also used for the dev principal. */
  async ensureOwner(): Promise<MemberRecord> {
    return this.upsert({
      id: this.options.ownerId,
      organizationId: this.options.organizationId,
      displayName: this.options.ownerName,
      roles: ['owner'],
    });
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await mkdir(dirname(this.options.filePath), { recursive: true });
    try {
      const raw = await readFile(this.options.filePath, 'utf8');
      const parsed = JSON.parse(raw) as MemberRecord[];
      for (const member of parsed) this.members.set(member.id, member);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async persist(): Promise<void> {
    await writeFile(
      this.options.filePath,
      JSON.stringify([...this.members.values()], null, 2),
      'utf8',
    );
  }
}

export function toPrincipal(member: MemberRecord): Principal {
  return {
    id: member.id,
    kind: 'member',
    organizationId: member.organizationId,
    displayName: member.displayName,
    roles: [...member.roles],
    agentIds: [...member.agentIds],
  };
}

export interface ResolvePrincipalOptions {
  headers: RequestHeaders;
  directory: MemberDirectory;
  auth: AuthConfig;
  /** Native client sessions, checked after member tokens. */
  sessions?: SessionStore;
  /** Caller address; development injection is loopback-only unless opted in. */
  remoteAddress?: string;
}

const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost'];

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return LOOPBACK_ADDRESSES.includes(address) || address.startsWith('127.');
}

/**
 * Resolves the caller identity. Request bodies are never consulted, so a
 * forged `senderId`/`senderName` cannot authenticate anyone.
 *
 * Credential order: member API token -> native session token -> development
 * principal injection (development mode only).
 */
export async function resolvePrincipal(
  options: ResolvePrincipalOptions,
): Promise<Principal> {
  const { headers, directory, auth, sessions } = options;

  const credential = readBearerToken(headers) ?? readCookieToken(headers);
  if (credential) {
    const digest = hashToken(credential);
    const member = await directory.findByTokenHash(digest);
    if (member) return toPrincipal(member);

    if (sessions) {
      const session = await sessions.findByTokenHash(digest);
      if (session) {
        const sessionMember = await directory.get(session.memberId);
        if (sessionMember && sessionMember.organizationId === session.organizationId) {
          // The session id lets the client flag "this device" without any
          // token material being exposed.
          return { ...toPrincipal(sessionMember), sessionId: session.id };
        }
      }
    }

    // A presented-but-invalid credential is never upgraded to another
    // principal: expired or garbage tokens are simply anonymous.
    return { ...ANONYMOUS_PRINCIPAL };
  }

  // Development injection only applies to callers with no credentials at all,
  // and only from loopback unless explicitly enabled.
  const devInjectionAllowed =
    auth.mode === 'development' &&
    (auth.allowDevAuth || isLoopbackAddress(options.remoteAddress));
  if (devInjectionAllowed) {
    const headerId = headerValue(headers, 'x-chatagent-principal-id')?.trim();
    // An injected identity bypasses the member API, so it has to satisfy the
    // same id rule; otherwise a crafted id could be persisted and later collide
    // with another member set inside a group key. Invalid ids fail closed.
    if (headerId && !isValidMemberId(headerId)) {
      return { ...ANONYMOUS_PRINCIPAL };
    }
    if (headerId) {
      const organizationId =
        headerValue(headers, 'x-chatagent-principal-org')?.trim() || auth.defaultOrganizationId;
      const displayName =
        headerValue(headers, 'x-chatagent-principal-name')?.trim() || headerId;
      const member = await directory.upsert({ id: headerId, organizationId, displayName });
      return { ...toPrincipal(member), viaDevFallback: true };
    }

    const owner = await directory.ensureOwner();
    return { ...toPrincipal(owner), viaDevFallback: true };
  }

  return { ...ANONYMOUS_PRINCIPAL };
}

// ---------------------------------------------------------------------------
// Object authorization
// ---------------------------------------------------------------------------

export function isAuthenticated(principal: Principal): boolean {
  return principal.kind !== 'anonymous' && principal.organizationId !== '';
}

export function isOrgAdmin(principal: Principal): boolean {
  return principal.roles.includes('owner') || principal.roles.includes('admin');
}

export function sameOrganization(principal: Principal, organizationId: string): boolean {
  return isAuthenticated(principal) && principal.organizationId === organizationId;
}

export function canReadAccount(principal: Principal, account: AgentAccount): boolean {
  return sameOrganization(principal, account.organizationId);
}

export function canManageAccount(principal: Principal, account: AgentAccount): boolean {
  if (!canReadAccount(principal, account)) return false;
  return (
    account.ownerId === principal.id ||
    principal.agentIds.includes(account.id) ||
    isOrgAdmin(principal)
  );
}

/**
 * Whether the member may send work to this AI account. An empty allowlist
 * means "any member of the organization"; a non-empty one is an explicit
 * grant list (owner/delegate/admin always pass).
 */
export function canUseAccount(principal: Principal, account: AgentAccount): boolean {
  if (!canReadAccount(principal, account)) return false;
  if (canManageAccount(principal, account)) return true;
  if (account.allowlist.length === 0) return true;
  return account.allowlist.includes(principal.id);
}

export function canReadConversation(principal: Principal, conversation: Conversation): boolean {
  if (!sameOrganization(principal, conversation.organizationId)) return false;
  return conversation.participantIds.includes(principal.id) || isOrgAdmin(principal);
}

export function canReadTask(
  principal: Principal,
  task: TaskRecord,
  account?: AgentAccount,
): boolean {
  if (!sameOrganization(principal, task.organizationId)) return false;
  if (task.requesterId === principal.id) return true;
  if (account && account.ownerId === principal.id) return true;
  return isOrgAdmin(principal);
}

export function canCancelTask(
  principal: Principal,
  task: TaskRecord,
  account?: AgentAccount,
): boolean {
  if (!canReadTask(principal, task, account)) return false;
  if (task.requesterId === principal.id) return true;
  if (account && account.ownerId === principal.id) return true;
  return isOrgAdmin(principal);
}

export function canReadArtifact(
  principal: Principal,
  artifact: Pick<TaskArtifact, 'organizationId' | 'ownerId'>,
  task?: TaskRecord,
): boolean {
  const organizationId = artifact.organizationId;
  if (!organizationId || !sameOrganization(principal, organizationId)) return false;
  if (artifact.ownerId === principal.id) return true;
  if (isOrgAdmin(principal)) return true;
  if (task && task.organizationId === organizationId && canReadTask(principal, task)) return true;
  return false;
}

export function canReadUpload(
  principal: Principal,
  upload: { organizationId: string; ownerId: string },
): boolean {
  if (!sameOrganization(principal, upload.organizationId)) return false;
  return upload.ownerId === principal.id || isOrgAdmin(principal);
}

export function canForwardArtifact(
  principal: Principal,
  artifact: Pick<TaskArtifact, 'organizationId' | 'ownerId'>,
  task?: TaskRecord,
): boolean {
  return canReadArtifact(principal, artifact, task);
}

function clone(member: MemberRecord): MemberRecord {
  return { ...member, roles: [...member.roles], agentIds: [...member.agentIds] };
}
