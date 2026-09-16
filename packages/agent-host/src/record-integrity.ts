import type {
  ApprovalReference,
  BlockReason,
  DelegationScope,
  ExecutorKind,
  LocalArtifact,
  LocalTaskRecord,
  LocalTaskState,
} from './types';

/**
 * What happened to the task store while it was loaded.
 *
 * Every entry is evidence, not a hidden repair: the UI surfaces the counts and
 * the file is never rewritten during load (the first accepted write persists the
 * normalized shape), so a reviewer can still inspect what was on disk.
 */
export interface StoreLoadReport {
  loadedAt: string;
  rows: number;
  repaired: { taskId: string; repairs: string[] }[];
  quarantined: { taskId: string; reason: string }[];
  duplicates: { taskId: string; droppedVersion: number; keptVersion: number }[];
  /** Set when the whole file was unreadable and moved aside. */
  corruptFile?: string;
}

export interface RowValidation {
  record: LocalTaskRecord;
  repairs: string[];
  /** Set when the row could not be trusted; the record is kept as a failed row. */
  quarantined?: string;
}

/** Why a stored row was kept but never allowed to run. */
export const INVALID_ROW_REASON: BlockReason = 'invalid_persisted_row';

const STATES: LocalTaskState[] = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
];
const KINDS: LocalTaskRecord['kind'][] = ['document', 'side_effect'];
const EXECUTORS: ExecutorKind[] = ['hermes', 'fake'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ''): { value: string; repaired: boolean } {
  if (typeof value === 'string') return { value, repaired: false };
  return { value: fallback, repaired: value !== undefined };
}

function optionalText(value: unknown): { value: string | undefined; repaired: boolean } {
  if (value === undefined || value === null) return { value: undefined, repaired: false };
  if (typeof value === 'string') return { value, repaired: false };
  return { value: undefined, repaired: true };
}

function count(value: unknown, fallback: number, minimum: number): { value: number; repaired: boolean } {
  if (typeof value === 'number' && Number.isInteger(value) && value >= minimum) {
    return { value, repaired: false };
  }
  return { value: fallback, repaired: true };
}

function timestamp(value: unknown, fallback: string): { value: string; repaired: boolean } {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
    return { value, repaired: false };
  }
  return { value: fallback, repaired: true };
}

function artifactsOf(value: unknown): { value: LocalArtifact[]; repaired: boolean } {
  if (!Array.isArray(value)) return { value: [], repaired: value !== undefined };
  const kept: LocalArtifact[] = [];
  let repaired = false;
  for (const entry of value) {
    if (!isPlainObject(entry) || typeof entry.relativePath !== 'string' || typeof entry.name !== 'string') {
      repaired = true;
      continue;
    }
    kept.push({
      relativePath: entry.relativePath,
      name: entry.name,
      bytes: typeof entry.bytes === 'number' && entry.bytes >= 0 ? entry.bytes : 0,
      sha256: typeof entry.sha256 === 'string' ? entry.sha256 : '',
    });
    if (typeof entry.bytes !== 'number' || typeof entry.sha256 !== 'string') repaired = true;
  }
  return { value: kept, repaired };
}

function toolsetsOf(
  value: unknown,
  kind: LocalTaskRecord['kind'],
): { value: string[]; repaired: boolean } {
  if (!Array.isArray(value)) {
    // A document task without a recorded toolset used to be the pre-floor shape;
    // defaulting it to the document capability keeps it runnable, while an
    // unknown kind (already quarantined) never gets here.
    return { value: kind === 'document' ? ['document'] : [], repaired: true };
  }
  const seen = new Set<string>();
  let repaired = false;
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      repaired = true;
      continue;
    }
    const normalized = entry.trim();
    if (normalized !== entry) repaired = true;
    seen.add(normalized);
  }
  if (seen.size !== value.length) repaired = true;
  return { value: [...seen], repaired };
}

/** A row that cannot be trusted is kept — as a failed record nobody may run. */
function quarantineRecord(taskId: string, reason: string, now: string): LocalTaskRecord {
  return {
    taskId,
    deviceId: '',
    agentId: '',
    goal: '',
    kind: 'document',
    state: 'failed',
    version: 1,
    workDir: '',
    toolsets: [],
    artifacts: [],
    attempts: 0,
    maxAttempts: 1,
    blockedReason: INVALID_ROW_REASON,
    error: `${INVALID_ROW_REASON}: ${reason}`,
    summary: '任务记录无法解析，已隔离为失败（不会执行）',
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
  };
}

/**
 * Validates one persisted row and returns a record the host may use.
 *
 * Rules: the fields that decide *whether* a task may run (taskId, kind, state,
 * workDir) must be trustworthy, otherwise the row is quarantined; everything
 * else is repaired with a safe default. A *wrong value* is recorded as a repair,
 * an absent optional field is filled silently (its absence stays visible in the
 * record itself, e.g. an empty deviceId). Unknown extra fields are dropped
 * rather than carried into memory.
 */
export function validatePersistedRow(raw: unknown, index: number, now: string): RowValidation {
  const fallbackId = `corrupt-row-${index + 1}`;
  if (!isPlainObject(raw)) {
    const reason = 'row is not an object';
    return { record: quarantineRecord(fallbackId, reason, now), repairs: [], quarantined: reason };
  }

  const taskId = typeof raw.taskId === 'string' && raw.taskId.trim() !== '' ? raw.taskId.trim() : '';
  if (!taskId) {
    const reason = 'taskId is missing';
    return { record: quarantineRecord(fallbackId, reason, now), repairs: [], quarantined: reason };
  }
  if (!KINDS.includes(raw.kind as LocalTaskRecord['kind'])) {
    const reason = `unknown kind ${JSON.stringify(raw.kind ?? null)}`;
    return { record: quarantineRecord(taskId, reason, now), repairs: [], quarantined: reason };
  }
  if (!STATES.includes(raw.state as LocalTaskState)) {
    const reason = `unknown state ${JSON.stringify(raw.state ?? null)}`;
    return { record: quarantineRecord(taskId, reason, now), repairs: [], quarantined: reason };
  }
  if (typeof raw.workDir !== 'string' || raw.workDir.trim() === '') {
    const reason = 'workDir is missing';
    return { record: quarantineRecord(taskId, reason, now), repairs: [], quarantined: reason };
  }

  const repairs: string[] = [];
  const kind = raw.kind as LocalTaskRecord['kind'];

  const deviceId = text(raw.deviceId);
  if (deviceId.repaired) repairs.push('deviceId');
  const agentId = text(raw.agentId);
  if (agentId.repaired) repairs.push('agentId');
  const goal = text(raw.goal);
  if (goal.repaired) repairs.push('goal');

  const version = count(raw.version, 1, 1);
  if (version.repaired) repairs.push('version');
  const attempts = count(raw.attempts, 0, 0);
  if (attempts.repaired) repairs.push('attempts');
  const rawMax = count(raw.maxAttempts, 2, 1);
  if (rawMax.repaired) repairs.push('maxAttempts');
  const maxAttempts = Math.max(rawMax.value, attempts.value);

  const toolsets = toolsetsOf(raw.toolsets, kind);
  if (toolsets.repaired) repairs.push('toolsets');
  const artifacts = artifactsOf(raw.artifacts);
  if (artifacts.repaired) repairs.push('artifacts');

  const updatedAt = timestamp(raw.updatedAt, now);
  if (updatedAt.repaired) repairs.push('updatedAt');
  const createdAt = timestamp(raw.createdAt, updatedAt.value);
  if (createdAt.repaired) repairs.push('createdAt');

  const record: LocalTaskRecord = {
    taskId,
    deviceId: deviceId.value,
    agentId: agentId.value,
    goal: goal.value,
    kind,
    state: raw.state as LocalTaskState,
    version: version.value,
    workDir: raw.workDir,
    toolsets: toolsets.value,
    artifacts: artifacts.value,
    attempts: attempts.value,
    maxAttempts,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
  };

  const runId = optionalText(raw.runId);
  if (runId.repaired) repairs.push('runId');
  if (runId.value) record.runId = runId.value;

  if (raw.executor !== undefined) {
    if (EXECUTORS.includes(raw.executor as ExecutorKind)) record.executor = raw.executor as ExecutorKind;
    else repairs.push('executor');
  }

  for (const field of ['summary', 'error', 'blockedReason', 'delegationId', 'approvalId', 'actionDigest'] as const) {
    const parsed = optionalText(raw[field]);
    if (parsed.repaired) repairs.push(field);
    if (parsed.value !== undefined) record[field] = parsed.value as never;
  }

  if (raw.exitCode !== undefined) {
    if (typeof raw.exitCode === 'number' || raw.exitCode === null) record.exitCode = raw.exitCode;
    else repairs.push('exitCode');
  }

  for (const field of ['startedAt', 'finishedAt'] as const) {
    const parsed = optionalText(raw[field]);
    if (parsed.repaired || (parsed.value !== undefined && Number.isNaN(Date.parse(parsed.value)))) {
      repairs.push(field);
      continue;
    }
    if (parsed.value !== undefined) record[field] = parsed.value;
  }

  if (raw.lease !== undefined) {
    const lease = raw.lease;
    if (
      isPlainObject(lease) &&
      typeof lease.holder === 'string' &&
      typeof lease.expiresAt === 'string' &&
      !Number.isNaN(Date.parse(lease.expiresAt))
    ) {
      record.lease = { holder: lease.holder, expiresAt: lease.expiresAt };
    } else {
      repairs.push('lease');
    }
  }

  // Audit-only snapshots: kept when they are objects, dropped (and reported)
  // otherwise. They are never used for a decision — the ids are the key.
  const delegation = raw.delegation;
  if (delegation !== undefined) {
    if (isPlainObject(delegation)) record.delegation = delegation as unknown as DelegationScope;
    else repairs.push('delegation');
  }
  const approval = raw.approval;
  if (approval !== undefined) {
    if (isPlainObject(approval)) record.approval = approval as unknown as ApprovalReference;
    else repairs.push('approval');
  }

  return { record, repairs, quarantined: undefined };
}
