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
   - **保留策略的 id 列表**：现在只上报条数与原因，未列出被清理的具体 taskId（内存计数）；如果审计需要逐条追溯，应落审计而非界面。
   - **完整 XSS 利用链验证**：CSP/导航/分区已加固并有 5/5 + 7/7 检查，但没有端到端的实际注入利用链复现。
