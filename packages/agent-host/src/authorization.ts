import { createHash } from 'node:crypto';
import type {
  ApprovalGrant,
  BlockReason,
  DelegationGrant,
  GrantSource,
  LocalTaskInput,
} from './types';

/**
 * Trusted authorization registry.
 *
 * The threat this closes: a renderer (or any other caller of the host) could
 * previously hand in a `delegation`/`approval` object of its own making — with
 * an unparseable expiry and an approval that was bound to nothing — and have a
 * side effect approved by the device. Self-declared authorization is therefore
 * not accepted transport-wise anymore: callers pass *ids*, and only this
 * registry — filled by trusted code paths — can resolve them.
 *
 * Who may mint a grant:
 * - the Electron main process, from a verified organization-server response
 *   (`organization-server`), or after an explicit local consent dialog shown to
 *   the signed-in employee (`local-user-consent`);
 * - tests (`test`).
 *
 * Nothing in the renderer→IPC surface can register a grant. Grants live in
 * memory for the life of the process: a restart requires re-authorization,
 * which is the safe default for delegated side effects.
 */
export interface AuthorizationRequest {
  kind: LocalTaskInput['kind'];
  delegationId?: string;
  approvalId?: string;
  /** ChatAgent capability names requested for this task (never `*`). */
  capabilities: string[];
  /** Digest computed by the host from the task payload. */
  actionDigest: string;
}

export type AuthorizationDecision =
  | { ok: true; delegation?: DelegationGrant; approval?: ApprovalGrant }
  | { ok: false; reason: BlockReason };

export type GrantKind = 'delegation' | 'approval';

/**
 * What the organization service says about a grant the host holds. `unknown`
 * means "we cannot vouch for this one": it is not the same as revoked, so it
 * blocks new work without destroying the local grant (a later check can restore
 * it), and it never touches work that is already running.
 */
export type AuthorizationVerificationStatus = 'active' | 'revoked' | 'expired' | 'unknown';

export interface AuthorizationVerification {
  id: string;
  kind: GrantKind;
  status: AuthorizationVerificationStatus;
  /** Refreshed expiry when the service still vouches for the grant. */
  expiresAt?: string;
}

export interface AuthorizationApplyResult {
  /** Grants the service still vouches for (with a possibly refreshed expiry). */
  refreshed: number;
  /** Grants the service invalidated (revoked or expired). */
  revoked: number;
  /** Grants the service could not vouch for. */
  unverifiable: number;
}

export interface AuthorizationRefreshState {
  /** `ok` = the last check succeeded, `unverified` = it failed, `idle` = never checked. */
  state: 'ok' | 'unverified' | 'idle';
  lastCheckAt?: string;
  lastError?: string;
  checks: number;
  failures: number;
  revoked: number;
  unverifiable: number;
}

export class TrustedAuthorizationRegistry {
  private readonly delegations = new Map<string, DelegationGrant>();
  private readonly approvals = new Map<string, ApprovalGrant>();
  /**
   * Grants the organization service refused to vouch for. Kept separate from
   * revocation so that "we could not check" and "it is gone" stay distinguishable
   * in status output, and so a later successful check can clear the mark instead
   * of forcing the user to re-authorize from scratch.
   */
  private readonly unverifiable = new Set<string>();

  private refreshState: AuthorizationRefreshState = {
    state: 'idle',
    checks: 0,
    failures: 0,
    revoked: 0,
    unverifiable: 0,
  };
  private lastCheckAtMs?: number;

  private static key(kind: GrantKind, id: string): string {
    return `${kind}:${id}`;
  }

  /**
   * Registers a verified delegation. Malformed grants are rejected outright;
   * expiry is enforced at authorization time (a grant may be registered while
   * valid and expire later).
   */
  grantDelegation(grant: DelegationGrant): void {
    assertNonEmpty(grant.id, 'delegation.id');
    assertNonEmpty(grant.ownerId, 'delegation.ownerId');
    assertNonEmpty(grant.agentId, 'delegation.agentId');
    assertNonEmpty(grant.deviceId, 'delegation.deviceId');
    assertTimestamp(grant.expiresAt, 'delegation.expiresAt');
    if (!Array.isArray(grant.capabilities) || grant.capabilities.some((item) => typeof item !== 'string')) {
      throw new Error('delegation.capabilities must be a string array');
    }
    this.delegations.set(grant.id, { ...grant, capabilities: [...grant.capabilities] });
  }

  /** Registers a verified approval. A grant that cannot be parsed is never stored. */
  grantApproval(grant: ApprovalGrant): void {
    assertNonEmpty(grant.id, 'approval.id');
    assertNonEmpty(grant.ownerId, 'approval.ownerId');
    assertNonEmpty(grant.actionDigest, 'approval.actionDigest');
    assertTimestamp(grant.expiresAt, 'approval.expiresAt');
    if (typeof grant.approved !== 'boolean') throw new Error('approval.approved must be a boolean');
    this.approvals.set(grant.id, { ...grant });
  }

  revokeDelegation(id: string): boolean {
    this.unverifiable.delete(TrustedAuthorizationRegistry.key('delegation', id));
    return this.delegations.delete(id);
  }

  revokeApproval(id: string): boolean {
    this.unverifiable.delete(TrustedAuthorizationRegistry.key('approval', id));
    return this.approvals.delete(id);
  }

  /**
   * Applies one round of organization-service verification ("continuous
   * authorization refresh"). `active` refreshes the stored expiry; everything
   * else removes the grant locally, so the existing pre-run re-check blocks any
   * task still referencing it. Ids the host no longer holds are ignored: the
   * answer is about *our* grants, not the service's bookkeeping.
   */
  applyVerification(
    results: readonly AuthorizationVerification[],
    now: number,
  ): AuthorizationApplyResult {
    const applied: AuthorizationApplyResult = { refreshed: 0, revoked: 0, unverifiable: 0 };
    for (const result of results) {
      if (!result || typeof result.id !== 'string' || result.id.trim() === '') continue;
      if (result.status === 'active') {
        const expiry = result.expiresAt;
        this.unverifiable.delete(TrustedAuthorizationRegistry.key(result.kind, result.id));
        if (expiry && !Number.isNaN(Date.parse(expiry))) {
          if (result.kind === 'delegation') {
            const grant = this.delegations.get(result.id);
            if (grant) this.delegations.set(result.id, { ...grant, expiresAt: expiry });
          } else {
            const grant = this.approvals.get(result.id);
            if (grant) this.approvals.set(result.id, { ...grant, expiresAt: expiry });
          }
        }
        applied.refreshed += 1;
        continue;
      }
      if (result.status === 'unknown') {
        // Cannot vouch ≠ revoked: mark it, keep it, and let the host hold new work.
        const key = TrustedAuthorizationRegistry.key(result.kind, result.id);
        if (this.holds(result.kind, result.id) && !this.unverifiable.has(key)) {
          this.unverifiable.add(key);
          applied.unverifiable += 1;
        } else if (this.unverifiable.has(key)) {
          applied.unverifiable += 1;
        }
        continue;
      }
      // revoked | expired: the service is authoritative about its own grants.
      const removed =
        result.kind === 'delegation' ? this.revokeDelegation(result.id) : this.revokeApproval(result.id);
      if (removed) applied.revoked += 1;
    }
    this.refreshState = {
      ...this.refreshState,
      revoked: this.refreshState.revoked + applied.revoked,
      unverifiable: this.unverifiable.size,
    };
    this.lastCheckAtMs = now;
    return applied;
  }

  /** Records a successful check that produced answers (or nothing to ask about). */
  markChecked(now: number): void {
    this.lastCheckAtMs = now;
    this.refreshState = {
      ...this.refreshState,
      state: 'ok',
      lastError: undefined,
      checks: this.refreshState.checks + 1,
      unverifiable: this.unverifiable.size,
    };
  }

  /**
   * Records a failed check. From here on the host treats every grant as
   * unverified: queued side-effect work is held instead of started, and nothing
   * that is already running is disturbed.
   */
  markCheckFailed(error: string, now: number): void {
    this.lastCheckAtMs = now;
    this.refreshState = {
      ...this.refreshState,
      state: 'unverified',
      lastError: error,
      failures: this.refreshState.failures + 1,
      unverifiable: this.unverifiable.size,
    };
  }

  /** True when a check has failed since the last successful one. */
  isUnverified(): boolean {
    return this.refreshState.state === 'unverified';
  }

  /** True when this specific grant is held but not vouched for by the service. */
  isGrantUnverifiable(kind: GrantKind, id: string): boolean {
    return this.unverifiable.has(TrustedAuthorizationRegistry.key(kind, id));
  }

  /** True when the task's grants are usable right now (see `authorize()`). */
  grantsAreUsable(request: Pick<AuthorizationRequest, 'kind' | 'delegationId' | 'approvalId'>): boolean {
    if (request.kind === 'document') return true;
    if (this.isUnverified()) return false;
    if (request.delegationId && this.isGrantUnverifiable('delegation', request.delegationId)) return false;
    if (request.approvalId && this.isGrantUnverifiable('approval', request.approvalId)) return false;
    return true;
  }

  /** Which grant ids the host currently holds, for the refresh question. */
  outstanding(only?: readonly string[]): { id: string; kind: GrantKind }[] {
    const wanted = only ? new Set(only) : undefined;
    const list: { id: string; kind: GrantKind }[] = [];
    for (const id of this.delegations.keys()) {
      if (!wanted || wanted.has(id)) list.push({ id, kind: 'delegation' });
    }
    for (const id of this.approvals.keys()) {
      if (!wanted || wanted.has(id)) list.push({ id, kind: 'approval' });
    }
    return list;
  }

  /** Verification bookkeeping plus the coarse status the UI reports. */
  refreshStatus(): AuthorizationRefreshState & { lastCheckAt?: string } {
    return {
      ...this.refreshState,
      unverifiable: this.unverifiable.size,
      lastCheckAt: this.lastCheckAtMs ? new Date(this.lastCheckAtMs).toISOString() : undefined,
    };
  }

  private holds(kind: GrantKind, id: string): boolean {
    return kind === 'delegation' ? this.delegations.has(id) : this.approvals.has(id);
  }

  /**
   * Consumes an approval so it authorizes exactly one execution. Called by the
   * host immediately before a side-effect run starts.
   */
  consumeApproval(id: string): boolean {
    return this.approvals.delete(id);
  }

  getDelegation(id: string): DelegationGrant | undefined {
    const grant = this.delegations.get(id);
    return grant ? { ...grant, capabilities: [...grant.capabilities] } : undefined;
  }

  getApproval(id: string): ApprovalGrant | undefined {
    const grant = this.approvals.get(id);
    return grant ? { ...grant } : undefined;
  }

  /** Ids currently held; for status/debug output, never for authorization. */
  summary(): { delegations: string[]; approvals: string[] } {
    return { delegations: [...this.delegations.keys()], approvals: [...this.approvals.keys()] };
  }

  /**
   * Decides whether a task may run. Pure function of the registry plus the
   * request; re-run before execution and again before a side effect is emitted.
   */
  authorize(
    request: AuthorizationRequest,
    context: { deviceId: string; agentId: string; now: number },
  ): AuthorizationDecision {
    if (request.kind === 'document') return { ok: true };

    if (request.capabilities.length === 0) return { ok: false, reason: 'capability_not_granted' };

    const delegation = request.delegationId ? this.delegations.get(request.delegationId) : undefined;
    if (!delegation) {
      return { ok: false, reason: request.delegationId ? 'delegation_unknown' : 'delegation_missing' };
    }
    if (delegation.deviceId !== context.deviceId) return { ok: false, reason: 'delegation_unknown' };
    if (delegation.agentId !== context.agentId) return { ok: false, reason: 'agent_mismatch' };
    if (Date.parse(delegation.expiresAt) <= context.now) return { ok: false, reason: 'delegation_expired' };
    for (const capability of request.capabilities) {
      if (!delegation.capabilities.includes(capability)) {
        return { ok: false, reason: 'capability_not_granted' };
      }
    }

    const approval = request.approvalId ? this.approvals.get(request.approvalId) : undefined;
    if (!approval) {
      return { ok: false, reason: request.approvalId ? 'approval_unknown' : 'approval_missing' };
    }
    if (!approval.approved) return { ok: false, reason: 'approval_not_approved' };
    if (Date.parse(approval.expiresAt) <= context.now) return { ok: false, reason: 'approval_expired' };
    if (approval.ownerId !== delegation.ownerId) return { ok: false, reason: 'approval_unknown' };
    if (approval.delegationId !== undefined && approval.delegationId !== delegation.id) {
      return { ok: false, reason: 'approval_unknown' };
    }
    if (approval.actionDigest !== request.actionDigest) {
      return { ok: false, reason: 'approval_digest_mismatch' };
    }

    return { ok: true, delegation, approval };
  }

  /** Convenience for callers that only need the reason. */
  blockReason(
    request: AuthorizationRequest,
    context: { deviceId: string; agentId: string; now: number },
  ): BlockReason | undefined {
    const decision = this.authorize(request, context);
    return decision.ok ? undefined : decision.reason;
  }
}

/**
 * Canonical digest of the action an approval is granted for. Both the issuer
 * (organization server / local consent) and the host must use this helper, so an
 * approval is bound to the exact task payload — change the goal or the toolset
 * and the old approval stops matching.
 */
export function computeActionDigest(
  input: Pick<LocalTaskInput, 'taskId' | 'agentId' | 'kind' | 'goal' | 'toolsets'>,
): string {
  const canonical = JSON.stringify({
    taskId: input.taskId,
    agentId: input.agentId,
    kind: input.kind,
    goal: input.goal,
    toolsets: [...input.toolsets].sort(),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function describeGrantSource(source: GrantSource): string {
  switch (source) {
    case 'organization-server':
      return '组织服务已核验';
    case 'local-user-consent':
      return '本机用户明确同意';
    case 'test':
      return '测试夹具';
    default:
      return String(source);
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function assertTimestamp(value: string, field: string): void {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
}
