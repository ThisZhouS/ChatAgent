#!/usr/bin/env node
/**
 * One-command acceptance run.
 *
 * Executes the whole verification chain in the order a reviewer would:
 * typecheck -> tests -> build -> restart the server -> API smoke -> dependency
 * audit -> client E2E,
 * and prints a single PASS/FAIL table with the evidence line of each step.
 *
 * Usage:
 *   node scripts/acceptance.mjs              # everything
 *   node scripts/acceptance.mjs --skip-e2e   # no Electron window (CI / headless)
 *   node scripts/acceptance.mjs --port 8787
 *
 * Exit code is non-zero when any step fails, so it can gate a release.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const skipE2e = args.includes('--skip-e2e');
const portIndex = args.indexOf('--port');
const port = portIndex === -1 ? '8787' : args[portIndex + 1];

/** Runs one step, streaming its output, and returns the interesting summary. */
function run(label, command, commandArgs, options = {}) {
  const started = Date.now();
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: process.platform === 'win32',
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
  });
  // Child output carries ANSI colour codes; strip them before pattern matching.
  const output = options.capture
    ? `${result.stdout ?? ''}${result.stderr ?? ''}`.replace(/\[[0-9;]*m/g, '')
    : '';
  const ok = result.status === 0;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  let detail = `${seconds}s`;
  if (options.summary && output !== '') {
    const matches = [...output.matchAll(new RegExp(options.summary.source, 'g'))];
    if (matches.length > 0) {
      // Several suites report their own totals: sum the captured numbers.
      const numbers = matches
        .map((match) => Number(match[1]))
        .filter((value) => Number.isFinite(value));
      detail =
        numbers.length > 0
          ? `${numbers.reduce((sum, value) => sum + value, 0)} cases · ${seconds}s`
          : `${matches[0][0]} · ${seconds}s`;
    }
  }
  if (!ok && output !== '') {
    const tail = output.trim().split(/\r?\n/).slice(-6).join(' | ');
    detail = `${detail} — ${tail.slice(0, 400)}`;
  }
  if (options.capture && output !== '') process.stdout.write(output);
  return { label, ok, detail };
}

const steps = [
  () => run('typecheck (tsc + vue-tsc)', 'pnpm', ['typecheck'], { capture: true, summary: /$/ }),
  () =>
    run('unit / integration tests', 'pnpm', ['test'], {
      capture: true,
      summary: /Tests\s+(\d+) passed/,
    }),
  () => run('build (server + web)', 'pnpm', ['build'], { capture: true, summary: /built in [\d.]+s/ }),
  () =>
    run('restart server', process.execPath, [join(root, 'scripts', 'restart-server.mjs'), '--port', port], {
      capture: true,
      summary: /health: .*/,
    }),
  () =>
    run('API smoke (27 checks)', process.execPath, [join(root, 'scripts', 'smoke.mjs')], {
      capture: true,
      env: { CHATAGENT_URL: `http://127.0.0.1:${port}` },
      summary: /\d+\/\d+ checks passed/,
    }),
];

steps.push(() =>
  run('dependency audit (critical gate)', process.execPath, [join(root, 'scripts', 'audit-deps.mjs'), '--level', 'critical'], {
    capture: true,
    summary: /(\d+ advisories|[0-9]+ at or above)/,
  }),
);

if (!skipE2e) {
  steps.push(() =>
    run(
      'client E2E (packaged exe)',
      process.execPath,
      [join(root, 'scripts', 'ui-e2e.mjs'), '--server', `http://localhost:${port}`],
      { capture: true, summary: /\d+\/\d+ UI checks passed/ },
    ),
  );
  // Gate 7A.2: the on-device agent must work (and stop cleanly) with the
  // organization server irrelevant to it. These two run under the real Electron
  // runtime, so they are launched with the desktop app's electron binary.
  const electronBin = join(root, 'apps', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe');
  if (existsSync(electronBin)) {
    for (const [label, script] of [
      ['local agent workbench (Electron)', 'electron-workbench-check.cjs'],
      ['local agent quit path (Electron)', 'electron-quit-check.mjs'],
      ['local receipt sync (Electron)', 'electron-receipt-sync-check.mjs'],
    ]) {
      steps.push(() =>
        run(label, electronBin, [join(root, 'scripts', script)], {
          capture: true,
          summary: /\d+\/\d+ checks passed/,
        }),
      );
    }
  }
}

const results = [];
for (const step of steps) {
  try {
    results.push(step());
  } catch (error) {
    results.push({
      label: 'step crashed',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

console.log('\n================ acceptance summary ================');
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label.padEnd(30)} ${result.detail}`);
}
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
if (failed.length > 0) {
  console.log('failed steps:');
  for (const result of failed) console.log(` - ${result.label}: ${result.detail}`);
}
process.exit(failed.length === 0 ? 0 : 1);
