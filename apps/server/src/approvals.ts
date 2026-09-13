import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  ApprovalAction,
  ApprovalRecord,
  OutboxRecord,
  Principal,
} from '@chatagent/contracts';
import type { AgentAccount } from '@chatagent/contracts';
import type { MemberDirectory } from './auth';
import { isOrgAdmin, sameOrganization } from './auth';

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return fallback;
  }
}

async function writeJson<T>(filePath: string, value: T): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

/**
 * Digest over the canonical action only. Any change to target, payload or
 * artifact version produces a different digest, so a stale approval can never
 * be replayed for new content.
 */
export function computeActionDigest(action: ApprovalAction): string {
  const canonical = JSON.stringify({
    tool: action.tool,
    target: action.target,
    chatType: action.chatType,
    kind: action.kind,
    text: action.text ?? null,
    artifactId: action.artifactId ?? null,
    artifactVersion: action.artifactVersion ?? null,
    artifactName: action.artifactName ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Stable version proxy for an immutable stored artifact. */
export function computeArtifactVersion(artifact: {
  id: string;
  sizeBytes: number;
  createdAt: string;
}): string {
  return `${artifact.id}:${artifact.sizeBytes}:${artifact.createdAt}`;
}

/** Outbox idempotency key: one external side effect per (task, action). */
export function stepKeyFor(taskId: string | undefined, runId: string, digest: string): string {
  const owner = taskId ?? `run:${runId}`;
  return createHash('sha256').update(`${owner}:${digest}`).digest('hex');
}

export interface ApprovalScope {
  organizationId: string;
  requesterId: string;
  taskId?: string;
  runId?: string;
}

export interface CreateApprovalInput extends ApprovalScope {
  action: ApprovalAction;
  digest: string;
  ttlSeconds: number;
}

export class ApprovalStore {
  private readonly approvals = new Map<string, ApprovalRecord>();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  async get(id: string): Promise<ApprovalRecord | undefined> {
    await this.load();
    const approval = this.approvals.get(id);
    return approval ? clone(approval) : undefined;
  }

  async list(organizationId?: string): Promise<ApprovalRecord[]> {
    await this.load();
    return [...this.approvals.values()]
      .filter((approval) => !organizationId || approval.organizationId === organizationId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(clone);
  }

  /** Reuses an existing pending request for the same digest instead of duplicating it. */
  async ensurePending(input: CreateApprovalInput): Promise<ApprovalRecord> {
    await this.load();
    for (const approval of this.approvals.values()) {
      if (
        approval.status === 'pending' &&
        approval.digest === input.digest &&
        approval.organizationId === input.organizationId &&
        approval.requesterId === input.requesterId &&
        // An approval is bound to one task: reusing another task's pending
        // request would deadlock this run (it can never win that approval).
        (approval.taskId ?? '') === (input.taskId ?? '')
      ) {
        return clone(approval);
      }
    }

    const now = new Date();
    const record: ApprovalRecord = {
      id: crypto.randomUUID(),
      organizationId: input.organizationId,
      requesterId: input.requesterId,
      taskId: input.taskId,
      runId: input.runId,
      action: input.action,
      digest: input.digest,
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + input.ttlSeconds * 1000).toISOString(),
    };
    this.approvals.set(record.id, record);
    await this.persist();
    return clone(record);
  }

  async decide(
    id: string,
    decision: 'approved' | 'rejected',
    approverId: string,
    reason?: string,
  ): Promise<ApprovalRecord | undefined> {
    await this.load();
    const existing = this.approvals.get(id);
    if (!existing) return undefined;
    if (existing.status !== 'pending') return clone(existing);

    const updated: ApprovalRecord = {
      ...existing,
      status: decision,
      approverId,
      reason,
      decidedAt: new Date().toISOString(),
    };
    this.approvals.set(id, updated);
    await this.persist();
    return clone(updated);
  }

  /**
   * Finds the approval that authorizes exactly this action digest. Expired
   * approvals are marked `expired` and never returned.
   */
  async findApproved(scope: ApprovalScope, digest: string): Promise<ApprovalRecord | undefined> {
    await this.load();
    const now = Date.now();
    let match: ApprovalRecord | undefined;
    let changed = false;

    for (const approval of this.approvals.values()) {
      if (
        approval.organizationId !== scope.organizationId ||
        approval.requesterId !== scope.requesterId ||
        approval.digest !== digest
      ) {
        continue;
      }
      // An approval is bound to the task that requested it: another task with
      // the same payload must obtain its own approval.
      if (approval.taskId && scope.taskId && approval.taskId !== scope.taskId) continue;
      if (approval.taskId && !scope.taskId) continue;
      if (approval.status !== 'approved') continue;
      if (Date.parse(approval.expiresAt) <= now) {
        this.approvals.set(approval.id, { ...approval, status: 'expired' });
        changed = true;
        continue;
      }
      if (!match) {
        match = approval;
        continue;
      }
      const current = Date.parse(match.decidedAt ?? match.createdAt);
      const candidate = Date.parse(approval.decidedAt ?? approval.createdAt);
      if (candidate >= current) match = approval;
    }

    if (changed) await this.persist();
    return match ? clone(match) : undefined;
  }

  /**
   * Compare-and-set claim. The check and the write happen without an await in
   * between, so two concurrent sends can never both win the same approval —
   * this is what makes "single use" real rather than best-effort.
   */
  async claim(id: string, stepKey: string): Promise<boolean> {
    await this.load();
    const existing = this.approvals.get(id);
    if (!existing) return false;
    if (existing.status !== 'approved') return false;
    if (existing.consumedAt) return false;
    if (Date.parse(existing.expiresAt) <= Date.now()) {
      this.approvals.set(id, { ...existing, status: 'expired' });
      await this.persist();
      return false;
    }
    this.approvals.set(id, {
      ...existing,
      status: 'consumed',
      consumedAt: new Date().toISOString(),
      consumedByStepKey: stepKey,
    });
    await this.persist();
    return true;
  }

  /** Returns a claimed approval to `approved` after a definitely-failed send. */
  async release(id: string, stepKey: string): Promise<void> {
    await this.load();
    const existing = this.approvals.get(id);
    if (!existing || existing.consumedByStepKey !== stepKey) return;
    this.approvals.set(id, {
      ...existing,
      status: 'approved',
      consumedAt: undefined,
      consumedByStepKey: undefined,
    });
    await this.persist();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const list = await readJson<ApprovalRecord[]>(this.filePath, []);
    for (const approval of list) this.approvals.set(approval.id, approval);
  }

  private async persist(): Promise<void> {
    await writeJson(this.filePath, [...this.approvals.values()]);
  }
}

function clone(approval: ApprovalRecord): ApprovalRecord {
  return { ...approval, action: { ...approval.action } };
}

export class OutboxStore {
  private readonly records = new Map<string, OutboxRecord>();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  async get(id: string): Promise<OutboxRecord | undefined> {
    await this.load();
    const record = this.records.get(id);
    return record ? { ...record } : undefined;
  }

  async findByStepKey(stepKey: string): Promise<OutboxRecord | undefined> {
    await this.load();
    for (const record of this.records.values()) {
      if (record.stepKey === stepKey) return { ...record };
    }
    return undefined;
  }

  async list(organizationId?: string): Promise<OutboxRecord[]> {
    await this.load();
    return [...this.records.values()]
      .filter((record) => !organizationId || record.organizationId === organizationId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((record) => ({ ...record }));
  }

  async listByTask(taskId: string): Promise<OutboxRecord[]> {
    await this.load();
    return [...this.records.values()]
      .filter((record) => record.taskId === taskId)
      .map((record) => ({ ...record }));
  }

  async save(record: OutboxRecord): Promise<OutboxRecord> {
    await this.load();
    const stored = { ...record, updatedAt: new Date().toISOString() };
    this.records.set(stored.id, stored);
    await this.persist();
    return { ...stored };
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const list = await readJson<OutboxRecord[]>(this.filePath, []);
    for (const record of list) this.records.set(record.id, record);
  }

  private async persist(): Promise<void> {
    await writeJson(this.filePath, [...this.records.values()]);
  }
}

export type ApprovalEvaluation =
  | { ok: true; approval: ApprovalRecord }
  | { ok: false; reason: string };

/**
 * Re-validates an approval at send time: status, expiry, organization,
 * requester membership and approver authority are all checked again. A revoked
 * approver or a payload change must fail here, before any gateway call.
 */
export async function evaluateApproval(
  approval: ApprovalRecord | undefined,
  scope: ApprovalScope,
  directory: MemberDirectory,
  stepKey: string,
): Promise<ApprovalEvaluation> {
  if (!approval) return { ok: false, reason: 'approval_missing' };
  if (approval.organizationId !== scope.organizationId) {
    return { ok: false, reason: 'organization_mismatch' };
  }
  if (approval.requesterId !== scope.requesterId) {
    return { ok: false, reason: 'requester_mismatch' };
  }
  if (approval.status === 'pending') return { ok: false, reason: 'approval_pending' };
  if (approval.status === 'rejected') return { ok: false, reason: 'approval_rejected' };
  if (approval.status === 'expired') return { ok: false, reason: 'approval_expired' };
  if (approval.consumedAt && approval.consumedByStepKey !== stepKey) {
    return { ok: false, reason: 'approval_already_consumed' };
  }
  if (Date.parse(approval.expiresAt) <= Date.now()) {
    return { ok: false, reason: 'approval_expired' };
  }

  const requester = await directory.get(approval.requesterId);
  if (!requester || requester.organizationId !== approval.organizationId) {
    return { ok: false, reason: 'requester_removed' };
  }

  if (!approval.approverId) return { ok: false, reason: 'approver_missing' };
  const approver = await directory.get(approval.approverId);
  if (!approver || approver.organizationId !== approval.organizationId) {
    return { ok: false, reason: 'approver_removed' };
  }
  if (!(approver.roles.includes('owner') || approver.roles.includes('admin'))) {
    return { ok: false, reason: 'approver_revoked' };
  }
  if (approver.id === approval.requesterId) {
    return { ok: false, reason: 'self_approval' };
  }

  return { ok: true, approval };
}

export function canDecideApproval(
  principal: Principal,
  approval: ApprovalRecord,
  account?: AgentAccount,
): boolean {
  if (!sameOrganization(principal, approval.organizationId)) return false;
  if (principal.id === approval.requesterId) return false;
  if (isOrgAdmin(principal)) return true;
  return account !== undefined && account.ownerId === principal.id;
}
