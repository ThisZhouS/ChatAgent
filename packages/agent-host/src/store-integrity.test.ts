import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHermesAdapter } from './adapter';
import { LocalAgentHost } from './host';
import { JsonFileAgentHostStore } from './store';
import type { LocalTaskRecord } from './types';

/**
 * Gate 7A follow-up: the task store is a file that outlives binary upgrades, so
 * what it loads must be validated instead of trusted. These tests cover the
 * migration rules (repair), the quarantine rules (keep but never run) and the
 * corrupt-file path (keep the evidence, do not brick the app).
 */

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-host-integrity-'));
  roots.push(root);
  return root;
}

function row(patch: Partial<LocalTaskRecord> = {}): LocalTaskRecord {
  const now = '2026-09-16T10:00:00.000Z';
  return {
    taskId: 'task-1',
    deviceId: 'desktop-test',
    agentId: 'hermes',
    goal: '生成周报',
    kind: 'document',
    state: 'queued',
    version: 1,
    workDir: 'C:/work',
    toolsets: ['document'],
    artifacts: [],
    attempts: 0,
    maxAttempts: 2,
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}

async function writeStore(root: string, rows: unknown[]): Promise<string> {
  const file = join(root, 'tasks.json');
  await writeFile(file, JSON.stringify(rows), 'utf8');
  return file;
}

describe('task store integrity on load', () => {
  it('repairs missing optional fields and reports every repair', async () => {
    const root = await tempRoot();
    const file = await writeStore(root, [
      {
        taskId: 'task-legacy',
        kind: 'document',
        state: 'queued',
        workDir: 'C:/work',
        goal: '旧记录',
      },
    ]);
    const store = new JsonFileAgentHostStore(file);
    await store.load();
    const record = await store.get('task-legacy');
    expect(record?.version).toBe(1);
    expect(record?.toolsets).toEqual(['document']);
    expect(record?.artifacts).toEqual([]);
    expect(record?.maxAttempts).toBe(2);
    expect(record?.attempts).toBe(0);
    expect(Number.isNaN(Date.parse(record?.createdAt ?? ''))).toBe(false);
    // Absent optional fields are filled with safe defaults without being counted
    // as a repair; wrong *values* are repaired and reported.
    expect(record?.deviceId).toBe('');
    expect(record?.agentId).toBe('');
    const report = store.getLoadReport();
    expect(report?.rows).toBe(1);
    expect(report?.repaired[0]?.repairs).toEqual(
      expect.arrayContaining(['version', 'attempts', 'maxAttempts', 'toolsets', 'createdAt', 'updatedAt']),
    );
    expect(report?.quarantined).toEqual([]);
    await store.close();
  });

  it('quarantines a row with an unknown kind or state instead of running it', async () => {
    const root = await tempRoot();
    const file = await writeStore(root, [
      row({ taskId: 'task-kind', kind: 'shell' as never }),
      row({ taskId: 'task-state', state: 'exploded' as never }),
      row({ taskId: 'task-nodir', workDir: '' }),
    ]);
    const store = new JsonFileAgentHostStore(file);
    await store.load();
    for (const taskId of ['task-kind', 'task-state', 'task-nodir']) {
      const record = await store.get(taskId);
      expect(record?.state, taskId).toBe('failed');
      expect(record?.blockedReason, taskId).toBe('invalid_persisted_row');
    }
    expect(store.getLoadReport()?.quarantined).toHaveLength(3);
    await store.close();
  });

  it('never dispatches a quarantined row, even when it looks queued', async () => {
    const root = await tempRoot();
    const file = await writeStore(root, [row({ taskId: 'task-badkind', kind: 'terminal' as never, state: 'queued' })]);
    const calls: string[] = [];
    const adapter = {
      kind: 'fake' as const,
      async run(request: { taskId: string }) {
        calls.push(request.taskId);
        return new FakeHermesAdapter({ durationMs: 5 }).run(request as never);
      },
    };
    const host = new LocalAgentHost({
      deviceId: 'desktop-test',
      agentId: 'hermes',
      workRoot: root,
      store: new JsonFileAgentHostStore(file),
      adapter,
    });
    await host.start();
    await host.tick();
    const record = await host.get('task-badkind');
    expect(calls).toEqual([]);
    expect(record?.state).toBe('failed');
    expect((await host.status()).storeIntegrity?.quarantined).toBe(1);
    await host.close();
  });

  it('keeps the newest row when one taskId appears twice and reports the drop', async () => {
    const root = await tempRoot();
    const file = await writeStore(root, [
      row({ taskId: 'dup', version: 1, goal: '旧' }),
      row({ taskId: 'dup', version: 7, goal: '新' }),
    ]);
    const store = new JsonFileAgentHostStore(file);
    await store.load();
    expect((await store.get('dup'))?.goal).toBe('新');
    expect(store.getLoadReport()?.duplicates).toEqual([{ taskId: 'dup', droppedVersion: 1, keptVersion: 7 }]);
    await store.close();
  });

  it('drops unknown extra fields instead of carrying them into memory', async () => {
    const root = await tempRoot();
    const file = await writeStore(root, [
      { ...row({ taskId: 'task-extra' }), __proto__polluted: true, approval: 'not-an-object', toolsets: ['document', 'document'] },
    ]);
    const store = new JsonFileAgentHostStore(file);
    await store.load();
    const record = (await store.get('task-extra')) as unknown as Record<string, unknown>;
    expect(record.__proto__polluted).toBeUndefined();
    expect(record.approval).toBeUndefined();
    expect(record.toolsets).toEqual(['document']);
    expect(store.getLoadReport()?.repaired[0]?.repairs).toEqual(expect.arrayContaining(['approval', 'toolsets']));
    await store.close();
  });

  it('moves a corrupt store file aside, starts empty, and reports the path', async () => {
    const root = await tempRoot();
    const file = join(root, 'tasks.json');
    await writeFile(file, '{"not":"an array"', 'utf8');
    const store = new JsonFileAgentHostStore(file);
    await store.load();
    expect(await store.list()).toEqual([]);
    const report = store.getLoadReport();
    expect(report?.corruptFile).toMatch(/tasks\.json\.corrupt-\d+$/);
    // The evidence is still on disk, and the live path is free for new work.
    const quarantined = await readFile(report?.corruptFile as string, 'utf8');
    expect(quarantined).toContain('not');
    await store.close();
  });

  it('treats a non-array store file as corrupt instead of iterating it', async () => {
    const root = await tempRoot();
    const file = await writeStore(root, []);
    await writeFile(file, JSON.stringify({ tasks: [] }), 'utf8');
    const store = new JsonFileAgentHostStore(file);
    await store.load();
    expect(await store.list()).toEqual([]);
    expect(store.getLoadReport()?.corruptFile).toBeTruthy();
    const leftovers = await readdir(root);
    expect(leftovers.some((name) => name.includes('.corrupt-'))).toBe(true);
    await store.close();
  });

  it('reports an empty first run as a clean load (no repairs, no quarantine)', async () => {
    const root = await tempRoot();
    const store = new JsonFileAgentHostStore(join(root, 'tasks.json'));
    await store.load();
    const report = store.getLoadReport();
    expect(report?.rows).toBe(0);
    expect(report?.repaired).toEqual([]);
    expect(report?.quarantined).toEqual([]);
    expect(report?.corruptFile).toBeUndefined();
    await store.close();
  });

  it('leaves the original file untouched until the first accepted write', async () => {
    const root = await tempRoot();
    const file = await writeStore(root, [{ taskId: 'task-raw', kind: 'document', state: 'queued', workDir: 'C:/work' }]);
    const original = await readFile(file, 'utf8');
    const store = new JsonFileAgentHostStore(file);
    await store.load();
    // Reading (which repairs in memory) must not rewrite: the raw evidence stays.
    expect(await readFile(file, 'utf8')).toBe(original);
    await store.put(row({ taskId: 'task-new' }));
    const afterWrite = JSON.parse(await readFile(file, 'utf8')) as LocalTaskRecord[];
    expect(afterWrite.map((r) => r.taskId).sort()).toEqual(['task-new', 'task-raw']);
    await store.close();
  });
});
