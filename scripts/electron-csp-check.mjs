#!/usr/bin/env node
/**
 * Closes a documented gap: the desktop injects a CSP for remote pages that do not
 * send one, but "the header is set" is not the same as "the browser enforces it".
 *
 * This runs the real app against a local stub page that contains
 *   - an inline `<script>` (must NOT run under the injected policy), and
 *   - a same-origin external script (must run: the real app is a bundled SPA),
 * then repeats with a stub that serves its own CSP — the desktop must keep the
 * server's policy instead of weakening or duplicating it.
 *
 * Usage: node scripts/electron-csp-check.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const debugPort = Number(argValue('--debug-port', '9348'));
const serverPort = Number(argValue('--server-port', '8795'));
const stateDir = join(root, 'Temp', 'csp-check');
const hostRootDir = join(stateDir, 'host');
const profileDir = join(stateDir, 'profile');
const devElectron = join(root, 'apps', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe');
const serverUrl = `http://127.0.0.1:${serverPort}`;

/** Mode 1: no CSP at all (the desktop must supply one). Mode 2: server CSP. */
let mode = 1;
const inlineRan = () => 'window.__inlineRan === 1';
const PAGE = '<!doctype html><meta charset="utf-8"><title>csp stub</title>'
  + '<script>window.__inlineRan = 1;</script>'
  + '<script src="/app.js"></script>'
  + '<div id="app">stub</div>';

const stub = createServer((req, res) => {
  if (req.url === '/app.js') {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end('window.__externalRan = 1;');
    return;
  }
  const headers = { 'content-type': 'text/html; charset=utf-8' };
  if (mode === 2) {
    // Deliberately permissive: proves the desktop does not override the server.
    headers['content-security-policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline'";
  }
  res.writeHead(200, headers);
  res.end(PAGE);
});

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

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

  send(method, params = {}, timeoutMs = 15000) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      setTimeout(() => {
        if (this.pending.delete(id)) rejectPromise(new Error(`${method} timed out`));
      }, timeoutMs);
    });
  }

  /**
   * Evaluate, but treat "the execution context is not there yet" as a value
   * instead of an error: a page target appears before its context exists, and a
   * single early evaluate would fail the check for a timing reason rather than a
   * product reason.
   */
  async evaluateSoft(expression, timeoutMs = 4000) {
    try {
      const result = await this.send(
        'Runtime.evaluate',
        { expression, returnByValue: true },
        timeoutMs,
      );
      if (result?.exceptionDetails) return { ok: false, error: 'exception' };
      return { ok: true, value: result?.result?.value };
    } catch (error) {
      return { ok: false, error: error.message };
    }
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
      ? targets.find(
          (item) =>
            item.type === 'page' &&
            item.webSocketDebuggerUrl &&
            // Wait for the real page, not the initial about:blank target.
            String(item.url ?? '').startsWith(serverUrl),
        )
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

async function runScenario(label, judge) {
  const child = spawn(
    devElectron,
    [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, resolve(root, 'apps', 'desktop')],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, CHATAGENT_SERVER_URL: serverUrl, CHATAGENT_HOST_ROOT: hostRootDir, CHATAGENT_NO_PROMPT: '1' },
    },
  );
  const logs = [];
  child.stdout?.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr?.on('data', (chunk) => logs.push(String(chunk)));
  try {
    const cdp = await connectToPage();
    if (!cdp) {
      check(`${label}: the app starts against the stub page`, false);
      return undefined;
    }
    await cdp.send('Runtime.enable', {}, 8000).catch(() => undefined);
    // Wait until the page actually finished loading before judging its scripts.
    const deadline = Date.now() + 20000;
    let ready = false;
    let external = false;
    while (Date.now() < deadline && !(ready && external)) {
      const state = await cdp.evaluateSoft('document.readyState');
      if (state.ok && state.value === 'complete') ready = true;
      const ran = await cdp.evaluateSoft('window.__externalRan === 1');
      if (ran.ok && ran.value === true) external = true;
      if (!(ready && external)) await sleep(300);
    }
    if (!ready) check(`${label}: the stub page finished loading`, false);
    const inlineState = await cdp.evaluateSoft(inlineRan());
    // Judgement runs while the app is still alive: a closed DevTools connection
    // must never be mistaken for "the script did not run".
    await judge({ cdp, external, logs, inlineState });
    return true;
  } finally {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
    const deadline = Date.now() + 15000;
    while (child.exitCode === null && Date.now() < deadline) await sleep(200);
  }
}

async function main() {
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(hostRootDir, { recursive: true });
  if (!existsSync(devElectron)) {
    console.log('SKIP  no Electron runtime available');
    process.exit(0);
  }
  await new Promise((resolvePromise) => stub.listen(serverPort, '127.0.0.1', resolvePromise));

  const shellStatus = async (cdp, logs) =>
    cdp
      .evaluate('window.chatagent.host.command({ type: "status" })')
      .catch((error) => {
        check(`status() answered over IPC — ${error.message}`, false, logs.join('').slice(-300));
        return undefined;
      });

  try {
    // ---- scenario 1: the server sends no CSP ------------------------------
    mode = 1;
    await runScenario('no server CSP', async ({ cdp, external, logs, inlineState }) => {
      const inline = inlineState.ok ? inlineState.value : undefined;
      check(
        'an inline script from the remote page is blocked by the injected CSP',
        inline === undefined || inline === false,
        `__inlineRan=${String(inline)}`,
      );
      check('a same-origin script still runs (the real app is a bundled SPA)', external === true);
      const status = await shellStatus(cdp, logs);
      const shell = status?.result?.shell ?? {};
      check('the desktop reports it supplied the policy itself', Number(shell.cspInjected) >= 1, JSON.stringify(shell));
    });
    await sleep(500);

    // ---- scenario 2: the server sends its own CSP -------------------------
    mode = 2;
    await runScenario('server CSP', async ({ cdp, logs, inlineState }) => {
      const inline = inlineState.ok ? inlineState.value : undefined;
      check(
        'a server-sent CSP is kept as-is (its own inline allowance still applies)',
        inline === true,
        `__inlineRan=${String(inline)} (server allowed inline)`,
      );
      const status = await shellStatus(cdp, logs);
      const shell = status?.result?.shell ?? {};
      check(
        'the desktop did not overwrite the server policy',
        Number(shell.cspFromServer) >= 1 && Number(shell.cspInjected) === 0,
        JSON.stringify(shell),
      );
    });
  } catch (error) {
    check(`csp check crashed — ${error.message}`, false);
  } finally {
    stub.close();
    const failed = results.filter((item) => !item.ok).length;
    console.log(`\n[gate7a-csp] ${results.length - failed}/${results.length} checks passed`);
    process.exit(failed === 0 ? 0 : 1);
  }
}

void main();
