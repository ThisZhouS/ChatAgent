import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectStoreLock, parseLockPayload, takeOverStoreLock } from './lock-takeover';
import { JsonFileAgentHostStore } from './store';

const dirs: string[] = [];
const children: ChildProcess[] = [];

async function tempStorePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'chatagent-lock-'));
  dirs.push(dir);
  return join(dir, 'tasks.json');
}

async function writeLock(filePath: string, payload: unknown, raw?: string): Promise<void> {
  await writeFile(`${filePath}.lock`, raw ?? JSON.stringify(payload), 'utf8');
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    try {
      if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // already gone
    }
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('store lock inspection', () => {
  it('reports no lock when the file is absent', async () => {
    const filePath = await tempStorePath();
    const info = await inspectStoreLock(filePath);
    expect(info.exists).toBe(false);
    expect(info.ambiguous).toBe(false);
  });

  it('treats a dead holder as a leftover, not an ambiguity', async () => {
    const filePath = await tempStorePath();
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
    await new Promise((resolve) => dead.on('exit', resolve));
    await writeLock(filePath, { pid: dead.pid, startedAt: new Date().toISOString() });
    const info = await inspectStoreLock(filePath);
    expect(info.exists).toBe(true);
    expect(info.holderAlive).toBe(false);
    expect(info.ambiguous).toBe(false);
  });

  it('flags a live holder as ambiguous (the pid may be reused)', async () => {
    const filePath = await tempStorePath();
    const alive = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    children.push(alive);
    await writeLock(filePath, { pid: alive.pid, startedAt: new Date().toISOString() });
    const info = await inspectStoreLock(filePath);
    expect(info.holderAlive).toBe(true);
    expect(info.ambiguous).toBe(true);
    expect(info.reason).toMatch(/alive/);
  });

  it('flags an unparseable lock that names no pid as ambiguous', async () => {
    const filePath = await tempStorePath();
    await writeLock(filePath, {}, '{"startedAt":"2026-09-16T00:00:00.000Z"');
    const info = await inspectStoreLock(filePath);
    expect(info.ambiguous).toBe(true);
    expect(info.holderPid).toBeUndefined();
  });

  it('salvages the pid from a truncated payload', () => {
    expect(parseLockPayload('{"pid": 4321, "startedAt').pid).toBe(4321);
    expect(parseLockPayload('not json at all')).toEqual({});
  });
});

describe('consented lock takeover', () => {
  it('does nothing when there is no lock', async () => {
    const filePath = await tempStorePath();
    const result = await takeOverStoreLock(filePath, { actor: 'local-user-consent', reason: 'test' });
    expect(result.takenOver).toBe(false);
  });

  it('never takes over its own lock, whatever the consent says', async () => {
    const filePath = await tempStorePath();
    await writeLock(filePath, { pid: process.pid, startedAt: new Date().toISOString() });
    const result = await takeOverStoreLock(filePath, { actor: 'local-user-consent', reason: 'oops' });
    expect(result.takenOver).toBe(false);
    expect(result.reason).toMatch(/this process/);
    // the lock is still there: mutual exclusion was not dropped
    await expect(readFile(`${filePath}.lock`, 'utf8')).resolves.toContain(String(process.pid));
  });

  it('moves the old lock aside and records who consented and why', async () => {
    const filePath = await tempStorePath();
    const previous = { pid: 4242, startedAt: '2026-09-15T10:00:00.000Z' };
    await writeLock(filePath, previous);
    const result = await takeOverStoreLock(filePath, {
      actor: 'local-user-consent',
      reason: '上一次运行异常结束，界面提示残留锁，用户点击“接管”',
    });
    expect(result.takenOver).toBe(true);
    expect(result.replacedPath).toBeTruthy();

    // Evidence is renamed, never deleted.
    await expect(readFile(result.replacedPath!, 'utf8')).resolves.toBe(JSON.stringify(previous));
    await expect(readFile(`${filePath}.lock`, 'utf8')).rejects.toThrow();

    const audit = (await readFile(result.auditPath, 'utf8')).trim().split('\n');
    expect(audit).toHaveLength(1);
    const entry = JSON.parse(audit[0]) as Record<string, unknown>;
    expect(entry.actor).toBe('local-user-consent');
    expect(entry.action).toBe('store_lock.takeover');
    expect(entry.previousHolder).toEqual({ pid: 4242, startedAt: previous.startedAt });
    expect(String(entry.reason)).toContain('接管');
  });

  it('appends one audit line per takeover', async () => {
    const filePath = await tempStorePath();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await writeLock(filePath, { pid: 5000 + attempt, startedAt: new Date().toISOString() });
      const result = await takeOverStoreLock(filePath, { actor: 'local-user-consent', reason: `第 ${attempt} 次` });
      expect(result.takenOver).toBe(true);
    }
    const audit = (await readFile(`${filePath}.lock-audit.jsonl`, 'utf8')).trim().split('\n');
    expect(audit).toHaveLength(2);
  });

  it('a lock held by a live process still blocks the store, until consent', async () => {
    const filePath = await tempStorePath();
    const alive = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    children.push(alive);
    await writeLock(filePath, { pid: alive.pid, startedAt: new Date().toISOString() });

    // Ambiguous lock: the store refuses to become a second writer.
    const blocked = new JsonFileAgentHostStore(filePath);
    await expect(blocked.load()).rejects.toThrow(/locked/);

    const takeover = await takeOverStoreLock(filePath, {
      actor: 'local-user-consent',
      reason: '疑似 pid 复用：界面确认后接管',
    });
    expect(takeover.takenOver).toBe(true);
    const store = new JsonFileAgentHostStore(filePath);
    await store.load();
    await store.close();
    const leftovers = (await readdir(join(filePath, '..'))).filter((name) => name.includes('.replaced-'));
    expect(leftovers.length).toBe(1);

    // The disputed lock was moved aside; the unrelated process keeps running.
    let stillAlive = true;
    try {
      process.kill(alive.pid!, 0);
    } catch {
      stillAlive = false;
    }
    expect(stillAlive).toBe(true);
  });

  it('heals a dead holder by itself, without an audit entry (not a consent event)', async () => {
    const filePath = await tempStorePath();
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
    await new Promise((resolve) => dead.on('exit', resolve));
    await writeLock(filePath, { pid: dead.pid, startedAt: new Date().toISOString() });

    const store = new JsonFileAgentHostStore(filePath);
    await store.load(); // unambiguous leftover: no human needed
    await store.close();
    const files = await readdir(join(filePath, '..'));
    expect(files.some((name) => name.endsWith('.lock-audit.jsonl'))).toBe(false);
  });
});
