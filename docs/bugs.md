# Bug 与修复 / Bugs

## 2026-09-06

### B1: 服务端 ESM 打包后启动崩溃 `Dynamic require of "fs" is not supported`

- 现象: `node apps/server/dist/index.js` 启动时报 `Dynamic require of "fs" is not supported`，堆栈指向 `mammoth/lib/docx/files.js`。
- 原因: `mammoth` 是 CJS 且内部有动态 `require("fs")`；tsup 默认只外部化入口包 `dependencies` 中的包，`mammoth` 是 workspace 包 `@chatagent/document` 的依赖，被错误打进 ESM bundle，导致动态 require 无法运行。
- 修复: 将 `docx`、`mammoth`、`xlsx` 提升为 `apps/server` 的直接依赖，使 tsup 默认外部化它们，由 Node 原生加载。bundle 从 2.82 MB 降到约 74 KB。
- 证据: 修复后 `/health` 正常返回。

### B2: 文档生成接口返回完整 `buffer`

- 现象: `/api/documents/generate/word` 返回 JSON 中含完整二进制 `buffer`，响应体积过大且污染契约。
- 修复: `ChatAgentService.generateWord/generateExcel/parseUploaded` 返回 `fileView`（去除 `buffer`）。
- 证据: 修复后返回体仅含 `id/name/mimeType/sizeBytes/createdAt/url/localPath`。

### B3: MockProvider 工具执行后回复原始 JSON

- 现象: 工具结果以 `{"ok":true,"summary":...}` 原始 JSON 作为助手回复写入会话。
- 修复: 解析工具结果并返回 `已完成：<summary>` 的人类可读文本。
- 证据: 重新发送消息后任务结果为 `已完成：Created Word document ...`。

## 2026-09-13（Gate 1/2）

### B4: 无应用级认证与对象授权（code-audit AUTH-01）

- 现象: 任何能访问端口的调用者都能读账号/会话/任务/文件、触发任务、订阅 SSE。
- 根因: 路由层没有 principal，也没有对象级授权判断。
- 修复: 新增 `apps/server/src/auth.ts`（production bearer token / development 注入边界）与授权矩阵；账号/会话/任务/文件/SSE 全覆盖。
- 证据: `apps/server/src/app.security.test.ts`、`auth.test.ts`。

### B5: 伪造 sender 字段可绕过白名单，且拒绝消息污染历史（AUTH-03）

- 现象: `senderId/senderName` 来自请求体；白名单还接受姓名匹配；拒绝前已写入会话历史并创建任务。
- 修复: 身份一律取自已认证 principal；白名单只按 id 匹配；未授权时在写入任何消息/任务之前返回拒绝。
- 证据: `app.security.test.ts › does not trust forged sender fields`、`› persists the authenticated principal as the message sender`。

### B6: Webhook 从未验签且无去重（AUTH-02、IM-01）

- 现象: `WebhookImGateway.verify` 从未被路由调用；未配置 token 时直接放行；重复投递会产生第二个任务。
- 修复: 路由先验签（HMAC/token）、检查时间窗、再按 `channel:channelMessageId` 去重；生产无验证材料 fail closed。
- 证据: `app.security.test.ts` webhook 用例组。

### B7: provider 异常/空响应仍可能被当作成功（TASK-01）

- 现象: runtime 异常返回空 text，service 用「任务已执行」兜底，engine 正常返回即 completed。
- 修复: 引入 `RunOutcome` 判别结果；`failed/incomplete/cancelled` 分别映射；生成类目标无产物降级为 `incomplete`。
- 证据: `packages/hermes/src/runtime.outcome.test.ts`、`apps/server/src/artifacts.test.ts`。

### B8: 取消可被迟到的完成覆盖（TASK-02）

- 现象: `cancel()` 写 cancelled 后，仍在运行的 handler 正常返回仍写 completed。
- 修复: 终态 CAS —— 终态记录拒绝任何后续写入；取消先提交则迟到结果被丢弃，完成先提交则取消返回 `already_finished`。
- 证据: `packages/task-engine/src/engine.test.ts` 竞态用例。

### B9: 全局产物前后差集导致并发串号（FILE-01）

- 现象: `service.runTask` 用全局 artifact 列表前后差集认领产物，两个任务并发时会互相认领对方文件。
- 修复: `saveArtifact` 接收服务端可信 scope（org/owner/task/run），任务只读 `listByTask(taskId)`；下载/列表/转发再次授权。
- 证据: `apps/server/src/artifacts.test.ts` 并发用例。

### B10: 无效工具参数被 `{}` 兜底执行（TOOL-02 部分）

- 现象: `JSON.parse` 失败时参数变成空对象，工具仍会执行（可能产生副作用）。
- 修复: 解析失败或非对象 → 记 `ok:false` 且不调用工具实现；文档工具改用 zod schema 严格校验，去掉 `String()` 兜底。
- 证据: `runtime.outcome.test.ts` 两个「不执行」用例。

### B11: `vitest.config.ts` 不收集 `apps/server` 测试（TEST-01）

- 现象: include 只有 `packages/*/src/**/*.test.ts`，服务端测试不会运行。
- 修复: include 增加 `apps/server/src/**/*.test.ts`；实测收集 8 个文件 / 50 个用例。

## 2026-09-13（Gate 4）

### B12: 外发无审批、无幂等、无回执语义（DELIVER-01 / TOOL-01）

- 现象: `send_message`/`forward_file` 直接调用网关；未配置 `sendUrl` 也返回 `ok:true`；重试会重复外发。
- 修复: 新增 `Approval` 摘要闸门与持久 outbox；`SendResult.state` 区分 `simulated|accepted|delivered|failed|unknown`；`ok` 仅 accepted/delivered 为 true。
- 证据: `apps/server/src/approval-outbox.test.ts`（9 例）。

### B13: 仅凭 HTTP 200 判定送达

- 现象: `WebhookImGateway.post()` 只检查 `response.ok`，2xx 即视为成功，超时/网络错误也被当作失败可重试。
- 修复: 2xx 且无业务错误 → `accepted`；非 2xx 或业务错误码 → `failed`；超时/传输错误 → `unknown`（不自动重发）。
- 证据: 同上门禁与 outbox 测试；`reportsBusinessError()` 覆盖 `ok:false` / `errcode|code != 0`。

### B14: 审批后任务无法继续

- 现象: `waiting_approval` 是死状态，没有任何机制让任务重新执行。
- 修复: `TaskEngine.resume()` + `POST /api/tasks/:id/resume`；终态任务 resume 返回 `already_finished`。
- 证据: `approval-outbox.test.ts` 端到端用例与现场 curl 验证。



## 2026-09-13（Gate 5：独立原生客户端）

### B15: 产品入口依赖第三方 IM，原生客户端不可用

- 现象: 会话只能通过 `POST /api/messages`（测试台语义）或第三方 webhook 触发；成员无法用自有身份登录、看不到联系人、不能与 AI 或同事在原生界面聊天。
- 根因: 身份只有成员令牌/dev 头，没有会话登录；`Conversation` 没有原生/外部来源与对端概念；前端「会话」页是消息注入测试台。
- 修复: 新增会话登录（成员令牌 → 会话令牌 + HttpOnly Cookie）、`/api/contacts`、`POST /api/conversations`、`POST /api/conversations/:id/messages`、`/api/events/stream`；`Conversation` 增加 `origin/targetKind/targetId` 且 `accountId` 可选；前端新增登录页与原生聊天视图并设为默认入口。
- 证据: `apps/server/src/native-chat.test.ts`（6 例）+ 现场 curl 走通。

### B16: 第三方通道默认开启，削弱「独立产品」定位

- 现象: 服务端启动即注册钉钉/飞书/企业微信/QQ webhook 路由，未配置验证材料时返回 401，产品语义仍以外部平台为中心。
- 修复: 新增 `CHATAGENT_ENABLE_EXTERNAL_CHANNELS`（默认 false）；关闭时只注册内存网关，第三方路由返回 404；文档与 ADR 明确第三方为可选插件。
- 证据: `native-chat.test.ts › does not expose third-party webhook channels unless explicitly enabled`。


## 2026-09-13（Gate 5：安全加固，来自独立安全审查）

### B17: 默认开发模式下匿名调用者等同组织 owner（P0）

- 现象: `pnpm start` / `start-server.cmd` 不设置 `NODE_ENV`，认证解析为 `development`；无凭据请求回落为 `dev-owner`（roles: owner），且**无效 Bearer 也会回落**。
- 修复: 无效凭据一律匿名；dev 注入仅在回环地址或 `CHATAGENT_ALLOW_DEV_AUTH=true` 时生效。
- 证据: `auth.test.ts` 新增 3 例；现场 `192.168.63.63:8787/api/accounts → 401`、`127.0.0.1 → 200`。

### B18: `parse_document` 跨组织读取上传文件（P0）

- 现象: 文档工具按文件名在所有组织的上传中匹配，任一成员可让 AI 解析其他组织的文档并生成可下载产物。
- 修复: `resolveInOrg(ref, organizationId)` + `resolveFile(ref, context)`；跨组织一律 `ok:false`。
- 证据: `security-regression.test.ts › document tools are organization scoped`。

### B19: 审批「单次使用」可被并发绕过（P1）

- 现象: 校验与消费之间隔着网关调用；两个任务可在任一方 consume 前同时通过，造成重复外发。
- 修复: `ApprovalStore.claim()` CAS 先占用再发送，失败归还（`release`）；审批绑定 `taskId`。
- 证据: 三个并发 claim 只有一个为 true。

### B20: 登出后 SSE 继续推送 / SSE 无上限（P1）

- 现象: 已吊销会话的流继续收到消息；单个客户端可开无限流，且无心跳与背压。
- 修复: 每隔 15s 复核会话并断流；订阅上限 200/单主体 5（超出 503）；20s 心跳；`write()` false 即断开。
- 证据: `security-regression.test.ts › event stream limits`。

### B21: 任意成员可驱动任意 AI 账号并注入 system 历史（P1）

- 现象: `POST /api/tasks` 接受 `input.history`，可插入 `role: "system"`；任务提交只校验同组织，不校验账号授权。
- 修复: `createTaskSchema` 移除 `input`，历史服务端重建；新增 `canUseAccount`（allowlist 语义）。
- 证据: `security-regression.test.ts › task submission cannot inject model history`。


## 2026-09-13（Gate 5 复核轮：独立验证发现的问题）

### B22: 终态仍可被同一微任务批次的迟到写入覆盖（F2，已复现）

- 现象: `TaskEngine.commit()` 的读-判断-写跨越 `await`；`cancel()` 与 handler 结果在同一 tick 提交时，两者都读到取消前记录，终态被改写成 `completed`（探针复现率 5/12）。
- 修复: 每个 taskId 一条串行化提交链（`serialize()`），`claim()`/`commit()` 均在其内执行；新增同 tick 竞态回归测试。
- 证据: `engine.test.ts › serializes a same-tick cancel against a late completion`。

### B23: 同组织成员的上传文件可被 AI 读取（F1）

- 现象: `resolveInOrg` 只校验组织，未校验上传者；同组织其他成员的文件可被 `parse_document` 读取并写成产物。
- 修复: 按 `ownerId`（或组织管理员）授权，`ToolContext.isOrgAdmin` 由服务端注入。
- 证据: `security-regression.test.ts › does not expose a colleague upload to another member`。

### B24: 出站 5xx 被判为 failed 导致重复外发（F3）

- 修复: 4xx → `failed`（可重试），5xx/408/429 → `unknown`（不自动重发）。
- 证据: `packages/im-gateway/src/delivery-state.test.ts`（5 例）。

### B25: 发送后崩溃可导致重复外发（F4）

- 修复: 先写 write-ahead outbox 意图（`unknown`）再调用网关；该记录永不自动重发。
- 证据: `approval-outbox.test.ts › never resends when the receipt could not be written`。

### B26: SSE 误断成员令牌流 / 任务流无保护（F5、F6）

- 修复: 仅对会话凭据启用复核；任务流补齐心跳、并发上限、背压断开与复核。

### B27: 转发附件 id 随机、`localPath` 泄漏（F7）

- 修复: `SendFileInput.artifactId` 传真实 id；工具输出与消息不再包含服务器路径。

### B28: admin 可夺取 owner（F8）

- 修复: owner 角色与 owner 令牌只能由 owner 操作；admin 不能改自己的角色。
- 证据: `members.test.ts › stops an admin from promoting to owner or taking over the owner`。

### B29: 写失败被吞、审计未 flush、出站视图越权（F9、F10）

- 修复: `JsonFileWriter` 保留失败批次并回调错误；`onClose` flush 审计；非管理员只看出站视图里自己账号的记录。


## 2026-09-13（Gate 5 第二轮复核）

### B30: 转发附件 id 随机 + 服务器路径泄漏（G1）

- 现象: `forward_file` 未填 `artifactId`，原生通道用随机 UUID 作附件 id → 前端下载 404；上传分支把绝对路径写进消息，群成员可见。
- 修复: 两处都传真实 `artifactId`；上传用 `/api/files/<uploadId>`；不再传 `localPath`。
- 证据: `native-delivery.test.ts › sends the stored artifact id and never a filesystem path`。

### B31: 成员令牌重置后 SSE 仍可推送（G2）

- 修复: 复核函数同时查会话存储与成员目录。

### B32: 合并写入的持久化与失败可见性（G3）

- 修复: `lastError` + `/health` 返回 503 + `storage.pending`。

### B33: 网关抛异常导致审批被消费且无回执（G4）

- 修复: 捕获异常 → `failed` 回执 + 归还审批；新增 `POST /api/outbox/:id/resolve` 对账入口。

### B34: 流配额重复释放 / cancel 无法中止 claim 窗口（G5、G6）

- 修复: 幂等 close 守卫；AbortController 先注册后 claim 并复核状态。

### B35: 重复 @ 生成多个任务 / 失效游标回退（G7、G8）

- 修复: 提及去重；未知游标返回空页。

### B36: 事件回放缓冲无上限（G9）

- 修复: 单任务事件缓冲上限 500 条。
