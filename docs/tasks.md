# ChatAgent 任务 / Tasks

阶段计划与交付物。已完成项打勾。

## Phase 0 — 启动与环境

- [x] P0-1 记录项目简报、调研、需求、环境。
- [x] P0-2 测量环境：OS、Node、pnpm、git、docker（docker 缺失，单机运行为准）。

## Phase 1 — 骨架与契约

- [x] P1-1 pnpm monorepo 根：workspace、tsconfig、.npmrc、.env.example、.gitignore。
- [x] P1-2 `@chatagent/contracts`：领域类型 + Zod 校验。
- [x] P1-3 根目录 `pnpm install` 与 `pnpm typecheck` 可运行。

## Phase 2 — 核心运行时

- [x] P2-1 `@chatagent/hermes`：Tool/ToolRegistry/ModelProvider/MockProvider/OpenAICompatibleProvider/Memory/AgentRuntime/事件。
- [x] P2-2 `@chatagent/hermes` 单元测试。
- [x] P2-3 `@chatagent/document`：Word/Excel 解析与生成 + 工具封装。
- [x] P2-4 `@chatagent/document` 单元测试。

## Phase 3 — 任务与 IM

- [x] P3-1 `@chatagent/task-engine`：状态机、队列、重试、取消、持久化。
- [x] P3-2 `@chatagent/task-engine` 单元测试。
- [x] P3-3 `@chatagent/im-gateway`：ImGateway 接口 + MemoryImGateway + WebhookImGateway + 平台规范化。
- [x] P3-4 `@chatagent/im-gateway` 单元测试。

## Phase 4 — 服务与前端

- [x] P4-1 `@chatagent/server`：Fastify 装配、REST、SSE、文件上传、静态托管。
- [x] P4-2 `@chatagent/web`：Vue 3 + Element Plus 工作台（会话/任务/文件/账号/设置）。
- [x] P4-3 前后端联调：注入消息 → 任务执行 → SSE → 文件产物（curl 验证）。
- [x] P4-4 浏览器/Electron 端到端验证：`scripts/ui-e2e.mjs` 经 CDP 驱动打包 exe（34/34，见 G6-12）。

## Phase 5 — 收尾

- [x] P5-1 根目录 build/typecheck/test 全绿并修复。
- [x] P5-2 Tree 文档与验收报告。
- [x] P5-3 README 快速开始与已知缺口。

## Phase 6 — 客户端 exe

- [x] P6-1 `apps/desktop` Electron 客户端（加载服务端 URL，失败回退本地错误页）。
- [x] P6-2 electron-builder 打包 Windows NSIS 安装包与免安装版。
- [x] P6-3 免安装版启动验证（Electron 进程正常运行）。

## Gate 1/2 — 可信身份与任务完整性（2026-09-13）

- [x] G1-1 最小认证：`development`/`production` 两档，bearer token + 显式 dev/test principal 注入边界。
- [x] G1-2 对象授权：账号/会话/消息/任务/产物/SSE 全覆盖，匿名、跨组织、同组织非参与者均拒绝。
- [x] G1-3 Webhook：token/HMAC 验签 + 时间窗 + 去重，生产 fail closed，dev 未验签标注 simulated。
- [x] G2-1 结构化 `RunOutcome`：provider 异常/空响应/截断/步数/Abort 分别传播。
- [x] G2-2 任务终态：`completed/failed/cancelled/incomplete/waiting_input/waiting_approval`，终态 CAS 不可覆盖。
- [x] G2-3 取消竞态：取消先提交不被迟到结果覆盖；完成先提交时取消返回 `already_finished`。
- [x] G2-4 start/stop：持久任务恢复、队列去重、stop 停止领取并 abort 在飞任务。
- [x] G3-1 产物归属：`saveArtifact` 接收服务端 scope，移除全局差集认领，新增 `listByTask`。
- [x] T1 测试：`vitest.config.ts` 收集 `apps/server`，新增授权/竞态/归属/终态用例。
- [ ] T2 真实模型、真实 Hermes、真实 IM 网关验证（BLOCKED：无凭据/未接入）。

## Gate 4 — 审批 + Outbox + 幂等回执（2026-09-13）

- [x] G4-1 `Approval` 实体：action digest（工具+目标+artifact 版本+载荷）、TTL、单次消费、自审禁止。
- [x] G4-2 `waiting_approval` 消费路径：未命中审批时 0 次网关调用 + 生成 pending，审批后 `resume` 继续。
- [x] G4-3 发送前重新校验：有效期、组织、requester 成员、approver 角色（撤权即拒绝）。
- [x] G4-4 持久 outbox：`stepKey = sha256(taskId|runId : digest)`，重试/重复投递只外发一次。
- [x] G4-5 `SendResult.state`：`simulated|accepted|delivered|failed|unknown`；`unknown` 不自动重发；`ok` 仅 accepted/delivered。
- [x] G4-6 任务终态映射：approvalRequired → `waiting_approval`；simulated/unknown/failed → `incomplete(delivery_*)`。
- [x] G4-7 测试 9 例：未审批零外发、重复不重发、载荷变更、撤权、过期、unknown 不重发、simulated 不算送达、failed 可重试、端到端。
- [ ] G4-8 真实投递验证（BLOCKED：无 IM 凭据，全部为 simulated）。
- [ ] G4-9 审批 UI 与 unknown 对账流程（未实现，仅 API）。

## Gate 5 — 独立原生客户端（2026-09-13，ADR-0001）

- [x] G5-1 方向决策：产品独立于第三方社交/办公软件；外部 IM 通道默认关闭。
- [x] G5-2 原生身份：成员令牌 → 会话令牌（`/api/auth/login|me|logout`），会话令牌 + HttpOnly Cookie。
- [x] G5-3 原生目录与聊天：`/api/contacts`、`POST /api/conversations`、`POST /api/conversations/:id/messages`。
- [x] G5-4 会话模型：`origin/targetKind/targetId`，AI 会话触发任务，成员会话进入对方收件箱。
- [x] G5-5 实时：`/api/events/stream` SSE，逐订阅者重新授权。
- [x] G5-6 前端：登录页 + 原生聊天视图（默认入口），移除旧「会话」测试台视图。
- [x] G5-7 测试：登录/越权/原生会话/成员投递/SSE 授权/外部通道默认 404（10 文件 66 用例）。
- [ ] G5-8 AI 主动消息的原生投递通道（当前仍走网关，无通道时 `simulated`）。
- [ ] G5-9 群聊、成员资料、消息检索、附件预览。

## Gate 5 — 独立原生化与安全加固（2026-09-13）

- [x] G5b-1 原生投递通道：AI 主动消息写入成员原生会话并返回 `delivered`；未知/跨组织收件人拒绝。
- [x] G5b-2 通道选择：精确通道 → native → memory，`send_message` 不再依赖第三方平台。
- [x] G5b-3 认证默认收紧：无效凭据一律匿名；dev 注入仅限回环或显式 `CHATAGENT_ALLOW_DEV_AUTH=true`。
- [x] G5b-4 文档工具按组织解析上传文件（修复跨组织读取）。
- [x] G5b-5 审批原子占用（claim/release）并绑定 taskId。
- [x] G5b-6 SSE：会话吊销复核、订阅上限、心跳、背压断开。
- [x] G5b-7 账号使用授权（allowlist）与移除客户端可注入的模型历史。
- [x] G5b-8 出站记录按组织过滤；终端任务不可再写；审计去 query；登录按 IP 限流；队列深度上限。（上传 413 见 G6-8：当时只映射了框架异常，仍会静默截断）
- [x] G5b-9 成员管理 API 与「成员」页（令牌一次性签发/重置）。
- [x] G5b-10 审批中心页（待审批/历史/outbox 回执）。
- [x] G5b-11 聊天交互：未读、预览、搜索、日期分隔、合并气泡、自动滚动、快捷提示词、附件下载。
- [x] G5b-12 深色模式与主题 token。
- [x] G5b-13 群聊（`POST /api/groups`，组内广播）与消息全文搜索（`GET /api/search`，仅限参与会话）。
- [x] G5b-14 未读游标与最后消息预览、导航未读徽标。
- [x] G5b-15 存储写放大治理（`JsonFileWriter` 防抖 + 关闭时 flush）。
- [x] G5b-16 体验细节：中文语言包、Ctrl/Cmd+K 搜索聚焦、aria-live、深色模式 token。
- [x] G5b-17a 群内 `@AI` 触发任务（提及去重、最多 3 个任务、剥离提及前缀）。
- [ ] G5b-17b 在线状态与已读回执（未做）。
- [x] G5b-18 依赖 CVE 扫描：`scripts/audit-deps.mjs` 对公共 registry 执行；overrides + xlsx 0.20.3 + @fastify/static 10.1.3 已消掉全部 critical。
- [ ] V-8 依赖扫描的持续集成化（需在有网络的 CI 中定期运行）。

## Gate 5 复核轮（2026-09-13 03:40）

- [x] V-1 独立验证子 agent 复核 11 项声明：确认 8 项、部分 3 项、证伪 1 项（终态 CAS 竞态）。
- [x] V-2 F1–F11 全部修复并补回归测试（同 tick 竞态、owner 级上传隔离、出站状态映射、写前意图、admin 不能提权等）。
- [x] V-3 可观测性：状态接口扩充 + 工作台卡片。
- [x] V-4 管理能力：账号编辑（人设/白名单/状态）、任务重试、成员令牌签发/重置页、审批中心页。
- [x] V-5 体验：桌面通知、标题未读、深色模式、中文语言包、Ctrl/Cmd+K。
- [x] V-6 交付物：`docs/security-checklist.md`、`scripts/smoke.mjs`、重新打包的 Windows exe。
- [x] V-7 消息分页（`limit`/`before` + 前端「加载更早」）与 SSE 断线提示条。
- [x] V-9 第二轮独立验证发现的 9 项问题（转发附件 id/路径、成员令牌 SSE 复核、存储健康 503、outbox 对账入口、流配额幂等、claim 窗口取消、提及去重、失效游标、事件缓冲上限）。
- [x] V-10 审计日志查看（`GET /api/audit` + 设置页表格）与前端组件测试（ChatView 4 例）。
- [x] V-11 成员自助能力：群成员邀请/退出（前端会话头部）、个人访问令牌自助重置（设置页）、成员接口越权校验与回归测试。
- [ ] V-8 依赖 CVE 扫描（BLOCKED：registry 无 audit 端点）。

## Gate 6 — 访问控制与交付加固（2026-09-13 04:00）

第三轮由独立对抗性复核子 agent 逐条复现后修复，详见 `docs/gate6-access-control-fixes.md`。

- [x] G6-1 **P0 会话劫持**：`findOrCreate` 不再隐式加人；`injectMessage` 要求调用者是会话参与者（否则 403），受害者历史不再可读、不可注入。
- [x] G6-2 退出群聊后失去该会话任务的读取/事件/取消权限（`assertTaskVisible`）。
- [x] G6-3 退群持久化：建群复用同一 `chatId` 时按请求成员集合**对账**（`setParticipants`）。
- [x] G6-4 超限上传不再静默截断：检查 `file.file.truncated` → 413 + 审计。
- [x] G6-5 smoke 审批人令牌移出仓库（`os.tmpdir()`），支持 `SMOKE_APPROVER_TOKEN`。
- [x] G6-6 SSE 补安全头与 CSP（`STREAM_SECURITY_HEADERS`）。
- [x] G6-7 成员增删/建群/发消息写审计（含拒绝分支）。
- [x] G6-8 自助令牌重置要求「确实出示过凭据」（拒 dev 回退身份）。
- [x] G6-9 群内生成的产物对**会话参与者**可下载（不再死链）。
- [x] G6-10 AI 产物以文件消息进入会话，前端可直接下载。
- [x] G6-11 可访问性：次级文字对比度 2.8 → 4.54（浅）/ 5.10（深），达到 WCAG AA。
- [x] G6-12 真实客户端 E2E：`scripts/ui-e2e.mjs`（登录→AI 回复→生成 Word→下载→深色→1024×720→7 个导航页、消息撤回与已读回执）34/34。
- [x] G6-13 运维：`scripts/restart-server.mjs`（按端口杀进程 + 等 `/health` + 记录真实 pid）。
- [x] G6-14 回归测试：`apps/server/src/membership-security.test.ts`（20 例）+ Web 组件测试（18 例），总计 21 文件 / 199 用例。
- [x] G6-16 消息撤回（仅发送者、窗口内、幂等；正文从历史/搜索/预览/模型上下文消失，广播 `message_recalled`，前端气泡占位 + 前端/服务端测试）。
- [x] G6-17 修复长会话渲染缺陷：`hasEarlier` 曾作为消息列表同级分支，>50 条会话只显示加载按钮（UI E2E 抓到），已移入线程内并补回归测试。
- [x] G6-18 已读回执（1:1）：`GET /api/conversations/:id/read-receipts` + 前端「已读/未读」标注，仅参与者可读。
- [x] G6-19 AI 回复写审计（`ai.message_sent`，不含正文）与群成员面板（头部「成员」弹窗）。
- [x] G6-20 文档解析资源上限（文本 20 万字符 / 段落 2000 / 表 50 / 单表 2 万行，行数仍按真实值上报）。
- [x] G6-21 会话导出为 Word 记录（参与者限定、撤回占位、归属导出者、审计 `conversation.exported`，前端「导出记录」）。
- [x] G6-22 zip 层炸弹防护：解压前检查中央目录（条目/单条目/总量/压缩比），超限 413 并说明触发限制；正常 docx 不受影响。
- [x] G6-23 在线状态：`GET /api/presence` + 联系人 `online` 标志（基于已认证事件流），前端绿点与「· 在线」，仅同组织可见。
- [x] G6-24 会话管理：列出/撤销自己的会话与「撤销其他设备」，`Principal.sessionId` 标记当前设备，单成员会话上限 20，审计 `auth.session_revoked(s)`。
- [x] G6-25 复核轮 4 的 NEW-1/2/3/5/6/7/9 修复：任务快照与 goal 撤回脱敏、AI 回复审计挂到正确函数并区分文件消息、未读数排除撤回、成员面板取服务端最新参与者、撤回窗口由服务端下发、区分禁用与过期、图标导入。
- [x] G6-26 群管理：改名（`PATCH /api/conversations/:id`）与显式移出成员（`DELETE …/members/:memberId`），参与者限定 + 审计 + `conversation_updated` 事件；前端「改名」弹窗与成员面板「移出」。
- [x] G6-27 群聊已读计数（复用 `/read-receipts`，前端显示「N 人已读」）。
- [x] G6-28 复核轮 5 修复：zip 守卫改为实测解压（挡住撒谎的中央目录）、resume 用脱敏 goal、任务事件脱敏、解析失败 400、解析先于落盘、online 字段一致、匿名批量撤销 401。
- [x] G6-29 会话附件共享（参与者可下载，越权引用防护 + 退出即失效）与消息转发（`/messages/:id/forward`，不转 AI、撤回不可复活、审计）。
- [x] G6-30 引用回复：`replyTo` 契约与同会话校验，前端引用条与气泡引用渲染（撤回后不泄露正文）。
- [x] G6-31 复核轮 6 修复：转发件可读（溯源）、任务 result/outcome 脱敏、入站附件归属校验、转发拒绝审计、413 审计、管理员 break-glass 写 `file.admin_access`。
- [x] G6-32 复核轮 7 修复：SSE 回放脱敏、群召唤 goal 双向匹配、审批载荷脱敏、旧接口 replyTo 校验、列表不写 break-glass、产物 break-glass 审计、授权后校验引用、引用条随撤回清空；依赖扫描从 BLOCKED 变为可执行。
- [x] G6-33 复核轮 8：撤回脱敏改为片段替换（含 AI 回声/包装、群召唤 goal 派生），覆盖任务记录/事件/审批载荷/实时 SSE；产物 break-glass 误报修复。
- [x] G6-34 错误响应带 `detail`（机器可读 reason），客户端可分支判断。
- [x] G6-15 二次复核（N1–N6）：建群**只增不减**、退群不可自我复活（409）、拒绝重建写审计、工作台发送写审计、上传拒绝写审计、成员 id 字符集约束。

## 后续方向

- 接一个真实或获批的内网网关，把 `simulated` 升级为 `accepted/delivered`，并补业务回执查询与对账。
- 完整租约与崩溃恢复（TASK-03）：多实例互斥、执行 heartbeat、事件游标补发。
- 工作台审批列表与一键批准/驳回；`unknown` 人工对账视图。
- 接入真实 QQ（NapCat/OneBot）、企业微信、钉钉、飞书凭据与平台原生签名。
- 账号/会话/消息/文件持久化到 PostgreSQL。
- PDF/OCR 文档处理；cron 定时任务与 MCP 工具接入；浏览器/Electron 端到端回归。

## 验证命令

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm dev
```
