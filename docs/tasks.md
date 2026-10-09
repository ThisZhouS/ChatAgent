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
- [x] G6-35 桌面外壳加固：`will-navigate` 拦截外链、`sandbox/webviewTag/allowRunningInsecureContent` 显式设置、权限请求默认拒绝；重新打包 exe 并跑通客户端 E2E 34/34。
- [x] G6-15 二次复核（N1–N6）：建群**只增不减**、退群不可自我复活（409）、拒绝重建写审计、工作台发送写审计、上传拒绝写审计、成员 id 字符集约束。

## 下一轮建议（按优先级，2026-09-16 收口后）

1. **Gate 7A.3（唯一被阻塞的门）**：固定版本 Hermes 的端到端办公闭环——锁定 tag + SHA、uv 管理的 Python 3.11、运行时放在 ASAR 外、显式模型配置、合成数据的 Word/Excel 闭环、工具隔离验证。需要真实运行时与模型凭据，当前环境不具备（**不得以 fake 结果冒充**）。
2. ~~**Host 侧持续回执同步**~~ **已完成**：主进程 `apps/desktop/receipt-sync.cjs` 周期同步（离线排队 + 按版本去重 + 失败退避），`status().receiptSync` 对 UI 可见；回执携带 `ownerId` 并由服务端校验（403 `receipt_owner_mismatch` + denied 审计）。真实 Electron 校验 16/16（`scripts/electron-receipt-sync-check.mjs`）。
3. **缺口收敛**：~~陈旧单 writer 锁的自愈（需本地明确同意 + 审计）~~ **已完成**（歧义情形弹窗询问、默认不接管、旧锁改名保留 + `lock-audit.jsonl` 审计、无人值守时锁获胜；`electron-lock-check.mjs` 9/9）；`taskkill /T /F` 子进程树回收已用真实两级进程树实测（`packages/agent-host/src/process-tree.ts` + 5 例真实进程测试），**Windows Job Object 仍未做**（需原生模块，离线无法验证）；`node:sqlite` 经实测（Electron 39 = Node 22.22.1，`node:sqlite` 仍 experimental）**决定暂不采用**，见 `docs/electron-upgrade.md`；Electron 升级（39.8.x 已于 2026-05-05 EOL，目标 42.11.x → 43/44）因本机无外网无法下载二进制，已写升级预研与回归清单。
4. ~~**持久化行治理**~~ **已完成**：`packages/agent-host/src/record-integrity.ts` 载入时校验/修复/隔离（未知 kind/state、缺 taskId/workDir 的行保留为 `failed`+`invalid_persisted_row`，永不执行），损坏文件另存为 `.corrupt-<时间戳>` 不删除，`status().storeIntegrity` 在服务端工作台与离线工作台均可见。
5. ~~**远程页面加固**~~ **已完成**：`persist:chatagent-workbench` 独立持久分区 + 缺省 CSP 注入（服务端已有 CSP 则不削弱）+ 分区内权限全拒；`status().shell` 可核对；`electron-csp-check.mjs` 用内联脚本载荷证明策略被浏览器强制执行（5/5），`electron-receipt-sync-check.mjs` 19/19 覆盖同步与分区。
6. ~~**任务库保留策略**~~ **已完成**：`selectExpiredRecords` 只淘汰终态记录、进行中的任务永不淘汰、载入只报告不改写文件、淘汰发生在下一次被接受的写入、写入失败时把记录放回内存；`status().storeIntegrity.prunable` 与设置页「保留策略」提示可见（`retention.test.ts` 7 例）。
7. ~~**服务端回执单调性**~~ **已完成**：离线队列乱序/重发时，比已存版本更旧的收据一律忽略并计入 `stale`，不会把已完成任务打回进行中；接口返回 `{accepted, stale}` 并在审计写明忽略条数（`local-tasks.test.ts` 10/10）。
8. **下一轮候选（未开始）**：服务端委托台账与授权签发路径（把 `supportedKinds` 扩到 `delegation`）；打包 exe 重建与打包后 E2E（需联网）；Windows Job Object 子进程回收（需原生模块）；Electron 升级到受支持版本（需联网下载二进制）；真实 IM/模型凭据下的端到端联调；SSE 断线补发与持久游标（Gate 7）。

## 后续方向

### 2026-09-15 用户最新决策：关窗常驻，退出即停止

采用 `docs/adr-0003-window-resident-agent.md`：后台与 Electron 主进程生命周期绑定；关窗保留托盘与任务，明确退出停止 Agent。取消独立 Host 进程、Windows Service 和主进程退出后继续运行的规划。下方旧阶段记录如有冲突，以本条为准。Gate 7A.1 的安全/状态修复与单机工作台仍要完成。

### 2026-09-15 复核更新（覆盖旧阶段顺序）

现状基线：HEAD b33c64d；本轮根测试 208、Web 39 用例及类型检查通过，但六项隔离探针复现错误行为。详见 `docs/review-2026-09-15-host-gaps-roadmap.md`。Gate7A 应视为部分完成：已有 Host/托盘/适配器，单机 UI、可靠停止与真实 Hermes 文档闭环仍需验收；主进程内 Host 符合最新决策。

- [x] Gate 7A.1 / H-06：Host `list` IPC 统一返回 `{ tasks }`，与工作台 `result.tasks` 一致；本机卡片显示 `blockedReason`/`error` 并提供重试，新增页面契约回归。回执仍由页面触发上传（Host 侧持续同步见 Gate 7A.2）。证据：`docs/iteration-2026-09-16-gate7a1-hardening.md`。
- [x] Gate 7A.1 / H-02：新增 `TrustedAuthorizationRegistry`；IPC 只传 `delegationId`/`approvalId` 引用（`.strict()` 拒绝内联委托/审批对象），校验时间/设备/Agent/能力/所有者/绑定委托/动作摘要，并在派发前复核。
- [x] Gate 7A.1 / H-01、H-04：提交按 taskId 幂等，同 id 异载荷报 `idempotency_conflict`，重跑仅经显式 `retry`；记录带 `version`，`finish` 丢弃终态后的迟到结果并用 CAS 提交，取消立即写终态。
- [x] Gate 7A.1 / H-03、H-05：落盘改为 write→fsync→rename 且错误抛给调用方（不再确认假成功）；JSON 任务库加独占锁文件（存活 pid 拒绝第二写者，死 pid/损坏/超 12h 可接管）配合 Electron 单实例锁，不扩展多进程服务。
- [x] Gate 7A.2：断网本机受信工作台（`apps/desktop/workbench.html`，严格 CSP、仅用窄桥、真实 Electron 11/11 验证）、关窗常驻（6/6）、明确退出后停止并清理自有进程树（`scripts/electron-quit-check.mjs` 10/10：进程结束、锁释放、任务库可读、无残留）、稳定 deviceId。**剩余**：断网账号归属核对（回执 `ownerId` 已由服务端校验并通过 403 拒绝越权）。
- [ ] Gate 7A.3：固定来源/版本/安装方式的 Hermes、显式模型配置与真实安全工具/文档验证；未达工具隔离前不接真实员工文件。
- [ ] 技术债（2026-09-16 调研）：Electron 39.8.x 已出官方支持窗口（现行为 42/43/44），升级需重打包+E2E；远端工作台未用独立 session 分区、未注入 CSP；JSON 任务库可评估 `node:sqlite`(WAL)+行级 CAS；Windows 上主进程被强杀后的子进程回收需 Job Object/原生插件。

- [ ] 后续：持久后台回执同步、原生消息/SSE 可靠性、任务步骤检查点、审批续跑，再做授权的计划/无人值守任务。

原先阶段记录保留作历史；第三方聊天平台仍非依赖，不作为本阶段受阻或发布前置条件。

### 2026-09-14 双用途客户端补充（当前优先级）

用户进一步明确：客户端既能独立作为 Agent 工具，也能供员工聊天；员工工作时与无人操作时，Hermes 均可按授权后台运行。先执行 `docs/adr-0002-dual-mode-client-agent-host.md` 中的 Gate 7A 最小验证，再推进下方 Gate 7–10 的可靠性路线。此为增加产品必要边界，不是取消持久性、安全或回归要求。

- [ ] Gate 7A：本机 Local Agent Host 与 UI 独立生命周期、单机任务入口和受限本地通信；无组织服务器也能管理本地任务。
- [ ] Gate 7A：固定上游版本的真实 Hermes Adapter，验证文档任务/产物/取消/错误；不能以 Mock 或自研同名包替代。
- [ ] Gate 7A：员工聊天时并行执行、关闭/重新打开 UI 后继续、无人操作触发获准计划、暂停/撤权；不抢鼠标键盘、不覆盖编辑中文件。
- [ ] 后续服务化：OS 注销/未登录运行、设备注册/租约、计划补跑、升级和服务凭据单独设计验收。安装服务、自启动、防休眠须显式授权，不能视为本次已实现。

### 原生可靠性与后续工作

2026-09-14 复核：产品不依赖 QQ、微信、飞书、钉钉等聊天平台。原生投递、审批中心和对账界面已有实现，不再作为从零开发任务。历史阶段复选框保留当时状态；当前依据见 `docs/review-2026-09-14-native-roadmap.md`。

- [ ] Gate 7：原生消息的可靠持久确认、业务幂等和消息/会话/回执/事件的一致提交；先评估单实例事务方案与 JSON 迁移/回滚，不预设必须 PostgreSQL 或多实例。
- [ ] Gate 7：SSE 持久游标、断线补发、重复去重及过期游标快照同步；按最新成员权限过滤回放。
- [ ] Gate 7：隔离测试环境故障注入，覆盖成功确认后进程异常退出、重复发送、重连和撤权；现有 199 用例保持通过。
- [ ] Gate 8：持久步骤/检查点、审批后的继续执行、复用原产物与载荷，避免重跑模型导致重新生成或重复审批。
- [ ] Gate 9：真实模型协议和办公闭环验收，显式 Mock/real 模式、上下文/超时/费用预算；Hermes 上游集成另作 ADR，不影响独立聊天主线。
- [ ] Gate 9：在权限、恢复、审计成立后逐项增加原生事件/定时任务、工作跟进和人工接管。
- [ ] Gate 10：内网试点、安装/成员引导、备份恢复、升级回滚、生产配置核验、多用户 Web/Electron 回归和容量验证。
- 第三方 IM 适配维持默认关闭，既不是主线任务，也不是产品可用性或发布的前置条件。PDF/OCR/MCP 按实际工作流程需要再排期。

## 验证命令

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm dev
```

## 下一轮建议（2026-09-16 第三轮验证之后）

1. **锁的持有者身份而非年龄**（F5 根治）：锁文件记录进程启动时间/boot id 或周期性心跳，让“pid 复用”的判断不再依赖 30 天年龄；心跳方案需同时给出断网/挂起的退化行为与审计。
2. ~~**Host 侧持续授权刷新**~~ **已完成**：`POST /api/agent-authorizations/verify`（只回 id+状态，不回传审批内容；他人/未知/无台账一律 `unknown`，并用 `supportedKinds` 声明只管 `approval`）+ 宿主 `authorizationRefresh`（默认 60 s，仅在有授权时提问；`active` 刷新过期时间、`revoked|expired` 本地撤销、`unknown` 只标记不销毁、调用失败/超时 → `unverified`）；`unverified` 时新外部副作用任务**暂缓**（不失败、不占租约、留队列，恢复后自动继续），在跑任务不回滚，本地文档任务不受影响；`status().authorization` 与设置页「授权复核」可见。证据：`docs/iteration-2026-09-16-gate7a1-hardening.md` 第十五轮、`authorization-refresh.test.ts` 10 例、`agent-authorizations.test.ts` 4 例、真实 Electron 21/21。**仍缺**：服务端的委托台账（目前 `supportedKinds` 只有 `approval`）与从服务端取授权的签发路径。

3. ~~**回执失败分级可见性**~~ **已完成**：`receipt-sync.cjs` 把失败分为 `server_rejected`(4xx)/`server_error`(5xx)/`network` 并持久化；服务端拒收后停止自动重试（15 分钟退避，手动触发也跳过），5xx 与网络失败仍走指数退避；回执在任何情况下都不丢；设置页按分级给出「被服务端拒收（需重新登录/确认归属）」或「联网后自动重试」，全部同步完成时不再显示提示。证据：`receipt-sync.test.mjs` 16 例、`SettingsView.test.ts` 文案分级一例。
4. ~~**保留策略的可见性收尾**~~ **已完成**：保留策略、授权复核、回执同步三类提示都出现在**离线工作台**（断网时员工唯一能看到的界面）与设置页：保留提示说明“N 条更早的终态记录会在下次写入时清理（进行中的任务不受影响）”以及“本次运行已按保留策略清理 N 条”，授权提示说明暂缓/撤销/无法确认的条数，回执提示按失败分级给出可操作话术；三者共用同一份 `status()` 载荷，无异常时不显示。证据：`electron-workbench-check.cjs` 11 → 13 项（520 条终态记录种子 + “干净运行不报警”反向断言）、`SettingsView.test.ts`（授权与回执文案各一例）。
5. ~~**打包与升级**~~ **已完成（换版本除外）**：① `electron-builder` 离线重打包成功（NSIS 安装包 + `win-unpacked/`）；② **打包后客户端 E2E 38/38**（真实 exe + 重建的 server dist：登录/AI 回复/Word 生成与聊天内下载/转发/附件/撤回/主题/1024x720/7 个视图），并修掉 E2E 自身竞态（`:loading` 吞点击 + 单次气泡检查即重试 → 现在等按钮可点、等气泡、绝不重复发送，新增“文档请求已发出”断言与失败诊断）；③ 升级调研 + **离线彩排**：39.8.10 已于 2026-05-05 EOL，目标 44.4.1（2027-03-02 前受支持），用本地缓存的 42.4.1 运行时把 7 个桌面壳检查（18/21/6/13/10/5/7）与打包后 E2E（38/38）全部跑通；新增 `CHATAGENT_ELECTRON_BIN`、`ui-e2e --exe/CHATAGENT_CLIENT_EXE` 覆盖点。详见 `docs/upgrade-2026-09-17-electron.md`。**仍缺**：把依赖版本真正换成 42.11.4/44.4.1（`pnpm add` 需 registry 网络，本环境无外网 → BLOCKED）。
6. **Gate 7A.3**：真实 Hermes 运行时 + 真实模型凭据的安全办公闭环，仍为唯一未验收的核心项，不得用 fake 冒充。

7. **下一轮候选（2026-09-17 收口后，均未开始）**：
   - **服务端授权台账与签发路径**：目前 `supportedKinds` 只有 `approval`，委托没有台账可查；需要把委托登记进服务端并让设备按需取授权（当前授权仍由受信代码在内存中铸造）。
   - **Electron 版本切换**：按 `docs/upgrade-2026-09-17-electron.md` 的步骤把依赖换成 42.11.4 或 44.4.1（需 registry 网络；彩排已全绿）。
   - **Windows Job Object 子进程回收**：现在依赖 `taskkill /T`，进程被强杀时仍可能留下孙进程；需要原生模块或更可靠的内核级绑定。
   - ~~**保留策略的 id 列表**~~ **已完成（2026-09-22，差距矩阵 §3.24）**：淘汰判定改为逐条带原因（`selectExpiredRecordsDetailed` → `{taskId, state, reason: age|count, updatedAt}`，原 id 接口保留为投影），存储层把每个淘汰批次追加到 `<tasks.json>.retention-audit.jsonl`（`action: task_store.pruned`，默认开启，可关或改路径）；审计写失败不让任务写入失败，但会计数并上报 `status().storeIntegrity.retentionAuditFailures/lastAuditError`，主进程打 `console.error`。**界面不变**（仍只说「N 条」），id 只在审计文件里。顺带修掉「写入失败仍自增淘汰计数」的多报缺陷。证据：`retention.test.ts` 8 → 15 例、根套件 **55 文件 / 443 用例**、`tsc` 0 错、真实 Electron `electron-workbench-check.cjs` **16/16**（审计条数与 `pruned` 逐条相等、被清理 id 不进页面）。
   - ~~**保留审计文件自身的增长治理**~~ **已完成（2026-09-30 第 59 轮，差距矩阵 §3.25）**：审计文件现有自己的双预算（行数默认 1200、字节默认 1 MiB），在高水位 `maxLines + 32` 触发裁剪、裁回 `maxLines`，并写一条 `task_store.retention_audit_rotated` 的 meta 行（含被丢批次数与最多 200 个 id + 精确截断计数），保留上一条 note；裁剪走 tmp→fsync→rename，失败不抛、不拖垮任务写入，计数进 `status().storeIntegrity.retentionAuditRotations/LinesDropped/MaxLines/MaxBytes`，**界面仍只说「N 条」**。证据：`retention-audit.test.ts` 14 例、`retention.test.ts` 17 例、`electron-workbench-check.cjs` 18/18。
   - **完整 XSS 利用链验证**：CSP/导航/分区已加固并有 5/5 + 13/13 检查，但没有端到端的实际注入利用链复现。
   - ~~**桌面壳七项没有可复现的合计**~~ **已完成（2026-10-08 第 60 轮，差距矩阵 §3.26）**：新增 `scripts/desktop-shell-checks.mjs`（运行器表 + 单脚本超时 + 钉死分母 + 合计），`acceptance.mjs` 改为调用它；`receipt-sync` 检查改为幂等；第 59 轮记的「92/92」订正为 91。证据：单条命令 **92/92、连跑两轮同结果**。
   - **`acceptance.mjs` 其余步骤仍无超时**（2026-10-08 第 60 轮发现，未处理）：`run()` 用 `spawnSync` 且不传 `timeout`，桌面壳那一步现在不会挂死了，但 `ui-e2e` / `build` 等步骤长时间无输出时仍只能干等。
   - **五项检查共用固定状态目录**（2026-10-08 第 60 轮发现，未处理）：`lock` / `csp` / `nav` / `quit`（`receipt-sync` 已改）都用仓库内 `Temp/<name>-check`，两个并发清扫会互相踩（独立复核复现过一次纯由碰撞造成的假失败）。顺序跑可复现；改成 `mkdtempSync` 即可，与 `receipt-sync` 本轮的做法相同。


## 2026-09-17 产品功能树审查（新增）

用户给出六域功能树（聊天/好友/群聊/UI/Agent/服务器），目标是「把 agent 与自建聊天工具整合、把能力关在笼子里」。四个只读子代理完成差距审计，结论与分阶段计划见 `docs/product-decomposition-gap-matrix-2026-09-17.md`。

- [x] **P0-1 消息投喂闸门**：消息默认在过撤回时间后再交给 agent；撤回取消未投喂项；上下文窗口化；提示词注入不可绕过规则。实现 `apps/server/src/agent-intake.ts` + `AgentIntakeStore`；验证 9 + 4 + 1 例。
- [x] **P0-2 Agent 联系人级权限分级**：`owner/confirm/chat/ignore` 四档，三处硬门（入站闸门、运行时 `allowedTools`、`POST /api/tasks` 403），账号编辑弹窗可设默认与逐联系人等级。证据：`contact-tier.test.ts` 8 例、`runtime-allowlist.test.ts` 4 例、`AccountTierEditor.test.ts` 5 例。
- [x] **P0-3 工具开关单一来源 + 拒绝原因回灌提示词**：唯一来源 `packages/agent-host/src/policy.ts`（13 项 + 能力下限），提交期即拒绝（含两份旧名单漂移的 6 个名字），`capabilityBrief()` 由同一名单生成并注入本机 Hermes 目标文本，拒绝信息区分「被关闭」与「不是能力」。证据：`policy.test.ts` 5 例、`host-security.test.ts` +2 例、`adapter.test.ts` +1 例。
- [x] **P1-1 断线补差与消息幂等**：事件带 `seq`（hub 有界重放缓冲），SSE 写 `id:` 并按 `Last-Event-ID`/`?since=` **逐条重新鉴权**回放；客户端重连补拉按 id 合并；发送加 `clientMsgId`（作用域=发送者+会话+key，10 分钟 TTL，有界台账）。证据：`event-replay.test.ts` 4 例、`ChatView.test.ts` 重连补拉一例。
- [x] **P1-2 好友关系与验证**：`RelationStore`（`data/relations.json`）保存申请与关系；申请→仅被申请人可同意→双向好友；备注私有；拉黑**私聊投递拒绝**（403，不落库）且不能再申请，群聊不受影响；界面有申请收件箱与联系人设置。证据：`friends.test.ts` 6 例 + `ChatView.test.ts` 3 例。**假设待确认**：好友=人际好友，拉黑≠忽略级。
- [x] **P1-3 群治理**：`ownerId`/`adminIds`/`announcement`/`dissolvedAt`；改名/公告/踢人/解散限群主或管理员，管理员不能动群主与其他管理员，群主退群需先交接（409）；公告广播；解散是软删除（历史可读、不能再发）；`findByChatId` 按组织隔离。证据：`group-governance.test.ts` 6 例 + `ChatView.test.ts` 2 例。
- [x] **P1-4 消息呈现**：转发带原作者与**原时间**并渲染；图片内联预览（`el-image` 可放大）；提醒决策抽成 `notifications.ts`（当前会话/可见窗口/无权限静默，**免打扰静默但 @ 突破**）；`muted` 存在每人每会话的已读行上、未读数照常。证据：`presentation.test.ts` 3 例 + `notifications.test.ts` 5 例 + `ChatView.test.ts` 3 例。
- [x] **P2-1 文件边界与拖入**：按文件签名校验扩展名（ZIP/OLE/PDF/PNG/JPEG/GIF/WEBP/文本，fail-closed），不匹配 415 + 审计；聊天区支持拖入单文件（含类型/大小预检与多文件提示）。证据：`file-signature.test.ts` 5 例、`documents-upload.test.ts` +2 例、`ChatView.test.ts` +2 例。
- [x] **P2-2 窗口置顶与隐藏**：主进程 `chatagent:window`（固定动词）+ 托盘菜单项（标签实时）+ `status().window` 读窗口真实状态；页面侧仅在桌面壳渲染控件。证据：`electron-nav-check.mjs` +5 项（13/13）、`ChatView.test.ts` +1 例。
- [x] **P2-3 内容钩子（关键词正则）**：群主/管理员可设每群 ≤20 条正则，命中即召唤助手且目标标注触发规则；走同一闸门/等级/审计；设置时拒绝灾难性回溯形态，匹配时有长度上限与 25ms 预算。证据：`content-hooks.test.ts` 7 例、`content-hooks-wiring.test.ts` 3 例、`ChatView.test.ts` 1 例。
- [x] **P2-4 澄清提问打通**：新增无副作用 `ask_user` 工具，提问作为助手消息发进原会话、任务停在 `waiting_input`；请求者的下一条消息经 `appendInput` 追加历史后 `resume`（不新建任务），他人消息不算答案，一次一个问题且随任务持久化。证据：`clarification.test.ts` 3 例。
- [x] **P2-5 会话外观（界面背景）**：`Conversation.appearance` 闭集（预设 id 或 #rrggbb），任何参与者可设；渲染为房间底色，深色房间自动切浅色文字且气泡保持实色（对比度不受影响）；非法样式串一律 400 且不改变已存值。证据：`appearance.test.ts` 3 例、`ChatView.test.ts` 2 例。
- [x] **P2-6 会话别名**：每查看者私有的 `{title?, members?}`（存在本人已读行），覆盖侧栏会话名、气泡发送者名与自己在本群的昵称；只能标注本会话成员、≤32 字、≤200 项、空串即清除。证据：`aliases.test.ts` 3 例、`ChatView.test.ts` 2 例。
- [x] **P2-7 事件游标与存储决策**：`docs/adr-0004-storage-and-event-cursor.md`（继续 JSON + 迁移触发条件 + 代价）；`since()` 返回 `truncated`，游标过期时 SSE 先发 `event: resync` 让客户端重载（不再静默丢一段消息）。证据：`cursor-expiry.test.ts` 3 例、`event-replay.test.ts` 更新、`ChatView.test.ts` 1 例。
- [x] **P2-8 表情与贴纸**：表情=插入普通字符；贴纸=contracts 里的闭集目录（id 随消息走、客户端自带资源渲染、未知 id 400 且客户端不渲染）。证据：`stickers.test.ts` 2 例、`ChatView.test.ts` 2 例。**P0/P1/P2 既定条目至此全部落地**；下一阶段转入端到端复验与收口。
- [x] **投喂重试预算（补 P0-1 收尾）**：入队项带 `maxAttempts`（默认 8，`CHATAGENT_AGENT_INTAKE_MAX_ATTEMPTS` 1-100），用尽即终态 `failed`，不再无限重试；等待撤回窗口不计入预算；`/api/agent/status` 报 `failed`/`stalled`，审计写 `agent_intake.failed`，会话只收到闭集原因码与次数（原始错误不外发）；客户端显示「已重试 N 次，请稍后重发」。证据：`agent-intake.test.ts` +2 例、`ChatView.test.ts` +1 例。

待产品确认的 9 个语义问题见该文档 §4（好友分级的对象、拉黑归属、转发撤回是否级联、公告范围、队列栈粒度、文件安全是否含内容扫描、窗口背景指哪个窗口、个人 ID 含义、目录外授权的形式）。

## 待办（第四十一轮发现，未处理）

- [x] 依赖审计的「空报告当干净」通道已封（第四十一轮）：registry 不可达时 pnpm 返回 `{"error":…}` 且退出码 0，脚本曾据此打印 `0 advisories` 并成功退出；现在缺 `metadata.totalDependencies` 就按未验证处理、退出 2。
- [ ] **依赖高危项（已定位来源）**：`extract-zip@2.0.1` 来自 `electron@39.8.10`，而 electron 是 `@chatagent/desktop` 的 **devDependency**（`pnpm why extract-zip` 实证：extract-zip@2.0.1 <- electron@39.8.10 <- @chatagent/desktop；没有任何 workspace 包声明它）。在打包产物 apps/desktop/release 里找不到任何 extract-zip 痕迹（本轮实核对），它没有随安装包分发。 所以正确的修法是**随既定的 Electron 版本切换一起消失**（彩排已在 42.4.1 全绿），切完复跑 `node scripts/audit-deps.mjs --level high` 核对，而不是现在动依赖树。既有验收门仍是 `--level critical`：**「critical 门通过」不等于「没有高危」**；是否把门提到 `high` 由产品决定（提上去会让当前验收立刻变红）。

- [x] **3B 转发级联撤回**（2026-09-21 所有者确认后实现）：撤回原文时按来源级联撤回转发副本（可跨会话）、取消其投喂项、广播事件并审计 `message.recall_cascade`；仅原文发送者可发起、窗口按原文判定。证据：`recall-cascade.test.ts` 3 例 + 根套件 51 文件 / 413 用例 + 线上实测（副本 recalledAt 置位、正文为空）。

- [x] **9C 管理员预置允许目录**（2026-09-21 所有者确认后实现）：宿主新增 `grantedWorkRoots`（默认空 = 旧行为），桌面从 `CHATAGENT_AGENT_GRANTED_ROOTS` 读取；授权根先 realpath、空白条目跳过、前缀相似不放行。证据：`workdir-grant.test.ts` 4 例、根套件 52 文件 / 417 用例、`gate7a-verify` Flow6 逃逸仍被拒、Electron 宿主冒烟 6/6。

- [ ] **1C 好友可见性**：按建议先试的「非好友不能开单聊」会让 **10 文件 / 35 用例**失败，说明它改变的是沟通模型而非加一层可见性，**已回退**；修正建议是落在发现层（联系人列表/搜索不可见，群内成员仍可见）。等你选，见 docs/design-1c-8b-5-2026-09-21.md。

- [x] **第 5 条：队列栈粒度改为每人一份**（2026-09-22 按所有者答复「用户设置」实现，差距矩阵 §3.19）：契约 `MemberPreferences` + `memberPreferencesSchema`（1–200、`.strict()`、空 patch 拒绝、越界 400）；新 `MemberPreferencesStore`（`data/member-preferences.json`，只存显式改动）；`GET/PATCH /api/preferences`（无成员 id 参数 = 只能改自己，PATCH 写审计 `member.preferences_updated`）；生效点两处——`AgentIntakeGate.contextLimitFor(requesterId)` 决定入队上下文、`appendInput(..., {limit})` 决定澄清追加历史。证据：`preferences.test.ts` 6 例、`agent-intake.test.ts` +3 例、根套件 **53 文件 / 426 用例**、`tsc` 0 错。
  - [x] **同条的下一片：客户端入口已补**（2026-09-22 同日）：设置页新增「我的助手偏好」卡片（两个 1–200 的数字 + 保存，显示服务端确认的「当前生效」值；保存失败保留旧值并显示错误），`api.preferences.get/update` 走 `GET/PATCH /api/preferences`。证据：`SettingsView.test.ts` +3 例、web 套件 **80 用例**、`vue-tsc` 0 错、生产构建通过。至此「用户可设置」在服务端与客户端都成立。

- [x] **第 1 条：好友可见性落在发现层（1C-(a) 组织目录可搜）**（2026-09-22 实现，差距矩阵 §3.20）：联系人列表只含「有关系记录的人」（好友 / 任一方向的待处理申请 / 被拉黑或起过备注的人）+ AI 账号；`GET /api/members` 成为发现入口（全组织可列，`online` 只给自己与好友）；`GET /api/presence` 同样收窄；客户端联系人卡片新增目录搜索（姓名 + 「加好友」，不显示状态），`peerOf`/群成员名回落到目录，新建群候选改为目录。**沟通层不动**：与未加好友的同事单聊、拉群、@、收发消息照常（用例钉死）。证据：新增 `contact-visibility.test.ts` 4 例、改到 4 个编码旧假设的既有断言、`scripts/smoke.mjs` 对端改取目录（否则会静默跳过撤回验收）、根套件 **54 文件 / 430 用例**、web **77 用例**、`tsc`/`vue-tsc` 0 错。
  - [x] **同条的下一片：8B 唯一 handle 已交付**（2026-09-22，差距矩阵 §3.21）：`PATCH /api/auth/handle`（无成员 id，只能改自己）、组织内唯一 409、保留词与格式 400、改名冷却 429（`CHATAGENT_HANDLE_CHANGE_COOLDOWN_DAYS` 默认 30，0 关闭）、旧名保留期 409（`CHATAGENT_HANDLE_RETENTION_DAYS` 默认 90，0 立即释放，本人随时可取回）、老成员在 `me()`/目录首读时惰性派生、目录搜索同时匹配显示名与 handle、设置页「我的个人 ID」卡片。证据：`handles.test.ts` 6 例、`SettingsView.test.ts` +2 例、`ChatView.test.ts` +1 例、根套件 **55 文件 / 436 用例**、web **83 用例**、`tsc`/`vue-tsc` 0 错。**九问至此全部落地。**

## 第 59 轮：测试基线与保留审计预算（2026-09-30，差距矩阵 §3.25）

起点是基线测量：干净 HEAD 上根套件并非全绿（首跑 2 文件失败、复跑换成另一文件），三个失败用例各指向一处真实缺陷。

- [x] **锁心跳的归属校验由 mtime 改为内容比较**（`store.ts`）：NTFS 时间戳粒度 ~15ms（独立复核实测同戳：plain write 40/300、write+rename 27/300），同一 tick 内落地的外来锁会被漏检并由 rename 覆盖——等于静默接替第二个写者。现在比较 pid + 本次 token；`host-security-verify.test.ts` 的 lostReason 断言同步更新。**订正（第 61 轮）**：那句「断言同步更新」不成立——它匹配的是**读时**检查，提交点检查从未被走到（改回 mtime 套件仍全绿）；第 61 轮补了确定性用例并变异验证，见 §第 61 轮。
- [x] **只有 ENOENT 才算「锁文件消失」**：`readFile` 的瞬时失败（EBUSY/EPERM）不再导致 `loseLock()` 永久退出持有；并让 `refreshLock()` 走与定时器相同的串行链（此前它与定时器共用 `.beat` 临时文件、可并发截断载荷）。
- [x] **`AuditLog` 首条记录不再丢**（`apps/server/src/audit.ts`）：删掉 `ready` 缓存（`mkdir` 与 `appendFile` 是两次 await，首条 append 若在目录建好前失败，标志已置位，此后整个进程的审计行全部静默失败），改为每次 append 都 mkdir（幂等）。证据：新增 `apps/server/src/audit.test.ts` 4 例。
- [x] **8 处审计读取的 ENOENT 竞态**：`membership-security` / `security-hardening` / `agent-intake-wiring` / `contact-tier` 统一改走 `test-helpers.waitForAudit()`（容忍 ENOENT、轮询到预算耗尽、失败表现为缺行而不是文件系统错误）；删掉三处「再读一次要求内容相等」的新竞态断言。
- [x] **`lock-takeover` 用例不再依赖本机 pid**：`inspectStoreLock`/`takeOverStoreLock` 接受可注入的 `alive` 判定（生产调用方不传 = 行为不变），并新增一例覆盖 `dead_pid` 分支。
- [x] **保留审计文件自身的预算**（`packages/agent-host/src/retention-audit.ts`，§3.24 的已知缺口）：双预算（行 1200 / 字节 1 MiB）+ 高水位滞后（`+32` 触发、裁回预算，避免饱和后每次写入都重写）+ meta 行（`task_store.retention_audit_rotated`，含批次数与最多 200 个 id + 精确截断计数，保留上一条 note）+ tmp→fsync→rename + 不抛（裁剪失败仍追加、计数上报）。证据：`retention-audit.test.ts` 14 例、`retention.test.ts` 17 例、真实 Electron 工作台 18/18。

**本轮验证**：根套件 **57 文件 / 464 用例**、`tsc` 0 错、web **83 用例** + `vue-tsc` 0 错；桌面壳七项在 HEAD 上 **91/91、退出码全 0**（lock 18、receipt-sync 21、host-smoke 6、workbench 18、quit 10、csp 5、nav 13）。**订正（2026-10-08 第 60 轮）**：此处原写「92/92」，但逐项合计为 91，且当时没有任何一条命令能复现该合计（见 §第 60 轮）。**未验证**：真实 Hermes + 真实模型凭据（Gate 7A.3）、双机局域网、安装包 GUI 人工验收；以及工作台检查里 20 行种子差额的原因（文件自洽，断言未保留，未宣称已解释）。

## 第 60 轮：桌面壳证据收口（2026-10-08，差距矩阵 §3.26）

起点是复验第 59 轮：根套件 464/464、web 83/83、`tsc` 0 错都复现了，但「桌面壳七项」复现不出来——不是某几项失败，而是**没有任何一条命令能跑出那个合计**。

- [x] **桌面壳七项没有单一运行器，且 `acceptance.mjs` 用错了运行器**（真缺陷）：七项检查里五项是 *node* 脚本（自己 spawn Electron，脚本头部写着 `Usage: node …`），两项（workbench / host-smoke）才是 *electron* 脚本；`scripts/acceptance.mjs` 却用 Electron 二进制启动**全部六项**（还漏了 `host-smoke`）。后果实测：`electron-lock-check.mjs` 在 Electron 下 `process.execPath` 变成 `electron.exe`，它派生的「存活持有者 / 已死 pid」两个辅助进程变成 Electron 调用，第二个场景永远等不到，**检查只打印前 5 项后无限卡住**（本机实测，无超时、无诊断）。新增 **`scripts/desktop-shell-checks.mjs`**：一张运行器表（每个脚本对应自己声明的运行器）+ 单脚本超时（默认 300s，超时按**失败**报出并杀进程树）+ 一行合计；`acceptance.mjs` 改为调用它，七项一次跑完（补上 `host-smoke`）。证据：`node scripts/desktop-shell-checks.mjs` → **92/92、退出码 0**。
- [x] **五个 node 脚本自加运行器守卫**：在 Electron 下立即打印原因并 `exit 2`，把「卡死」变成「明确失败」。证据：`electron scripts/electron-lock-check.mjs` → 退出 2 + `this is a node script (it spawns Electron itself) — run: node …`。
- [x] **订正第 59 轮证据里的合计**：四处（`docs/tasks.md`、`docs/handoff-2026-09-18.md`、差距矩阵 §3.25、`Prompt/2026-09-30-continue-project.md`）把「桌面壳七项 92/92」订正为 **91/91**（18+21+6+18+10+5+13），并标注订正时间与原因。**「critical 门通过」式的口径同样适用**：一个不可复现的合计不是证据。
- [x] **工作台检查补回一条可证明的不变量**（第 59 轮记的「20 行种子差额、原因未查明」由此收口）：`electron-workbench-check.cjs` 新增断言——每个种子批次要么还在审计文件里、要么被裁剪计数，`kept + dropped === seeded`。实测 **`kept=1196 dropped=904 seeded=2100`**，精确成立。第 59 轮那条被删掉的断言（把「进程内读到的计数」与「文件里读到的计数」混在一处比较）不可恢复（第 59 轮从未提交），但其失败**不是数据缺陷**：同一批数字在当轮也自洽（该轮自己记了 1196+904=2100），现在两个数都取自读者会看的那两处（文件 + `status()`）并通过。
- [x] **顺手订正交接文档里的运行器指引**：`docs/handoff-2026-09-18.md` 原写 quit / csp / nav「必须用 `electron` 跑」，与这三个脚本自己的 `Usage: node …` 相反（本机实测 `node` 下 10/10、5/5、13/13 全过）；改为「两个必须用 electron，其余五个用 node，一律走 `desktop-shell-checks.mjs`」。
- [x] **`receipt-sync` 的状态目录耦合（加固，不是仍可达的缺陷）**：它用固定目录 `Temp/receipt-sync-check` 并在启动时 `rmSync(…, {force:true})` 重置，退出只杀直接子进程。**实测触发路径**：我最初把五项 node 检查误用 `electron` 启动（正是上一条那个缺陷），误启动的实例留下 Electron 子进程占着 profile 目录，导致随后用 `node` 正确启动的 `receipt-sync` 在重置处抛 `EPERM`（或退化成 `14/15 checks passed`，干净状态下是 21/21）。修法：状态目录改为**每次运行唯一**（`mkdtempSync`）、退出按**进程树**杀（`taskkill /pid <pid> /T /F`）。**不夸大**：① 误启动这条路已由运行器守卫堵住；② 旧行为（固定目录 + 只杀直接子进程）与 csp / nav / quit 相同，而这三者在**正确运行器**下实测零残留进程（退出后 0/0/0），`receipt-sync` 改后同样零残留——所以这两处是**加固**（与 lock 检查的 `taskkill /T` 对齐），不是修一个仍可达的缺陷。**仍存的边界**：五项检查共用仓库内固定状态目录（`Temp/<name>-check`），因此**两个并发的清扫会互相踩**（独立复核就复现过一次纯由碰撞造成的假失败）；单条命令顺序跑可复现（连跑两轮同结果，见下），并发不在本轮的验收口径内。
- [x] **运行器不再相信脚本自报的分母**：`desktop-shell-checks.mjs` 给七个脚本各钉了预期条数（18 / 21 / 6 / 19 / 10 / 5 / 13）。上面那次退化就是反例——脚本自报的 `14/15` 本身是自洽的，一个只看「N/M 都过」的合计会把 15 当成完整的 15 项吸收掉，合计照样「全绿」而证据已经少了两成。分母不等于钉死值即判失败（`the script's assertion set changed`）。

**本轮验证**：根套件 **57 文件 / 464 用例**、`tsc` 0 错、web **83 用例** + `vue-tsc` 0 错；桌面壳七项 **92/92、退出码 0**（lock 18、receipt-sync 21、host-smoke 6、workbench **19**、quit 10、csp 5、nav 13），由单条命令 `node scripts/desktop-shell-checks.mjs` 复现，**连跑两轮同结果**（第二轮即幂等性验证：改前第二轮的 receipt-sync 会因残留进程崩溃或退化成 14/15）。**未验证**：与第 59 轮相同（Gate 7A.3、双机局域网、安装包 GUI 人工验收、长跑设备）；本轮只改检查脚本与文档，未触碰产品源码。

## 第 61 轮：扇出审计收下的三个缺陷（2026-10-08，差距矩阵 §3.27）

起点是「fan out subagents 继续」：六个只读发现子代理按面各自报缺陷（桌面壳检查 / 宿主存储与锁 / 宿主授权 / 服务端对象授权与审计 / 投喂闸门 / 测试质量），每条再由 **3 个独立复核子代理**从「能否复现 / 有没有守卫 / 影响是否成立」三个角度对抗，多数否证即丢弃。

**过程留痕（两个失败，都不掩饰）**：① 首轮跑到 13 个结果时进程中断，**没有产出综合报告**，结果从 workflow journal 里逐条取回；② 第二轮的 25 个子代理**全部因用量配额 429 失败**（`agents_done: 0`），所以只有首轮拿到裁决的发现进入了本轮，其余原样记为**未验证**。③ 首轮的复核子代理**违反了只读约束**：往仓库里写了探针测试与日志，还手工复制了一整份 `packages/agent-host/src/iso/`（会被 `vitest.config.ts` 的 `packages/*/src/**/*.test.ts` 收集成测试）。已把探针证据移到 `Temp/agent-probes/` 并从仓库删除，`git status` 归零、套件复跑全绿；第二轮已把「只在仓库外的临时目录里复现」写成硬规则。

- [x] **`ignore` 级在「排队中的投喂」上不生效**（真缺陷，3 个复核全部确认并端到端复现）：延迟模式下，confirm 级联系人发来消息 → 所有者在撤回窗口内把他改成 `ignore` → 窗口到点后该投喂**照样提交**，任务完成并把助手回复发进了会话。最严的一档反而最不被执行，所有者的指令只对「下一条消息」有效。根因：`deliver()` 只复查 `recalledAt` 不复查 tier；`runTask()` 里 `const policy = tierPolicy(tier)` 是**死变量**（算了从不读）。修法：`AgentIntakeGate` 新增 `mayIntake` 选项，在 `deliver()` **提交前**复查（与 `recalledAt` 同一位置、同一理由），不通过按 `tier_ignored` 取消；`mayIntake` 抛错时**不当作放行**——抛进既有重试路径，让投喂等待重试而不是被未验证地交出。证据：新增 `agent-intake-wiring.test.ts` 用例（排队 → 降级 → 窗口过后：无任务、`cancelled=1`、`submitted=0`）；**变异验证**：短路该检查后用例失败（`expected [...] to have a length of +0 but got 1`）。
- [x] **非撤回类的投喂取消不留审计**（真缺陷，修上一条时发现）：闸门 `onEvent` 只对 `failed` 写审计，`cancelled` 一律不写；撤回路径之所以有 `agent_intake.cancelled`，是服务端在撤回处自己补的。所以 `tier_ignored` 取消**在审计里毫无痕迹**（实测审计文件只有 `auth.login` 与 `message.sent`）。修法：闸门 `onEvent` 对 `cancelled` 也写一行（含 reason、不含正文），**排除 `recalled`**——那条由撤回路径自己写（它知道行为人），否则每次撤回都重复计数。
- [x] **两处「审计不写密钥」断言里有一处是死的**（测试质量）：`audit.test.ts` 断言审计文件不含 `super-secret-token`，但那个字面量在该测试里**从来不是输入**，任何实现都能通过。修法：改成真的传一个多余字段（`token: 'super-secret-token'`）并断言它**不落盘**——这才是 writer「只写认识的字段」的不变量；另加「每个字段都被截断」一例。**变异验证**：writer 改成 `{at, ...event}` 时两条都失败（token 出现、长度 500 > 65）。**同轮否证**：复核称姊妹用例 `security-hardening.test.ts` 那条「同样空洞」——**不成立**：它是集成用例（真 token POST 给真登录路由），把路由改成记录 token 会让它失败（实测 1 失败）；它守的是调用点，不是 AuditLog。
- [x] **第 59 轮的锁内容修复此前没有会失败的用例**（测试质量，见上文订正）：补 `beforeLockCommit` 测试缝（生产不传，与 `heartbeatMs` 同类），在提交窗口内落一把外来锁，并把两个文件设成**同一时间戳**，让 mtime 比较真的分辨不出。**变异验证**：把提交点改回 mtime 比较，该用例失败（`held: true`——旧检查看不出来，会照样 rename 覆盖）。顺带把既有那条改成确定性命中**读时**分支（先 drain `load()` 排出的 beat 再写外来锁）——它此前两种结局都可能，所以断言才写成了容忍正则。

**本轮验证**：根套件 **57 文件 / 467 用例**（+3）、`tsc`/`vue-tsc` 0 错、web **83 用例**；改过 `packages/agent-host` 后重建 `agent-host.bundle.cjs`，桌面壳七项复跑 **92/92、退出码 0**（lock 18、receipt-sync 21、host-smoke 6、workbench 19、quit 10、csp 5、nav 13）。

**未验证（配额耗尽，既未确认也未否证，不得当作已解决）**：`GET /api/audit` 是否跨组织（若成立最严重）、审批决定是否不写审计、webhook 发送者是否恒被解析为 owner 档、审批的决定期与发送期规则是否互相矛盾；以及一条探针线索（外来锁是否会被心跳覆盖，疑似探针假象，见 `Temp/agent-probes/probe-log.txt`）。

## 第 62 轮：把中断的审计跑完，并收下它确认的缺陷（2026-10-08，差距矩阵 §3.28）

配额恢复后重跑扇出：2 个发现子代理（补第 61 轮没跑完的两个面：桌面壳检查、宿主存储与锁）+ 对**第 61 轮那五条未验证发现**的 3 人复核 + 综合。36 个子代理全部完成、0 错误。**仓库零改动**（第 61 轮把「只在仓库外的临时目录里复现」写成硬规则后，违规没再发生；本轮 `git status` 全程为空）。

**确认并已修（每条都有会失败的用例）**

- [x] **`GET /api/audit` 不按组织隔离**（跨租户读，最严重）：`listAudit` 只做 `requireOrgAdmin`，把全局 `audit.jsonl` 原样返回。**实测**：`org_other` 的 owner 用**真 token** 登录后 `GET /api/audit` 拿到了 `org_local` 的行。服务端其他所有列表面（`listOutbound`/`listMembers`/`listContacts`/`listApprovals`/`listOutbox`）都过 `sameOrganization`，只有这里没有。修法：`AuditLog` 增加默认组织（写时给没有组织的行盖章）+ `listAudit` 读时过滤，且**以行为人所属组织为准**（查成员记录，不信任行上的字段），查不到行为人的行按盖章组织判断，两者都没有则不展示（fail closed）。证据：新增 `security-hardening.test.ts` 用例（两个组织写同一个文件，各自只看到自己的）；**变异验证**：去掉过滤后 `org_local` 的管理员能看到 `u_theirs`。
- [x] **失败的写入会被并发写入「撤销回滚」**（数据完整性）：`persist()` 在入队**之前**就抓快照，而 `commit()` 的回滚只恢复自己那条——于是第二个提交（快照里含着第一个的改动）把已回滚的状态写回磁盘。调用方被告知「写入失败」，磁盘上却留着，重启后（或调度器空闲时）该任务照跑。修法：把**整个读-改-写**串行化（`commitChain`），不只是文件写。证据：新增用例断言并发提交不重叠；**变异验证**：去掉串行化后 3 个提交重叠（`expected 3 to be 1`）。**边界**：该用例钉的是「提交不重叠」这一机制（并发下让磁盘写失败无法确定性构造），已在注释里写明。
- [x] **审批决定不写审计**：`POST /api/approvals/:id/decision` 返回 200 并解锁一次真实外发，却不在 `audit.jsonl` 留任何痕迹（兄弟接口 `/api/outbox/:id/resolve` 有）。修法：补 `approval.decided`（行为人 + 决定，不抄自由文本 reason）。**变异验证**：改掉 action 名后用例失败。**订正**：决定本身在 `approvals.json` 里有记录（可变文件，非追加台账），这是审计完整性缺口而非「完全没记录」。
- [x] **导航检查把「CDP 连接掉了」读成「宿主拒绝了未知命令」**（证据完整性）：`cdp.evaluate(...).catch(...)` 的兜底让 15s 超时/WebSocket 断开也满足 `ok !== true`，于是那一行在**没观测到宿主**的情况下打印 PASS。修法：去掉兜底并钉住真实拒绝码 `invalid_command`（与下方窗口动作那条一致）。**实测**：收紧后仍 13/13，说明宿主确实按名拒绝。
- [x] **`acquireLock` 把「读不到的锁」当成「没有锁」**（fail-open）：`inspectLock` 把任何非 ENOENT 的读失败都塌成 `raw=undefined` → `no_lock`/`stale` → `acquireLock` 删掉**活持有者**的锁并成为第二个写者。修法：读失败时改用 `stat`（在拒绝读的共享模式下仍成功），「存在但读不到」判为 `owner_unknown`/`stale:false`/`ambiguous:true`，于是启动直接抛 `AgentHostStoreLockedError`（与心跳的 `readLock` 同一口径）。证据：新增用例（用目录作为「存在但读不到」的可移植构造）；**变异验证**：还原后状态变回 `no_lock`。
- [x] **CSP 检查把「测不出来」当成「被拦住了」**（加固）：`inline === undefined || inline === false` 接受了探针超时/报错的结果。改为 `inlineState.ok && value === false`（相邻场景同样收紧为 `ok && value === true`）。

**判为否证，不改（记录以免重蹈）**

- **心跳「读与 rename 之间」的 check-then-act 窗口**（第 61 轮留下的探针线索）——**3/3 否证**。窗口是代码事实（读与 rename 之间确实没有 await），但**仓库里没有任何写入者能落在那里**：`tasks.json.lock` 的写者只有 `writeFile({flag:'wx'})`（文件在则失败）、beat 自己的 rename、`rm`、以及 `takeOverStoreLock` 的**改名移走**（路径变空，beat 会主动让位）。探针用的是裸 `writeFile` 覆盖一个**存在**的锁——生产代码不做这件事；且只在**同进程**内复现（跨进程 0/1400 次）。**探针假象，不修**。
- **三处 shell 检查断言是字面量 `true`**——**2/3 否证**。事实为真（三行都是 `true`，名字都过度声称），但被声称的危害都有别处兜着（导航检查用 `Object.keys` 白名单钉死了窄桥）。属harness 卫生问题（约 3% 虚高），不是验证缺口。

**复核三票分裂、按「未决」记录（不得当作已确认）**：webhook/IM 发送者恒被解析为 owner 档（`defaultTier` 对外部平台发送者不生效——需产品口径：外部发送者是否属于分级功能的适用范围）；审批「决定期」接受账号所有者、而「发送期」要求目录 owner/admin（需产品口径：账号所有者条款是否该存在；「反之亦然」那半被三票一致否证，决定期只会更宽松）；生产环境委托路径惰性（需产品决定：补签发路径还是隐藏该入口）。

**同轮顺带修掉的用户可见问题**：桌面壳检查会驱动**真实应用**，于是每一项都在桌面上闪一个 ChatAgent 窗口、显示检查用的桩页面（导航检查里那一下还会把窗口指向 `/app.js`，浏览器把 JS 当源码渲染，窗口上出现 `window.__ready = 1;`）。修法：`main.cjs` 新增 `CHATAGENT_NO_WINDOW=1`（创建但不呈现窗口，渲染器与 CDP 照常），运行器为七项统一设置；导航检查**按设计**仍会短暂呈现窗口（它验的就是窗口状态），因此顺带把 `show` 也做成与 `pin` 同口径——**回读真实可见性，没生效就如实返回失败**，而不是假装成功。

**本轮验证**：根套件 **57 文件 / 470 用例**（+3）、`tsc`/`vue-tsc` 0 错、web 83 用例；重建 `agent-host.bundle.cjs` 后桌面壳七项 **92/92、退出码 0**（全程无窗口）。

**新发现、本轮未处理**：**根套件在 HEAD 上并非稳定全绿**——实测 HEAD（7fc0e97）4 次跑挂 1 次（`security-regression.test.ts` 的 outbound 组织隔离），带本轮改动时另见 `authorization-refresh.test.ts` 与 `retention.test.ts` 各挂一次；**三次挂的是三个不同的用例**，且单独跑都通过，指向**并行执行下的资源争用**而不是某个用例坏了（`retention` 那次挂在 `auditFailures` 非 0，即瞬时文件系统错误被计入）。**已在第 63 轮处理，见下。**

## 第 63 轮：同一个任务被执行两次（根套件不稳定的真因）（2026-10-09，差距矩阵 §3.29）

第 62 轮记的「根套件在 HEAD 上 4 次挂 1 次」不是用例坏了，是**宿主调度器的一个真缺陷**：**同一个任务会被执行两次，且两次并发**。

**复现与证据**：先测频率——6 次全量跑挂 1 次（`authorization-refresh.test.ts` 的「holds new side-effect work…」，断言 `calls.sort()` 应等于 `['t-doc','t-running']`，实测 `t-doc` 出现 **5 次**）。单独跑该文件 25 次全绿，所以必须复现「并发调度」这个条件。

**机制**：`dispatch()` 在 `await store.claim(...)` **之前**检查 `active.size`，而 `claim` 对「状态 running、租约持有人相同」的任务是**幂等返回**的（**不 bump version**）。于是：一个调度在 `active` 还空的时候通过了那道检查 → 等到它真正 `claim` 时，另一个调度已经把该任务跑起来了 → `claim` 幂等返回 running 记录 → `execute` 里的 `compareAndSet` 版本号**正好匹配** → 执行器**再跑一次**。负载越高，`list()`/`claim()` 的延迟抖动越大，越容易撞上——这正是它只在全量并行下偶发的原因。

**修法**：在 `await claim` **之后**重新检查——`active.has(taskId)` 直接挡住「同一个任务跑第二次」，并补上并发上限的复查（此前只在 await 前查过一次）。生产默认 `maxConcurrency` 为 1（`main.cjs` 不设，`service.ts:212` 那个 2 是服务端 TaskEngine 的），该窗口在 1 下同样可达。

**确定性复现**（新增 `host.test.ts` 用例）：把**第二次** `claim` 卡住，直到第一次已经跑起来（`waitFor(calls.length >= 1)`），再放行 → 修复前 `expected [ 'overlap-1', 'overlap-1' ] to deeply equal [ 'overlap-1' ]`。**注意并发度取 2**：在 1 下并发上限复查会先挡住它，用例就钉不住真正要钉的性质（同一个任务不得跑两次）。

**变异验证**：去掉 `active.has` 检查 → 用例失败（`['overlap-1','overlap-1']`）；加回 → 通过。

**效果**：修复后**连续 20 次全量跑全绿**（每次 471 用例；修复前 6 次挂 1 次）。**边界（不夸大）**：这直接解释了 `authorization-refresh` 那条（同一签名，已证明）；另两条（`security-regression`、`retention`）修复前各只见到一次、修复后 20 次未复现——**20 次不足以单独证明它们也被修好**，只能说与该修复相容。`retention` 那条的签名（`auditFailures` 非 0）指向瞬时文件系统错误被计入断言，是另一类原因，若复现应单独处理。

## 第 64 轮：把「睡一觉再断言」的用例改成等条件，并给验收链加超时（2026-10-09，差距矩阵 §3.30）

起点是第 63 轮的订正：20 次全绿之后，紧接着 10 次抽样挂了 1 次，是同文件里**另一条**用例。

- [x] **`authorization-refresh.test.ts` 用固定 `sleep` 等调度结果**（真脆弱断言）：`does not run work whose delegation the service revoked after submission` 在 `resume()` 后 `await setTimeout(150)`，再断言任务已变 `failed`。负载高时调度器 150ms 内还没走到该任务，读到的仍是 `queued` → 挂（实测签名：`expected 'queued' to be 'failed'`）。修法：换成 `waitFor(状态 === 'failed')`。同文件另一条（`unknown` 委派应**保持** queued）是**否定断言**，睡一觉无法区分「被 hold 住」与「还没被看到」——改为先等**肯定信号**（`status().authorization.heldTasks >= 1`）再断言它没被启动。
- [x] **`acceptance.mjs` 的每一步都没有超时**（真缺陷）：`run()` 用 `spawnSync` 且不传 `timeout`，卡住的 `ui-e2e` / `build` 会把整条验收链**永久挂住**且不打印任何原因——这正是第 60/61 轮反复强调的那类问题。修法：加每步上限（默认 20 分钟）并识别 `ETIMEDOUT`，超时按**失败**报出并写明原因。
- [x] **顺手订正第 63 轮的结论**：见上「订正（第 64 轮）」。

**本轮验证**：根套件 **57 文件 / 471 用例**、`tsc`/`vue-tsc` 0 错；**连续 15 次全量跑全绿**（第 63 轮修复后累计 45 次跑、1 次挂，那一次已在本轮修掉）。

**本轮未复现、未修**：`retention.test.ts` 的 `auditFailures` 非 0——带探针跑 10 次全量**没有复现**（`auditFailures` 全为 0）。**不当作已解决**，只是本轮没有信号；其签名指向「瞬时文件系统错误被计入断言」，若再出现应单独处理。

**本轮记录、未处理**：全仓测试里还有 **68 处** `setTimeout(resolve, N)`；其中多数是正当的（`waitFor` 轮询间隔、清理时的 `Promise.race` 上限），但也有「睡一觉再断言」的同型写法。本轮**只改了有证据的两处**，没有盲目批量改写——把 68 处一律改掉的风险大于收益。

**订正（第 64 轮）**：上面那句「连续 20 次全绿」是真的，但**不足以说明套件已经稳定**——紧接着的 10 次抽样里挂了 1 次，是同文件里**另一条**用例（固定 `sleep` 后断言调度结果）。也就是说：第 63 轮修掉的是「同一任务跑两次」这个**真缺陷**（已证明），但套件里**还并存**着与负载相关的脆弱断言。见 §第 64 轮。
