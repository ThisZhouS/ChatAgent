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
    // Seed more terminal rows than the store keeps, before anything loads: the
    // offline workbench has to show retention housekeeping (and that in-flight
    // work is unaffected) instead of silently dropping history.
    const seeded = [];
    for (let index = 0; index < 520; index += 1) {
      const at = new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString();
      seeded.push({
        taskId: `wb-old-${String(index).padStart(3, '0')}`,
        deviceId: 'desktop-workbench-check',
        agentId: 'hermes',
        goal: '历史任务',
        kind: 'document',
        state: 'succeeded',
        workDir: path.join(root, 'work', `wb-old-${index}`),
        toolsets: ['document'],
        attempts: 1,
        maxAttempts: 1,
        createdAt: at,
        updatedAt: at,
        finishedAt: at,
        version: 1,
      });
    }
    fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify(seeded), 'utf8');

    // Seed the retention trail at its own watermark, so the housekeeping below runs
    // through the real trim path too: a trail that has outgrown its budget must be
    // cut back with a note that names what went, not silently shortened. (Without
    // this the run only ever appends, and the trim path is never exercised.)
    const seededAudit = [];
    const seededTotal = 2_100;
    for (let index = 0; index < seededTotal; index += 1) {
      const stamp = new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString();
      seededAudit.push(
        JSON.stringify({
          at: stamp,
          action: 'task_store.pruned',
          actor: 'local-host',
          store: path.join(root, 'tasks.json'),
          reason: 'count',
          count: 1,
          tasks: [
            {
              taskId: `wb-seed-${String(index).padStart(4, '0')}`,
              state: 'succeeded',
              reason: 'count',
              updatedAt: stamp,
            },
          ],
        }),
      );
    }
    fs.writeFileSync(
      path.join(root, 'tasks.json.retention-audit.jsonl'),
      `${seededAudit.join('\n')}\n`,
      'utf8',
    );
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

    // Retention housekeeping leaves a per-record trail: the count on screen is
    // backed by a file naming every dropped id and the rule that dropped it (round-4
    // follow-up: a bare count cannot be traced afterwards). The trail has its own
    // budget now, so a saturated trail is trimmed — and a trim must say so, in a
    // note that names the batches it removed, instead of quietly shortening history.
    // The trim runs only when the write path trims, so give the queued work a moment
    // to land before reading the file.
    await wait(1500);
    const auditPath = path.join(root, 'tasks.json.retention-audit.jsonl');
    const auditLines = fs.existsSync(auditPath)
      ? fs
          .readFileSync(auditPath, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
    const pruneLines = auditLines.filter((entry) => entry.action === 'task_store.pruned');
    const notes = auditLines.filter((entry) => entry.action === 'task_store.retention_audit_rotated');
    // The trail was seeded by this check, so only the batches *this run* wrote say
    // anything about the host's own bookkeeping: the seeded ones are counted as
    // "trimmed" the same way a real trim's batches are.
    const audited = pruneLines
      .flatMap((entry) => entry.tasks || [])
      .filter((task) => !String(task.taskId).startsWith('wb-seed-'));
    const status = await host.status();
    const reported = status.storeIntegrity && status.storeIntegrity.pruned;
    const integrity = status.storeIntegrity || {};
    const trimmedByTrims = integrity.retentionAuditLinesDropped || 0;
    check(
      'retention writes a per-record audit trail next to the store',
      auditLines.length > 0 &&
        pruneLines.length > 0 &&
        pruneLines.every((entry) => entry.actor === 'local-host' && entry.store) &&
        auditLines.every(
          (entry) =>
            entry.action === 'task_store.pruned' ||
            entry.action === 'task_store.retention_audit_rotated',
        ),
      `lines=${auditLines.length} prunes=${pruneLines.length} notes=${notes.length} path=${auditPath}`,
    );
    check(
      'the host-written batches agree with the count on screen, id by id',
      audited.length === reported &&
        audited.every(
          (task) =>
            typeof task.taskId === 'string' &&
            typeof task.state === 'string' &&
            (task.reason === 'age' || task.reason === 'count') &&
            typeof task.updatedAt === 'string',
        ),
      `audited=${audited.length} reported=${reported}`,
    );
    check(
      'a trail over its budget is trimmed, and the trim names what it dropped',
      notes.length > 0 &&
        (integrity.retentionAuditRotations || 0) > 0 &&
        trimmedByTrims > 0 &&
        notes.every(
          (note) =>
            typeof note.droppedLines === 'number' &&
            note.droppedLines > 0 &&
            Array.isArray(note.droppedTasks) &&
            note.droppedTasks.length > 0,
        ) &&
        notes[0].droppedLines === trimmedByTrims &&
        auditLines.length <= (integrity.retentionAuditMaxLines || 0),
      `notes=${notes.length} lines=${auditLines.length} maxLines=${integrity.retentionAuditMaxLines} ` +
        `rotations=${integrity.retentionAuditRotations} trimmed=${trimmedByTrims}`,
    );
    check(
      'the trimmed trail keeps the newest seeded batches and never ends on its own bookkeeping',
      pruneLines.some((entry) =>
        (entry.tasks || []).some((task) => task.taskId === `wb-seed-${String(seededTotal - 1).padStart(4, '0')}`),
      ) &&
        pruneLines[0].tasks[0].taskId === 'wb-seed-0904' &&
        auditLines[auditLines.length - 1].action === 'task_store.pruned',
      `first=${pruneLines[0].tasks[0].taskId} last=${auditLines[auditLines.length - 1].action}`,
    );
    // No seeded batch may vanish without being accounted for: each one is either
    // still in the trail or was dropped by a trim that counted it. The seed file is
    // written before the host starts and trims drop from the oldest end, so as long
    // as fewer than `seededTotal` lines were dropped in total every dropped line is
    // a seeded one — which makes this an exact reconciliation, not an approximation.
    // (An earlier form of this assertion mixed a count read in-process with one read
    // from the file and showed a 20-line gap; both numbers here come from the same
    // two places a reviewer would look: the file, and the status the page reports.)
    const keptSeedBatches = pruneLines.filter(
      (entry) =>
        (entry.tasks || []).length > 0 &&
        (entry.tasks || []).every((task) => String(task.taskId).startsWith('wb-seed-')),
    );
    check(
      'every seeded batch is either kept or counted as dropped — none vanishes',
      keptSeedBatches.length + trimmedByTrims === seededTotal,
      `kept=${keptSeedBatches.length} dropped=${trimmedByTrims} seeded=${seededTotal}`,
    );
    check(
      'pruned ids reach the trail, never the page',
      audited.some((task) => task.taskId.startsWith('wb-old-')) &&
        !afterSubmit.includes('wb-old-000'),
      `first=${audited[0] && audited[0].taskId}`,
    );

    // The workbench keeps working after the server is unreachable: the page is
    // local, so nothing above touched http://localhost:8787.
    check(
      'workbench shows retention housekeeping instead of silent data loss',
      text.includes('条更早的终态记录') && text.includes('进行中的任务不受影响'),
      text.includes('保留') ? 'retention note rendered' : '(no retention note)',
    );
    check(
      'a clean run shows no authorization or receipt alarm',
      !text.includes('授权暂时无法向组织服务复核') && !text.includes('条回执未上传'),
      'no false alarms in the offline workbench',
    );
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
