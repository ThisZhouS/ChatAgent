/**
 * The retention audit file is the only local file that used to grow without a
 * ceiling. These tests pin the bound and, just as important, the trace: a trim has
 * to leave a meta line that names the task ids it removed, or rotation would delete
 * the very history the audit exists to keep.
 *
 * The first version of this module had defects that an independent review measured,
 * and the cases below pin them so they cannot come back:
 *
 * - trimming exactly at the budget left the file *at* the budget, so the next append
 *   was over it again and every task write rewrote the whole trail (31 ms instead of
 *   1.7 ms at the default budget) — hence the high watermark;
 * - the trim was driven by the line budget alone, so a trail of a few fat batches
 *   could sit far over the byte budget and rotate on every append without ever
 *   dropping a line (measured: 488 KB against a 40 KB budget);
 * - a trim that could not drop anything still rewrote the file, which is the same
 *   per-append rewrite in the case where one batch is bigger than the whole budget.
 *
 * Budgets below the shipped floors are clamped (`MIN_AUDIT_MAX_LINES`), so the cases
 * here use caps at or above the floor and say so where the clamping matters.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_AUDIT_MAX_BYTES,
  DEFAULT_AUDIT_MAX_LINES,
  MAX_NOTE_TASK_IDS,
  MIN_AUDIT_MAX_LINES,
  rotateRetentionAudit,
  taskIdsOf,
} from './retention-audit';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'chatagent-audit-rotate-'));
  dirs.push(dir);
  return join(dir, 'tasks.json.retention-audit.jsonl');
}

function pruneLine(index: number): string {
  return JSON.stringify({
    at: new Date(Date.UTC(2026, 8, 1) + index * 1000).toISOString(),
    action: 'task_store.pruned',
    actor: 'local-host',
    reason: 'count',
    count: 1,
    tasks: [{ taskId: `old-${index}`, state: 'succeeded', reason: 'count', updatedAt: '2026-09-01T00:00:00.000Z' }],
  });
}

/** One fat batch line, close to the 500-record worst case the store can emit. */
function fatLine(index: number, tasks = 400): string {
  return JSON.stringify({
    at: new Date().toISOString(),
    action: 'task_store.pruned',
    actor: 'local-host',
    reason: 'count',
    count: tasks,
    tasks: Array.from({ length: tasks }, (_, task) => ({
      taskId: `fat-${index}-${task}`,
      state: 'succeeded',
      reason: 'count',
      updatedAt: '2026-09-01T00:00:00.000Z',
    })),
  });
}

function lines(raw: string): Array<Record<string, unknown>> {
  return raw
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function batchIds(raw: string): string[] {
  return lines(raw)
    .filter((line) => line.action === 'task_store.pruned')
    .map((line) => (line.tasks as Array<{ taskId: string }>)[0]!.taskId);
}

describe('retention audit rotation', () => {
  it('leaves a trail inside the budget untouched', async () => {
    const file = await tempFile();
    await writeFile(file, `${[0, 1, 2].map(pruneLine).join('\n')}\n`, 'utf8');
    const result = await rotateRetentionAudit(file, { maxLines: 10, maxBytes: 4096 });
    expect(result.rotated).toBe(false);
    expect(result.droppedBatches).toBe(0);
    expect(lines(await readFile(file, 'utf8'))).toHaveLength(3);
  });

  it('does nothing when there is no audit file yet', async () => {
    const file = await tempFile();
    await expect(rotateRetentionAudit(file)).resolves.toMatchObject({
      rotated: false,
      droppedBatches: 0,
    });
  });

  it('keeps the newest batches and stamps the file with what the trim dropped', async () => {
    const file = await tempFile();
    const total = 400;
    await writeFile(file, `${Array.from({ length: total }, (_, index) => pruneLine(index)).join('\n')}\n`, 'utf8');

    const maxLines = 64;
    const result = await rotateRetentionAudit(file, { maxLines, maxBytes: 10_000_000, slackLines: 0 });
    const keep = maxLines - 4; // `maxLines - 2` target lines, less the two notes
    expect(result.rotated).toBe(true);
    expect(result.droppedBatches).toBe(total - keep);
    expect(result.keptLines).toBe(keep + 1); // kept batches + the new note

    const kept = lines(await readFile(file, 'utf8'));
    expect(kept).toHaveLength(keep + 1);
    expect(kept[0]).toMatchObject({
      action: 'task_store.retention_audit_rotated',
      actor: 'local-host',
      reason: 'lines',
      droppedLines: total - keep,
    });
    // The newest batches survive, the oldest are the ones that went...
    const ids = batchIds(await readFile(file, 'utf8'));
    expect(ids[0]).toBe(`old-${total - keep}`);
    expect(ids[ids.length - 1]).toBe(`old-${total - 1}`);
    // ...and their ids are still readable from the note, which is the whole point of
    // not simply deleting the head of the file. (The note keeps an exact count even
    // when the id list is capped.)
    const droppedIds = kept[0]!.droppedTasks as string[];
    expect(droppedIds[0]).toBe('old-0');
    expect(kept[0]!.droppedTasksTruncated ?? droppedIds.length).toBe(total - keep);
  });
  it('trims at a high watermark, so a saturated trail is not rewritten on every append', async () => {
    const file = await tempFile();
    const maxLines = MIN_AUDIT_MAX_LINES;
    const slack = 10;
    // Seed just past the watermark: the trim fires once, and the file must then be
    // far enough below the watermark that the following appends are plain appends.
    await writeFile(
      file,
      `${Array.from({ length: maxLines + slack + 1 }, (_, index) => pruneLine(index)).join('\n')}\n`,
      'utf8',
    );
    const first = await rotateRetentionAudit(file, { maxLines, maxBytes: 10_000_000, slackLines: slack });
    expect(first.rotated).toBe(true);
    expect(lines(await readFile(file, 'utf8')).length).toBeLessThanOrEqual(maxLines);

    // Simulate the appends that follow: none of them may need a trim until the
    // watermark is crossed again. Without hysteresis this loop rotates every time.
    let rotations = 0;
    for (let append = 0; append < slack; append += 1) {
      const raw = await readFile(file, 'utf8');
      await writeFile(file, `${raw}${pruneLine(1000 + append)}\n`, 'utf8');
      const result = await rotateRetentionAudit(file, { maxLines, maxBytes: 10_000_000, slackLines: slack });
      if (result.rotated) rotations += 1;
    }
    expect(rotations).toBe(0);
  });

  it('enforces the byte budget even when the batch count is under the line cap', async () => {
    const file = await tempFile();
    // Four fat batches: 4 lines, so a line cap of 200 would never fire, but the file
    // is ~155 KB because each line names 400 tasks.
    await writeFile(file, `${Array.from({ length: 4 }, (_, index) => fatLine(index)).join('\n')}\n`, 'utf8');
    const before = (await readFile(file, 'utf8')).length;
    expect(before).toBeGreaterThan(100_000);

    const maxBytes = 40_000;
    let rotations = 0;
    for (let round = 0; round < 3; round += 1) {
      const result = await rotateRetentionAudit(file, { maxLines: 200, maxBytes, slackLines: 0 });
      if (result.rotated) rotations += 1;
    }
    // The file must come down to what can actually fit: whole batches are dropped
    // until the remainder is as close to the budget as a batch can get.
    expect(rotations).toBe(1);
    const after = (await readFile(file, 'utf8')).length;
    expect(after).toBeLessThan(before);
    expect(batchIds(await readFile(file, 'utf8'))).toHaveLength(1);
    // The trim happened once and then stopped: a file that cannot shrink further is
    // left alone rather than rewritten on every append.
    const again = await rotateRetentionAudit(file, { maxLines: 200, maxBytes, slackLines: 0 });
    expect(again.rotated).toBe(false);
  });

  it('keeps the previous rotation note next to the new one', async () => {
    const file = await tempFile();
    await writeFile(file, `${Array.from({ length: 60 }, (_, index) => pruneLine(index)).join('\n')}\n`, 'utf8');
    const maxLines = MIN_AUDIT_MAX_LINES;
    await rotateRetentionAudit(file, { maxLines, maxBytes: 10_000_000, slackLines: 0 });
    const afterFirst = lines(await readFile(file, 'utf8'));
    expect(afterFirst).toHaveLength(maxLines - 3); // 13 batches + 1 note
    const firstNoteAt = afterFirst[0]!.at;

    // Grow it again and rotate once more: the reader must still see what the
    // previous trim removed, and the file must stay inside the cap.
    const grown = await readFile(file, 'utf8');
    await writeFile(file, `${grown}${Array.from({ length: 20 }, (_, index) => pruneLine(100 + index)).join('\n')}\n`, 'utf8');
    const second = await rotateRetentionAudit(file, { maxLines, maxBytes: 10_000_000, slackLines: 0 });
    expect(second.rotated).toBe(true);
    const kept = lines(await readFile(file, 'utf8'));
    expect(kept.length).toBeLessThanOrEqual(maxLines);    expect(kept[0]).toMatchObject({ action: 'task_store.retention_audit_rotated' });
    expect(kept[0]!.at).toBe(firstNoteAt);
    expect(kept[1]).toMatchObject({ action: 'task_store.retention_audit_rotated' });
    expect(second.droppedBatches).toBeGreaterThan(0);
  });

  it('never drops the newest batch, even when it is bigger than the whole budget', async () => {
    const file = await tempFile();
    await writeFile(file, `${pruneLine(0)}\n`, 'utf8');
    const result = await rotateRetentionAudit(file, { maxLines: MIN_AUDIT_MAX_LINES, maxBytes: 1, slackLines: 0 });
    // A byte budget that cannot hold even one batch plus a note: there is nothing to
    // drop (the newest batch is never a candidate), so no trim is attempted — and
    // crucially the file is not rewritten on every append.
    expect(result.rotated).toBe(false);
    expect(result.error).toBeUndefined();
    expect(batchIds(await readFile(file, 'utf8'))).toEqual(['old-0']);
  });

  it('drops the oldest batches when the byte budget cannot hold them all', async () => {
    const file = await tempFile();
    await writeFile(file, `${Array.from({ length: 6 }, (_, index) => fatLine(index)).join('\n')}\n`, 'utf8');
    const result = await rotateRetentionAudit(file, { maxLines: 200, maxBytes: 90_000, slackLines: 0 });
    expect(result.rotated).toBe(true);
    expect(result.droppedBatches).toBeGreaterThan(0);
    const ids = batchIds(await readFile(file, 'utf8'));
    // The newest batch survives; the dropped ones are named in the note.
    expect(ids[ids.length - 1]).toBe('fat-5-0');
    const note = lines(await readFile(file, 'utf8'))[0]!;
    expect(note.action).toBe('task_store.retention_audit_rotated');
    expect((note.droppedTasks as string[]).length).toBeGreaterThan(0);
  });

  it('survives a damaged line: it counts as dropped, it does not abort the trim', async () => {
    const file = await tempFile();
    const body = ['{ this is not json', ...Array.from({ length: 60 }, (_, index) => pruneLine(index))].join('\n');
    await writeFile(file, `${body}\n`, 'utf8');
    const maxLines = MIN_AUDIT_MAX_LINES;
    const result = await rotateRetentionAudit(file, { maxLines, maxBytes: 10_000_000, slackLines: 0 });
    expect(result.rotated).toBe(true);
    // The damaged line is not a batch (it names no tasks) but it is still dropped.
    expect(result.droppedBatches).toBe(61 - (maxLines - 4));
    const kept = lines(await readFile(file, 'utf8'));
    expect(kept.length).toBeLessThanOrEqual(maxLines);
    expect(kept.filter((line) => line.action === 'task_store.retention_audit_rotated')).toHaveLength(1);
    expect(kept.some((line) => line.action === undefined)).toBe(false); // the damaged line is gone
  });

  it('reports an unwritable trim instead of throwing at the caller', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'chatagent-audit-rotate-'));
    dirs.push(dir);
    // The audit path is a directory: every read/write of it fails.
    const file = join(dir, 'audit-as-directory');
    await (await import('node:fs/promises')).mkdir(file);
    const result = await rotateRetentionAudit(file, { maxLines: MIN_AUDIT_MAX_LINES, maxBytes: 10 });
    // Whatever the outcome, it resolves: the store must be able to keep going.
    expect(typeof result.rotated).toBe('boolean');
    expect(result.error === undefined || typeof result.error === 'string').toBe(true);
  });

  it('never lets the note itself grow past the id cap', async () => {
    const file = await tempFile();
    // 60 fat batches: 24,000 ids in the dropped set, far past the note's cap.
    await writeFile(file, `${Array.from({ length: 60 }, (_, index) => fatLine(index, 400)).join('\n')}\n`, 'utf8');
    const result = await rotateRetentionAudit(file, { maxLines: 20, maxBytes: 10_000_000, slackLines: 0 });
    expect(result.rotated).toBe(true);
    expect(result.droppedTaskIds.length).toBeGreaterThan(MAX_NOTE_TASK_IDS);
    const note = lines(await readFile(file, 'utf8'))[0]!;
    expect((note.droppedTasks as string[]).length).toBe(MAX_NOTE_TASK_IDS);
    expect(note.droppedTasksTruncated).toBe(result.droppedTaskIds.length);
    // And the note stays small relative to the batches it describes.
    expect(JSON.stringify(note).length).toBeLessThan(20_000);
  });

  it('clamps nonsense budgets instead of rotating on every append, and never crashes', async () => {
    const file = await tempFile();
    await writeFile(file, `${[0, 1, 2].map(pruneLine).join('\n')}\n`, 'utf8');
    // 0/negative/NaN budgets are clamped to the floors, not honoured: a zero budget
    // would mean "rewrite the file on every append and drop everything". Whatever the
    // floor does, the outcome must be a bounded file and no thrown error.
    for (const options of [
      { maxLines: 0, maxBytes: 0 },
      { maxLines: -5, maxBytes: -1 },
      { maxLines: Number.NaN, maxBytes: Number.NaN },
    ]) {
      const result = await rotateRetentionAudit(file, { ...options, slackLines: 0 });
      expect(result.error).toBeUndefined();
      expect(lines(await readFile(file, 'utf8')).length).toBeLessThanOrEqual(MIN_AUDIT_MAX_LINES + 1);
    }
    // And a trail inside the floors is left alone, which is the normal case.
    const file2 = await tempFile();
    await writeFile(file2, `${[0, 1, 2].map(pruneLine).join('\n')}\n`, 'utf8');
    await expect(
      rotateRetentionAudit(file2, { maxLines: MIN_AUDIT_MAX_LINES, maxBytes: 4096, slackLines: 0 }),
    ).resolves.toMatchObject({ rotated: false });
  });

  it('reads ids out of a batch line, and nothing out of anything else', () => {
    expect(taskIdsOf([pruneLine(1), '{', 'null', JSON.stringify({ tasks: 'no' })])).toEqual(['old-1']);
  });

  it('ships a budget that is a real bound rather than a default of zero', () => {
    expect(DEFAULT_AUDIT_MAX_LINES).toBeGreaterThan(100);
    expect(DEFAULT_AUDIT_MAX_BYTES).toBeGreaterThan(100_000);
  });
});
