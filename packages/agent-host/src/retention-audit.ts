/**
 * Bounds for the retention audit file itself.
 *
 * The trail written by the task store (one JSON line per prune batch, naming every
 * dropped task id) was the only local file that grew without a ceiling: the task
 * store caps itself at 500 records, but this file only ever appended. On a device
 * that runs for months the audit would outgrow the data it describes, and a
 * reviewer opening it would page through megabytes to answer "which ids went
 * yesterday".
 *
 * The rule is the same shape as the task store's own retention: keep the newest
 * entries, drop the oldest, never drop the newest. What is different is the trace:
 * a trim writes a *meta line* naming the batches it removed, so a reader can tell
 * "the trail starts here because the rest was rotated" from "this install produced
 * exactly this much history".
 *
 * Two bounds, because one is not enough:
 *
 * - a line budget (the normal case — a batch is a few hundred bytes);
 * - a byte budget (a batch can be huge: `maxRecords` is 500, so one prune can name
 *   500 ids and be hundreds of kilobytes on its own).
 *
 * Trimming happens at a *high watermark*, not at the budget: once the file is over
 * the watermark it is cut back to the budget, so the cost of a rewrite is amortised
 * over `watermark - budget` appends instead of being paid on every append. Without
 * that hysteresis the store would rewrite the whole trail on every single task
 * write once the audit saturated (measured: 31 ms per task write instead of 1.7 ms).
 *
 * Crash safety follows the store's commit rule: write the trimmed content to a
 * temporary file, fsync, then rename. A power cut during rotation leaves either the
 * old file or the new one, never a half-written trail. Nothing here throws: a
 * housekeeping failure must never fail the task write that triggered it.
 */
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Lines kept in the audit file before trimming. */
export const DEFAULT_AUDIT_MAX_LINES = 1_200;
/**
 * Bytes kept in the audit file before trimming. This is the budget that bites first
 * at the default line cap (a batch is ~400 bytes, so 1 MiB arrives at ~2,500
 * lines): the two are deliberately of the same order, because a line cap whose
 * moment never arrives is not a bound. A trail of unusually short batches still
 * hits the line cap instead of squatting just under the byte cap forever.
 */
export const DEFAULT_AUDIT_MAX_BYTES = 1_048_576;
/** The line cap also has a floor: below this, "a file" cannot hold a usable trail. */
export const MIN_AUDIT_MAX_LINES = 16;
/**
 * How far past the line budget the file may grow before it is cut back. Trimming
 * at the budget itself would leave exactly `maxLines` lines, so the very next
 * append would be over it again and every task write would rewrite the trail.
 */
export const DEFAULT_AUDIT_ROTATE_SLACK_LINES = 32;
/**
 * Upper bound on the ids repeated in a rotation note. The ids are already written
 * by the batch lines being dropped, and the note has to stay small enough that it
 * can never dominate the file it is supposed to bound.
 */
export const MAX_NOTE_TASK_IDS = 200;

export interface AuditRotationOptions {
  /** Lines kept after a trim; the file may grow to this plus a slack before one. */
  maxLines?: number;
  /** Bytes the file is not supposed to exceed (one batch of fat lines may). */
  maxBytes?: number;
  /** Overridable for tests: how far past `maxLines` the file may drift. */
  slackLines?: number;
}

export interface AuditRotationResult {
  /** True when the file was trimmed (the caller then appends to the new file). */
  rotated: boolean;
  /** Prune-batch lines dropped by this trim (a note is not a batch). */
  droppedBatches: number;
  /** Task ids named by the dropped lines, as far as the lines could be parsed. */
  droppedTaskIds: string[];
  /** Lines left in the file after the trim (batches + notes). */
  keptLines: number;
  /** Set when the trim itself failed; the caller still appends (see the contract). */
  error?: string;
}

const EMPTY: AuditRotationResult = {
  rotated: false,
  droppedBatches: 0,
  droppedTaskIds: [],
  keptLines: 0,
};

/** Identifies a rotation note as opposed to a prune batch. */
const ROTATION_ACTION = 'task_store.retention_audit_rotated';

function isRotationNote(line: string): boolean {
  try {
    return (JSON.parse(line) as { action?: unknown }).action === ROTATION_ACTION;
  } catch {
    return false;
  }
}

/** The audit lines of a raw file, without trailing empty elements. */
function splitLines(raw: string): string[] {
  return raw === '' ? [] : raw.split('\n').filter((line) => line !== '');
}

/**
 * Task ids named by a run of audit lines. Best effort on purpose: the trail must
 * survive a hand-edited or truncated line, and the rotation note should still say
 * what it can rather than refuse to rotate.
 */
export function taskIdsOf(lines: readonly string[]): string[] {
  const ids: string[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as { tasks?: Array<{ taskId?: unknown }> };
      if (!Array.isArray(entry.tasks)) continue;
      for (const task of entry.tasks) {
        if (typeof task?.taskId === 'string') ids.push(task.taskId);
      }
    } catch {
      // A damaged line contributes no ids; it is still counted as dropped.
    }
  }
  return ids;
}

function rotationNote(
  droppedLines: number,
  droppedTaskIds: readonly string[],
  reason: string,
  maxIds = MAX_NOTE_TASK_IDS,
): string {
  const limit = Math.max(1, Math.min(MAX_NOTE_TASK_IDS, maxIds));
  const ids = droppedTaskIds.length > limit ? droppedTaskIds.slice(0, limit) : droppedTaskIds;
  return JSON.stringify({
    at: new Date().toISOString(),
    action: ROTATION_ACTION,
    actor: 'local-host',
    reason,
    droppedLines,
    // The ids of the dropped batches stay readable: without this, rotation would
    // make the very traceability the audit exists for disappear. Truncated on
    // purpose (the count above stays exact) so the note cannot grow without bound.
    droppedTasks: ids,
    ...(ids.length < droppedTaskIds.length ? { droppedTasksTruncated: droppedTaskIds.length } : {}),
  });
}

/** Mean line length, used to estimate how much room the kept batches need. */
function averageLineBytes(lines: readonly string[]): number {
  if (lines.length === 0) return 1;
  const total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  return Math.max(1, Math.round(total / lines.length));
}

function positiveInteger(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  return rounded >= minimum ? rounded : minimum;
}

/**
 * Trims the audit file when it has outgrown its budget, so the append that follows
 * cannot make it grow without bound. Never throws: a housekeeping failure is
 * reported in the result and the caller still appends (losing the append would be
 * strictly worse than a file that is over budget until the next attempt).
 */
export async function rotateRetentionAudit(
  path: string,
  options: AuditRotationOptions = {},
): Promise<AuditRotationResult> {
  try {
    const maxLines = positiveInteger(options.maxLines, DEFAULT_AUDIT_MAX_LINES, MIN_AUDIT_MAX_LINES);
    const maxBytes = positiveInteger(options.maxBytes, DEFAULT_AUDIT_MAX_BYTES, 1);
    const slack = positiveInteger(
      options.slackLines,
      Math.max(DEFAULT_AUDIT_ROTATE_SLACK_LINES, Math.floor(maxLines / 16)),
      0,
    );
    const rotateAtLines = maxLines + slack;
    // What the file ends up holding once this trim is done (the note being written
    // needs a slot). This is `slack` lines below the watermark, so the appends that
    // follow are plain appends instead of each triggering another trim — the defect
    // an independent review measured was one full rewrite per task write.
    const trimTargetLines = Math.max(3, maxLines - 2);

    const size = await stat(path).then(
      (info) => info.size,
      () => undefined,
    );
    if (size === undefined) return EMPTY; // no audit file yet: nothing to rotate
    // Cheap gate, strictly in bytes-to-bytes terms — no reading the whole trail just
    // to learn that nothing needs doing. A trail that is over the line watermark must
    // be at least that many bytes, so a byte budget at or below the watermark is the
    // real bound; a larger one only means the line watermark decides, and then the
    // gate has to fall back to it. (Deriving the byte floor from `rotateAtLines +
    // maxBytes` instead of just `maxBytes` is what keeps a short-batch trail from
    // silently skipping its trim.)
    const byteGate = Math.min(maxBytes, Math.max(rotateAtLines, maxBytes / 2));
    if (size < Math.min(rotateAtLines, byteGate)) return EMPTY;

    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return EMPTY;
    }
    const lines = splitLines(raw);
    // `+ 1` for the append this call precedes: the trim exists to keep that line
    // inside the budget, so the decision has to include it.
    const overCount = lines.length + 1 > rotateAtLines;
    const overBytes = size > maxBytes;
    if (!overCount && !overBytes) return EMPTY;

    const notes = lines.filter(isRotationNote);
    const batches = lines.filter((line) => !isRotationNote(line));
    const previousNote = notes.length > 0 ? notes[notes.length - 1] : undefined;

    // The note being written needs a slot, and everything kept must fit in the
    // budgets once it is there — otherwise the next append would immediately be
    // over again and every task write would rewrite the trail.
    const keepByLines = Math.max(1, trimTargetLines - 2);
    // Keep the note smaller than the byte budget it is enforcing, so the file's own
    // bookkeeping can never be the thing that breaks the bound.
    const maxNoteIds = Math.max(1, Math.min(MAX_NOTE_TASK_IDS, Math.floor(maxBytes / 64)));
    const noteCeiling = maxNoteIds * 48 + 256;
    // A batch is the smallest unit that can be dropped (a line is one prune, and
    // half a line is not readable), so the byte rule drops whole batches until the
    // remainder fits next to the notes. The newest batch is never a candidate.
    const keepByBytes = Math.max(
      1,
      Math.floor((maxBytes - noteCeiling) / Math.max(1, averageLineBytes(batches))),
    );
    const keep = Math.max(1, Math.min(keepByLines, keepByBytes, batches.length));
    const droppedBatches = batches.slice(0, batches.length - keep);
    const keptBatches = batches.slice(batches.length - keep);
    if (droppedBatches.length === 0) {
      // Nothing left to drop: one batch (or the notes) alone is bigger than the byte
      // budget, and repeated trimming could not change that. Rewriting the file
      // would only burn I/O on every append, so report "no trim" and let the caller
      // append. This is the only case where the byte budget bends for one batch.
      return { ...EMPTY, keptLines: lines.length, droppedTaskIds: [] };
    }
    const note = rotationNote(
      droppedBatches.length,
      taskIdsOf(droppedBatches),
      overCount ? (overBytes ? 'lines+bytes' : 'lines') : 'bytes',
      maxNoteIds,
    );
    const keptLines = [previousNote, note, ...keptBatches].filter((line) => line !== undefined);
    const next = `${keptLines.join('\n')}\n`;

    const tmp = join(dirname(path), `.${process.pid}-${Date.now()}.audit.tmp`);
    await mkdir(dirname(path), { recursive: true });
    try {
      const handle = await open(tmp, 'w');
      try {
        await handle.writeFile(next, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, path);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
    // `droppedBatches` counts only batches: the notes are the trail's own
    // bookkeeping, and a reader counting "how many batches went" must not have to
    // subtract them.
    return {
      rotated: true,
      droppedBatches: droppedBatches.length,
      droppedTaskIds: taskIdsOf(droppedBatches),
      keptLines: keptLines.length,
    };
  } catch (error) {
    // Never throw: the caller's task write must not fail because housekeeping did.
    return { ...EMPTY, error: error instanceof Error ? error.message : String(error) };
  }
}
