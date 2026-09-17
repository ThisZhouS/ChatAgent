#!/usr/bin/env node
/**
 * Gate 7A.2 remainder — continuous receipt sync check (real Electron app).
 *
 * Starts a stub organization server *in this process* (no project server, no
 * network) and drives the real desktop app against it:
 *   1. the app starts the local agent host and syncs changed tasks by itself
 *      (no settings page needed), carrying the session cookie;
 *   2. a receipt is sent once per task version — an unchanged task is not re-sent;
 *   3. a server failure (500) keeps the receipt queued and retries later;
 *   4. a task whose verified delegation names another owner is uploaded with that
 *      ownerId, so the server can refuse a foreign claim;
 *   5. nothing is lost when the app quits before the server recovers: the queue
 *      lives on disk and the next launch sends it.
 *
 * Usage: node scripts/electron-receipt-sync-check.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const debugPort = Number(argValue('--debug-port', '9346'));
const serverPort = Number(argValue('--server-port', '8793'));
const stateDir = join(root, 'Temp', 'receipt-sync-check');
const hostRootDir = join(stateDir, 'host');
const profileDir = join(stateDir, 'profile');
// The runtime can be pointed elsewhere with CHATAGENT_ELECTRON_BIN so an upgrade
// (or a beta) can be rehearsed against the real checks without touching the pin.
const devElectron =
  process.env.CHATAGENT_ELECTRON_BIN ||
  join(root, 'apps', 'desktop', 'node_modules', 'electron', 'dist', 'electron.exe');
const serverUrl = `http://127.0.0.1:${serverPort}`;
const COOKIE = 'chatagent_session=stub-session-token';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

// ---- stub organization server ------------------------------------------------
const posts = [];
const authorizationAsks = [];
let failNext = 1; // the first sync attempt gets a 500 on purpose
const stub = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/agent-authorizations/verify') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        payload = undefined;
      }
      authorizationAsks.push({ cookie: req.headers.cookie ?? '', payload, at: Date.now() });
      res.writeHead(200, { 'content-type': 'application/json' });
      // The stub keeps no ledger for delegations, exactly like the real server.
      res.end(
        JSON.stringify({
          supportedKinds: ['approval'],
          results: (payload?.grants ?? [])
            .filter((grant) => grant.kind === 'approval')
            .map((grant) => ({ id: grant.id, kind: 'approval', status: 'active' })),
        }),
      );
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/local-tasks') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        payload = undefined;
      }
      const record = { cookie: req.headers.cookie ?? '', payload, at: Date.now(), status: 0 };
      if (failNext > 0) {
        failNext -= 1;
        record.status = 500;
        posts.push(record);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"stub failure"}');
        return;
      }
      record.status = 200;
      posts.push(record);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"accepted":1}');
    });
    return;
  }
  // Anything else is the page the app loads: hand out a session cookie so the
  // sync path has the same credential a logged-in user would have.
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'set-cookie': `${COOKIE}; Path=/; HttpOnly`,
  });
  res.end('<!doctype html><meta charset="utf-8"><title>stub</title><p>stub server</p>');
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

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${label}${last ? ` (last: ${JSON.stringify(last).slice(0, 200)})` : ''}`);
}

function launchApp() {
  return spawn(
    devElectron,
    [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`, resolve(root, 'apps', 'desktop')],
    {
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, CHATAGENT_SERVER_URL: serverUrl, CHATAGENT_HOST_ROOT: hostRootDir },
    },
  );
}

async function main() {
  rmSync(stateDir, { recursive: true, force: true });
  mkdirSync(hostRootDir, { recursive: true });
  if (!existsSync(devElectron)) {
    console.log('SKIP  no Electron runtime available');
    process.exit(0);
  }

  // Seed one finished task that claims a delegation owner: the sync must upload
  // the *verified* owner instead of assuming the logged-in member.
  const seeded = {
    taskId: 'seeded-delegated',
    deviceId: 'desktop-seed',
    agentId: 'hermes',
    goal: '别人委托的本机任务',
    kind: 'document',
    state: 'succeeded',
    version: 3,
    workDir: join(hostRootDir, 'work'),
    toolsets: ['document'],
    artifacts: [],
    attempts: 1,
    maxAttempts: 2,
    delegation: {
      id: 'delegation-1',
      ownerId: 'member-alice',
      agentId: 'hermes',
      deviceId: 'desktop-seed',
      expiresAt: '2030-01-01T00:00:00.000Z',
      capabilities: ['document'],
    },
    summary: '已完成',
    createdAt: '2026-09-16T10:00:00.000Z',
    updatedAt: '2026-09-16T10:05:00.000Z',
  };
  writeFileSync(join(hostRootDir, 'tasks.json'), JSON.stringify([seeded], null, 2), 'utf8');

  await new Promise((resolvePromise) => stub.listen(serverPort, '127.0.0.1', resolvePromise));
  check('stub organization server is up (offline test double, no project server)', true, serverUrl);

  let child = launchApp();
  let exited = false;
  child.on('exit', () => {
    exited = true;
  });

  try {
    const cdp = await connectToPage();
    check('the desktop app starts against the stub server', Boolean(cdp));
    if (!cdp) throw new Error('no page');
    await cdp.send('Runtime.enable');

    const hasSeed = (post) => (post.payload?.receipts ?? []).some((r) => r.taskId === 'seeded-delegated');

    // 1. The app syncs by itself: no settings page is opened by this script.
    const firstAttempt = await waitFor(async () => posts.find(hasSeed), 45000, 'the seeded receipt to be uploaded');
    check(
      'a stored local task is uploaded automatically (no page needed)',
      firstAttempt.status === 500,
      `first attempt status=${firstAttempt.status} (stub answers 500 on purpose)`,
    );

    // The page load is what hands the profile its session cookie, so the retry
    // (after the same 500) is the attempt that carries the credential.
    const accepted = await waitFor(
      async () => posts.find((post) => hasSeed(post) && post.status === 200),
      90000,
      'the sync to retry and succeed after the stub failure',
    );
    check('the sync retries by itself after a server failure', Boolean(accepted), `attempts=${posts.length}`);
    const acceptedReceipt = accepted.payload.receipts.find((r) => r.taskId === 'seeded-delegated');
    check(
      'the retried receipt carries the session cookie of the signed-in profile',
      accepted.cookie.includes('chatagent_session=stub-session-token'),
      accepted.cookie ? accepted.cookie.slice(0, 60) : '(no cookie)',
    );
    check(
      'the receipt claims the owner the device verified, not the caller',
      acceptedReceipt.ownerId === 'member-alice',
      `ownerId=${acceptedReceipt.ownerId}`,
    );
    check(
      'the receipt keeps the honest terminal state and summary',
      acceptedReceipt.state === 'succeeded' && acceptedReceipt.summary === '已完成',
      `state=${acceptedReceipt.state}`,
    );


    // 2. Dedupe: an unchanged task must not be uploaded again (retries for the
    //    failed attempt do not count — only accepted uploads do).
    const acceptedBefore = posts.filter((post) => hasSeed(post) && post.status === 200).length;
    const syncState = await cdp.evaluate('window.chatagent.host.command({ type: "status" })');
    check(
      'status exposes the receipt queue state to the UI',
      syncState?.ok === true && syncState.result?.receiptSync !== undefined,
      JSON.stringify(syncState?.result?.receiptSync ?? null),
    );
    // Continuous authorization refresh is wired into the real app: the host only
    // reports this block when a verifier is configured, and with no grants held
    // the loop must stay quiet instead of polling the organization service.
    const authorization = syncState?.result?.authorization ?? null;
    check(
      'status reports the continuous authorization refresh state',
      authorization !== null && authorization.state === 'idle' && authorization.checks === 0,
      JSON.stringify(authorization),
    );
    check(
      'no authorization question is asked while the device holds no grants',
      authorizationAsks.length === 0,
      `asks=${authorizationAsks.length}`,
    );

    // Shell hardening travels with the same status payload: the remote page runs
    // in its own persistent partition and the desktop supplies the security
    // headers when the server does not.
    const shell = syncState?.result?.shell ?? {};
    check(
      'the remote workbench uses its own persistent session partition',
      shell.partition === 'persist:chatagent-workbench',
      `partition=${shell.partition}`,
    );
    check(
      'the desktop injected a CSP for a server response that had none',
      Number(shell.cspInjected) >= 1 && Number(shell.remoteResponses) >= 1,
      `responses=${shell.remoteResponses} injected=${shell.cspInjected} fromServer=${shell.cspFromServer}`,
    );
    const pageTitle = await cdp.evaluate('document.title');
    check('the page still renders under the injected policy', pageTitle === 'stub', `title=${pageTitle}`);
    await sleep(35000); // one full sync interval with nothing changed
    const acceptedAfter = posts.filter((post) => hasSeed(post) && post.status === 200).length;
    check(
      'an unchanged task is not uploaded a second time (per-version dedupe)',
      acceptedAfter === acceptedBefore,
      `accepted uploads ${acceptedBefore} -> ${acceptedAfter}`,
    );

    // 3. A new local task is picked up while the app runs.
    const taskId = `live-${Date.now()}`;
    await cdp.evaluate(
      `window.chatagent.host.command({ type: 'submit', taskId: ${JSON.stringify(taskId)}, goal: '运行时新增任务', kind: 'document', toolsets: ['document'] })`,
    );
    await waitFor(
      async () => posts.some((post) => (post.payload?.receipts ?? []).some((r) => r.taskId === taskId)),
      60000,
      'the new task to be synced',
    );
    const livePost = posts.findLast((post) => post.payload.receipts.some((r) => r.taskId === taskId));
    const liveReceipt = livePost.payload.receipts.find((r) => r.taskId === taskId);
    check('a task created while running is synced too', Boolean(liveReceipt), `state=${liveReceipt?.state}`);
    check(
      'local-only work carries no owner claim (nothing to bind)',
      liveReceipt.ownerId === undefined,
      `ownerId=${String(liveReceipt.ownerId)}`,
    );

    // 4. Queue survives a quit: fail the server, quit, restart, and the next
    //    launch must deliver what the previous one could not.
    failNext = 99;
    const queuedId = `offline-${Date.now()}`;
    await cdp.evaluate(
      `window.chatagent.host.command({ type: 'submit', taskId: ${JSON.stringify(queuedId)}, goal: '离线期间的任务', kind: 'document', toolsets: ['document'] })`,
    );
    await waitFor(
      async () => posts.some((post) => post.payload.receipts.some((r) => r.taskId === queuedId)),
      60000,
      'the offline task to be attempted',
    );
    await cdp.evaluate('window.chatagent.host.quitApp()').catch(() => undefined);
    const deadline = Date.now() + 20000;
    while (!exited && Date.now() < deadline) await sleep(200);
    check('the app quits even with the server failing', exited);

    const queueFile = join(hostRootDir, 'receipts-sync.json');
    let queue;
    try {
      queue = JSON.parse(readFileSync(queueFile, 'utf8'));
    } catch (error) {
      check('the offline queue is kept on disk', false, error.message);
    }
    if (queue) {
      check(
        'the unfinished receipt is still queued on disk (nothing lost)',
        Boolean(queue.pending && queue.pending[queuedId]),
        `pending=${Object.keys(queue.pending ?? {}).length}`,
      );
      check('the already-synced task is not queued again', !queue.pending['seeded-delegated']);
    }

    // 5. Next launch delivers the queue.
    failNext = 0;
    posts.length = 0;
    exited = false;
    child = launchApp();
    child.on('exit', () => {
      exited = true;
    });
    const cdp2 = await connectToPage();
    check('the app restarts with the queue on disk', Boolean(cdp2));
    const delivered = await waitFor(
      async () => posts.some((post) => post.payload.receipts.some((r) => r.taskId === queuedId)),
      60000,
      'the queued receipt to be delivered after restart',
    );
    check('a receipt queued offline is delivered by the next launch', Boolean(delivered));
    await cdp2.evaluate('window.chatagent.host.quitApp()').catch(() => undefined);
  } catch (error) {
    check(`receipt sync check crashed — ${error.message}`, false);
  } finally {
    if (!exited) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    stub.close();
    const failed = results.filter((item) => !item.ok).length;
    console.log(`\n[gate7a-receipt-sync] ${results.length - failed}/${results.length} checks passed`);
    process.exit(failed === 0 ? 0 : 1);
  }
}

void main();
