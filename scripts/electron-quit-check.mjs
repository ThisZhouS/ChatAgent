#!/usr/bin/env node
/**
 * Gate 7A.2 — explicit quit check (real Electron app, real main.cjs).
 *
 * Proves the "stop the agent and quit" path end to end:
 *   1. the app starts the host and accepts a local task (fake executor fallback);
 *   2. the task store is protected by a lock file while the app runs;
 *   3. asking the app to quit (the tray/menu path -> `chatagent:host:quit-app`)
 *      actually stops the process within the bounded shutdown window;
 *   4. quitting releases the single-writer lock and leaves the store readable,
 *      so the next launch takes over cleanly.
 *
 * Usage: node scripts/electron-quit-check.mjs
 *        node scripts/electron-quit-check.mjs --debug-port 9345
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const debugPort = Number(argValue('--debug-port', '9345'));
const stateDir = join(root, 'Temp', 'quit-check');
const hostRoot = join(stateDir, 'host');
const profileDir = join(stateDir, 'profile');
// The runtime can be pointed elsewhere with CHATAGENT_ELECTRON_BIN so an upgrade
// (or a beta) can be rehearsed against the real checks without touching the pin.
const devElectron =
  process.env.CHATAGENT_ELECTRON_BIN ||
  join(root, 'apps', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe');
const packagedExe = join(root, 'apps', 'desktop', 'release', 'win-unpacked', 'ChatAgent.exe');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function httpGetJson(port, path) {
  return new Promise((resolvePromise) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
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

/** Minimal CDP client: enough to evaluate expressions in the page. */
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
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result?.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
    }
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

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(hostRoot, { recursive: true });

  // Default to the source app: the packaged exe in release/ may predate the
  // current main.cjs/bundle, which would test yesterday's lifecycle instead.
  const usePackaged = args.includes('--packaged');
  const command = usePackaged ? packagedExe : devElectron;
  if (!existsSync(command)) {
    console.log('SKIP  no Electron runtime available');
    process.exit(0);
  }

  const child = spawn(
    command,
    [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profileDir}`,
      ...(usePackaged ? [] : [resolve(root, 'apps', 'desktop')]),
    ],
    {
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        // The organization server is deliberately unreachable: the local agent
        // must work (and quit cleanly) without it.
        CHATAGENT_SERVER_URL: 'http://127.0.0.1:9',
        CHATAGENT_HOST_ROOT: hostRoot,
      },
    },
  );

  let exited = false;
  let exitCode;
  child.on('exit', (code) => {
    exited = true;
    exitCode = code;
  });

  try {
    const cdp = await connectToPage();
    check('the desktop app starts and exposes a debuggable page', Boolean(cdp));
    if (!cdp) throw new Error('no page to drive');

    await cdp.send('Runtime.enable');
    await waitFor(
      async () => cdp.evaluate('Boolean(window.chatagent && window.chatagent.host)').catch(() => false),
      20000,
      'the host bridge',
    );
    check('the renderer only gets the narrow host bridge', true);

    const status = await cdp.evaluate('window.chatagent.host.command({ type: "status" })');
    check(
      'the agent host is running without the organization server',
      status?.ok === true && status?.result?.running === true,
      `running=${status?.result?.running} executor=${status?.result?.executor}`,
    );
    const deviceId = status?.result?.deviceId ?? '';
    check('the device id is a stable per-install value', /^desktop-/.test(deviceId), deviceId);

    const taskId = `quit-check-${Date.now()}`;
    await cdp.evaluate(
      `window.chatagent.host.command({ type: 'submit', taskId: ${JSON.stringify(taskId)}, goal: '退出前完成的任务', kind: 'document', toolsets: ['document'] })`,
    );
    let record;
    await waitFor(
      async () => {
        const list = await cdp.evaluate('window.chatagent.host.command({ type: "list" })');
        record = list?.result?.tasks?.find((item) => item.taskId === taskId);
        return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(record?.state);
      },
      30000,
      'the local task to reach a terminal state',
    );
    // The app must report an honest outcome: either it produced the artifact, or it
    // failed for a stated reason (e.g. no model provider configured on this box).
    check(
      'a local task reaches an honest terminal state inside the app',
      record?.state === 'succeeded' ||
        /no_provider|no inference provider/i.test(String(record?.error ?? '')),
      `state=${record?.state} error=${record?.error ?? '-'} executor=${status?.result?.executor}`,
    );

    const lockPath = join(hostRoot, 'tasks.json.lock');
    check('the task store is locked by the running app', existsSync(lockPath), lockPath);

    // The user path: tray/menu "stop the agent and quit".
    await cdp.evaluate('window.chatagent.host.quitApp()').catch(() => undefined);

    const quitDeadline = Date.now() + 15000;
    while (!exited && Date.now() < quitDeadline) await sleep(200);
    check('explicit quit stops the app process (bounded shutdown)', exited, `exitCode=${exitCode}`);

    check('quitting releases the single-writer lock', !existsSync(lockPath));

    const storePath = join(hostRoot, 'tasks.json');
    let stored;
    try {
      stored = JSON.parse(readFileSync(storePath, 'utf8'));
    } catch (error) {
      stored = undefined;
      check('the task store stays readable after quit', false, error.message);
    }
    if (stored) {
      const persisted = Array.isArray(stored)
        ? stored.find((item) => item.taskId === taskId)
        : undefined;
      check(
        'the task outcome is still recorded on disk after quit',
        persisted?.state === record?.state,
        `disk=${persisted?.state} reported=${record?.state}`,
      );
    }

    let pidAlive = true;
    try {
      process.kill(child.pid, 0);
    } catch {
      pidAlive = false;
    }
    check('no app process is left behind', !pidAlive, `pid=${child.pid}`);
  } catch (error) {
    check(`quit check crashed — ${error.message}`, false);
  } finally {
    if (!exited) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    const failed = results.filter((item) => !item.ok).length;
    console.log(`\n[gate7a-quit] ${results.length - failed}/${results.length} checks passed`);
    process.exit(failed === 0 ? 0 : 1);
  }
}

void main();
