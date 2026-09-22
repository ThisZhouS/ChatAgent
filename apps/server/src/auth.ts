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
import { checkHandle, isValidMemberId, normalizeHandle } from '@chatagent/contracts';
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
/**
 * Handles that were given up by a rename and are still inside their retention window. They are
 * kept so somebody else cannot take a name people already associate with a colleague; the window
 * is bounded, because a name nobody uses any more should not be lost forever.
 */
export interface RetiredHandle {
  handle: string;
  organizationId: string;
  /** The member who gave it up, so they can take their own name back. */
  memberId: string;
  /** Last moment the name stays reserved. */
  until: string;
}

export class MemberDirectory {
  private readonly members = new Map<string, MemberRecord>();
  private readonly retired = new Map<string, RetiredHandle>();
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
      Partial<
        Pick<MemberRecord, 'roles' | 'agentIds' | 'tokenHash' | 'handle' | 'handleChangedAt'>
      >,
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
      handle: input.handle ?? existing?.handle,
      handleChangedAt: input.handleChangedAt ?? existing?.handleChangedAt,
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

  /** The member holding this handle, if any. Lookup is case-insensitive by construction. */
  async findByHandle(organizationId: string, rawHandle: string): Promise<MemberRecord | undefined> {
    await this.load();
    const handle = normalizeHandle(rawHandle);
    for (const member of this.members.values()) {
      if (member.organizationId === organizationId && member.handle === handle) {
        return clone(member);
      }
    }
    return undefined;
  }

  /** The name is inside somebody's retention window (their own name never blocks them). */
  async isRetired(
    organizationId: string,
    rawHandle: string,
    forMemberId?: string,
  ): Promise<RetiredHandle | undefined> {
    await this.load();
    const handle = normalizeHandle(rawHandle);
    const entry = this.retired.get(`${organizationId}:${handle}`);
    if (!entry) return undefined;
    // The window is bounded: an expired reservation is forgotten here as well as on load, so a
    // zero-day retention really releases the name instead of holding it until a restart.
    if (Date.parse(entry.until) <= Date.now()) {
      this.retired.delete(`${organizationId}:${handle}`);
      return undefined;
    }
    if (entry.memberId === forMemberId) return undefined;
    return { ...entry };
  }

  /**
   * Sets a member's handle. Reasons are returned instead of thrown, because "already taken" and
   * "still reserved" are answers the caller has to render, not failures of the store.
   */
  async setHandle(
    memberId: string,
    rawHandle: string,
    retentionDays: number,
  ): Promise<
    { ok: true; member: MemberRecord } | { ok: false; reason: 'taken' | 'retired' | 'missing' }
  > {
    await this.load();
    const existing = this.members.get(memberId);
    if (!existing) return { ok: false, reason: 'missing' };
    const handle = normalizeHandle(rawHandle);
    const holder = await this.findByHandle(existing.organizationId, handle);
    if (holder && holder.id !== memberId) return { ok: false, reason: 'taken' };
    const retired = await this.isRetired(existing.organizationId, handle, memberId);
    if (retired) return { ok: false, reason: 'retired' };

    const now = new Date().toISOString();
    const previous = existing.handle;
    if (previous && previous !== handle) {
      this.retired.set(`${existing.organizationId}:${previous}`, {
        handle: previous,
        organizationId: existing.organizationId,
        memberId,
        until: new Date(
          Date.now() + Math.max(0, retentionDays) * 24 * 60 * 60 * 1000,
        ).toISOString(),
      });
    }
    const record: MemberRecord = {
      ...existing,
      handle,
      // The cooldown counts changes of an existing name; the first assignment is not a change.
      handleChangedAt: previous && previous !== handle ? now : existing.handleChangedAt,
      updatedAt: now,
    };
    this.members.set(record.id, record);
    await this.persist();
    return { ok: true, member: clone(record) };
  }

  /**
   * Gives every member of the organization a handle, derived from their id when they never chose
   * one. This is the lazy half of the migration: members that existed before handles did get a
   * usable name on the first read, without a separate migration step somebody could forget.
   * Returns how many were assigned.
   */
  async ensureHandles(organizationId: string, retentionDays: number): Promise<number> {
    await this.load();
    let assigned = 0;
    for (const member of [...this.members.values()]) {
      if (member.organizationId !== organizationId || member.handle) continue;
      const candidate = await this.deriveHandle(organizationId, member);
      const result = await this.setHandle(member.id, candidate, retentionDays);
      if (result.ok) assigned += 1;
    }
    return assigned;
  }

  /** A readable, valid, still-free name derived from the member id (then their display name). */
  private async deriveHandle(organizationId: string, member: MemberRecord): Promise<string> {
    const seeds = [
      slugifySeed(member.id),
      slugifySeed(member.displayName),
    ].filter((seed) => seed.length >= 3);
    for (const seed of seeds) {
      for (let suffix = 0; suffix < 50; suffix += 1) {
        const candidate = normalizeHandle(suffix === 0 ? seed : `${seed}-${suffix + 1}`);
        if (checkHandle(candidate) !== undefined) continue;
        const holder = await this.findByHandle(organizationId, candidate);
        if (holder && holder.id !== member.id) continue;
        if (await this.isRetired(organizationId, candidate, member.id)) continue;
        return candidate;
      }
    }
    // Last resort: a deterministic, obviously generated name is better than a member who can
    // never be found.
    for (let counter = 0; counter < 1000; counter += 1) {
      const candidate = `u-${slugifySeed(member.id).slice(0, 12) || 'member'}-${counter}`;
      if (
        checkHandle(candidate) === undefined &&
        !(await this.findByHandle(organizationId, candidate)) &&
        !(await this.isRetired(organizationId, candidate, member.id))
      ) {
        return candidate;
      }
    }
    throw new Error('could not derive a handle');
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await mkdir(dirname(this.options.filePath), { recursive: true });
    try {
      const raw = await readFile(this.options.filePath, 'utf8');
      const parsed = JSON.parse(raw) as
        | MemberRecord[]
        | { members?: MemberRecord[]; retiredHandles?: RetiredHandle[] };
      // The file used to be a bare array; both shapes are accepted so an existing deployment is
      // read as-is and rewritten in the new shape on the next write.
      const members = Array.isArray(parsed) ? parsed : (parsed.members ?? []);
      for (const member of members) this.members.set(member.id, member);
      const retired = Array.isArray(parsed) ? [] : (parsed.retiredHandles ?? []);
      const now = Date.now();
      for (const entry of retired) {
        // An expired reservation is simply forgotten: the window is bounded on purpose.
        if (entry && typeof entry.handle === 'string' && Date.parse(entry.until) > now) {
          this.retired.set(`${entry.organizationId}:${entry.handle}`, entry);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private async persist(): Promise<void> {
    await writeFile(
      this.options.filePath,
      JSON.stringify(
        { members: [...this.members.values()], retiredHandles: [...this.retired.values()] },
        null,
        2,
      ),
      'utf8',
    );
  }
}

/** Lowercased, restricted to the handle alphabet, forced to start with a letter. */
function slugifySeed(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^[^a-z]+/, 'u')
    .slice(0, 20)
    .replace(/[._-]+$/, '');
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
