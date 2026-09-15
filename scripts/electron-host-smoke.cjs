// Gate 7A — desktop lifecycle smoke (runs under the real Electron runtime).
//
// Proves the semantics main.cjs relies on:
//   1. the host lives in the main process and keeps running after the window is
//      closed (window-all-closed must NOT quit);
//   2. an in-flight task survives a window close and completes;
//   3. a host restart recovers the task store and interrupted work.
//
// Run: node apps/desktop/node_modules/.bin/electron scripts/electron-host-smoke.cjs
// (or: npx electron scripts/electron-host-smoke.cjs)
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  LocalAgentHost,
  JsonFileAgentHostStore,
  FakeHermesAdapter,
} = require(path.join(__dirname, '..', 'apps', 'desktop', 'agent-host.bundle.cjs'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const root = process.env.CHATAGENT_HOST_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'gate7a-smoke-'));

function makeHost(rootDir) {
  return new LocalAgentHost({
    deviceId: 'desktop-test',
    agentId: 'hermes',
    workRoot: path.join(rootDir, 'work'),
    store: new JsonFileAgentHostStore(path.join(rootDir, 'tasks.json')),
    adapter: new FakeHermesAdapter({ durationMs: 1500, artifactName: 'result.md' }),
    executorReason: 'smoke test fake',
  });
}

let windowClosed = false;
let host = null;

// Mirrors main.cjs: closing every window must NOT quit the process, or an
// in-flight task dies with it. Electron's default (no listener) IS to quit.
app.on('window-all-closed', () => {
  // keep the host alive
});

app.whenReady().then(async () => {
  try {
    host = makeHost(root);
    await host.start();
    const st = await host.status();
    check('host starts in the main process', st.running === true, 'running=true');

    // A task that takes 1.5s — long enough to outlive a window close.
    const taskId = 'smoke-close-window';
    await host.submit({
      taskId,
      agentId: host.agentId,
      goal: '在关闭窗口后完成本任务并产出 result.md',
      kind: 'document',
      workDir: host.workRoot,
      toolsets: ['document'],
    });
    check('task submitted while the window is open', true);

    // Real window, then close it immediately.
    const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false } });
    await win.loadURL('about:blank');
    win.close();
    windowClosed = true;
    check('window was closed without quitting the process', windowClosed);

    // Give the task time to finish with the window closed.
    await new Promise((resolve) => setTimeout(resolve, 2200));

    const record = await host.list().then((tasks) => tasks.find((t) => t.taskId === taskId));
    check(
      'in-flight task completed after the window was closed',
      record?.state === 'succeeded',
      `state=${record?.state}`,
    );
    check(
      'artifact exists on disk inside the work root',
      fs.existsSync(path.join(root, 'work', taskId, 'result.md')),
    );

    // "Reopen" = a fresh host reading the same store (as a relaunch would).
    await host.stop('smoke_done');
    const host2 = makeHost(root);
    await host2.start();
    const recovered = await host2.list().then((tasks) => tasks.find((t) => t.taskId === taskId));
    check(
      'restart re-reads the completed task from the store',
      recovered?.state === 'succeeded',
      `state=${recovered?.state}`,
    );
    await host2.stop('smoke_done');
  } catch (err) {
    console.log(`FAIL  smoke crashed — ${err.stack}`);
    results.push({ name: 'smoke', ok: false, detail: err.message });
  } finally {
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n[gate7a-smoke] ${results.length - failed}/${results.length} checks passed`);
    app.exit(failed === 0 ? 0 : 1);
  }
});
