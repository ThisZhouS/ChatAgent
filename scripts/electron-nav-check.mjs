#!/usr/bin/env node
/**
 * Closes another documented gap: the desktop has navigation guards
 * (setWindowOpenHandler / will-navigate / will-attach-webview), but nothing
 * proved they hold for a *remote* page. This runs the real app against a local
 * stub page and drives the exact moves a hostile (or merely broken) page would:
 *
 *   1. assert the preload bridge is the narrow one (no generic IPC channel);
 *   2. an unknown host command is rejected, not silently accepted;
 *   3. window.open('https://…') creates no window/tab;
 *   4. top-level navigation to another origin is prevented (the shell keeps its
 *      configured page), while a same-origin navigation still works;
 *   5. external links are not handed to the OS browser when
 *      CHATAGENT_OPEN_EXTERNAL=off (terminal-server behaviour).
 *
 * Usage: node scripts/electron-nav-check.mjs
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
const debugPort = Number(argValue('--debug-port', '9350'));
const serverPort = Number(argValue('--server-port', '8797'));
const stateDir = join(root, 'Temp', 'nav-check');
const hostRootDir = join(stateDir, 'host');
const profileDir = join(stateDir, 'profile');
// The runtime can be pointed elsewhere with CHATAGENT_ELECTRON_BIN so an upgrade
// (or a beta) can be rehearsed against the real checks without touching the pin.
const devElectron =
  process.env.CHATAGENT_ELECTRON_BIN ||
  join(root, 'apps', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe');
const serverUrl = `http://127.0.0.1:${serverPort}`;
const FOREIGN = 'https://example.invalid/from-page';

const PAGE = '<!doctype html><meta charset="utf-8"><title>nav stub</title>'
  + '<div id="app">stub</div>'
  + '<script src="/app.js"></script>';

const stub = createServer((req, res) => {
  if (req.url === '/app.js') {
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end('window.__ready = 1;');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
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

  async evaluateSoft(expression, timeoutMs = 4000) {
    try {
      const result = await this.send('Runtime.evaluate', { expression, returnByValue: true }, timeoutMs);
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

async function main() {
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(hostRootDir, { recursive: true });
  if (!existsSync(devElectron)) {
    console.log('SKIP  no Electron runtime available');
    process.exit(0);
  }
  await new Promise((resolvePromise) => stub.listen(serverPort, '127.0.0.1', resolvePromise));

  const child = spawn(
    devElectron,
    [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, resolve(root, 'apps', 'desktop')],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        CHATAGENT_SERVER_URL: serverUrl,
        CHATAGENT_HOST_ROOT: hostRootDir,
        CHATAGENT_NO_PROMPT: '1',
        // Terminal-server behaviour: the check must not spawn a real browser.
        CHATAGENT_OPEN_EXTERNAL: 'off',
      },
    },
  );
  const logs = [];
  child.stdout?.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr?.on('data', (chunk) => logs.push(String(chunk)));

  try {
    const cdp = await connectToPage();
    if (!cdp) {
      check('the app starts against the stub page', false, logs.join('').slice(-300));
    } else {
      await cdp.send('Runtime.enable', {}, 8000).catch(() => undefined);
      const deadline = Date.now() + 20000;
      let ready = false;
      while (Date.now() < deadline && !ready) {
        const state = await cdp.evaluateSoft('window.__ready === 1 && document.readyState === "complete"');
        ready = state.ok && state.value === true;
        if (!ready) await sleep(300);
      }
      if (!ready) check('the stub page finished loading', false);

      const bridge = await cdp.evaluateSoft(
        'JSON.stringify({ top: Object.keys(window.chatagent || {}).sort(), host: Object.keys((window.chatagent || {}).host || {}).sort(), window: Object.keys((window.chatagent || {}).window || {}).sort() })',
      );
      const shape = bridge.ok && bridge.value ? JSON.parse(bridge.value) : {};
      check(
        'the page bridge is the narrow one (no generic ipcRenderer passthrough)',
        // The surface is a fixed list, on purpose: adding a channel here has to be a
        // deliberate edit, so a new bridge member cannot slip in unnoticed.
        Array.isArray(shape.top) &&
          shape.top.join(',') === 'host,platform,versions,window' &&
          Array.isArray(shape.host) &&
          shape.host.join(',') === 'command,openWorkbench,quitApp' &&
          Array.isArray(shape.window) &&
          shape.window.join(',') === 'set',
        JSON.stringify(shape),
      );

      const unknown = await cdp
        .evaluate('window.chatagent.host.command({ type: "definitely-not-a-command" })')
        .catch((error) => ({ ok: false, error: error.message }));
      check(
        'an unknown host command is refused by the host, not accepted',
        unknown && unknown.ok !== true,
        JSON.stringify(unknown).slice(0, 200),
      );

      // 3. window.open must create nothing.
      await cdp
        .evaluateSoft(`window.__openResult = String(window.open(${JSON.stringify(FOREIGN)}, '_blank'))`)
        .catch(() => undefined);
      await sleep(1500);
      const targets = await httpGetJson(debugPort, '/json/list');
      const pages = Array.isArray(targets) ? targets.filter((item) => item.type === 'page') : [];
      check(
        'window.open to another origin creates no window or tab',
        pages.length === 1,
        `${pages.length} page target(s): ${pages.map((item) => item.url).join(', ')}`,
      );

      // 4. top-level navigation to another origin must be prevented.
      await cdp.evaluateSoft(`location.href = ${JSON.stringify(FOREIGN)}`).catch(() => undefined);
      await sleep(2000);
      const after = await cdp.evaluateSoft('location.href');
      check(
        'top-level navigation away from the app is prevented',
        after.ok && String(after.value).startsWith(serverUrl),
        String(after.value ?? after.error),
      );
      check(
        'the refused external link was not handed to the OS browser',
        logs.join('').includes('external link not opened'),
        logs.join('').split('\n').filter((line) => line.includes('external link')).slice(-1)[0] ?? '(no log line)',
      );
      // A page that tries to open a window still keeps its own context intact.
      const alive = await cdp.evaluateSoft('window.__ready === 1');
      check('the page is still the trusted shell page after both attempts', alive.ok && alive.value === true);

      // 6. Window controls: the page asks, the main process acts, and the answer carries the
      //    window's real state - so the UI (and this check) never has to trust a local flag.
      const windowBridge = await cdp.evaluateSoft(
        'typeof window.chatagent?.window?.set === "function"',
      );
      check(
        'the page can reach the window controls',
        windowBridge.ok && windowBridge.value === true,
        String(windowBridge.value ?? windowBridge.error),
      );

      const pinned = await cdp.evaluate('window.chatagent.window.set("pin")');
      check(
        'pinning reports the window as pinned',
        pinned?.ok === true && pinned.result?.pinned === true,
        JSON.stringify(pinned),
      );

      const status = await cdp.evaluate('window.chatagent.host.command({ type: "status" })');
      check(
        'the host status carries the window state',
        status?.ok === true && status.result?.window?.pinned === true,
        JSON.stringify(status?.result?.window ?? null),
      );

      const hidden = await cdp.evaluate('window.chatagent.window.set("hide")');
      check(
        'hiding the window is reported as not visible',
        hidden?.ok === true && hidden.result?.visible === false,
        JSON.stringify(hidden),
      );

      await cdp.evaluate('window.chatagent.window.set("show")');
      const unpinned = await cdp.evaluate('window.chatagent.window.set("unpin")');
      check(
        'showing and unpinning restore a normal window',
        unpinned?.ok === true && unpinned.result?.pinned === false && unpinned.result?.visible === true,
        JSON.stringify(unpinned),
      );

      // A window control takes a fixed verb; anything else is refused by name.
      const unknownAction = await cdp.evaluate('window.chatagent.window.set("move")');
      check(
        'an unknown window action is refused',
        unknownAction?.ok === false && unknownAction.error === 'unknown_action',
        JSON.stringify(unknownAction),
      );

      // 5. sanity: same-origin navigation is not blocked wholesale.
      await cdp.evaluateSoft(`location.href = ${JSON.stringify(`${serverUrl}/app.js`)}`).catch(() => undefined);
      await sleep(1500);
      const sameOrigin = await httpGetJson(debugPort, '/json/list');
      const urls = Array.isArray(sameOrigin) ? sameOrigin.filter((item) => item.type === 'page').map((item) => item.url) : [];
      check(
        'a same-origin navigation is still allowed (the guard is not a blanket block)',
        urls.some((url) => String(url).includes('/app.js')),
        urls.join(', '),
      );
    }
  } finally {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
    const deadline = Date.now() + 15000;
    while (child.exitCode === null && Date.now() < deadline) await sleep(200);
    stub.close();
  }

  const failed = results.filter((item) => !item.ok).length;
  console.log(`\n[gate7a-nav] ${results.length - failed}/${results.length} checks passed`);
  if (failed > 0) {
    const tail = logs.join('').slice(-600);
    if (tail.trim()) console.log(`[gate7a-nav] app log tail:\n${tail}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

void main();
