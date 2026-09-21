import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeHermesAdapter,
  FORBIDDEN_TOOLSETS,
  HermesProcessAdapter,
  HERMES_TOOLSETS,
  resolveHermesToolsets,
} from './adapter';
import { LocalAgentHost } from './host';
import { MemoryAgentHostStore } from './store';

/**
 * Structural tests for the executor port.
 *
 * The real-runtime block only runs when a Hermes executable is available (env
 * `CHATAGENT_HERMES_EXE` or the bundled runtime extracted under `Temp/`). Without
 * a configured model provider the run is expected to fail *cleanly*: exit code 1,
 * a machine-readable `no_provider` failure and no artifact. That is a real
 * integration signal (the process contract, the work directory, the captured
 * streams and the exit code), and it must never be reported as a passing model
 * run.
 */

const candidates = [
  process.env.CHATAGENT_HERMES_EXE,
  join(process.cwd(), 'Temp', 'hermes-runtime', 'hermes-agent-cn-runtime-win32-x64.exe'),
].filter((value): value is string => typeof value === 'string' && value !== '');

const hermesExe = candidates.find((candidate) => existsSync(candidate));

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('fake executor contract', () => {
  it('writes one artifact inside the work directory and reports itself as fake', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'chatagent-fake-'));
    roots.push(workDir);
    const adapter = new FakeHermesAdapter({ durationMs: 5, artifactName: 'out.md' });
    const result = await adapter.run({
      taskId: 't1',
      runId: 'r1',
      goal: '写一份清单',
      workDir,
      toolsets: ['document'],
      timeoutMs: 1000,
    });
    expect(result.executor).toBe('fake');
    expect(result.exitCode).toBe(0);
    expect(result.failure).toBeUndefined();
    expect(result.artifacts.map((artifact) => artifact.name)).toContain('out.md');
  });

  it('honours cancellation through the abort signal', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'chatagent-fake-'));
    roots.push(workDir);
    const controller = new AbortController();
    controller.abort();
    const result = await new FakeHermesAdapter().run({
      taskId: 't2',
      runId: 'r2',
      goal: 'x',
      workDir,
      toolsets: ['document'],
      timeoutMs: 1000,
      signal: controller.signal,
    });
    expect(result.failure?.kind).toBe('cancelled');
    expect(result.artifacts).toEqual([]);
  });
});

describe('hermes process adapter arguments', () => {
  it('never enables approval bypass flags and always scopes the toolset', () => {
    const adapter = new HermesProcessAdapter({ executable: 'hermes.exe' });
    const args = adapter.buildArgs({
      taskId: 't3',
      runId: 'r3',
      goal: 'hello',
      workDir: '/tmp',
      toolsets: ['document', 'web'],
      timeoutMs: 1000,
    });
    expect(args).toContain('-z');
    expect(args).toContain('--ignore-user-config');
    // `document` maps to the file toolset; `web` stays web. Shell-like toolsets
    // are never added implicitly.
    expect(args.join(' ')).toContain('-t file,web');
    expect(args).not.toContain('--yolo');
    expect(args).not.toContain('--accept-hooks');
  });

  it('maps product capabilities and refuses shell-like toolsets', () => {
    expect(resolveHermesToolsets(['document']).toolsets).toEqual(['file']);
    expect(resolveHermesToolsets([]).toolsets).toEqual(['file']);
    const refused = resolveHermesToolsets(['document', 'terminal', 'computer_use']);
    expect(refused.toolsets).toEqual(['file']);
    expect(refused.invalid).toEqual(['terminal', 'computer_use']);
    // Every mapped target must be a real Hermes toolset name.
    expect((HERMES_TOOLSETS as readonly string[]).includes('file')).toBe(true);
    // The forbidden list is a Set now (one shared source), so membership is the check.
    expect([...FORBIDDEN_TOOLSETS]).toContain('terminal');
  });

  it('fails closed when a forbidden toolset is requested', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'chatagent-toolset-'));
    roots.push(workDir);
    const adapter = new HermesProcessAdapter({ executable: 'does-not-exist.exe' });
    const result = await adapter.run({
      taskId: 't4',
      runId: 'r4',
      goal: 'x',
      workDir,
      toolsets: ['terminal'],
      timeoutMs: 1000,
    });
    expect(result.failure?.kind).toBe('invalid_toolset');
    // The refusal says which entry was refused and why, instead of a generic message.
    expect(result.failure?.message).toContain('switched off: terminal');
    expect(result.artifacts).toEqual([]);
  });

  it('tells the model which capabilities are switched off for the run', async () => {
    const adapter = new HermesProcessAdapter({ executable: 'does-not-exist.exe' });
    const args = adapter.buildArgs({
      taskId: 't5',
      runId: 'r5',
      goal: '整理周报',
      workDir: 'C:/tmp',
      toolsets: ['document'],
      timeoutMs: 1000,
    });
    const goal = args[args.indexOf('-z') + 1] ?? '';
    // The boundary is injected with the run, and it is generated from the same list the
    // host checks - so a switched-off capability can never still be advertised.
    expect(goal).toContain('整理周报');
    expect(goal).toContain('Run boundaries');
    expect(goal).toContain('Switched off and not negotiable');
    expect(goal).toContain('browser');
    expect(goal).toContain('never emulate it');
    expect(goal).toContain('Available toolsets for this run: file');
  });
});

describe.skipIf(hermesExe === undefined)('real Hermes runtime (process contract only)', () => {
  it('starts the pinned runtime, scopes the run and reports the missing provider honestly', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'chatagent-hermes-'));
    roots.push(workDir);
    const adapter = new HermesProcessAdapter({
      executable: hermesExe as string,
      env: { HERMES_INFERENCE_MODEL: '' },
    });
    const result = await adapter.run({
      taskId: 'real_1',
      runId: 'real_run_1',
      goal: 'reply with OK',
      workDir,
      toolsets: ['document'],
      timeoutMs: 60_000,
    });

    // The process contract is what we can assert without credentials.
    expect(result.executor).toBe('hermes');
    expect(typeof result.exitCode).toBe('number');
    expect(result.durationMs).toBeGreaterThan(0);
    if (result.exitCode === 0) {
      // Only reachable when the machine already has a provider configured; the
      // answer must then be real text and no fake artifacts may appear.
      expect(result.failure).toBeUndefined();
      expect(result.output.length).toBeGreaterThan(0);
    } else {
      expect(result.failure?.kind).toBe('no_provider');
      expect(result.artifacts).toEqual([]);
    }

    // The mapped toolset must be a name the runtime actually accepts; an unknown
    // name makes Hermes exit 2 ("ignoring unknown --toolsets entries").
    const { execFileSync } = await import('node:child_process');
    const toolList = execFileSync(hermesExe as string, ['tools', 'list'], { encoding: 'utf8' });
    expect(toolList).toContain('file');
    expect(toolList).not.toMatch(/ignoring unknown/i);

    // A real run through the host must be labelled `hermes`, never `fake`.
    const host = new LocalAgentHost({
      deviceId: 'device_real',
      agentId: 'agent_real',
      workRoot: workDir,
      store: new MemoryAgentHostStore(),
      adapter,
      defaultTimeoutMs: 60_000,
    });
    await host.start();
    const submitted = await host.submit({
      taskId: 'real_host_1',
      agentId: 'agent_real',
      goal: 'reply with OK',
      kind: 'document',
      workDir,
      toolsets: ['document'],
    });
    const deadline = Date.now() + 90_000;
    let record = await host.get(submitted.taskId);
    while (record !== undefined && record.state !== 'failed' && record.state !== 'succeeded' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      record = await host.get(submitted.taskId);
    }
    expect(record?.executor).toBe('hermes');
    expect(record?.state).toBe(result.exitCode === 0 ? 'succeeded' : 'failed');
    await host.stop();
  }, 120_000);
});
