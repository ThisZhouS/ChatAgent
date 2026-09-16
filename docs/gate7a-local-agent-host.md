# Gate 7A 验收报告：本地 Agent 主机 + 真实 Hermes 双模 PoC

日期：2026-09-14（晚间轮） · 依据：`Prompt/2026-09-14-gate7a-local-agent-host-hermes-poc.md`

> **2026-09-16 状态更正（本文其余部分保留为历史）**：本报告是 09-14 的 PoC 结论，之后 H-01～H-06 已有修复、生命周期按 ADR-0003 收敛，以下内容已过时：
> - 第 6/7/8/11 条的提交面已改为「只传 `delegationId`/`approvalId` 引用」+ 可信授权注册表 + 提交幂等 + 显式 `retry`；`list` IPC 统一返回 `{ tasks }`。
> - 第 12 条的数字为历史值；当前基线：根 vitest 24 文件/238 用例、web 6 文件/40 用例、tsc/vue-tsc 0、真实 Electron 工作台 11/11 与关窗常驻 6/6。
> - 关窗常驻、托盘重开、显式退出即停止已由 ADR-0003 与 `apps/desktop/main.cjs`（单一幂等拆除路径 + 稳定 deviceId + 断网本机工作台 `workbench.html`）实现。
> - 当前基线与证据：`docs/review-2026-09-15-host-gaps-roadmap.md`、`docs/iteration-2026-09-16-gate7a1-hardening.md`、`docs/review-2026-09-16-adversarial-verification.md`。Gate 7A 整体仍**未完成**：真实 Hermes 安全办公闭环与 Host 侧持续回执同步待做。

## 一、可行性结论（≤15 行）

1. 真实 Hermes 运行时存在且可调用：`Temp/hermes-runtime/hermes-agent-cn-runtime-win32-x64.exe`（hermes_agent 0.17.0，Nous Research，MIT，sha256 `78cf8734…2721`）。
2. `--cli -z` 一键模式可用：stdout-only、以 CWD 为任务工作目录、`--ignore-user-config` 生效（不触碰 `~/.hermes`）。
3. 模型供应商缺失 ⇒ 真实推理不可运行：`hermes -z` 退出码 1 并明确报 "No inference provider configured"，主机将其归类为 `no_provider` 失败，绝不伪装成功。
4. Hermes 默认启用 terminal/code_execution/browser/computer_use；主机必须 `-t` 显式最小白名单（文档任务→`file`），未知/被禁工具集 fail-closed 拒绝（`invalid_toolset`）。
5. `hermes acp`（ACP 依赖未装）、cron、webhook、第三方 IM 凭据均为 BLOCKED，不假装集成。
6. `LocalAgentHost`（start/stop/pause/resume/submit/cancel + 租约单调度）与 `HermesAdapter`（固定版本进程/协议端口）已实现，本地任务库落盘（taskId/deviceId/agentId/state/runId/workDir/artifacts/error/exit）。
7. 单入口调度：任务只被租约持有者执行；同一 taskId 重复提交仅执行一次（attempts=1）。
8. 窄 IPC：zod 校验 + 每次启动的随机令牌闸门 + 拒绝任意路径/任意命令；UI 只读状态、只发受控命令。
9. 主机故障/关窗/重启绝不写 completed：运行中被打断的任务恢复为 interrupted/cancelled。
10. 工作目录与哈希安全：逃逸被拒、基线一致才原地覆盖、基线过期写 `<file>.<ts>.new` 版本。
11. 桌面主进程持有主机生命周期：关窗不退出（托盘可重开）、显式“停止 Agent 并退出”分离。
12. 验证全绿：tsc / vue-tsc 0 错；vitest 根 192 + web 28 通过；host 级 8 流程 19/19；Electron 真实运行时关窗续跑 6/6；真实 Hermes 进程契约通过；桌面应用真实启动无 JS 错误。
13. 结论：**PASS**（PoC 目标达成）；真实模型推理、ACP、真实第三方 IM、桌面 exe 重建属后续 Gate（**BLOCKED**）。

## 二、八部分报告

### 1. 任务与交付形态
本机 Agent 作为独立工作主体运行：任务输入 → 身份/权限（委托+审批门）→ 本地调度（租约单入口）→ 执行器（真实 Hermes / 离线 fake 双模）→ 产物（哈希）→ 状态落盘。交付物：`packages/agent-host`（新包）、桌面集成、8 流程验证证据。

### 2. 架构与组件
- `packages/agent-host/src/types.ts`：`LocalTaskState`（queued|running|succeeded|failed|cancelled|interrupted）、`BlockReason`、`DelegationScope`、`ApprovalReference`、`LocalTaskInput/Record`（lease/attempts/blockedReason）、`ExecutorResult.failure.kind` 含 `invalid_toolset`、`HostStatus`（host running vs runningTasks 区分）。
- `store.ts`：`JsonFileAgentHostStore`（原子 tmp+rename、CAS `claim(taskId, holder, leaseMs)`、`release`、`recoverInterrupted`）与 `MemoryAgentHostStore`。
- `sandbox.ts`：`isInside`、`assertInsideWorkRoot`（realpath、符号链接逃逸拒绝）、`ensureTaskWorkDir`、`sha256Of/fileSha256`、`writeFileIfUnchanged`（基线一致→覆盖；过期→`.new` 版本）、`collectArtifacts`。
- `adapter.ts`：`HermesProcessAdapter`（`--cli -z <goal> --ignore-user-config -t <toolsets>`，cwd=workDir，硬超时 SIGKILL，stdout/stderr 有界，绝不 `--yolo`/`--accept-hooks`）与 `FakeHermesAdapter`（`executor:'fake'`，主机 status 带原因，绝不被当成真实 Hermes）；`HERMES_TOOLSETS`/`FORBIDDEN_TOOLSETS`/`CHATAGENT_TOOLSET_MAP`/`resolveHermesToolsets`（未知/被禁 fail-closed）。
- `host.ts`：`LocalAgentHost` 完整生命周期；副作用任务需有效且未过期的委托 + 已批准且未过期的审批引用，且绝不自我审批；`finish()` 超时重试；getter workRoot/agentId/deviceId。
- `ipc.ts`：`hostCommandSchema`（status/list/pause/resume/stop/cancel/submit，字段有界）、`handleHostCommand(host, cmd, {token}, presentedToken)` 永不抛出。
- `apps/desktop/main.cjs` + `preload.cjs`：主进程创建/启动主机（每次启动随机 32B 令牌，令牌不出主进程）、`ipcMain.handle('chatagent:host', …)`、`window-all-closed` 不退出、托盘、显式 `chatagent:host:quit-app`。
- `apps/web/src/views/SettingsView.vue`：仅桌面（存在 `window.chatagent.host`）显示“本机 Agent 主机”卡片：状态/执行器/原因、任务表、暂停/继续/停止/取消/提交，浏览器中自动隐藏。

### 3. 验证流程（1–8）
| 流程 | 结果 | 证据 |
|---|---|---|
| 1 单设备单主机一任务+哈希产物 | PASS | `gate7a-verify.mjs` Flow1：succeeded，report.md，磁盘哈希一致 |
| 2 UI 与 Agent 并行 | PASS | Flow2：running 时 UI 可查状态、runningTasks>0 |
| 3 关闭 UI→任务继续/重开状态仍在 | PASS | Electron 真实运行时 `electron-host-smoke.cjs` 6/6：关窗不退出、任务完成后落盘、重启重读；Flow3 中断不写 completed |
| 4 主机故障绝不写 completed | PASS | Flow4：stop/重启恢复为 interrupted/cancelled；host.test.ts 崩溃恢复 |
| 5 暂停/继续/取消（撤销） | PASS | Flow5：paused 状态翻转、cancel→cancelled；host.test.ts 暂停/取消矩阵 |
| 6 工作目录与哈希安全 | PASS | Flow6：逃逸拒绝、基线覆盖、过期 `.new` 版本；host.test.ts workdir/文件安全 |
| 7 绝不重复执行 | PASS | Flow7：同 taskId 提交两次 runs=1；host.test.ts exactly-once（租约） |
| 8 独立第三方（Hermes 契约） | PASS（真实进程）/ 其余见阻塞项 | Flow8：被禁工具集 fail-closed、IPC schema、令牌闸门、外部工作目录拒绝；真实 Hermes 无 provider→`no_provider` 明确失败 |
| 桌面真实启动 | PASS | `gate7a-launch-test`：主进程启动主机（work 目录创建）、无 JS 错误 |
| 单元/集成回归 | PASS | vitest 根 192（20 文件）+ web 28（3 文件）；tsc/vue-tsc 0 错 |

### 4. 桌面集成
- 主机生命周期归主进程：关窗/渲染进程崩溃不停止主机；`window-all-closed` 不调用 `app.quit()`；托盘提供“显示主窗口 / 退出（停止后台 Agent）”；单实例锁保证重开聚焦既有窗口。
- 每次启动生成随机设备令牌，仅存主进程内存；preload 只暴露 `chatagent.host.command/quitApp` 窄桥。
- 执行器选择：`CHATAGENT_HERMES_EXE` 或打包/开发目录内运行时 → 真实 Hermes；否则离线 fake 并在状态中明示原因。
- 构建链：`apps/desktop/build-agent-host.mjs`（esbuild 把 agent-host 打成单文件 CJS，内联 zod）→ `npm run build:host`，已接入 `dev`/`build` 与 electron-builder `files`。

### 5. 安全清单
- 窄 IPC：zod discriminatedUnion、令牌闸门、无任意进程/路径/参数命令。
- 授权由主机执行（委托+审批门），不交给提示词；绝不自我审批。
- 执行器 fail-closed：显式最小工具集、禁 terminal/code_execution/browser/computer_use/cron 等、`--ignore-user-config`、无 `--yolo`。
- 工作目录 realpath 防符号链接逃逸；UI 无法指定任意 workDir。
- 文件写入哈希保护（基线一致才覆盖）；产物按 taskId 目录收集并带 sha256。
- 设备令牌不出主进程；测试/文档不记录凭据。

### 6. 命令与证据
```
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json          # 0 错
node apps/web/node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p apps/web/tsconfig.json  # 0 错
node node_modules/vitest/vitest.mjs run --reporter=dot                  # 192 passed
(cd apps/web && vitest run)                                             # 28 passed
node scripts/gate7a-verify.mjs                                          # 19 passed / 0 failed / 0 blocked
CHATAGENT_HERMES_EXE=Temp/hermes-runtime/... node scripts/gate7a-verify.mjs  # 19/19（含真实 Hermes 契约）
node apps/desktop/node_modules/electron/cli.js scripts/electron-host-smoke.cjs  # 6/6（关窗续跑）
apps/web vite build                                                     # 构建通过
桌面真实启动（electron .，CHATAGENT_HOST_ROOT=临时目录）                 # 主机启动、无 JS 错误
```

### 7. 未做 / 阻塞项（诚实标注）
- **BLOCKED** 真实模型推理：Hermes 运行时无 provider 配置 ⇒ 真实推理不可运行（`no_provider` 明确失败，未伪装）。
- **BLOCKED** ACP 通道：`hermes acp --check` 提示依赖未安装。
- **BLOCKED** 真实第三方 IM 凭据/网关、Windows 服务/自启/防休眠（不在本 Gate 范围）。
- **BLOCKED** 桌面 exe 重建：Gate 7A 变更尚未重新打包 NSIS 安装包（构建链已接好，见第 4 部分）。
- 浏览器无可用 provider，UI 双态（桌面显示/浏览器隐藏）以组件测试覆盖（SettingsView.test.ts 2 新增用例）。

### 8. 剩余风险与下一步
- 下一步：真实模型 provider（内网 OpenAI 兼容网关）接入后重跑 Flow8 真实推理；ACP 通道评估；任务结果回执→服务器审批/交付链路的打通；桌面 exe 重建与端到端（打包版）回归。
- 风险：Hermes 版本升级可能改变 `-t` 工具集名/退出码（adapter 已 fail-closed，需随版本回归）；真实 Hermes 进程可能派生子进程，超时/取消时需确认全部回收。
