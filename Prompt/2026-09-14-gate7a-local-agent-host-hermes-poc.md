# ChatAgent Gate 7A：本机 Agent Host 与真实 Hermes 双模式 PoC

> 2026-09-15 生命周期要求已更新：先读 `docs/adr-0003-window-resident-agent.md`。后台绑定 Electron 主进程，关窗常驻、明确退出停止；本历史 Prompt 中独立于整个客户端存活的要求不再执行，不新增守护服务。模块边界、真实 Hermes、安全与单机工作台要求仍保留。

你现在使用 DeepSeek Harness 开发 `E:\ChatAI` 中的 ChatAgent。请先加载并遵守：

- `chatagent-engineering`
- `deepseek-harness-workflow`
- `incremental-prompt`
- `project-driver`
- `project-framework`
- `project-testing`

## 先读现状

开始前必须阅读并以当前代码为准：

- `README.md`
- `docs/project-brief.md`
- `docs/architecture.md`
- `docs/tasks.md`
- `docs/adr-0001-standalone-native-chat.md`
- `docs/adr-0002-dual-mode-client-agent-host.md`
- `docs/review-2026-09-14-native-roadmap.md`
- `apps/desktop/main.cjs`
- `apps/desktop/preload.cjs`
- `apps/desktop/package.json`
- `apps/server/src/app.ts`
- `apps/server/src/service.ts`
- `packages/task-engine/src/engine.ts`
- `packages/hermes/src/types.ts`
- `packages/hermes/src/runtime.ts`

这是已有项目的增量开发，不是重搭项目。保留现有成员、原生私聊、群聊、文件、审批、任务、审计和第三方通道默认关闭的实现。不要重置用户修改、创建分支、提交 Git、重组 `.git`/`.codex`，不要把历史文档中过时的第三方平台任务重新变成主线。

## 产品目标

同一台 Windows 电脑同时支持：

1. 员工正常使用 ChatAgent 聊天客户端；
2. Hermes 在后台独立执行已授权任务；
3. 员工关闭聊天窗口后，程序最小化托盘，后台 Agent 仍可继续；
4. 没有员工操作时，Agent 可执行预先授权的任务；

“后台运行”不是只把窗口隐藏到托盘。UI 生命周期、Agent Host 生命周期、任务生命周期必须分开。当前 Electron 只是加载服务端页面，不能声称已经有本机后台 Hermes。

## 本次只做 Gate 7A PoC

### A. 先做可行性核验，不要先写大量代码

先输出不超过 15 行的调查结果：

- 本机是否存在可运行的真实 Hermes、版本/commit、启动入口和许可证；
- 它是否能在当前 Windows 环境下作为无 UI 子进程或受控进程运行；
- 工具注册、工作目录、产物、事件、取消、超时、错误和退出码如何获取；
- 是否能满足“员工聊天 + Agent 并行”而不依赖 UI；
- 现有 `packages/hermes` 哪些接口可复用，哪些只是自研实验实现；
- 需要哪些非敏感配置，哪些步骤会需要用户批准。

如果本机没有 Hermes、无法确认上游版本，或网络/安装条件不足：不要伪造集成。先实现 adapter 接口、fake executor 和隔离测试，并明确 `BLOCKED: real Hermes unavailable`；不得把 fake executor 写成真实 Hermes 通过。

### B. 设计并实现最小 Host 边界

只建立使 PoC 可验证的最小边界，优先复用现有代码，不提前拆微服务：

- `LocalAgentHost`：独立 start/stop/status/pause/resume/submit/cancel 生命周期；
- `HermesAdapter`：固定版本的进程/协议适配端口；真实 Hermes 与 fake executor 可替换；
- 本地任务存储：至少保存 taskId、deviceId、agentId、状态、runId、工作目录、产物引用、错误和退出信息；
- 唯一调度入口：同一任务不可被本地 Host 和服务端同时领取；
- 通过窄 schema 的本地 IPC/HTTP 调用，验证调用方身份和参数；不开放任意 shell、任意路径或任意子进程；
- UI 只读取状态并提交受控命令，不能在 preload 或 renderer 中直接启动 Hermes。

可以先放在 `apps/desktop` 附近或新建职责清晰的 package，但先说明文件归属和为何需要新目录。不要为了 PoC 引入 Redis、Kafka、PostgreSQL、Kubernetes 或第三方聊天 SDK。

### C. 真实 Hermes 与 ChatAgent 任务边界

- ChatAgent 的 TaskEngine 仍是业务任务账本；不要同时创建一个不知情的第二调度器。
- Hermes 只在 Host 分配的工作目录、工具集合、资源预算和时间期限内运行。
- 不能让 Hermes 默认 shell/文件能力绕过 ChatAgent 的组织、成员、文件和审批策略。
- 使用组织聊天服务是可选的；单机本地任务不应强制连接组织服务器。
- 组织副作用任务必须带 device/owner/delegation/expiry；无法确认授权则等待或拒绝。
- 审批永远不能由 Agent 自己批准；员工离线也不等于同意审批。
- 员工正在编辑的原文件只能读快照或产生新版本，不能后台无条件覆盖。

### D. UI 与 Agent 并行

只补必要的状态展示，不重做整体界面：

- 设备状态、UI 状态、Agent 状态、人类在线状态分别表示；
- 显示 Agent 是否运行、当前任务、暂停/恢复、停止和错误；
- 关闭窗口、退出 UI、暂停 Agent、停止 Agent 四个动作必须不同；
- UI 崩溃或被关闭不能误杀 Host；Host 异常不能将任务标记为成功；
- 不展示完整 `reasoning_content`，只展示可审计的操作摘要；
- 不抢占鼠标、键盘、剪贴板、窗口焦点或员工浏览器会话。

本阶段不要求实现系统托盘自启动、Windows Service、开机未登录运行、防休眠或 GUI 自动化；只保留扩展点并把它们记录为后续设计。不要用 detached child process 假装完成生产级后台服务。

## 必须实现的验证流程

使用合成测试文件和 fake/sandbox 目录，不使用真实员工文件、真实收件人或生产凭据：

1. **单机任务**：无组织服务器、无第三方平台凭据，提交授权的文档任务，得到可验证产物；若真实 Hermes 不可用，标记 BLOCKED 并执行 fake 结构测试。
2. **并行使用**：Agent 执行期间，员工可以登录、聊天、发送消息、查看任务；二者互不阻塞。
3. **关闭 UI**：关闭窗口但不选择“停止 Agent”，任务继续；重新打开后能看到状态、结果或明确失败。
4. **Host 故障**：Host 异常退出不会写 completed；重启后恢复或标记可恢复/失败，不能静默丢失。
5. **暂停/撤权**：暂停停止领取新任务；撤权阻止新的副作用；等待审批时不能自动发送。
6. **文件安全**：工作目录外访问拒绝；原文件 hash 变化时不覆盖；员工正在使用的浏览器 profile 不被复用。
7. **重复执行**：相同任务重试不会产生两个执行者或重复产物/外发副作用。
8. **第三方独立性**：关闭 external channels 后，上述单机和原生聊天测试仍可运行。

## 测试与命令

先补单元/集成测试，再运行真实可用命令：

```text
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node apps/web/node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p apps/web/tsconfig.json
node node_modules/vitest/vitest.mjs run --reporter=dot
```

必要时再运行 `pnpm typecheck`、`pnpm test`、`pnpm build`。如果 pnpm、Hermes、模型网关、浏览器或 Windows 服务条件不可用，准确记录 BLOCKED；不要通过 Mock 宣称真实 Hermes、无人值守或安装包验收通过。

## 安全限制

- 不把 Electron renderer/preload 暴露成任意进程执行器；继续保持 `contextIsolation`、`nodeIntegration: false`、sandbox 和外链拦截。
- 不把 loopback 监听、隐藏窗口、随机端口或难猜 ID 当作认证。
- 不把员工登录 token 长期复制给后台 Agent；使用独立、可撤销、过期的设备/委托凭据。
- 不读取或持久化密钥、密码、私人聊天原文、完整生产文件或模型推理原文。
- 不安装系统服务、自启动或防休眠，除非先报告具体权限、风险、卸载和用户批准点。

## 交付格式

完成后必须报告：

1. 可行性核验：真实 Hermes 的版本/commit、启动方式、结果（PASS 或 BLOCKED）；
2. 修改文件、模块边界和为什么没有扩大范围；
3. LocalAgentHost/HermesAdapter 的接口和生命周期；
4. 任务、设备、委托、工作目录、产物和错误的持久化语义；
5. 员工并行使用、关闭 UI、Host 崩溃、暂停/撤权和重复执行的测试结果；
6. 实际执行命令、测试文件数、用例数、类型检查和构建结果；
7. 哪些是 fake、哪些是真实 Hermes，哪些真实条件仍 BLOCKED；
8. 未解决风险和下一条最小 Prompt。不得写“后台运行已完成”，除非独立 Host 在真实目标环境中通过上述流程。
