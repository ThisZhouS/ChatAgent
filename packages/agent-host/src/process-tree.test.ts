import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { terminateProcessTree, type KillableChild } from './process-tree';

const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      if (child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // already gone
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** True while the OS still knows the pid (Windows included). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid: number, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}

const sleepForever = 'setInterval(() => {}, 1000);';

/**
 * Starts a real two-level tree: a direct child that itself spawns a grandchild
 * and reports its pid. This is the shape the adapter must be able to reclaim.
 */
function startTree(): { child: ChildProcess; grandchildPid: () => number | undefined } {
  const dir = mkdtempSync(join(tmpdir(), 'chatagent-tree-'));
  dirs.push(dir);
  const pidFile = join(dir, 'grandchild.pid');
  const script = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });",
    `writeFileSync(${JSON.stringify(pidFile)}, String(grand.pid));`,
    sleepForever,
  ].join('\n');
  const child = spawn(process.execPath, ['-e', script], {
    stdio: 'ignore',
    windowsHide: true,
  });
  children.push(child);
  return {
    child,
    grandchildPid: () => {
      try {
        const pid = Number(readFileSync(pidFile, 'utf8').trim());
        return Number.isFinite(pid) && pid > 0 ? pid : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

async function waitForGrandchildPid(get: () => number | undefined, timeoutMs = 8000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = get();
    if (pid !== undefined) return pid;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the grandchild never reported its pid');
}

describe('terminateProcessTree (real processes)', () => {
  it('kills the whole tree: the executor child and what it spawned', async () => {
    const { child, grandchildPid } = startTree();
    const grandPid = await waitForGrandchildPid(grandchildPid);
    expect(isAlive(child.pid!)).toBe(true);
    expect(isAlive(grandPid)).toBe(true);

    const how = terminateProcessTree(child);
    expect(how).toBe(process.platform === 'win32' ? 'tree' : 'signal');
    expect(await waitDead(child.pid!)).toBe(true);
    expect(await waitDead(grandPid)).toBe(true);
  });

  it('never touches unrelated processes on the machine', async () => {
    const bystander = spawn(process.execPath, ['-e', sleepForever], { stdio: 'ignore', windowsHide: true });
    children.push(bystander);
    const { child, grandchildPid } = startTree();
    const grandPid = await waitForGrandchildPid(grandchildPid);

    terminateProcessTree(child);
    expect(await waitDead(child.pid!)).toBe(true);
    expect(await waitDead(grandPid)).toBe(true);
    expect(isAlive(bystander.pid!)).toBe(true);
  });

  it('falls back to a signal when the child has no pid yet', () => {
    const signals: Array<string | number | undefined> = [];
    const fake: KillableChild = {
      pid: undefined,
      kill(signal) {
        signals.push(signal);
        return true;
      },
    };
    expect(terminateProcessTree(fake)).toBe('signal');
    expect(signals).toEqual(['SIGKILL']);
  });

  it('falls back to a signal when taskkill cannot be started', () => {
    const signals: Array<string | number | undefined> = [];
    const fake: KillableChild = {
      pid: 4321,
      kill(signal) {
        signals.push(signal);
        return true;
      },
    };
    const how = terminateProcessTree(fake, {
      platform: 'win32',
      spawnTaskkill: () => {
        throw new Error('taskkill is missing');
      },
    });
    expect(how).toBe('signal');
    expect(signals).toEqual(['SIGKILL']);
  });

  it('uses taskkill with /T /F for the pid it was given (windows)', () => {
    const asked: number[] = [];
    const fake: KillableChild = { pid: 987, kill: () => true };
    const how = terminateProcessTree(fake, { platform: 'win32', spawnTaskkill: (pid) => asked.push(pid) });
    expect(how).toBe('tree');
    expect(asked).toEqual([987]);
  });
});
