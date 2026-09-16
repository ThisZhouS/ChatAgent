/**
 * Task-store retention (long-running installs).
 *
 * The task store is a JSON file that is rewritten (write → fsync → rename) on
 * every state change, so an install that runs daily for a year pays an ever
 * growing cost per write — and the file itself becomes the biggest thing in
 * userData. Retention bounds that without ever touching work that still matters:
 *
 * - only *terminal* records are candidates (`succeeded` / `failed` / `cancelled` /
 *   `interrupted`); queued or running work is never dropped, however old;
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

const TERMINAL: ReadonlySet<LocalTaskRecord['state']> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]);

function updatedAtMs(record: LocalTaskRecord): number {
  const parsed = Date.parse(record.updatedAt ?? record.createdAt ?? '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Returns the task ids that may be dropped. Pure: the caller decides when to
 * actually write, and a load must never rewrite the file on its own.
 */
export function selectExpiredRecords(
  records: readonly LocalTaskRecord[],
  options: RetentionOptions = {},
): string[] {
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const now = (options.now ?? Date.now)();
  const expired = new Set<string>();

  if (options.maxAgeMs !== undefined) {
    const cutoff = now - options.maxAgeMs;
    for (const record of records) {
      if (TERMINAL.has(record.state) && updatedAtMs(record) < cutoff) expired.add(record.taskId);
    }
  }

  // Count cap: oldest terminal records first, and only if the cap is exceeded.
  const remaining = records.filter((record) => !expired.has(record.taskId));
  const over = remaining.length - maxRecords;
  if (over > 0) {
    const candidates = remaining
      .filter((record) => TERMINAL.has(record.state))
      .sort((a, b) => updatedAtMs(a) - updatedAtMs(b));
    for (const record of candidates.slice(0, over)) expired.add(record.taskId);
  }

  return [...expired];
}
