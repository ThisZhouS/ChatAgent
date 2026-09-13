#!/usr/bin/env node
/**
 * Restarts the ChatAgent server in the background.
 *
 * Usage:
 *   node scripts/restart-server.mjs                 # build-less restart on :8787
 *   node scripts/restart-server.mjs --port 8791
 *   node scripts/restart-server.mjs --no-kill       # start only when the port is free
 *
 * Why this exists: on Windows a plain `kill` on a bash pid does not reliably
 * stop the node process, so the port owner is resolved from `netstat` and
 * stopped explicitly. The script then waits for /health before reporting, and
 * records the real listener pid in Temp/server.pid.
 */
import { spawn, execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { mkdirSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const portArgIndex = args.indexOf('--port');
const port = portArgIndex === -1 ? Number(process.env.PORT ?? 8787) : Number(args[portArgIndex + 1]);
const shouldKill = !args.includes('--no-kill');
const entry = join(root, 'apps', 'server', 'dist', 'index.js');

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`invalid port: ${String(port)}`);
  process.exit(1);
}

/** Returns the pids listening on the given TCP port. */
function listenersOn(portNumber) {
  const pids = new Set();
  if (process.platform === 'win32') {
    let output = '';
    try {
      output = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
    } catch (error) {
      console.error(`netstat failed: ${error instanceof Error ? error.message : String(error)}`);
      return pids;
    }
    for (const line of output.split(/\r?\n/)) {
      if (!line.includes('LISTENING')) continue;
      const columns = line.trim().split(/\s+/);
      const local = columns[1] ?? '';
      const pid = columns[columns.length - 1] ?? '';
      if (local.endsWith(`:${portNumber}`) && /^\d+$/.test(pid) && pid !== '0') pids.add(pid);
    }
    return pids;
  }
  try {
    const output = execFileSync('lsof', ['-ti', `tcp:${portNumber}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    });
    for (const pid of output.split(/\s+/)) if (/^\d+$/.test(pid)) pids.add(pid);
  } catch {
    // lsof missing or nothing listening — treated as a free port
  }
  return pids;
}

function stop(pid) {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', pid, '/F'], { stdio: 'ignore' });
    else process.kill(Number(pid), 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/**
 * Probes /health once. Uses a one-shot connection (agent: false) so the process
 * can exit immediately afterwards without tripping the libuv handle assertion
 * that keep-alive sockets cause while node shuts down on Windows.
 */
function probeHealth(portNumber) {
  return new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port: portNumber, path: '/health', method: 'GET', agent: false, timeout: 3000 },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          raw += chunk;
        });
        response.on('end', () => {
          let body;
          try {
            body = JSON.parse(raw);
          } catch {
            body = undefined;
          }
          if (response.statusCode === 200 && body && body.ok === true) resolve({ ok: true, body });
          else resolve({ ok: false, error: `status=${response.statusCode} body=${raw.slice(0, 200)}` });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('health probe timed out')));
    req.on('error', (error) => resolve({ ok: false, error: error.message }));
    req.end();
  });
}

async function waitForHealth(portNumber, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    const result = await probeHealth(portNumber);
    if (result.ok) return result;
    lastError = result.error;
    await new Promise((done) => setTimeout(done, 400));
  }
  return { ok: false, error: lastError };
}

const before = listenersOn(port);
if (before.size > 0) {
  if (!shouldKill) {
    console.error(`port ${port} is already in use by pid(s) ${[...before].join(', ')}; pass without --no-kill to replace`);
    process.exit(1);
  }
  for (const pid of before) {
    const stopped = stop(pid);
    console.log(`${stopped ? 'stopped' : 'could not stop'} pid ${pid} on port ${port}`);
  }
  await new Promise((done) => setTimeout(done, 1200));
}

mkdirSync(join(root, 'Temp'), { recursive: true });
const logPath = join(root, 'Temp', 'server.log');
const logFd = openSync(logPath, 'a');

const child = spawn(process.execPath, [entry], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: process.env.HOST ?? '0.0.0.0',
  },
  detached: true,
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
});
child.unref();
// The child owns its own handle to the log; the parent must drop its copy or
// libuv reports a closing-handle assertion while shutting down on Windows.
closeSync(logFd);

const health = await waitForHealth(port);
const after = listenersOn(port);
if (health.ok) {
  const pid = [...after][0] ?? String(child.pid ?? 'unknown');
  writeFileSync(join(root, 'Temp', 'server.pid'), `${pid}\n`, 'utf8');
  console.log(`ChatAgent server listening on http://localhost:${port} (pid ${pid})`);
  console.log(`health: ${JSON.stringify(health.body)}`);
  console.log(`log: ${logPath}`);
  process.exit(0);
}

console.error(`server did not become healthy on port ${port}: ${health.error ?? 'unknown error'}`);
console.error(`log: ${logPath}`);
process.exit(1);
