import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MAX_RECORDS, selectExpiredRecords } from './retention';
import { JsonFileAgentHostStore } from './store';
import type { LocalTaskRecord } from './types';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
  });
});
