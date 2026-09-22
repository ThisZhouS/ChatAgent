/**
 * Task-store retention (long-running installs).
 *
 * The task store is a JSON file that is rewritten (write → fsync → rename) on
 * every state change, so an install that runs daily for a year pays an ever
 * growing cost per write — and the file itself becomes the biggest thing in
 * userData. Retention bounds that without ever touching work that still matters:
 *
 * - only *finished and non-retryable* records are candidates (`succeeded` /
 *   `failed` / `cancelled`); queued, running and `interrupted` work is never
 *   dropped, however old (`interrupted` can still be retried by the user);
 * - the newest records are always kept (the cap is about volume, not history);
 * - the age rule is opt-in (default: no age limit), so a quiet device keeps its
 *   history until the count cap is reached.
 */
import type { LocalTaskRecord } from './types';

export interface RetentionOptions {
  /** Upper bound of records kept per device. Default 500. */
  maxRecords?: number;
  /** Drop terminal records older than this. Default: no age limit. */
  maxAgeMs?: number;
  now?: () => number;
}

export const DEFAULT_MAX_RECORDS = 500;

/** Why a record was dropped: the age rule or the per-device count cap. */
export type RetentionReason = 'age' | 'count';

/**
 * One dropped record, with what a reviewer needs to trace it afterwards. The
 * store writes these to its retention audit, so "500 rows became 480" can be
 * answered with the exact ids and the rule that removed each one.
 */
export interface ExpiredRecord {
  taskId: string;
  state: LocalTaskRecord['state'];
  reason: RetentionReason;
  /** The timestamp the decision was based on; `''` when the row had none. */
  updatedAt: string;
}

const PRUNABLE: ReadonlySet<LocalTaskRecord['state']> = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);
// `interrupted` is deliberately absent: it is a *retryable* outcome (the host
// keeps it, retry() accepts it, status() counts it as finished), so dropping it
// silently removed work the user could still re-queue (round-3 finding F4).

function updatedAtMs(record: LocalTaskRecord): number {
  const parsed = Date.parse(record.updatedAt ?? record.createdAt ?? '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Returns the records that may be dropped, each with the rule that removed it.
 * Pure: the caller decides when to actually write, and a load must never rewrite
 * the file on its own.
 */
export function selectExpiredRecordsDetailed(
  records: readonly LocalTaskRecord[],
  options: RetentionOptions = {},
): ExpiredRecord[] {
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const now = (options.now ?? Date.now)();
  const expired = new Map<string, ExpiredRecord>();

  if (options.maxAgeMs !== undefined) {
    const cutoff = now - options.maxAgeMs;
    for (const record of records) {
      if (!PRUNABLE.has(record.state) || updatedAtMs(record) >= cutoff) continue;
      expired.set(record.taskId, {
        taskId: record.taskId,
        state: record.state,
        reason: 'age',
        updatedAt: record.updatedAt ?? record.createdAt ?? '',
      });
    }
  }

  // Count cap: oldest terminal records first, and only if the cap is exceeded.
  const remaining = records.filter((record) => !expired.has(record.taskId));
  const over = remaining.length - maxRecords;
  if (over > 0) {
    const candidates = remaining
      .filter((record) => PRUNABLE.has(record.state))
      .sort((a, b) => updatedAtMs(a) - updatedAtMs(b));
    for (const record of candidates.slice(0, over)) {
      expired.set(record.taskId, {
        taskId: record.taskId,
        state: record.state,
        reason: 'count',
        updatedAt: record.updatedAt ?? record.createdAt ?? '',
      });
    }
  }

  return [...expired.values()];
}

/**
 * Returns the task ids that may be dropped (the id projection of
 * `selectExpiredRecordsDetailed`, kept for callers that only need the ids).
 */
export function selectExpiredRecords(
  records: readonly LocalTaskRecord[],
  options: RetentionOptions = {},
): string[] {
  return selectExpiredRecordsDetailed(records, options).map((entry) => entry.taskId);
}
