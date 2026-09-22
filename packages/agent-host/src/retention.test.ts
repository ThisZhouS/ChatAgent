import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_RECORDS,
  selectExpiredRecords,
  selectExpiredRecordsDetailed,
} from './retention';
import { JsonFileAgentHostStore } from './store';
import type { LocalTaskRecord } from './types';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  // A failing assertion must not leave a console spy installed for the rest of
  // the file (the unwritable-audit case asserts on console.error).
  vi.restoreAllMocks();
});

function record(taskId: string, state: LocalTaskRecord['state'], updatedAt: string): LocalTaskRecord {
  return {
    taskId,
    deviceId: 'desktop-test',
    agentId: 'hermes',
    goal: 'g',
    kind: 'document',
    state,
    version: 1,
    workDir: 'C:/tmp/work',
    toolsets: ['document'],
    artifacts: [],
    attempts: 1,
    maxAttempts: 2,
    createdAt: updatedAt,
    updatedAt,
  };
}

describe('task store retention', () => {
  it('never drops work that is still queued or running, however old', () => {
    const records = [
      record('old-queued', 'queued', '2020-01-01T00:00:00.000Z'),
      record('old-running', 'running', '2020-01-01T00:00:00.000Z'),
      record('done', 'succeeded', '2026-01-01T00:00:00.000Z'),
    ];
    const expired = selectExpiredRecords(records, { maxRecords: 1 });
    expect(expired).toEqual(['done']);
  });

  it('keeps interrupted work: it is retryable, not terminal', () => {
    const records = [
      record('i-old', 'interrupted', '2025-01-01T00:00:00.000Z'),
      record('i-new', 'interrupted', '2026-09-01T00:00:00.000Z'),
      record('done', 'succeeded', '2026-08-01T00:00:00.000Z'),
    ];
    expect(selectExpiredRecords(records, { maxRecords: 1 })).toEqual(['done']);
    // Even the age rule leaves retryable rows alone.
    expect(
      selectExpiredRecords(records, {
        maxRecords: 10,
        maxAgeMs: 24 * 60 * 60 * 1000,
        now: () => Date.parse('2026-09-16T00:00:00.000Z'),
      }),
    ).toEqual(['done']);
  });

  it('drops the oldest terminal records first when the cap is exceeded', () => {
    const records = [
      record('a', 'succeeded', '2026-01-01T00:00:00.000Z'),
      record('b', 'failed', '2026-02-01T00:00:00.000Z'),
      record('c', 'succeeded', '2026-03-01T00:00:00.000Z'),
    ];
    expect(selectExpiredRecords(records, { maxRecords: 2 })).toEqual(['a']);
    expect(selectExpiredRecords(records, { maxRecords: 1 })).toEqual(['a', 'b']);
    expect(selectExpiredRecords(records, { maxRecords: 3 })).toEqual([]);
  });

  it('keeps everything when the cap is not exceeded, even if all are terminal', () => {
    const records = Array.from({ length: DEFAULT_MAX_RECORDS }, (_, i) =>
      record(`t${i}`, 'succeeded', new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString()),
    );
    expect(selectExpiredRecords(records)).toEqual([]);
  });

  it('honours an explicit age limit only for terminal records', () => {
    const now = () => Date.parse('2026-09-16T00:00:00.000Z');
    const records = [
      record('ancient-done', 'succeeded', '2025-01-01T00:00:00.000Z'),
      record('ancient-queued', 'queued', '2025-01-01T00:00:00.000Z'),
      record('recent', 'succeeded', '2026-09-01T00:00:00.000Z'),
    ];
    const expired = selectExpiredRecords(records, {
      maxAgeMs: 30 * 24 * 60 * 60 * 1000,
      now,
    });
    expect(expired).toEqual(['ancient-done']);
  });
});

describe('retention inside the task store', () => {
  function seedStore(records: LocalTaskRecord[]) {
    const dir = mkdtempSync(join(tmpdir(), 'chatagent-retention-'));
    dirs.push(dir);
    const filePath = join(dir, 'tasks.json');
    writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf8');
    return filePath;
  }

  it('a load reports prunable records but never rewrites the file', async () => {
    const records = [
      record('keep-queued', 'queued', '2020-01-01T00:00:00.000Z'),
      record('old-1', 'succeeded', '2026-01-01T00:00:00.000Z'),
      record('old-2', 'succeeded', '2026-01-02T00:00:00.000Z'),
    ];
    const filePath = seedStore(records);
    const before = readFileSync(filePath, 'utf8');
    const store = new JsonFileAgentHostStore(filePath, { maxRecords: 2 });
    await store.load();
    const report = store.getLoadReport();
    expect(report?.prunable).toEqual(['old-1']);
    expect(readFileSync(filePath, 'utf8')).toBe(before); // load is read-only
    await store.list();
    expect(readFileSync(filePath, 'utf8')).toBe(before);
    await store.close();
  });

  it('the next accepted write drops prunable terminal rows and keeps live work', async () => {
    const records = [
      record('keep-queued', 'queued', '2020-01-01T00:00:00.000Z'),
      record('old-1', 'succeeded', '2026-01-01T00:00:00.000Z'),
      record('old-2', 'succeeded', '2026-01-02T00:00:00.000Z'),
    ];
    const filePath = seedStore(records);
    const store = new JsonFileAgentHostStore(filePath, { maxRecords: 2 });
    await store.load();
    await store.put(record('fresh', 'succeeded', '2026-09-16T00:00:00.000Z'));
    await store.flush();
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as LocalTaskRecord[];
    const ids = onDisk.map((item) => item.taskId).sort();
    // Cap 2 with three terminal + one live record: the two oldest terminal rows
    // go, the queued one stays (live work is never dropped to satisfy the cap).
    expect(ids).toEqual(['fresh', 'keep-queued']);
    await store.close();
  });

  it('a failed write restores what retention dropped (memory matches disk)', async () => {
    const records = [
      record('old-1', 'succeeded', '2026-01-01T00:00:00.000Z'),
      record('old-2', 'succeeded', '2026-01-02T00:00:00.000Z'),
    ];
    const filePath = seedStore(records);
    const store = new JsonFileAgentHostStore(filePath, { maxRecords: 1 });
    await store.load();
    await store.close(); // releases the lock: the next write must fail
    await expect(store.put(record('new', 'succeeded', '2026-09-16T00:00:00.000Z'))).rejects.toThrow();
    const kept = (await store.list()).map((item) => item.taskId).sort();
    // The refused write is not kept (the caller was told it failed) and the rows
    // retention had dropped for that write are back: memory still mirrors disk.
    expect(kept).toEqual(['old-1', 'old-2']);
    // A write that never landed dropped nothing either: the housekeeping counter
    // must not report 2 records as pruned, and the audit must stay empty.
    expect(store.retentionStats().pruned).toBe(0);
    await expect(readFile(`${filePath}.retention-audit.jsonl`, 'utf8')).rejects.toThrow();
  });

  it('a refused write leaves the retention audit empty and the counter at zero', async () => {
    const filePath = seedStore([
      record('old-1', 'succeeded', '2026-01-01T00:00:00.000Z'),
      record('old-2', 'succeeded', '2026-01-02T00:00:00.000Z'),
    ]);
    const store = new JsonFileAgentHostStore(filePath, { maxRecords: 1 });
    await store.load();
    await store.close();
    await expect(store.put(record('new', 'succeeded', '2026-09-16T00:00:00.000Z'))).rejects.toThrow();
    expect(store.retentionStats()).toMatchObject({ pruned: 0, auditFailures: 0 });
    await expect(readFile(`${filePath}.retention-audit.jsonl`, 'utf8')).rejects.toThrow();
  });
});

describe('retention audit (which ids went, and why)', () => {
  function seedStore(records: LocalTaskRecord[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'chatagent-retention-audit-'));
    dirs.push(dir);
    const filePath = join(dir, 'tasks.json');
    writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf8');
    return filePath;
  }

  function auditLines(filePath: string): Array<Record<string, unknown>> {
    const raw = readFileSync(`${filePath}.retention-audit.jsonl`, 'utf8').trim();
    return raw === '' ? [] : raw.split('\n').map((line) => JSON.parse(line));
  }

  it('names every dropped task id, its state and the rule that dropped it', async () => {
    const filePath = seedStore([
      record('keep-queued', 'queued', '2020-01-01T00:00:00.000Z'),
      record('old-1', 'succeeded', '2026-01-01T00:00:00.000Z'),
      record('old-2', 'failed', '2026-01-02T00:00:00.000Z'),
    ]);
    const store = new JsonFileAgentHostStore(filePath, { maxRecords: 2 });
    await store.load();
    await store.put(record('fresh', 'succeeded', '2026-09-16T00:00:00.000Z'));
    await store.flush();
    await store.close();

    const lines = auditLines(filePath);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      action: 'task_store.pruned',
      actor: 'local-host',
      store: filePath,
      reason: 'count',
      count: 2,
    });
    expect(lines[0].tasks).toEqual([
      { taskId: 'old-1', state: 'succeeded', reason: 'count', updatedAt: '2026-01-01T00:00:00.000Z' },
      { taskId: 'old-2', state: 'failed', reason: 'count', updatedAt: '2026-01-02T00:00:00.000Z' },
    ]);
    // The live queued row is never in the audit: it was not dropped.
    expect(JSON.stringify(lines)).not.toContain('keep-queued');
    expect(store.retentionStats()).toMatchObject({
      pruned: 2,
      auditFailures: 0,
      auditPath: `${filePath}.retention-audit.jsonl`,
    });
  });

  it('distinguishes the age rule from the count cap in the same trail', async () => {
    const filePath = seedStore([
      record('ancient', 'succeeded', '2026-01-01T00:00:00.000Z'),
      record('live', 'queued', '2026-01-01T00:00:00.000Z'),
    ]);
    const store = new JsonFileAgentHostStore(filePath, {
      maxAgeMs: 60 * 60 * 1000,
      maxRecords: 10,
    });
    await store.load();
    await store.put(record('fresh', 'succeeded', new Date().toISOString()));
    await store.flush();
    await store.close();
    expect(auditLines(filePath)[0]).toMatchObject({
      reason: 'age',
      count: 1,
      tasks: [{ taskId: 'ancient', state: 'succeeded', reason: 'age' }],
    });
  });

  it('keeps the caller’s write working when the audit file cannot be written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chatagent-retention-audit-bad-'));
    dirs.push(dir);
    const filePath = join(dir, 'tasks.json');
    writeFileSync(
      filePath,
      JSON.stringify([record('old-1', 'succeeded', '2026-01-01T00:00:00.000Z')], null, 2),
      'utf8',
    );
    // A directory in the audit file's place: the append fails with EISDIR.
    const blocked = join(dir, 'blocked-audit');
    mkdirSync(blocked);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = new JsonFileAgentHostStore(filePath, {
      maxRecords: 1,
      retentionAudit: { path: blocked },
    });
    await store.load();
    await store.put(record('fresh', 'succeeded', '2026-09-16T00:00:00.000Z'));
    await store.flush();
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as LocalTaskRecord[];
    // Housekeeping evidence is best effort: the task write still happened, and the
    // refused append is counted (never silently swallowed).
    expect(onDisk.map((row) => row.taskId)).toEqual(['fresh']);
    expect(store.retentionStats()).toMatchObject({ pruned: 1, auditFailures: 1 });
    expect(store.retentionStats().lastAuditError).toContain('EISDIR');
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
    await store.close();
  });

  it('writes no audit at all when it is switched off', async () => {
    const filePath = seedStore([record('old-1', 'succeeded', '2026-01-01T00:00:00.000Z')]);
    const store = new JsonFileAgentHostStore(filePath, { maxRecords: 1, retentionAudit: false });
    await store.load();
    await store.put(record('fresh', 'succeeded', '2026-09-16T00:00:00.000Z'));
    await store.flush();
    expect(store.retentionStats()).toMatchObject({ pruned: 1 });
    expect(store.retentionStats().auditPath).toBeUndefined();
    await expect(readFile(`${filePath}.retention-audit.jsonl`, 'utf8')).rejects.toThrow();
    await store.close();
  });
});

describe('retention selection reasons', () => {
  it('reports reason, state and timestamp per dropped id, and the id list matches', () => {
    const now = () => Date.parse('2026-09-16T00:00:00.000Z');
    const records = [
      record('aged', 'succeeded', '2025-01-01T00:00:00.000Z'),
      record('recent-1', 'failed', '2026-09-10T00:00:00.000Z'),
      record('recent-2', 'succeeded', '2026-09-11T00:00:00.000Z'),
    ];
    // 30-day window: only `aged` is past it, so the cap (1) takes the older of the
    // two survivors — both rules appear, each on the record it actually removed.
    const options = { maxRecords: 1, maxAgeMs: 30 * 24 * 60 * 60 * 1000, now };
    expect(selectExpiredRecordsDetailed(records, options)).toEqual([
      { taskId: 'aged', state: 'succeeded', reason: 'age', updatedAt: '2025-01-01T00:00:00.000Z' },
      {
        taskId: 'recent-1',
        state: 'failed',
        reason: 'count',
        updatedAt: '2026-09-10T00:00:00.000Z',
      },
    ]);
    expect(selectExpiredRecords(records, options)).toEqual(['aged', 'recent-1']);
  });

  it('never attributes a reason to work that is still live', () => {
    const records = [
      record('q', 'queued', '2020-01-01T00:00:00.000Z'),
      record('i', 'interrupted', '2020-01-01T00:00:00.000Z'),
    ];
    expect(
      selectExpiredRecordsDetailed(records, { maxRecords: 0, maxAgeMs: 1, now: () => Date.now() }),
    ).toEqual([]);
  });
});
