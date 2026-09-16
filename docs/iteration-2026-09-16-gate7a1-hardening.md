# 2026-09-16 Gate 7A.1 加固与桌面生命周期收敛

日期：2026-09-16（Asia/Shanghai）。基线：Git HEAD `b33c64d`（工作区含 2026-09-15 文档改动）。关联：`docs/review-2026-09-15-host-gaps-roadmap.md`、`docs/adr-0003-window-resident-agent.md`、`Prompt/2026-09-16-continuous-iteration.md`。

## 本轮范围

按 2026-09-15 复核的 H-01～H-06 修可信性与跨层契约，并把 ADR-0003（关窗常驻、明确退出即停止）落成可验证行为；同时处理联网调研发现的三个高价值缺口（退出时序、权限检查、幂等键语义）。不改聊天/任务主流程，不接真实模型与真实 Hermes。

## 变更

### H-01 提交幂等（重复提交不得重放已完成任务）

- `LocalAgentHost.submit()` 先查同 id 记录：存在即返回原记录，不重新入队、不重新执行。
- 同 id + 不同载荷（goal/kind/toolsets/agentId 任一变化）抛 `idempotency_conflict`，IPC 返回同名错误码 —— 幂等键只对“同一个请求”可复用。
- 重跑只走显式 `retry(taskId)`：仅允许 `failed`/`interrupted` 的本机文档任务且未超 `maxAttempts`；副作用任务需重新审批，禁止自动重试。

### H-02 可信授权（拒绝调用方自声明审批）

- 新增 `packages/agent-host/src/authorization.ts`：`TrustedAuthorizationRegistry` 持有已核验的委托/审批，`computeActionDigest()` 定义动作摘要的规范形式。
- 提交入参由“委托/审批对象”改为 `delegationId`/`approvalId` 引用；zod schema 改为 `.strict()`，仍带 `delegation`/`approval` 字段的调用返回 `invalid_command`。
- 校验项：委托已登记、设备匹配、Agent 身份匹配、未过期、能力覆盖所需 toolset；审批已登记、`approved` 为真、未过期、owner 与委托一致、可选绑定同一 delegation、`actionDigest` 与任务载荷完全一致。
- 授权在 `submit` 与“执行器启动前”各复核一次；撤权/过期后排队中的任务会以 `delegation_unknown` 等终态失败且执行次数为 0。
- 审批/委托仅存在于进程内存：重启必须重新授权。IPC 面没有任何“授予”命令。

### H-03 落盘错误不再被吞

- `JsonFileAgentHostStore.persist()` 改为 write → `FileHandle.sync()` → rename，并把失败抛给调用方（写队列本身保持可用）。
- `submit` 落盘失败时抛错、设置 `lastError=store_write_failed`，不再返回“已受理”的假记录；IPC 以 `host_error` 上报。

### H-04 终态不被迟到结果覆盖

- `LocalTaskRecord` 增加 `version`；`finish()` 先复读、遇终态直接丢弃（计入 `lateResultsDropped`），再以 `compareAndSet(taskId, expectedVersion, next)` 提交，竞态写入同样被拒。
- `cancel()` 对运行中任务先发 abort、立即写 `cancelled`；`stop()` 有界等待（默认 3s）后强制终态。

### H-05 单 writer

- `JsonFileAgentHostStore` 在 `load()` 前以 `wx` 独占创建 `tasks.json.lock`（记录 pid/时间），检测到存活进程即抛 `AgentHostStoreLockedError`；pid 已死、锁损坏或超过 12 小时视为可接管；`close()` 释放。
- 桌面端保持 Electron 单实例锁，启动失败时弹窗说明“任务库被占用”，而非静默双写。

### H-06 IPC 契约与可用性

- `handleHostCommand` 的 `list` 统一返回 `{ tasks }`，与 `SettingsView.vue` 读取的 `result.tasks` 一致；命令异常统一转为 `{ok:false}`（区分 `idempotency_conflict`）。
- 工作台本机卡片新增“说明”列（显示 `blockedReason`/`error`）与失败任务的“重试”按钮。

### 桌面生命周期（ADR-0003）

- 稳定 `deviceId`：`userData/device.json` 生成一次，替换原先所有机器相同的 `desktop-<platform>`。
- 唯一且幂等的关闭路径 `shutdownHostOnce()`：`before-quit`（preventDefault 一次 → 有界拆除 → 再 `app.quit()`）与 Windows 注销/关机事件 `query-session-end`/`session-end` 共用；托盘“退出”不再单独实现一套。
- 权限默认拒绝补齐 `setPermissionCheckHandler`（原先只有 request handler）。
- 外链改造为解析后的协议白名单（`http:`/`https:`/`mailto:`）。
- `HermesProcessAdapter` 中止/超时时用 `taskkill /PID <child> /T /F` 清理**自有**子进程树（只针对本应用 spawn 的 pid），避免遗留 python/浏览器子进程。

## 证据

```text
node node_modules/vitest/vitest.mjs run --reporter=dot        # 23 文件 / 226 用例通过
cd apps/web && node ../../node_modules/vitest/vitest.mjs run  # 6 文件 / 40 用例通过
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json      # exit 0
node apps/web/node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p apps/web/tsconfig.json   # exit 0
node apps/desktop/build-agent-host.mjs                        # 重新生成 agent-host.bundle.cjs
node --check apps/desktop/main.cjs
```

新增回归：`packages/agent-host/src/host-security.test.ts`（37 项，覆盖 H-01～H-06 的安全行为），`packages/agent-host/src/host.test.ts` 的授权用例改为注册表语义，`apps/web/src/views/SettingsView.test.ts` 增加阻塞原因/重试契约用例。

## 未完成 / 不在本轮

- Gate 7A.2 剩余：组织服务不可达时的**本机受信工作台**（当前断线只看到错误页 + 期望远端页面），断网下的任务提交/产物查看仍待实现；托盘重开、退出清理、稳定 deviceId 已完成。
- Gate 7A.3：真实 Hermes 上游（固定 tag/commit、uv 管理的 Python 运行时）与真实模型的安全办公闭环仍未验收；本机无 runtime/凭据，保持 BLOCKED，未用 fake 冒充。
- 调研发现、尚未处理：Electron 39.8.x 已不在官方支持窗口（现行为 42/43/44），升级需重新打包与 E2E；远端工作台未使用独立 session 分区；未做 CSP 注入；任务库仍是 JSON（`node:sqlite` + WAL + 行级 CAS 是后续更稳的方向）；Windows 上“主进程被强杀”仍无法保证子进程全部回收（Job Object 需原生插件）。

## 交付判断

H-01～H-06 已按“安全行为”回归并可复现验证；Gate 7A 整体仍是**部分完成**，不得据此宣称本机工作台或真实 Hermes 已可用。
