import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The tree-kill *mechanism* is exercised with real processes in
// process-tree.test.ts; here we pin the call site: an aborted or timed-out run
// must go through that helper (a regression here would leak executor children).
vi.mock('./process-tree', () => ({ terminateProcessTree: vi.fn(() => 'tree') }));

import { HermesProcessAdapter } from './adapter';
import { terminateProcessTree } from './process-tree';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('executor cancellation goes through the tree kill', () => {
  it('calls terminateProcessTree when the run is aborted', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'chatagent-kill-'));
    roots.push(workDir);
    const controller = new AbortController();
    const adapter = new HermesProcessAdapter({
      executable: join(workDir, 'no-such-hermes.exe'),
    });
    const running = adapter.run({
      taskId: 'kill-1',
      runId: 'run-kill-1',
      goal: 'x',
      workDir,
      toolsets: ['document'],
      timeoutMs: 5000,
      signal: controller.signal,
    });
    controller.abort();
    const result = await running;
    expect(terminateProcessTree).toHaveBeenCalledTimes(1);
    expect(result.failure?.kind).toBe('cancelled');
  });

});
