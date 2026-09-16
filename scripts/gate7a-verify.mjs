// Gate 7A — end-to-end verification of the local Agent Host (host level, no GUI).
//
// Drives the real classes (store, sandbox, adapter, IPC handler) exactly as the
// desktop main process does, and prints a PASS/BLOCKED line per required flow.
//
// Run: node scripts/gate7a-verify.mjs
import { mkdtemp, rm, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { LocalAgentHost, JsonFileAgentHostStore, FakeHermesAdapter, HermesProcessAdapter,
  handleHostCommand, resolveHermesToolsets, isInside, assertInsideWorkRoot,
  writeFileIfUnchanged, sha256Of, fileSha256 } = require(join(here, '..', 'apps', 'desktop', 'agent-host.bundle.cjs'));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS  ' : 'FAIL  '}${name}${detail ? ` — ${detail}` : ''}`);
}
function blocked(name, detail) {
  results.push({ name, ok: 'blocked', detail });
  console.log(`BLOCKED ${name} — ${detail}`);
}

const ROOT = await mkdtemp(join(tmpdir(), 'gate7a-verify-'));
const HERMES_EXE = process.env.CHATAGENT_HERMES_EXE;
const TOKEN = 'verify-token-0123456789abcdef';
const ctx = { token: TOKEN };

function makeHost(adapter, { workRoot = join(ROOT, 'work'), store = join(ROOT, 'tasks.json') } = {}) {
  return new LocalAgentHost({
    deviceId: 'desktop-verify',
    agentId: 'hermes',
    workRoot,
    store: new JsonFileAgentHostStore(store),
    adapter,
    executorReason: adapter.kind === 'fake' ? 'offline fake for verification' : '',
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitState(host, taskId, states, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    const tasks = await host.list();
    const t = tasks.find((x) => x.taskId === taskId);
    if (t && states.includes(t.state)) return t;
    last = t;
    await sleep(30);
  }
  return last;
}

// ---- Flow 1: single device, one task, artifact with hash --------------------
{
  const host = makeHost(new FakeHermesAdapter({ durationMs: 200, artifactName: 'report.md' }));
  await host.start();
  const res = await handleHostCommand(
    host,
    { type: 'submit', taskId: 'f1', goal: '生成本地演示报告', kind: 'document', toolsets: ['document'] },
    ctx,
    TOKEN,
  );
  const done = await waitState(host, 'f1', ['succeeded', 'failed']);
  const artifact = done?.artifacts?.[0];
  check(
    'Flow1 单设备任务成功且带哈希产物',
    res.ok === true && done?.state === 'succeeded' && !!artifact?.sha256,
    `state=${done?.state} artifact=${artifact?.name ?? 'none'} executor=${done?.executor ?? '?'}`,
  );
  if (artifact?.sha256) {
    const onDisk = await fileSha256(join(host.workRoot, 'f1', artifact.name));
    check('Flow1 产物哈希与磁盘一致', onDisk === artifact.sha256);
  }
  await host.close('done');
}

// ---- Flow 2+3: UI 与 Agent 并行；关闭 UI 任务继续 ---------------------------
// Host-level: a long task keeps running while "the UI" (this script) does other
// work, and survives an explicit host stop/restart (reopen). The real Electron
// close-window continuity is covered by scripts/electron-host-smoke.cjs.
{
  const storePath = join(ROOT, 'tasks-f23.json');
  const host = makeHost(new FakeHermesAdapter({ durationMs: 1200, artifactName: 'result.md' }), { store: storePath });
  await host.start();
  await host.submit({
    taskId: 'f23', agentId: host.agentId, goal: '长任务', kind: 'document',
    workDir: host.workRoot, toolsets: ['document'],
  });
  const mid = await waitState(host, 'f23', ['running', 'succeeded', 'failed']);
  check('Flow2 UI 并行：任务进入 running 后 UI 仍可查状态', mid?.state === 'running', `state=${mid?.state}`);
  const statusWhileRunning = await host.status();
  check('Flow2 UI 并行：runningTasks>0 且 host running', statusWhileRunning.running === true && statusWhileRunning.runningTasks > 0);
  // Simulate the host going away mid-run: the record must be interrupted/
  // cancelled — never "succeeded" (a window close in the real app keeps the
  // host alive — proven by the electron smoke).
  await host.close('ui_closed_simulation'); // release the lock: host2 reopens this store
  const afterStop = await waitState(host, 'f23', ['interrupted', 'cancelled', 'failed', 'succeeded'], 2000);
  check('Flow3 中断不写 completed', afterStop?.state === 'interrupted' || afterStop?.state === 'cancelled',
    `state=${afterStop?.state}`);
  // reopen = a fresh host on the same store (as a relaunch would)
  const host2 = makeHost(new FakeHermesAdapter({ durationMs: 400, artifactName: 'result.md' }), { store: storePath });
  await host2.start();
  const reopened = await host2.list().then((t) => t.find((x) => x.taskId === 'f23'));
  check('Flow3 重新打开后状态/结果仍在（已记录中断）',
    reopened?.state === 'interrupted' || reopened?.state === 'cancelled',
    `state=${reopened?.state}`);
  await host2.close('done');
}

// ---- Flow 4: 主机故障绝不写 completed ---------------------------------------
{
  const storePath = join(ROOT, 'tasks-f4.json');
  const host = makeHost(new FakeHermesAdapter({ durationMs: 1500 }), { store: storePath });
  await host.start();
  await host.submit({
    taskId: 'f4', agentId: host.agentId, goal: '会被故障打断', kind: 'document',
    workDir: host.workRoot, toolsets: ['document'],
  });
  await waitState(host, 'f4', ['running', 'succeeded', 'failed']);
  // crash: stop() without letting the adapter finish. recoverInterrupted() on
  // the next start does the same job for a hard process kill.
  await host.close('host_crash'); // release the lock: host2 reopens this store
  const host2 = makeHost(new FakeHermesAdapter({ durationMs: 100 }), { store: storePath });
  await host2.start();
  const rec = await host2.list().then((t) => t.find((x) => x.taskId === 'f4'));
  check('Flow4 主机故障后状态为 interrupted/cancelled（绝不 completed）',
    rec?.state === 'interrupted' || rec?.state === 'cancelled',
    `state=${rec?.state}`);
  await host2.close('done');
}

// ---- Flow 5: 暂停 / 继续 / 取消 ----------------------------------------------
{
  const host = makeHost(new FakeHermesAdapter({ durationMs: 600, artifactName: 'x.md' }));
  await host.start();
  host.pause();
  const paused = await handleHostCommand(host, { type: 'status' }, ctx, TOKEN);
  check('Flow5 pause：状态 paused=true', (paused.result?.paused) === true);
  host.resume();
  const resumed = await handleHostCommand(host, { type: 'status' }, ctx, TOKEN);
  check('Flow5 resume：状态 paused=false', (resumed.result?.paused) === false);
  await host.submit({
    taskId: 'f5', agentId: host.agentId, goal: '将被取消', kind: 'document',
    workDir: host.workRoot, toolsets: ['document'],
  });
  await waitState(host, 'f5', ['running', 'succeeded', 'failed']);
  const cancelRes = await handleHostCommand(host, { type: 'cancel', taskId: 'f5' }, ctx, TOKEN);
  const rec = await waitState(host, 'f5', ['cancelled', 'succeeded', 'failed', 'interrupted']);
  check('Flow5 cancel：任务进入 cancelled', cancelRes.ok === true && rec?.state === 'cancelled', `state=${rec?.state}`);
  await host.close('done');
}

// ---- Flow 6: 工作目录与哈希安全 ----------------------------------------------
{
  const workRoot = join(ROOT, 'work6');
  let refused = false;
  try {
    await assertInsideWorkRoot(workRoot, join(workRoot, '..', 'escape'));
  } catch {
    refused = true;
  }
  check('Flow6 工作目录逃逸被拒绝', refused);

  const dir = join(ROOT, 'hashcheck');
  await mkdir(dir, { recursive: true });
  const f = join(dir, 'doc.md');
  await writeFile(f, 'v1');
  const b1 = await fileSha256(f); // baseline = digest of the on-disk content
  const r1 = await writeFileIfUnchanged(f, 'v2', b1);
  const afterOverwrite = await readFile(f, 'utf8');
  check('Flow6 基线一致时原地覆盖写', r1.written === true && afterOverwrite === 'v2');
  const r2 = await writeFileIfUnchanged(f, 'v3', b1); // stale baseline
  const content = await readFile(f, 'utf8');
  check('Flow6 基线过期时写入版本文件、原文件不动',
    r2.written === true && !!r2.versioned && content === 'v2' && (await stat(r2.versioned)).isFile());
}

// ---- Flow 7: 绝不重复执行（同一任务仅执行一次） ------------------------------
{
  let runs = 0;
  const counting = {
    kind: 'fake',
    run: async (request) => {
      runs += 1;
      return new FakeHermesAdapter({ durationMs: 300, artifactName: 'once.md' }).run(request);
    },
  };
  const host = makeHost(counting);
  await host.start();
  const task = {
    taskId: 'f7', agentId: host.agentId, goal: '只执行一次', kind: 'document',
    workDir: host.workRoot, toolsets: ['document'],
  };
  await host.submit(task);
  await host.submit(task); // same taskId submitted twice
  const done = await waitState(host, 'f7', ['succeeded', 'failed']);
  await sleep(200); // give a rogue second run time to appear
  check('Flow7 同一任务提交两次仅执行一次', done?.state === 'succeeded' && runs === 1,
    `state=${done?.state} runs=${runs}`);
  await host.close('done');
}

// ---- Flow 8: 独立第三方（Hermes 契约）----------------------------------------
{
  // fail-closed toolset mapping (the adapter never runs forbidden capabilities)
  const mapped = resolveHermesToolsets(['document', 'terminal', 'code_execution', 'browser']);
  check('Flow8 被禁工具集被 fail-closed 拒绝',
    mapped.invalid.includes('terminal') && mapped.invalid.includes('code_execution') && mapped.invalid.includes('browser'),
    `invalid=[${mapped.invalid.join(',')}] granted=[${mapped.toolsets.join(',')}]`);

  // IPC schema 校验
  const host = makeHost(new FakeHermesAdapter({ durationMs: 1 }));
  await host.start();
  const badSchema = await handleHostCommand(host, { type: 'explode' }, ctx, TOKEN);
  check('Flow8 IPC schema 校验拒绝未知命令', badSchema.ok === false && badSchema.error === 'invalid_command');

  // 令牌闸门
  const noToken = await handleHostCommand(host, { type: 'status' }, ctx, 'wrong-token');
  check('Flow8 错误设备令牌被拒绝', noToken.ok === false && noToken.error === 'unauthorized');

  // 工作目录边界（host 不允许 UI 指向任意路径）
  const outside = join(ROOT, 'outside8');
  await mkdir(outside, { recursive: true });
  let workRefused = false;
  try {
    await host.assertWorkDir(outside);
  } catch {
    workRefused = true;
  }
  check('Flow8 主机拒绝外部工作目录', workRefused);
  await host.close('done');

  // 真实 Hermes 运行时契约（若提供 exe）
  if (HERMES_EXE) {
    const realHost = makeHost(new HermesProcessAdapter({ executable: HERMES_EXE }));
    await realHost.start();
    await realHost.submit({
      taskId: 'f8-real', agentId: realHost.agentId, goal: 'no model', kind: 'document',
      workDir: realHost.workRoot, toolsets: ['document'],
    });
    const rec = await waitState(realHost, 'f8-real', ['succeeded', 'failed'], 30000);
    check('Flow8 真实 Hermes 进程契约（无 provider → 明确失败，不伪装成功）',
      rec?.state === 'failed' && (rec?.error === 'no_provider' || String(rec?.error).includes('provider')),
      `state=${rec?.state} error=${rec?.error ?? ''}`);
    await realHost.close('done');
  } else {
    blocked('Flow8 真实 Hermes 运行时契约', 'CHATAGENT_HERMES_EXE 未设置（PoC 运行时可经 env 指定）');
  }
}

// ---- summary ----------------------------------------------------------------
console.log('');
const passed = results.filter((r) => r.ok === true).length;
const failed = results.filter((r) => r.ok === false).length;
const blockedN = results.filter((r) => r.ok === 'blocked').length;
console.log(`[gate7a-verify] ${passed} passed, ${failed} failed, ${blockedN} blocked`);
try {
  await rm(ROOT, { recursive: true, force: true });
} catch {
  // Windows may hold handles from the Hermes child briefly; cleanup is best-effort.
}
process.exit(failed === 0 ? 0 : 1);
