#!/usr/bin/env node
/**
 * Single-writer lock behaviour in the real app (Gate 7A follow-up).
 *
 * The store heals the unambiguous case itself and refuses the ambiguous one. This
 * check drives the real desktop app to prove both halves end to end:
 *   1. a lock naming a *live* pid keeps the background agent down — the app still
 *      starts, the lock file is left exactly as it was, and nothing is taken over
 *      without a human (prompts are disabled in this run, so "no human" must mean
 *      "keep the lock");
 *   2. a lock naming a *dead* pid is healed automatically and the agent starts,
 *      with no audit entry — the store's own recovery is not a consent event;
 *   3. after a consented takeover (exercised in the unit suite) the store starts.
 *
 * The interactive dialog itself needs a human click and is documented as a manual
 * step in docs/acceptance-guide.md instead of being faked here.
 *
 * Usage: node scripts/electron-lock-check.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const debugPort = Number(argValue('--debug-port', '9347'));
const serverPort = Number(argValue('--server-port', '8794'));
const stateDir = join(root, 'Temp', 'lock-check');
const hostRootDir = join(stateDir, 'host');
const profileDir = join(stateDir, 'profile');
const devElectron = join(root, 'apps', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe');
const tasksPath = join(hostRootDir, 'tasks.json');
const lockPath = `${tasksPath}.lock`;
const serverUrl = `http://127.0.0.1:${serverPort}`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

// A stub page so the app window can load without the project server.
import { createServer } from 'node:http';
const stub = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>stub</title>');
});

function httpGetJson(port, path) {
  return new Promise((resolvePromise) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolvePromise(JSON.parse(body));
        } catch {
          resolvePromise(undefined);
        }
      });
    });
    req.on('error', () => resolvePromise(undefined));
    req.end();
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      entry.resolve(message.result);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      setTimeout(() => rejectPromise(new Error(`${method} timed out`)), 15000);
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
    return result?.result?.value;
  }
}

async function connectToPage(timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await httpGetJson(debugPort, '/json/list');
    const page = Array.isArray(targets)
      ? targets.find((item) => item.type === 'page' && item.webSocketDebuggerUrl)
      : undefined;
    if (page) {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolvePromise, rejectPromise) => {
        ws.addEventListener('open', () => resolvePromise());
        ws.addEventListener('error', () => rejectPromise(new Error('websocket failed')));
        setTimeout(() => rejectPromise(new Error('websocket connect timed out')), 10000);
      });
      return new Cdp(ws);
    }
    await sleep(400);
  }
  return undefined;
}

function launchApp(extraEnv = {}) {
  const child = spawn(
    devElectron,
    [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, resolve(root, 'apps', 'desktop')],
    {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        CHATAGENT_SERVER_URL: serverUrl,
        CHATAGENT_HOST_ROOT: hostRootDir,
        CHATAGENT_NO_PROMPT: '1',
        ...extraEnv,
      },
    },
  );
  const logs = [];
  child.stdout?.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr?.on('data', (chunk) => logs.push(String(chunk)));
  return { child, logs };
}

async function stopApp(app) {
  try {
    app.child.kill('SIGKILL');
  } catch {
    // already gone
  }
  const deadline = Date.now() + 15000;
  while (app.child.exitCode === null && Date.now() < deadline) await sleep(200);
}

async function main() {
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(hostRootDir, { recursive: true });
  if (!existsSync(devElectron)) {
    console.log('SKIP  no Electron runtime available');
    process.exit(0);
  }
  await new Promise((resolvePromise) => stub.listen(serverPort, '127.0.0.1', resolvePromise));

  try {
    // ---- scenario 1: the lock names a live process ------------------------
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const lockPayload = JSON.stringify({ pid: holder.pid, startedAt: new Date().toISOString() });
    writeFileSync(lockPath, lockPayload, 'utf8');

    const first = launchApp();
    const cdp = await connectToPage();
    check('the app starts even when the task store is locked', Boolean(cdp));
    if (cdp) {
      await cdp.send('Runtime.enable');
      const status = await cdp.evaluate('window.chatagent.host.command({ type: "status" })');
      check('the background agent stays down while the lock is disputed', status?.ok !== true, JSON.stringify(status).slice(0, 120));
    }
    await sleep(1500);
    check(
      'the disputed lock is left untouched (no silent takeover)',
      readFileSync(lockPath, 'utf8') === lockPayload,
      lockPath,
    );
    const afterFirst = readdirSync(hostRootDir);
    check(
      'nothing was renamed aside and no audit entry was written without consent',
      !afterFirst.some((name) => name.includes('.replaced-') || name.endsWith('.lock-audit.jsonl')),
      afterFirst.join(', ') || '(empty)',
    );
    check(
      'the unattended run explains itself instead of hanging on a dialog',
      first.logs.some((line) => line.includes('store lock kept')),
      first.logs.find((line) => line.includes('store lock'))?.trim().slice(0, 120) ?? '(no log line)',
    );
    await stopApp(first);
    try {
      spawn('taskkill', ['/pid', String(holder.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // already gone
    }

    // ---- scenario 2: the lock names a process that is gone ----------------
    const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
    await new Promise((resolvePromise) => dead.on('exit', resolvePromise));
    const stalePayload = JSON.stringify({ pid: dead.pid, startedAt: '2026-09-16T00:00:00.000Z' });
    writeFileSync(lockPath, stalePayload, 'utf8');

    const second = launchApp();
    const cdp2 = await connectToPage();
    check('the app starts with a leftover lock in place', Boolean(cdp2));
    let running = false;
    if (cdp2) {
      await cdp2.send('Runtime.enable');
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && !running) {
        const status = await cdp2.evaluate('window.chatagent.host.command({ type: "status" })');
        running = status?.ok === true && status.result?.running === true;
        if (!running) await sleep(500);
      }
    }
    check('a leftover lock is healed automatically (single writer restored)', running);
    const files = readdirSync(hostRootDir);
    check(
      'the automatic heal writes no consent audit entry',
      !files.some((name) => name.endsWith('.lock-audit.jsonl')),
      files.join(', '),
    );
    check(
      'the leftover lock file is gone after the heal',
      !existsSync(lockPath) || readFileSync(lockPath, 'utf8').includes(String(second.child.pid ?? -1)),
      existsSync(lockPath) ? 'lock re-created by the new writer' : 'lock removed',
    );
    if (cdp2) await cdp2.evaluate('window.chatagent.host.quitApp()').catch(() => undefined);
    await stopApp(second);
  } catch (error) {
    check(`lock check crashed — ${error.message}`, false);
  } finally {
    stub.close();
    const failed = results.filter((item) => !item.ok).length;
    console.log(`\n[gate7a-lock] ${results.length - failed}/${results.length} checks passed`);
    process.exit(failed === 0 ? 0 : 1);
  }
}

void main();
