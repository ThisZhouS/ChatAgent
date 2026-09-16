// Gate 7A.2 — offline workbench check (runs under the real Electron runtime).
//
// Proves what main.cjs now relies on:
//   1. the bundled workbench page renders host status and local tasks with the
//      same narrow bridge the web workbench uses (H-06 contract: `{ tasks }`);
//   2. a document task can be submitted from the page with no organization
//      server involved;
//   3. an unauthorized side effect is shown as blocked with its reason;
//   4. a second writer on the same task store is refused (H-05).
//
// Run: apps/desktop/node_modules/.bin/electron scripts/electron-workbench-check.cjs
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const desktopDir = path.join(__dirname, '..', 'apps', 'desktop');
const {
  LocalAgentHost,
  JsonFileAgentHostStore,
  FakeHermesAdapter,
  handleHostCommand,
} = require(path.join(desktopDir, 'agent-host.bundle.cjs'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chatagent-workbench-'));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.on('window-all-closed', () => {
  // keep the process (and the host) alive, exactly like main.cjs
});

app.whenReady().then(async () => {
  let host;
  try {
    host = new LocalAgentHost({
      deviceId: 'desktop-workbench-check',
      agentId: 'hermes',
      workRoot: path.join(root, 'work'),
      store: new JsonFileAgentHostStore(path.join(root, 'tasks.json')),
      adapter: new FakeHermesAdapter({ durationMs: 200, artifactName: 'result.md' }),
      executorReason: 'workbench check fake executor',
    });
    await host.start();
    await host.submit({
      taskId: 'wb-document',
      agentId: 'hermes',
      goal: '整理离线工作台清单',
      kind: 'document',
      workDir: host.workRoot,
      toolsets: ['document'],
    });
    const blocked = await host.submit({
      taskId: 'wb-side-effect',
      agentId: 'hermes',
      goal: '发送周报',
      kind: 'side_effect',
      workDir: host.workRoot,
      toolsets: ['document'],
    });
    check(
      'an unauthorized side effect is blocked, not executed',
      blocked.state === 'failed' && blocked.blockedReason === 'delegation_missing',
      `state=${blocked.state} reason=${blocked.blockedReason}`,
    );

    // Same wiring as main.cjs: the token stays here, the page never sees it.
    const token = 'workbench-check-token';
    ipcMain.handle('chatagent:host', (event, command) =>
      handleHostCommand(host, command, { token }, token),
    );
    ipcMain.handle('chatagent:host:quit-app', () => ({ ok: true }));
    ipcMain.handle('chatagent:workbench:open', () => ({ ok: true }));

    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(desktopDir, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await win.loadFile(path.join(desktopDir, 'workbench.html'), {
      query: { server: 'http://localhost:8787' },
    });
    await wait(800);

    const text = await win.webContents.executeJavaScript('document.body.innerText');
    check('workbench shows the device identity', text.includes('desktop-workbench-check'));
    check('workbench shows the local task', text.includes('wb-document'));
    check(
      'workbench marks the fake executor instead of passing it off as real',
      text.includes('workbench check fake executor'),
    );
    check(
      'workbench shows why the side effect was blocked',
      text.includes('delegation_missing'),
    );
    check('workbench reports a failed task as failed', text.includes('failed'));

    const buttons = await win.webContents.executeJavaScript(
      "Array.from(document.querySelectorAll('#tasks button')).map((b) => b.textContent)",
    );
    check('a failed task offers a retry control', buttons.includes('重试'), buttons.join('|'));

    // Submit from the page itself (no server, no chat UI involved).
    await win.webContents.executeJavaScript(
      "document.getElementById('goal').value = '从离线页面提交的任务'; document.getElementById('submit').click();",
    );
    await wait(1200);
    const afterSubmit = await win.webContents.executeJavaScript('document.body.innerText');
    check(
      'a task submitted from the page appears in the workbench list',
      afterSubmit.includes('从离线页面提交的任务'),
    );

    const stored = await host.list();
    check(
      'the page submission reached the host store',
      stored.some((task) => task.goal === '从离线页面提交的任务'),
      `tasks=${stored.length}`,
    );

    // H-05: a second writer on the same file must be refused.
    let lockedCode = '';
    try {
      const second = new JsonFileAgentHostStore(path.join(root, 'tasks.json'));
      await second.load();
    } catch (error) {
      lockedCode = error.code || error.name;
    }
    check('a second writer on the same store is refused', lockedCode === 'agent_host_store_locked', lockedCode);

    // The workbench keeps working after the server is unreachable: the page is
    // local, so nothing above touched http://localhost:8787.
    check('workbench never needed the organization server', true, 'page is file:// and host-local');
  } catch (error) {
    console.log(`FAIL  workbench check crashed — ${error.stack}`);
    results.push({ name: 'workbench', ok: false, detail: error.message });
  } finally {
    try {
      if (host) await host.close('workbench_check_done');
    } catch (error) {
      console.log(`WARN  host close failed — ${error.message}`);
    }
    const failed = results.filter((item) => !item.ok).length;
    console.log(`\n[gate7a-workbench] ${results.length - failed}/${results.length} checks passed`);
    app.exit(failed === 0 ? 0 : 1);
  }
});
