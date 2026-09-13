import type { TaskArtifact, TaskEvent, TaskRecord, TaskState } from '@chatagent/contracts';

export interface TaskStore {
  get(id: string): Promise<TaskRecord | undefined>;
  list(): Promise<TaskRecord[]>;
  save(task: TaskRecord): Promise<void>;
}

export interface TaskContext {
  signal: AbortSignal;
  emit(event: Omit<TaskEvent, 'taskId' | 'at'>): void;
  update(patch: Partial<TaskRecord>): Promise<void>;
  appendArtifact(artifact: TaskArtifact): Promise<void>;
}

/**
 * Structured handler outcome. A plain string is the legacy success shape and
 * is only valid for handlers that have nothing else to report.
 */
export type TaskOutcome =
  | { kind: 'completed'; result: string }
  | { kind: 'failed'; error: string; retryable?: boolean }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'waiting_input'; question: string }
  | { kind: 'waiting_approval'; approvalId: string }
  | { kind: 'incomplete'; reason: string; message: string };

export type TaskHandlerResult = string | TaskOutcome;

export type TaskHandler = (task: TaskRecord, context: TaskContext) => Promise<TaskHandlerResult>;

export interface SubmitTaskInput {
  accountId: string;
  conversationId?: string;
  organizationId: string;
  requesterId: string;
  goal: string;
  input?: Record<string, unknown>;
  maxAttempts?: number;
}

export interface CancelResult {
  ok: boolean;
  reason?: 'not_found' | 'already_finished';
  state?: TaskState;
}

export interface TaskEngineOptions {
  store: TaskStore;
  handler: TaskHandler;
  maxConcurrency?: number;
  retryDelayMs?: number;
  stopTimeoutMs?: number;
  /** Rejects new submissions once this many tasks are queued or running. */
  maxQueueDepth?: number;
}
