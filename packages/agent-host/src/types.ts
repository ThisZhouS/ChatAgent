/**
 * Domain types for the on-device agent host (Gate 7A PoC).
 *
 * The host owns the lifetime of on-device agent execution. It is deliberately
 * independent from the Electron window, from the organization server and from
 * the ChatAgent TaskEngine: the TaskEngine stays the business ledger, while the
 * host is the single dispatcher for work that runs on this device.
 */

/** Which executor produced a result. A fake run must never look like a real one. */
export type ExecutorKind = 'hermes' | 'fake';

/**
 * Lifecycle states. `interrupted` is written when the host finds a task that was
 * `running` after a restart; it is never turned into `succeeded` silently.
 */
export type LocalTaskState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/** Why a task is not allowed to run (authorization, not execution). */
export type BlockReason =
  | 'delegation_missing'
  | 'delegation_unknown'
  | 'delegation_expired'
  | 'agent_mismatch'
  | 'capability_not_granted'
  | 'approval_missing'
  | 'approval_unknown'
  | 'approval_not_approved'
  | 'approval_expired'
  | 'approval_digest_mismatch'
  | 'host_stopped'
  | 'host_paused'
  | 'work_root_missing'
  /** The persisted row could not be trusted when the store was loaded. */
  | 'invalid_persisted_row';

export const TERMINAL_LOCAL_STATES: LocalTaskState[] = ['succeeded', 'failed', 'cancelled'];

export interface DelegationScope {
  /** Human who delegated the work; never derived from "is the employee online". */
  ownerId: string;
  agentId: string;
  deviceId: string;
  /** ISO timestamp: after this moment the delegation is void. */
  expiresAt: string;
  /** Capabilities granted to this delegation, e.g. ["document.generate"]. */
  capabilities: string[];
}

/**
 * Approval reference for organization side effects. The host verifies it and
 * never approves anything itself; an expired or unapproved reference blocks the
 * task instead of sending.
 */
export interface ApprovalReference {
  id: string;
  approved: boolean;
  expiresAt: string;
  /** Digest of tool+target+payload the approval was granted for. */
  actionDigest: string;
}

/**
 * Issuer of a delegation/approval grant. Only trusted code paths may mint grants:
 * verified organization-server responses, or an explicit local user consent
 * dialog driven from the Electron main process. A renderer-supplied object is
 * never a grant — that is exactly what the registry exists to prevent.
 */
export type GrantSource = 'organization-server' | 'local-user-consent' | 'test';

/** A delegation the host trusts, keyed by id. */
export interface DelegationGrant extends DelegationScope {
  id: string;
  issuedAt: string;
  source: GrantSource;
}

/** An approval the host trusts, keyed by id and bound to one action digest. */
export interface ApprovalGrant extends ApprovalReference {
  issuedAt: string;
  source: GrantSource;
  /** Owner the approval was issued to; must match the delegation owner. */
  ownerId: string;
  /** When set, the approval only applies to this delegation. */
  delegationId?: string;
}

export interface LocalTaskInput {
  /** Business task id from ChatAgent's TaskEngine (or a local-only id). */
  taskId: string;
  agentId: string;
  /** Free-form goal handed to the executor. */
  goal: string;
  /** `document` = local artifact work; `side_effect` = external effect needing approval. */
  kind: 'document' | 'side_effect';
  /** Absolute directory the executor may work in; anything else is refused. */
  workDir: string;
  /** Executor toolset allow-list. Never empty, never `*`. */
  toolsets: string[];
  timeoutMs?: number;
  /**
   * Reference to a delegation already held by the host. Callers pass an id, never
   * a scope object: the host resolves and validates it against its own registry.
   */
  delegationId?: string;
  /** Reference to an approval already held by the host, bound by action digest. */
  approvalId?: string;
  /** Extra context for the executor (already sanitized by the caller). */
  notes?: string;
}

export interface LocalArtifact {
  /** Path relative to the task workDir; absolute paths never leave the host. */
  relativePath: string;
  name: string;
  bytes: number;
  sha256: string;
}

export interface LocalTaskRecord {
  taskId: string;
  deviceId: string;
  agentId: string;
  goal: string;
  kind: LocalTaskInput['kind'];
  state: LocalTaskState;
  /**
   * Compare-and-set version. Every accepted write bumps it, so an execution that
   * finishes after a cancel/stop can be rejected instead of overwriting the
   * terminal state.
   */
  version: number;
  /** Set for every execution attempt; a retry gets a new runId. */
  runId?: string;
  workDir: string;
  toolsets: string[];
  executor?: ExecutorKind;
  artifacts: LocalArtifact[];
  /** Safe, short, auditable summary of what happened. Never model reasoning. */
  summary?: string;
  error?: string;
  exitCode?: number | null;
  attempts: number;
  maxAttempts: number;
  /** Why the task was not executed (authorization) or could not be. */
  blockedReason?: BlockReason;
  /** Single-dispatcher guard: whoever holds the lease may run the task. */
  lease?: { holder: string; expiresAt: string };
  /** Resolved snapshot of the verified delegation (audit only; ids are the key). */
  delegation?: DelegationScope;
  /** Id of the delegation that was verified for this task (re-checked before running). */
  delegationId?: string;
  /** Resolved snapshot of the verified approval (audit only; ids are the key). */
  approval?: ApprovalReference;
  /** Id of the approval that was verified for this task (re-checked before running). */
  approvalId?: string;
  /** Digest the approval had to match; recorded so a later reviewer can re-check. */
  actionDigest?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/** Result returned by an executor; the host converts it into task state. */
export interface ExecutorRequest {
  taskId: string;
  runId: string;
  goal: string;
  workDir: string;
  toolsets: string[];
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ExecutorResult {
  executor: ExecutorKind;
  /** Process/agent exit code when the executor is a process. */
  exitCode: number | null;
  /** Final answer text (bounded, already sanitized by the adapter). */
  output: string;
  /** Files produced inside the workDir. */
  artifacts: LocalArtifact[];
  /** Recorded commands/tool calls as short audit lines (never reasoning text). */
  audit: string[];
  durationMs: number;
  /** Machine-readable failure class, when the run failed. */
  failure?: {
    kind:
      | 'timeout'
      | 'cancelled'
      | 'no_provider'
      | 'invalid_toolset'
      | 'executor_error'
      | 'not_found'
      | 'workdir_refused';
    message: string;
  };
}

export interface HermesAdapterConfig {
  /** Absolute path of the Hermes executable. */
  executable: string;
  /** Optional model/provider overrides; never credentials. */
  model?: string;
  provider?: string;
  /** Maximum bytes of stdout/stderr kept per run. */
  maxOutputBytes?: number;
  /** Extra environment for the child process (no secrets are added by the host). */
  env?: Record<string, string>;
}

export interface HostStatus {
  deviceId: string;
  agentId: string;
  /** Independent from window visibility: the host is alive as long as this says so. */
  running: boolean;
  paused: boolean;
  executor: ExecutorKind;
  /** Why the executor is fake, when it is. */
  executorReason?: string;
  workRoot: string;
  queued: number;
  /** How many tasks are executing right now (distinct from `running` above). */
  runningTasks: number;
  finished: number;
  /**
   * Results that arrived after a task had already reached a terminal state and
   * were therefore discarded. A non-zero value means the CAS guard did its job.
   */
  lateResultsDropped: number;
  /**
   * What the store found while loading: repaired rows, quarantined rows and
   * duplicates. Present only when the store reports it (the file store does).
   */
  storeIntegrity?: {
    repaired: number;
    quarantined: number;
    duplicates: number;
    /** Set when the whole store file was unreadable and moved aside. */
    corruptFile?: string;
  };
  lastError?: string;
}
