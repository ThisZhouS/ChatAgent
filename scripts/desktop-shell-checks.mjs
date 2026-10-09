#!/usr/bin/env node
/**
 * The seven desktop-shell checks, each under the runtime it documents, with one total.
 *
 * Why this exists: the seven checks are not all run the same way. Five are *node*
 * scripts that spawn the Electron runtime themselves (their headers read
 * `Usage: node scripts/...`); two are *electron* scripts that use the Electron API
 * directly (`Run: …/electron scripts/...`). Hand-assembling that list is how the recorded
 * "desktop shell: 92/92" figure stopped being reproducible: `scripts/acceptance.mjs`
 * launched every check with the Electron binary, so `electron-lock-check.mjs` ran
 * with `process.execPath` pointing at electron.exe — its `node -e` helpers became
 * Electron invocations, the second scenario never reached its stale-lock write, and
 * the run hung instead of failing. This runner keeps the runtime choice in one
 * table, so it cannot drift per call site again.
 *
 * Usage:
 *   node scripts/desktop-shell-checks.mjs                  # all seven
 *   node scripts/desktop-shell-checks.mjs --only lock      # one check, for debugging
 *   node scripts/desktop-shell-checks.mjs --timeout-ms 60000
 *
 * Exit code: 0 all checks ran and passed; 1 any check failed; 2 nothing failed but
 * something could not run (no Electron runtime). A check that is *not run* verified
 * nothing, so it must never be reported as a pass — same convention the checks
 * themselves use when they skip.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const only = argValue('--only', undefined);
const timeoutMs = Number(argValue('--timeout-ms', '300000'));

/** Where the checks read the runtime they should drive. */
const electronBin =
  process.env.CHATAGENT_ELECTRON_BIN ||
  join(root, 'apps', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe');

/**
 * `runner` is the documented one for each script, not a guess: it matches the
 * `Usage:` line in the script's own header. Changing one here without changing
 * that header is a bug.
 *
 * `expect` is how many checks the script is supposed to run. It is pinned because a
 * script can shrink its own assertion set and still report a self-consistent total:
 * when a leftover Electron held this check's state directory, `receipt-sync` printed
 * `14/15 checks passed` instead of `21/21` — a *smaller* number of assertions, which
 * the total would happily have absorbed as if the run were complete. A denominator
 * that does not match the pinned one is a failure, not a pass.
 */
const CHECKS = [
  { id: 'lock', label: 'single-writer lock', script: 'electron-lock-check.mjs', runner: 'node', expect: 18 },
  { id: 'receipt-sync', label: 'receipt sync + partition', script: 'electron-receipt-sync-check.mjs', runner: 'node', expect: 21 },
  { id: 'host-smoke', label: 'host lifecycle smoke', script: 'electron-host-smoke.cjs', runner: 'electron', expect: 6 },
  { id: 'workbench', label: 'offline workbench', script: 'electron-workbench-check.cjs', runner: 'electron', expect: 19 },
  { id: 'quit', label: 'quit path', script: 'electron-quit-check.mjs', runner: 'node', expect: 10 },
  { id: 'csp', label: 'remote page CSP', script: 'electron-csp-check.mjs', runner: 'node', expect: 5 },
  { id: 'nav', label: 'navigation + bridge', script: 'electron-nav-check.mjs', runner: 'node', expect: 13 },
];

/** Kills a check and anything it spawned, so a timeout cannot leak an app window. */
function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // already gone
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

/**
 * Runs one check with a hard deadline. A check that overruns is a *failure* with a
 * readable reason — the previous behaviour (wait forever) made a hung check
 * indistinguishable from a slow one and swallowed the whole sweep.
 */
function runCheck(check) {
  const command = check.runner === 'electron' ? electronBin : process.execPath;
  const started = Date.now();
  return new Promise((resolvePromise) => {
    let output = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(command, [join(root, 'scripts', check.script)], {
        cwd: root,
        // The checks read this to point at the runtime under test, so a rehearsal
        // against another Electron build reaches the scripts they spawn too.
        env: {
          ...process.env,
          // The checks drive the real app; without this each one flashes a ChatAgent window
          // on the employee's desktop showing whatever stub page the check serves. The
          // window-action check shows its window on purpose - that is what it tests.
          CHATAGENT_NO_WINDOW: '1',
          CHATAGENT_ELECTRON_BIN: electronBin,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      resolvePromise({ ...check, ok: false, detail: `could not start: ${error.message}` });
      return;
    }
    let graceTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // The kill can still fail (taskkill unavailable, or a surviving descendant
      // holding the stdio pipe), and `close` would then never fire — a hang, which
      // is the exact failure this runner exists to prevent. Settle on our own clock.
      graceTimer = setTimeout(() => {
        resolvePromise({
          ...check,
          ok: false,
          detail: `timed out after ${Math.round(timeoutMs / 1000)}s and did not exit after the kill`,
          ran: 0,
          total: 0,
        });
      }, 15000);
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => (output += String(chunk)));
    child.stderr?.on('data', (chunk) => (output += String(chunk)));
    child.on('error', (error) => {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolvePromise({ ...check, ok: false, detail: `could not start: ${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(graceTimer);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      // Every check reports `[tag] N/M checks passed`; the numbers are the evidence.
      const match = output.match(/(\d+)\/(\d+) checks passed/);
      const ran = match ? Number(match[1]) : 0;
      const total = match ? Number(match[2]) : 0;
      if (timedOut) {
        resolvePromise({
          ...check,
          ok: false,
          detail: `timed out after ${Math.round(timeoutMs / 1000)}s (exit code ${String(code)})`,
          ran,
          total,
        });
        return;
      }
      // Exit 2 is the checks' own "unverified, not a pass" signal (no Electron runtime).
      const unverified = code === 2;
      // A total other than the pinned one means the script ran a different set of
      // assertions than it is documented to run — a shrunk run, not a smaller pass.
      const shrank = !unverified && total !== check.expect;
      resolvePromise({
        ...check,
        ok: code === 0 && !shrank,
        unverified,
        ran,
        total,
        detail: shrank
          ? `ran ${ran}/${total}, expected ${check.expect} checks — the script's assertion set changed`
          : match
            ? `${match[0]} · ${seconds}s`
            : `exit code ${String(code)} · ${seconds}s`,
      });
    });
  });
}

const selected = only ? CHECKS.filter((check) => check.id === only) : CHECKS;
if (selected.length === 0) {
  console.error(`unknown check "${String(only)}"; known ids: ${CHECKS.map((c) => c.id).join(', ')}`);
  process.exit(1);
}
// Electron-type checks cannot run at all without the runtime; say so up front rather
// than reporting a spawn error seven times.
if (!existsSync(electronBin) && selected.some((check) => check.runner === 'electron')) {
  console.log(`no Electron runtime at ${electronBin} — 未验证，退出码 2（不是通过）`);
  process.exit(2);
}

const results = [];
for (const check of selected) {
  console.log(`\n--- ${check.label} (${check.runner}: ${check.script}) ---`);
  const result = await runCheck(check);
  results.push(result);
  console.log(`${result.ok ? 'PASS' : result.unverified ? 'SKIP' : 'FAIL'}  ${check.label} — ${result.detail}`);
}

const failed = results.filter((result) => !result.ok && !result.unverified);
const unverified = results.filter((result) => result.unverified);
const ran = results.reduce((sum, result) => sum + (result.ran || 0), 0);
const total = results.reduce((sum, result) => sum + (result.total || 0), 0);

console.log('\n================ desktop shell summary ================');
for (const result of results) {
  const mark = result.ok ? 'PASS' : result.unverified ? 'SKIP' : 'FAIL';
  console.log(`${mark}  ${result.id.padEnd(14)} ${result.detail}`);
}
console.log(`\n[desktop-shell] ${ran}/${total} checks passed across ${results.length} script(s)`);
if (unverified.length > 0) {
  console.log(`unverified (not run, so not passed): ${unverified.map((r) => r.id).join(', ')}`);
}
process.exit(failed.length > 0 ? 1 : unverified.length > 0 ? 2 : 0);
