import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { collectArtifacts, writeFileIfUnchanged } from './sandbox';
import { terminateProcessTree } from './process-tree';
import type { ExecutorRequest, ExecutorResult, HermesAdapterConfig } from './types';

/**
 * Executor port. The host only ever talks to this interface, so the real Hermes
 * runtime and the deterministic fake are interchangeable — and the result always
 * states which one ran.
 */
export interface HermesAdapter {
  readonly kind: 'hermes' | 'fake';
  run(request: ExecutorRequest): Promise<ExecutorResult>;
}

/**
 * Hermes toolset names, as reported by `hermes tools list` (runtime 0.17.0-cn.1).
 * The runtime enables terminal, code execution, browser automation and computer
 * use by default; the host therefore never relies on those defaults.
 */
export const HERMES_TOOLSETS = [
  'web',
  'browser',
  'terminal',
  'file',
  'code_execution',
  'vision',
  'video',
  'image_gen',
  'video_gen',
  'x_search',
  'moa',
  'tts',
  'skills',
  'todo',
  'memory',
  'context_engine',
  'session_search',
  'clarify',
  'delegation',
  'cronjob',
  'homeassistant',
  'spotify',
  'yuanbao',
  'computer_use',
] as const;

/** Capabilities that must never be granted implicitly to an on-device agent. */
export const FORBIDDEN_TOOLSETS = [
  'terminal',
  'code_execution',
  'browser',
  'computer_use',
  'cronjob',
  'delegation',
  'homeassistant',
  'spotify',
] as const;

/**
 * Product vocabulary → Hermes toolsets. Only explicitly mapped capabilities are
 * granted; anything unknown falls back to read/write file access inside the task
 * directory, which is the minimum a document task needs.
 */
export const CHATAGENT_TOOLSET_MAP: Record<string, readonly string[]> = {
  document: ['file'],
  'document.read': ['file'],
  messages: ['file'],
  'messages.send': ['file'],
  web: ['web'],
};

/** Resolves ChatAgent capability names into a validated Hermes toolset list. */
export function resolveHermesToolsets(requested: string[]): { toolsets: string[]; invalid: string[] } {
  const resolved = new Set<string>();
  const invalid: string[] = [];
  for (const name of requested) {
    const mapped = CHATAGENT_TOOLSET_MAP[name];
    if (mapped === undefined) {
      if ((HERMES_TOOLSETS as readonly string[]).includes(name)) {
        if ((FORBIDDEN_TOOLSETS as readonly string[]).includes(name)) invalid.push(name);
        else resolved.add(name);
      } else {
        invalid.push(name);
      }
      continue;
    }
    for (const toolset of mapped) resolved.add(toolset);
  }
  if (resolved.size === 0) resolved.add('file');
  return { toolsets: [...resolved], invalid };
}

/** Lines that are safe to keep as an audit trail (never model reasoning). */
function auditLines(text: string, limit = 40): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .slice(0, limit)
    .map((line) => line.slice(0, 200));
}

function classifyFailure(stderr: string, stdout: string): ExecutorResult['failure'] | undefined {
  const combined = `${stderr}\n${stdout}`;
  if (/No inference provider configured/i.test(combined)) {
    return { kind: 'no_provider', message: 'no inference provider is configured for Hermes' };
  }
  if (/command not found|not recognized|cannot find the file|ENOENT/i.test(combined)) {
    return { kind: 'not_found', message: 'the Hermes executable could not be started' };
  }
  if (/Traceback|Fatal|panic:/i.test(combined)) {
    return { kind: 'executor_error', message: 'the executor reported an internal error' };
  }
  return undefined;
}

/**
 * Real upstream Hermes adapter.
 *
 * Runs the pinned runtime in one-shot mode (`--cli -z`) with an explicit toolset
 * allow-list, the task directory as CWD and a hard timeout. Deliberate choices:
 *
 * - never `--yolo` and never `--accept-hooks`: approval bypass flags exist in the
 *   CLI, but ChatAgent policy must not be delegated to the executor;
 * - `--ignore-user-config` keeps a developer machine's personal Hermes profile
 *   out of product runs;
 * - stdout is the final answer only, so artifacts are collected from the work
 *   directory instead of trusting the executor's claims.
 */
export class HermesProcessAdapter implements HermesAdapter {
  readonly kind = 'hermes' as const;

  constructor(private readonly config: HermesAdapterConfig) {}

  buildArgs(request: ExecutorRequest): string[] {
    const args = ['--cli', '-z', request.goal, '--ignore-user-config'];
    const { toolsets } = resolveHermesToolsets(request.toolsets);
    args.push('-t', toolsets.join(','));
    if (this.config.model) args.push('-m', this.config.model);
    if (this.config.provider) args.push('--provider', this.config.provider);
    return args;
  }

  async run(request: ExecutorRequest): Promise<ExecutorResult> {
    const startedAt = Date.now();
    const resolved = resolveHermesToolsets(request.toolsets);
    if (resolved.invalid.length > 0) {
      // Fail closed: an unknown or forbidden capability never silently degrades
      // into "run with whatever Hermes has enabled by default".
      return {
        executor: 'hermes',
        exitCode: null,
        output: '',
        artifacts: [],
        audit: [`refused toolsets: ${resolved.invalid.join(', ')}`],
        durationMs: Date.now() - startedAt,
        failure: {
          kind: 'invalid_toolset',
          message: `unsupported or forbidden toolset(s): ${resolved.invalid.join(', ')}`,
        },
      };
    }
    const args = this.buildArgs(request);
    const maxBytes = this.config.maxOutputBytes ?? 256 * 1024;

    return new Promise<ExecutorResult>((resolve) => {
      const child = spawn(this.config.executable, args, {
        cwd: request.workDir,
        env: { ...process.env, ...(this.config.env ?? {}) },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let cancelled = false;

      /**
       * Terminates the executor *and its children*. Hermes spawns helper
       * processes (python, browsers, shells); killing only the direct child would
       * leave orphans behind after a cancel or an app quit. `taskkill /T` is
       * scoped to the pid we spawned, so unrelated Python/Hermes processes on the
       * machine are never touched.
       */
      const killTree = (): void => {
        terminateProcessTree(child);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, request.timeoutMs);

      const onAbort = (): void => {
        cancelled = true;
        killTree();
      };
      request.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < maxBytes) stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < maxBytes) stderr += chunk.toString('utf8');
      });

      const finish = async (exitCode: number | null, spawnError?: Error): Promise<void> => {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
        const artifacts = await collectArtifacts(request.workDir);
        const failure: ExecutorResult['failure'] | undefined = cancelled
          ? { kind: 'cancelled', message: 'the run was cancelled' }
          : timedOut
            ? { kind: 'timeout', message: `the run exceeded ${request.timeoutMs}ms` }
            : spawnError
              ? { kind: 'not_found', message: spawnError.message }
              : exitCode === 0
                ? undefined
                : (classifyFailure(stderr, stdout) ?? {
                    kind: 'executor_error',
                    message: `the executor exited with code ${String(exitCode)}`,
                  });
        resolve({
          executor: 'hermes',
          exitCode,
          output: stdout.trim().slice(0, 4000),
          artifacts,
          audit: auditLines(`${stdout}\n${stderr}`).slice(0, 20),
          durationMs: Date.now() - startedAt,
          failure,
        });
      };

      child.on('error', (error) => {
        void finish(null, error);
      });
      child.on('close', (code) => {
        void finish(code);
      });
    });
  }
}

export interface FakeHermesOptions {
  /** Milliseconds the fake run takes; keeps the parallel-use test realistic. */
  durationMs?: number;
  /** Force a failure class (timeout/cancel are produced through the same path). */
  failWith?: 'executor_error' | 'no_provider' | 'timeout';
  /** File written into the task directory as the artifact. */
  artifactName?: string;
}

/**
 * Deterministic offline executor.
 *
 * It exists so the host, the IPC surface and the parallel-use flows can be tested
 * and demonstrated without a model provider. Every record it produces is marked
 * `executor: 'fake'`, and the host reports why the real runtime was not used, so
 * a fake run can never be mistaken for a real Hermes run.
 */
export class FakeHermesAdapter implements HermesAdapter {
  readonly kind = 'fake' as const;

  constructor(private readonly options: FakeHermesOptions = {}) {}

  async run(request: ExecutorRequest): Promise<ExecutorResult> {
    const startedAt = Date.now();
    const duration = this.options.durationMs ?? 30;
    await new Promise((resolve) => setTimeout(resolve, duration));

    if (request.signal?.aborted) {
      return {
        executor: 'fake',
        exitCode: null,
        output: '',
        artifacts: [],
        audit: ['fake executor cancelled'],
        durationMs: Date.now() - startedAt,
        failure: { kind: 'cancelled', message: 'the run was cancelled' },
      };
    }
    if (this.options.failWith) {
      return {
        executor: 'fake',
        exitCode: 1,
        output: '',
        artifacts: [],
        audit: [`fake executor failed with ${this.options.failWith}`],
        durationMs: Date.now() - startedAt,
        failure: {
          kind: this.options.failWith,
          message: `fake executor: ${this.options.failWith}`,
        },
      };
    }

    const name = this.options.artifactName ?? `agent-report-${request.taskId}.md`;
    const body = [
      `# 本地 Agent 报告（fake executor）`,
      '',
      `- taskId: ${request.taskId}`,
      `- runId: ${request.runId}`,
      `- toolsets: ${request.toolsets.join(', ') || '(none)'}`,
      `- goal: ${request.goal.slice(0, 200)}`,
      `- generated: ${new Date().toISOString()}`,
      '',
      '本文件由 fake executor 生成，用于验证宿主生命周期，不代表真实 Hermes 执行结果。',
      '',
    ].join('\n');
    const written = await writeFileIfUnchanged(join(request.workDir, name), body);
    const artifacts = await collectArtifacts(request.workDir);

    return {
      executor: 'fake',
      exitCode: 0,
      output: `fake executor wrote ${name}${written.versioned ? ` (new version: ${written.versioned})` : ''}`,
      artifacts,
      audit: [`write ${name}`, `sha256 ${written.sha256.slice(0, 16)}`],
      durationMs: Date.now() - startedAt,
    };
  }
}
