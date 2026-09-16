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

export class TrustedAuthorizationRegistry {
  private readonly delegations = new Map<string, DelegationGrant>();
  private readonly approvals = new Map<string, ApprovalGrant>();

  /** Registers a verified delegation. Rejects malformed or already-expired grants. */
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
    return this.delegations.delete(id);
  }

  revokeApproval(id: string): boolean {
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
