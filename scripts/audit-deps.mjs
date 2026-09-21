#!/usr/bin/env node
/**
 * Dependency vulnerability scan.
 *
 * The workspace uses a local pnpm mirror that has no audit endpoint, so the scan
 * is run explicitly against the public npm registry. Findings are printed grouped
 * by package and the exit code is non-zero when a high/critical advisory remains,
 * which makes the script usable as a release gate.
 *
 * Usage:
 *   node scripts/audit-deps.mjs               # high + critical gate
 *   node scripts/audit-deps.mjs --level moderate
 *   node scripts/audit-deps.mjs --json        # raw machine-readable output
 *
 * Network: requires https://registry.npmjs.org (audit endpoint). When it is not
 * reachable the script reports that and exits 0 so an offline build is not
 * blocked — record it as an unverified item instead.
 */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const levelIndex = args.indexOf('--level');
const level = levelIndex === -1 ? 'high' : (args[levelIndex + 1] ?? 'high');
const asJson = args.includes('--json');
const registry = process.env.CHATAGENT_AUDIT_REGISTRY ?? 'https://registry.npmjs.org';

const SEVERITY_ORDER = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 };

function runAudit() {
  try {
    const stdout = execFileSync('pnpm', ['audit', '--registry', registry, '--json'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch (error) {
    // pnpm exits non-zero when advisories exist, so stderr/stdout still carry the report.
    const stdout = error?.stdout ?? '';
    if (typeof stdout === 'string' && stdout.trim().startsWith('{')) return { ok: true, stdout };
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const audit = runAudit();
if (!audit.ok) {
  console.log('dependency audit skipped: the registry audit endpoint is unreachable');
  console.log(`  reason: ${audit.error}`);
  console.log('  → treat "dependency CVE scan" as UNVERIFIED for this run');
  // Exit 2 (unverified), not 0: the message above already says UNVERIFIED, and a caller that
  // only reads the exit code must not be told this step passed.
  console.log('[audit-deps] 0 advisories checked — 未验证，退出码 2（不是通过）');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  console.log('dependency audit could not be parsed; raw output follows');
  console.log(audit.stdout.slice(0, 2000));
  console.log('[audit-deps] 报告无法解析 — 未验证，退出码 2（不是通过）');
  process.exit(2);
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const advisories = report.advisories ?? {};
const grouped = new Map();
for (const advisory of Object.values(advisories)) {
  const key = `${advisory.module_name}@${advisory.vulnerable_versions}`;
  const entry = grouped.get(key) ?? {
    severity: advisory.severity,
    patched: advisory.patched_versions,
    title: advisory.title,
    paths: new Set(),
  };
  if (SEVERITY_ORDER[advisory.severity] < SEVERITY_ORDER[entry.severity]) entry.severity = advisory.severity;
  for (const finding of advisory.findings ?? []) {
    for (const path of finding.paths ?? []) entry.paths.add(path);
  }
  grouped.set(key, entry);
}

const rows = [...grouped.entries()]
  .map(([pkg, entry]) => ({ pkg, ...entry, paths: [...entry.paths] }))
  .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

const threshold = SEVERITY_ORDER[level] ?? 1;
const blocking = rows.filter((row) => SEVERITY_ORDER[row.severity] <= threshold);

console.log(`ChatAgent dependency audit (${registry})\n`);
for (const row of rows) {
  const direct = row.paths.some((path) => /^apps_|^packages_/.test(path)) ? 'app' : 'transitive';
  console.log(
    `${row.severity.toUpperCase().padEnd(9)} ${row.pkg.padEnd(34)} -> ${String(row.patched).padEnd(12)} [${direct}]`,
  );
}
const totals = report.metadata?.vulnerabilities ?? {};
console.log(
  `\n${rows.length} advisories — critical=${totals.critical ?? 0} high=${totals.high ?? 0} moderate=${totals.moderate ?? 0} low=${totals.low ?? 0}`,
);
console.log(`${blocking.length} at or above "${level}"`);

if (blocking.length > 0) {
  console.log('\nblocking advisories:');
  for (const row of blocking) {
    console.log(` - ${row.severity}: ${row.pkg} → fix ${row.patched} (${row.title})`);
  }
  console.log('\nnote: dev-only tooling (electron-builder chain) can be accepted explicitly by raising --level');
}
process.exit(blocking.length === 0 ? 0 : 1);
