/**
 * Process-tree termination for executor children (Gate 7A follow-up).
 *
 * Hermes spawns helper processes (python, browsers, shells). Killing only the
 * direct child leaves orphans behind after a cancel, a timeout or an app quit,
 * so the whole tree rooted at the pid we spawned is terminated. `taskkill /T`
 * is scoped to that pid: unrelated Python/Hermes processes on the machine are
 * never touched. Every other platform falls back to a signal to the child.
 *
 * This lives in its own module so the *real* mechanism can be exercised with
 * real processes instead of being copied into a test.
 */
import { spawn } from 'node:child_process';

/** The subset of ChildProcess this needs; keeps the helper easy to fake. */
export interface KillableChild {
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface KillTreeOptions {
  /** Injected for tests and for callers that need a different OS strategy. */
  platform?: NodeJS.Platform;
  /** Injected taskkill runner; defaults to spawning the real `taskkill`. */
  spawnTaskkill?: (pid: number) => void;
}

/**
 * Terminates `child` and everything it spawned. Returns how the kill was
 * issued so callers (and tests) can tell a forceful tree kill from a fallback.
 */
export function terminateProcessTree(child: KillableChild, options: KillTreeOptions = {}): 'tree' | 'signal' {
  const platform = options.platform ?? process.platform;
  const pid = child.pid;
  if (pid === undefined || pid === null) {
    child.kill('SIGKILL');
    return 'signal';
  }
  if (platform !== 'win32') {
    child.kill('SIGKILL');
    return 'signal';
  }
  const runTaskkill =
    options.spawnTaskkill ??
    ((target: number) => {
      spawn('taskkill', ['/pid', String(target), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      }).on('error', () => child.kill('SIGKILL'));
    });
  try {
    runTaskkill(pid);
    return 'tree';
  } catch {
    child.kill('SIGKILL');
    return 'signal';
  }
}
