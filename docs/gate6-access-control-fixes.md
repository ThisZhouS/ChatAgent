# Gate 6：访问控制与交付加固（独立对抗性复核后的修复）

日期：2026-09-13 · 关联：`docs/gate5-standalone-hardening.md`、`docs/security-checklist.md`、`docs/adr-0001-standalone-native-chat.md`

本轮由**独立对抗性复核子 agent**（可用子 agent 全权驱动 HTTP API、自带干净实例与数据目录）对「群成员管理 + 自助令牌重置」切片与既有加固面做复核，逐条复现后给出修复。全部结论以当前代码 + 实测为准，未复现的一律不作为结论。

复核基线（子 agent 固定）：`service.ts 047d4daf…`、`stores.ts 8919f3f8…`、`app.ts 2a7792c6…`、`auth.ts 04fbfd45…`、`dist/index.js 290632c9…`。该轮同时确认工具链：`pnpm typecheck` 退出码 0；`pnpm test` 18 文件 / 123 用例通过。修复后本轮为 **21 文件 / 144 用例**（服务端与包 18 文件/129 例 + Web 3 文件/15 例），详见 §8。

## 1. P0：会话劫持（`POST /api/messages` + 调用方自选 `chatId`）

**问题**：`ConversationStore.findOrCreate` 命中已有会话时会把调用者**静默加入** `participantIds`，而 `injectMessage` 只校验「调用者是本组织成员」，不校验会话归属。AI 私聊的 `chatId` 是可推导的（`native:agent:<accountId>:<memberId>`，账号表与成员表对普通成员可读），于是任意成员都能：

- 读任意同事与 AI 的完整私聊历史（文档、生成的文件、汇报内容）；
- 向该会话注入消息，令受害者窗口里出现攻击者内容，并以受害会话为模型上下文驱动 AI；
- 无「踢人」接口（当时只有加入/退出），受害者无法自救；且当时该操作**不写审计**。

**修复**（`stores.ts`、`service.ts`）：

- `findOrCreate` **不再隐式加入**已有会话；合法加入必须走 `addParticipant` 并经过授权检查（`openConversation`、`createGroup`、`NativeImGateway` 本就如此）。
- `injectMessage` 先按 `chatId` 解析会话，再要求 `participantIds` 含调用者，否则 `ServiceError(403,'forbidden','not_a_participant')`，并把已解析的会话传给 `deliver()` 避免二次查找。

**实测**（本机 8787，真实数据目录）：

```
POST /api/messages {chatId:"native:agent:<ai>:u_alice"} as u_bob  -> 403 {"error":"forbidden"}
GET  /api/conversations/<alice-ai-conv>/messages   as u_bob       -> 404
POST /api/messages {chatId:"native:agent:<ai>:u_bob"}   as u_bob  -> 200 {"authorized":true,...}   (合法自建会话仍可用)
```

回归测试 `apps/server/src/membership-security.test.ts`：`refuses a foreign chatId instead of joining the victim conversation`、`still lets a member create their own conversation through the chatId path`。

## 2. P2：退出群聊后仍可读/取消该会话的任务

**问题**：`canReadTask`/`canCancelTask` 只看 `requesterId`，与会话参与关系无关。实测：成员在群里 `@AI` 后退出，仍能 `GET /api/tasks/:id`、`GET /api/tasks/:id/events`（泄露 AI 回复文本）并 `POST /api/tasks/:id/cancel`，而会话本身已 404。

**修复**：`service.ts` 新增 `assertTaskVisible`——任务若绑定会话，则非参与者（组织管理员除外）一律 404；`listTasks` 同步过滤。审批流与任务 SSE 不受影响（发起人仍是参与者）。

回归测试：`revokes task read, events and cancel for the member who left`。

## 3. P2：退群不持久——同名同成员的群「复活」会话

**问题**：群 `chatId` 由 `sha256(org + 排序成员 + 标题)` 派生，复用时 `findOrCreate` 只做「加人」不做「对人」。实测：alice 建群 → 退群 → bob 发言 → 重建同名同成员群 → **同一会话 id**，alice 被隐式拉回并看到退群后的消息。

**修复**：新增 `ConversationStore.setParticipants()`，建群复用时按请求成员集合**对账**（保留原有加入顺序、移除未列出的成员）。语义明确为：**「建群」即声明成员集合**。

回归测试：`keeps a member who left out and reconciles stale participants`（含：不带 alice 重建 → 得到**新会话**且 alice 两条都读不到；被邀请者在下一次同集合重建时被对账移除）。

## 4. P2：超限上传被静默截断

**问题**：`@fastify/multipart` 在 `fileSize` 超限时可能**不抛错**，而路由从不检查 `file.file.truncated`。实测：21 MiB 上传状态在 413/200 之间摇摆；25/40 MiB 一律 200，落盘恰好 20 MiB——用户（与 AI 的 `parse_document`）会拿到**被截断**的文档且无任何提示。此结论同时证伪了 `docs/tasks.md`、`docs/security-checklist.md` 里「上传 413」的旧表述。

**修复**：`app.ts` 在两处（`/api/documents/parse`、上传接口）先判 `file.file.truncated` → `413 {"error":"file too large"}`，并在 `toBuffer()` 之后再判一次；拒绝事件写审计（`upload.rejected`，`detail=truncated:<name>`）。

回归测试：`rejects an upload above the size cap instead of storing a truncated file`（21 MiB 实测 413）。

## 5. P2：smoke 审批人令牌落在仓库目录内

**问题**：`scripts/smoke.mjs` 需要一名非发起人的 owner 来批准外发（自审批按设计被拒），于是把该 owner 的**长期令牌**缓存到 `Temp/smoke-approver.json`，并声称 `mode 0o600`；Windows 上 Node 忽略该 mode（`icacls` 显示 `Authenticated Users:(M)`）。虽然是 git-ignored，但任何本地用户/备份/CI 拷贝都会拿到组织 owner 权限。

**修复**：缓存改到 **`os.tmpdir()`**（仓库之外），支持 `SMOKE_APPROVER_TOKEN` 显式注入；文档明确「这是活凭据，删除缓存文件即可重新签发」。`data/members.json` 里的 `smoke_approver` 已清理，示例成员恢复为 `dev-owner / u_alice / u_bob`。

## 6. P3 批次

| ID | 问题 | 修复 | 证据 |
| --- | --- | --- | --- |
| P3-1 | SSE 走 `reply.raw.writeHead`，绕过 `onSend`，流式响应**没有**安全头与 CSP | 新增 `STREAM_SECURITY_HEADERS` 并合入两条流的 `writeHead` | 测试 `sends hardening headers on streamed responses`（实测 `x-content-type-options: nosniff`、`x-frame-options: DENY`、CSP 存在） |
| P3-2 | 成员增删、建群、发消息无审计——「加人即授予全部历史读取权」却无痕迹 | 新增 `conversation.group_created` / `conversation.member_added`（含拒绝分支）/ `conversation.left` / `message.sent` | 测试 `records group creation, invitations and leaving`（轮询审计文件，写入是合并落盘的） |
| P3-3 | `development` 模式下回环调用者可无凭据 `POST /api/auth/token/rotate`，等于**铸造长期 owner 令牌** | `Principal.viaDevFallback` 标记由 `resolvePrincipal` 注入；该路由对 dev 回退身份返回 `401 a presented credential is required to rotate a token`，并写审计（`denied`/`dev_fallback`） | 实测：无凭据 → 401；带成员会话 → 200 |
| P3-4 | AI 生成的产物以 `kind:'file'` 消息进入会话，但**非发起人**（群友）看到文件气泡却下载 404 | `canReadArtifactShared`：任务绑定会话的**参与者**可下载该产物（仍限同组织） | 测试 `lets a group peer download the document the AI produced`（同群成员 200 且带 attachment 头，非参与者仍 404） |

## 7. 本轮同时交付的其他改进

- **生成的产物直接出现在会话里**：任务产出文件后，服务端追加一条 `kind:'file'` 消息（`已生成文件：<name>` + 附件 `url=/api/files/<id>`），客户端渲染为可点击下载的 `📎` 附件（`service.ts` `appendArtifactMessage`）。
- **真实浏览器级 E2E**：`scripts/ui-e2e.mjs` 通过 Electron 的 CDP 端口驱动**打包后的 exe**：填表登录 → 打开 AI 会话 → 发消息 → 等 AI 回复 → 生成 Word → 校验文件可下载 → 深色模式 → 1024×720 响应式 → **逐个打开 7 个导航页**，并截图存证。**34/34 通过**（含撤回流程）。
- **视图渲染测试**：`apps/web/src/views/views.render.test.ts` 逐个渲染全部页面。起因是本轮一次真实事故：`SettingsView.vue` 的 `<style>` 块被误插到 `<template>` 中间，`vite build` **不报错**、页面照常返回 200，只有 vitest 编译该 SFC 时才暴露（`pnpm build` 因此不足以保证页面可用，必须渲染测试 + 导航遍历）。
- **可访问性实测并修复**：E2E 用 WCAG 公式计算对比度，发现浅色主题次级文字（会话预览、时间戳，12px）仅 **2.8:1**、深色 4.3:1，均低于 AA 4.5:1。调整 `--ca-muted`（浅 `#68707c` / 深 `#98a2b8`）后实测 **4.54 / 5.10**。
- **可靠的本地重启**：`scripts/restart-server.mjs` 按端口定位真实监听进程（Windows 上 `kill` 不可靠）、等待 `/health`、写入 `Temp/server.pid`；避免了「旧进程仍占端口导致新构建未生效」这类事故（本轮真实发生过一次）。

## 8. 复核轮 2：验证子 agent 的二次复核与 N1–N6 修复

修复后由同一个独立验证子 agent（自带干净实例）逐条复核，结论：**P0 会话劫持、退出后任务越权、超限上传、smoke 令牌缓存、SSE 安全头、dev 回退铸造令牌、产物共享范围 7 项 CONFIRMED FIXED**；「退群持久化」「审计覆盖」两项只判 **PARTIALLY FIXED**，并新发现 N1–N7。已按优先级修复：

| ID | 复核发现 | 修复 | 证据 |
| --- | --- | --- | --- |
| N1（P2） | 建群「对账」会**静默踢人**：创建后被邀请的成员，在任何参与者重发同一建群请求时被移除（并连带失去该会话的任务/产物） | 删除 `setParticipants`，改为**只增不减**的并集语义（`createGroup` 逐个 `addParticipant`） | 新测试 `never removes members that were invited in the meantime`；实测：重发后同会话、被邀请者仍可读 |
| N2（P2） | 退群者可用同一标题+成员列表**自我复活**并读到离开期间的消息 | 新增 `ConversationStore.findByChatId`：键已存在且调用者不是参与者 → `409 group_membership_required`；只有现有成员显式邀请才能回来 | 新测试 `refuses re-creation by a member who left the group`；实测 `409` + 读到 `404`，被邀请后恢复 `200` |
| N3（P3） | 重建造群导致的成员变动无审计 | 建群被拒时写 `conversation.group_created`（`outcome: denied`） | 新测试 `records a refused group re-creation` |
| N4（P3） | `message.sent` 只覆盖原生发送；工作台 `POST /api/messages` 与 AI 回复没有 | 工作台路径补 `message.sent`（不含正文） | 新测试 `records sends on the workbench path without leaking the message body`；AI 回复仍不逐条审计（见 §10） |
| N5（P3） | 超限上传被框架提前抛出，`file.file.truncated` 分支实际不会执行，且拒绝未写审计 | 413 分支补 `upload.rejected` 审计 | 代码 `app.ts` 错误处理分支；上传结果仍为 413 且不落盘 |
| N6（P3） | 成员 id 允许任意字符，含逗号时可构造群键碰撞 | `createMemberSchema.id` 限定 `^[A-Za-z0-9][A-Za-z0-9._-]*$` | 契约层校验（400） |

N7（`chatId` 存在性探测：403 vs 200）不修：`chatId` 本就是调用方自选的键，且该差异已被审计记录，属可接受的信息量。

### 复核轮 3（终检）：同一子 agent 对 N1–N6 的再验证 + 新增收尾项

复核结论：**N1、N2、N3、N4、N5、N6 全部 CONFIRMED**（含现场证据：邀请者不被踢、退群者 `409`、拒绝重建与上传拒绝写审计、工作台发送写审计、成员 id 校验 400、`pnpm test` 21 文件 / 193 用例、冒烟 27/27）。同时提出 3 项收尾问题，均已修复：

| ID | 复核发现 | 修复 |
| --- | --- | --- |
| NEW-1（P3，仅开发档位） | `x-chatagent-principal-id` 注入路径不校验字符集，可写入 `evil,comma` 这类 id | `resolvePrincipal` 用同一规则 `isValidMemberId` 校验注入身份，非法即**失败关闭**（匿名 → 401）；规则收敛到 `packages/contracts` 供两处共用 |
| NEW-2（P4） | 所有人都退出的群 `participantIds: []` 会永久无法寻址（重建恒 409，提示语还误导） | 参与者为空的群视为**可回收**：允许重建并重新加入（新增测试 `lets a former member reclaim a group nobody is left in`） |
| NEW-3（P4） | 被拒的重建审计只有标题，没有会话 id | 拒绝原因改为 `group_membership_required:<conversationId>`，随 `auth.denied` 一起落入审计 |
| NEW-4（P4） | AI 自身回复不写 `message.sent` | 明确为已知取舍并写入文档（逐条审计 AI 输出会显著放大日志；若要合规追溯，应在 `appendAssistantMessage` 加结构化审计且不含正文） |

## 8.1 消息撤回 + 长会话渲染修复（2026-09-13 04:30）

**消息撤回**（`POST /api/messages/:id/recall`）：

- 仅**发送者本人**可撤回，且只在窗口内（`CHATAGENT_RECALL_WINDOW_SECONDS`，默认 120s；`0` 表示禁用）；重复撤回幂等。
- 撤回后正文与附件从**所有读取路径**消失：会话历史、消息搜索、会话列表预览、以及**模型上下文**（`buildHistory` 过滤），存储仍保留原文以便审计，但 API 不返回。
- 广播 `message_recalled` 事件，其他客户端气泡即时替换为「对方撤回了一条消息」。
- 前端：自己的（窗口内）消息旁出现「撤回」，撤回后气泡显示占位文案且不再渲染附件链接。
- 审计 `message.recalled`（成功/拒绝，均不含正文）。
- 已知边界（诚实记录）：AI 的回复若**引用**了被撤回的内容仍会保留——那是另一条消息，撤回不追溯第三方内容。

**长会话渲染缺陷（真实事故）**：`ChatView` 的「加载更早的消息」曾是消息列表的**同级分支**（`v-else-if="hasEarlier"`），因此任何超过一页（50 条）的会话**只显示加载按钮、不显示任何气泡**。这是本轮 UI E2E 在演示会话自然超过 50 条后抓到的（`conversation history rendered — 0 bubbles`），已把该按钮移入线程内部，并补前端回归测试 `renders messages AND the earlier-page control in a long conversation`。

## 8.2 已读回执（1:1）（2026-09-13 04:35）

- 新增 `GET /api/conversations/:id/read-receipts`：返回**其他人类参与者**的读游标（AI 账号不计），只有会话参与者可读，非参与者 404。
- 前端在 1:1 会话中把「已读 / 未读」标在自己最后一条消息下（群聊不显示：没有逐人回执时给部分计数会误导）。
- 审计/隐私：回执只暴露给同会话参与者；游标本身来自既有 `ReadStateStore`，没有新增持久化字段。
- 测试：`reports the peer cursor only to participants of the conversation`（服务端）、`marks the last own message as read once the peer cursor catches up`（前端）。

## 8.3 AI 回复审计与群成员面板（2026-09-13 04:40）

- **AI 回复进入审计**（关闭复核轮 NEW-4）：`ChatAgentService` 增加可选审计回调（`app.ts` 注入 `audit.record`），`appendAssistantMessage` 写 `ai.message_sent`（actor=AI 账号、target=会话、detail=`assistant_reply`），**不含正文**。
- **群成员面板**：群会话头部新增「成员」按钮 → 弹窗列出当前参与者（AI 标 `AI` 标签），人名通过联系人接口解析；补前端测试 `lists the group participants in a dialog`。

## 8.4 文档解析资源上限（2026-09-13 04:45）

上传虽有 20 MiB 限制，但小体积压缩包仍可能解出超长文本或百万行表格，直接把模型上下文与内存打爆。新增 `packages/document/src/limits.ts`：

| 上限 | 默认值 | 行为 |
| --- | --- | --- |
| 提取文本字符数 | 200,000 | 超出即截断并附「内容过长，已截断」标记 |
| 段落数 | 2,000 | 保留前 N 段 |
| 工作表数 | 50 | 只物化前 N 个 sheet |
| 单表读取行数 | 20,000 | 只读取前缀，但**行数仍按真实值上报** |
| 每表预览行 | 10 | 控制响应体大小 |

测试：`packages/document/src/document-service.test.ts` 的 `truncates an oversized text document…` 与 `caps workbook sheets while still reporting the real row count`。仍未实现的是 **zip 层炸弹检测**（解压前统计条目数与解压后总大小），已写入 `docs/security-checklist.md` 已知缺口。

## 8.5 会话导出为 Word 记录（2026-09-13 04:50）

- 新增 `POST /api/conversations/:id/export`：把会话（最新 500 条）导出为 Word 记录（`createWordBuffer`），返回可下载的产物视图；参与者才能导出，非参与者 404。
- 内容规则：撤回的消息只写 `[已撤回]`（正文与附件永不出现在导出件里），附件以名称列出，另附「会话类型/参与者/消息条数/导出时间」小表。
- 归属：导出件是**导出者自己的产物**（`ownerId`），同会话他人下载该副本 404（其中不含对方看不到的内容，共享由导出者决定）。
- 前端：会话头部「导出记录」按钮 → 生成并打开下载。
- 审计：`conversation.exported`（含文件名，不含正文）。
- 测试：`exports a Word transcript for participants only, without recalled bodies`（含 docx 文本断言与越权断言）。

## 8.6 Zip 层炸弹防护（2026-09-13 04:55）

上传限制只管**压缩后**体积：几十 KB 的 deflate 数据可以解出几百 MB，解析器一开始工作就已经把内存打满。新增 `packages/document/src/zip-guard.ts`，在把 buffer 交给 Word/Excel 解析器**之前**检查 zip 中央目录：

| 限制 | 默认值 | 说明 |
| --- | --- | --- |
| 条目数 | 2,000 | 防止海量小条目 |
| 单条目解压后大小 | 64 MiB | 单文件膨胀上限 |
| 全部条目解压后总大小 | 200 MiB | 累计膨胀上限 |
| 单条目压缩比 | 200:1 | 高压缩比即拒（含 compressedSize=0 但 uncompressedSize>0 的畸形条目） |

- 非 zip buffer 直接放行（文本/CSV 等）；中央目录越界、截断、签名错误的统一按 `DocumentLimitError`（reason `zip_directory`）拒绝。
- 拒绝路径经 `service.parseUploaded` 映射为 **413**（不是 500），消息说明触发的是哪条限制。
- 现场验证：正常 docx（8.5 KB）解析 200；71 KB 的 docx 形状炸弹（解压 70 MB）→ **413 `archive entry expands to 73400320 bytes (limit 67108864)`**；`data/uploads/` 不受影响。
- 测试：`packages/document/src/document-service.test.ts` 的 5 例（单条目膨胀、极端压缩比、条目数、非 zip 放行、经 document service 的整链拒绝）。
- 仍然不覆盖：**嵌套压缩包**（zip 里再放 zip 由解析器自行处理）与非 zip 格式（PDF 等）的解析资源上限。

## 8.7 在线状态（2026-09-13 05:00）

- `NativeEventHub.onlinePrincipals()`：拥有**已认证事件流**的主体集合 —— 这是服务端唯一诚实的「在线」定义（客户端连着，不代表人正在看屏幕）。
- `GET /api/presence` 返回同组织在线成员；`GET /api/contacts` 的每个成员带 `online` 布尔值（AI 账号仍用 `accountStatus`）。
- 前端：联系人头像带绿点、副标题追加「· 在线」。
- 现场实测（真实 SSE）：开流前 `[]` → 流打开后 `["u_alice"]` 且联系人 `u_alice:true` → 断开后回到 `[]`。
- 测试：服务端 `reports a member as online only while their event stream is open`（含开流/关流两段）、前端 `marks an online colleague in the contact list`。
- 隐私：只返回**同组织**成员；跨组织不可见（与联系人接口同一套组织过滤）。

## 8.8 会话管理（丢失设备处置）（2026-09-13 05:05）

- `GET /api/auth/sessions`：列出**自己的**会话（最近活动/过期时间/是否当前设备），**绝不返回令牌或哈希**。
- `DELETE /api/auth/sessions/:id`：撤销自己的某一个会话（他人会话 id 不可见且 404）；`DELETE /api/auth/sessions`：撤销**除当前设备外**的全部会话（必须出示会话凭据，仅用成员 API 令牌调用会 400，避免误伤）。
- `Principal.sessionId` 由 `resolvePrincipal` 在会话令牌分支写入，用于标记「当前设备」；不进入任何响应体。
- 会话表有上限：同一成员最多保留 20 个会话，登录时淘汰最旧的（否则反复登录会无限增长）。
- 审计：`auth.session_revoked`、`auth.sessions_revoked`。
- 现场实测：撤销另一台设备后该令牌立刻 401、当前设备仍 200、列表从 46 降到 45；前端设置页新增「我的登录会话」表格与「撤销其他会话」。
- 测试：服务端 3 例（越权 404/当前设备保留/上限）、前端 1 例。

## 8.9 冒烟扩到 27 项 + 会话管理（2026-09-13 05:10）

`scripts/smoke.mjs` 从 16 项扩到 **27 项**，把本轮新增的客户端面纳入同一条命令：

| 新增检查 | 断言要点 |
| --- | --- |
| presence endpoint answers | 返回 `online` 数组 |
| direct conversation with a colleague opens | 1:1 会话可开 |
| recall target created / message recall accepted | 撤回接口 200 且 `ok=true` |
| recalled body is no longer readable | 历史里 `recalledAt` 有值、`text` 为空 |
| recalled message leaves search results | 搜索 0 命中（1:1 会话内验证，避免 AI 引用干扰） |
| read receipts are readable by a participant | 参与者可读回执 |
| direct conversations reject membership changes | 1:1 会话加人 400 |
| conversation exports as a Word transcript / downloadable | 导出 `.docx` 且可下载 |
| sessions endpoint answers without exposing token material | 不泄露哈希；开发档位允许 0 条 |

实测：开发档位 **27/27**；带成员凭据（`SMOKE_MEMBER`/`SMOKE_TOKEN`）**27/27**（列出 20 条会话，验证了单成员会话上限）。

## 8.10 复核轮 4（撤回/回执/审计/长会话/成员面板）与修复

第四轮独立复核（自带实例与数据目录、逐条现场复现）结论：**消息撤回 CONFIRMED（另发现一处越界泄露）**、**已读回执 CONFIRMED**、**长会话渲染修复 CONFIRMED**、**AI 回复审计 STILL BROKEN（挂错函数）**、**群成员面板 PARTIAL（缓存导致陈旧）**。全部已修：

| ID | 复核发现 | 修复 | 证据 |
| --- | --- | --- | --- |
| NEW-1（P2） | 撤回的正文仍能从**任务快照**（`GET /api/tasks[/:id]` 的 `input.history` 与 `goal`）被管理员/账号所有者读到 | 新增 `withRedactedHistory`：读取任务与**重跑任务**时，把命中撤回文本的快照条目替换为 `[已撤回]`，`goal` 同样处理（快照为空时也会处理 goal） | 实测：撤回前任务快照含密文 → 撤回后 `false`，任务列表不泄露；回归测试 1 例 |
| NEW-2（P2） | `ai.message_sent` 挂在 `appendArtifactMessage` 上：文本回复**从不**审计，文件消息被误标 `assistant_reply` | 移到 `appendAssistantMessage`（`detail: assistant_reply`），文件消息改为 `detail: artifact_message` | 实测审计计数：`assistant_reply=26`、`artifact_message=1`，且现场发送文本回复后计数增长 |
| NEW-3（P3） | 已撤回消息仍计入未读数 | 未读过滤增加 `!message.recalledAt` | 回归测试 `stops counting a recalled message as unread`（含毫秒级游标时序处理） |
| NEW-5（P4） | 群成员面板读的是客户端缓存的会话，别人新拉进来的人看不到 | 打开面板时先 `GET /api/conversations/:id` 取最新参与者 | 前端改动 + 既有面板测试 |
| NEW-6（P4） | 前端硬编码撤回窗口 120s，与服务端可配置窗口不一致 | `/api/agent/status` 增加 `recallWindowSeconds`，前端启动时读取（失败回落默认值） | 实测 `recallWindowSeconds: 120`；`AgentStatus` 类型同步 |
| NEW-7（P4） | `RECALL_WINDOW_SECONDS=0` 时提示「窗口已过期」 | 区分 `recall_disabled`（"recall is disabled on this server"）与 `recall_window_expired` | 回归测试 1 例 |
| NEW-9（P4） | `DocumentsView` 未导入 `UploadFilled` 图标（Vue 警告） | 显式导入 `@element-plus/icons-vue` 的 `UploadFilled` | 前端测试套件无警告 |
| NEW-4 / NEW-8 / NEW-10 | 撤回只解除消息引用（上传文件对本人/管理员仍可下载）；管理员可读全组织会话；smoke 缓存 owner 令牌 | 均为**有意边界**，已写入 `docs/security-checklist.md` 与本文档限制章节 | — |

复核同时确认（无缺陷）：撤回的 8 条读取面（最新页/分页分支/搜索/预览/模型上下文/SSE/管理员历史/审计）全部干净；回执的越权与跨组织行为正确；长会话修复的根因与现状与本节 8.1 描述一致。

## 8.11 群管理（改名 / 显式移出）（2026-09-13 05:10）

建群是「只增不减」，退群只能自助，因此缺少管理工作本身的入口。本轮补上两条**参与者限定**、**写审计**的接口：

| 能力 | 接口 | 规则 |
| --- | --- | --- |
| 群改名 | `PATCH /api/conversations/:id` | 仅参与者；标题 1–64 字符；确定性 chatId 不变（会话身份不变）；广播 `conversation_updated` 让所有客户端即时刷新标题 |
| 移出成员 | `DELETE /api/conversations/:id/members/:memberId` | 仅参与者；不能移除自己（用 `/leave`）；被移除者**立刻失去**消息/任务/产物访问权；非参与者一律 404 |

- 前端：群头部「改名」弹窗；群成员面板每行「移出」；`conversation_updated` 事件驱动标题更新。
- 审计：`conversation.renamed`、`conversation.member_removed`。
- 现场实测：改名 200；参与者可改名；移出后该成员读会话 404；非参与者移出 404；自助移除返回 400（提示用 `/leave`）。
- 测试：服务端 2 例（改名权限 + 空标题 400 + 审计；移除的自我/越权/生效/审计）、前端 1 例（改名弹窗与移出按钮）。

## 8.12 一条命令的验收链（2026-09-13 05:12）

`scripts/acceptance.mjs` 把六步串起来并打印汇总表（任一步失败即非零退出，可作发布门禁）：

```
PASS  typecheck (tsc + vue-tsc)       · 8.5s
PASS  unit / integration tests       21 文件 / 193 用例 · 20.0s
PASS  build (server + web)           built in 8.24s · 21.6s
PASS  restart server                 health: {"ok":true,"storage":{"pending":false}} · 3.1s
PASS  API smoke (27 checks)          27/27 checks passed · 1.3s
PASS  client E2E (packaged exe)      34/34 UI checks passed · 17.3s
6/6 steps passed
```

`--skip-e2e` 供无桌面环境使用；`--port` 可指向别的实例。

## 8.12b 群聊已读计数（2026-09-13 05:20）

1:1 会话此前显示「已读/未读」，群聊没有回执显示。现在群里自己最后一条消息下方显示「N 人已读」（N = 读游标已追上该消息的**其他人类参与者**数量；AI 账号不计入，且服务端本来就逐人上报）。前端复用既有 `GET /api/conversations/:id/read-receipts`，未新增接口；前端测试 1 例。

## 8.13 全新 production 实例的客户端 E2E（2026-09-13 05:14）

之前的 E2E 都在已有数据的开发实例上跑；本轮把「真实客户端 E2E」跑到**空数据目录 + production 档位**的实例上，过程中发现并修复了验收脚本自身的三处脆弱点（都是脚本问题，不是产品问题）：

1. 登录后等待「会话列表」——全新部署**没有任何会话**，改为等待侧栏（含联系人）出现；
2. 头部文案在会话异步打开（open → select → load）之前就断言，改为等输入框可用后再断言；
3. 联系人里的 AI 条目此前按文本匹配（群预览里出现「助理」也会命中），改用 `AI` 标签定位。

修复后结果：**空数据目录 + 仅签发一个成员**的生产档位实例上，`node scripts/ui-e2e.mjs --server http://localhost:8799 --member owner_local --token ...` → **34/34 通过**（登录 → 从联系人打开与 AI 的会话 → 问候 → 生成 Word → 会话内下载 → 撤回 → 深色模式 → 1024×720 → 七个导航页），开发实例同样 34/34。

## 8.14 复核轮 5：zip 守卫真测量 + 撤回脱敏补全（2026-09-13 05:35）

第五轮独立复核（群管理 / 会话管理 / 在线状态 / zip 守卫 / 任务快照脱敏）结论：**群管理 CONFIRMED（含 51 项检查）、会话管理 CONFIRMED、在线状态 CONFIRMED**，zip 守卫与撤回脱敏 **PARTIAL**，并给出两个 P1：

| ID | 复核发现 | 修复 | 证据 |
| --- | --- | --- | --- |
| **P1-A** | zip 守卫**信任中央目录**：1.5 MB 的上传把服务端 RSS 从 106 MB 推到 **607 MB** 后 500 —— 声明尺寸作假即可绕过全部检查 | 守卫改为**实测**：按本地头定位数据，用 `zlib.inflateRaw` + `maxOutputLength` 硬顶棚真实解压每个条目，压缩比也用**实测**的输入/输出字节数计算；不支持的方法直接拒绝；ZIP64 哨兵值不再误判 | 实测：71 KB 的「声明 1 KiB」炸弹 → **413 `archive entry expands beyond 67108864 bytes`**（此前通过）；200 MiB 炸弹同拒；正常 docx/xlsx 不受影响；新增 3 例单测（撒谎的中央目录 / 正常文档 / 不支持的方法） |
| **P1-B** | 撤回脱敏漏了**重跑路径**：`resume` 仍把原始 goal 交给模型（复核用录制型假模型拿到原文） | `runTask` 改用 `withRedactedHistory(task).goal` | 代码级修复 + 事件路径测试 |
| P2 | 任务事件（`GET /api/tasks/:id/events` 与任务 SSE）里仍带被撤回的 goal | 新增 `recalledTextsOf` + `redactEventPayloads`：事件负载中任何包含撤回正文的字符串替换为 `[已撤回]` | 新增测试（撤回后事件不含正文） |
| P3 | 非 zip / 无 EOCD 的 `.docx` 走到解析器后返回 **500** | 解析失败统一映射为 **400 `the document could not be parsed`** | 实测：伪造 `.docx` → 400 |
| P4 | 被拒绝的上传**先落盘再解析**（20 MiB 炸弹仍占盘） | 改为**先解析后落盘**：守卫不通过就不写 uploads | 代码级修复 |
| P4 | `MemberView.online` 只在 `/api/contacts` 有值 | `/api/members`、`/api/auth/me` 同样填充 | 代码级修复 |
| P4 | 匿名调用批量撤销返回 400（应为 401） | 先判匿名 → 401 | 代码级修复 |

P1-B 的**现场验证**（2026-09-13 05:34，真实服务端）：

```
task state        waiting_approval          # 目标文本含待撤回密文
recall            200
goal after recall "[已撤回]"               # 读取面已脱敏
events leak?      false
resume            200 {"ok":true,"state":"pending"}
state after resume completed | goal: "[已撤回]"   # 重跑用的是脱敏后的 goal
events leak after? false
own bubbles leak?  false
```

仍作为**有意边界**保留并记录：AI 已经发出的引用回复与 `task.result` 里 AI 自己的回声不追溯（撤回不能撤回别人的消息）；上传文件本体不因消息撤回而删除；组织管理员可读本组织全部会话。

## 8.15 收尾一致性（2026-09-13 05:35）

- `.env.example` 补齐 `CHATAGENT_RECALL_WINDOW_SECONDS`，并单列**只给脚本/客户端用**的变量（`CHATAGENT_URL`/`CHATAGENT_SERVER_URL`、`SMOKE_MEMBER`/`SMOKE_TOKEN`/`SMOKE_APPROVER_TOKEN`）；现在服务端读取的环境变量在示例里 **100% 覆盖**（脚本化比对 `config.ts` 与示例文件的变量集合）。
- 清理审计测试里遗留的占位常量（`CHATAGENT_AUDIT_HINT`），并把「AI 文本回复 vs 文件消息分别写审计」改成真正断言两类 `detail` 的用例（轮询等待后台任务落审计）。
- `docs/environment.md` 补上终态验证命令与 `.env.example` 覆盖说明。

## 8.16 会话附件共享 + 消息转发（2026-09-13 22:00）

**会话附件共享（修一个真实缺陷）**：此前上传文件只有**上传者本人**（与组织管理员）能下载 —— 会话里的 `📎 文件名` 对收件人是死链（实测：发件人 200、收件人 404，群成员同样 404）。现在规则为：

- 上传者本人、以及**上传者把该文件作为附件发进某个会话**后的该会话参与者，都可以下载并在「文件」页看到它；
- 非参与者 404、跨组织不可见、退出会话后立即失去访问、被撤回消息的附件失去该捷径（上传者本人仍拥有文件）；
- **越权引用防护**：消息只能携带**自己上传**的文件（否则 `400 a file you uploaded`），并且读取授权要求「引用该文件的消息必须由文件所有者发出」。若没有这两条，任何成员只要在自己的会话里写一条带别人文件 id 的消息，就能把别人的私有文件变成可读 —— 已补专门的回归测试（`refuses to let a member attach somebody else file`）。

**消息转发**：`POST /api/messages/:id/forward {conversationId}`

| 规则 | 说明 |
| --- | --- |
| 权限 | 能读源消息 + 是目标会话参与者；否则 404/403 |
| 目标限制 | 不能转发给 AI 会话（`400`，避免意外触发任务） |
| 内容 | 复制正文与原附件 id，`metadata.forwardedFrom` 记录来源（消息/会话/原发送者） |
| 撤回语义 | 被撤回的消息或空消息 `400 this message has nothing to forward`（转发不能复活已撤回内容） |
| 副作用 | 广播 `message` 事件 → 目标会话实时可见；审计 `message.forwarded` |
| 前端 | 每条消息气泡「转发」→ 选择同事/群聊 → 顶部「已转发」提示 |

现场实测：转发到群 200、群成员看到副本并能下载附件（200）、转发给 AI 400、越权转发 404、撤回后转发 400。客户端 E2E 也加了一步真实点击（点「转发」→ 选目标 → 确认 → 顶部出现「已转发」），客户端检查从 33 项增至 **34 项**。

## 9. 生产档位实测（2026-09-13 04:35）

`CHATAGENT_AUTH_MODE=production` + 独立数据目录，无凭据请求一律 401：

| 场景 | 命令 | 结果 |
| --- | --- | --- |
| 服务端接口 | `SMOKE_MEMBER=owner_local SMOKE_TOKEN=owner-prod-token CHATAGENT_URL=http://localhost:8797 node scripts/smoke.mjs` | **27/27**（含审批、外发 `delivered`、产物下载、搜索、建群） |
| 打包客户端 | `node scripts/ui-e2e.mjs --server http://localhost:8796` | **34/34**（成员令牌登录 → AI 回复 → 生成 Word → 下载 → 深色 → 响应式 → 7 个导航页） |
| 无凭据访问 | `curl -o /dev/null -w '%{http_code}' localhost:8796/api/accounts` | 401 |

另做**全新实例**验证（空数据目录 + `production` 档位 + 仅签发一个成员）：

```bash
rm -rf Temp/fresh-data
CHATAGENT_DATA_DIR=Temp/fresh-data node scripts/add-member.mjs u_fresh "Fresh User" "fresh-token" org_local owner
PORT=8798 HOST=127.0.0.1 CHATAGENT_AUTH_MODE=production CHATAGENT_DATA_DIR=Temp/fresh-data node apps/server/dist/index.js
SMOKE_MEMBER=u_fresh SMOKE_TOKEN=fresh-token CHATAGENT_URL=http://localhost:8798 node scripts/smoke.mjs
# → 27/27：默认 AI 账号自动创建、会话/任务/Word 产物/审批/原生投递 delivered/搜索/建群全部通过
```

结论：「生产档位下前端拿不到登录态」的旧结论不再成立（README 已更正）；空目录部署可直接跑通全流程。`scripts/smoke.mjs` 的审批人缓存改为**按服务端地址分文件 + 使用前先登录校验**，否则换实例/换数据目录时会拿到失效的旧凭据。

## 10. 验证结果（可复现）

```bash
pnpm typecheck                     # tsc --noEmit + vue-tsc，退出码 0
pnpm test                          # 21 文件 / 193 用例全绿（服务端与包 18 文件/168 例 + Web 3 文件/25 例）
pnpm build                         # 服务端 tsup + Web vite + Electron 资源
node scripts/restart-server.mjs    # 重启并等待 /health
node scripts/smoke.mjs             # 27/27
node scripts/ui-e2e.mjs            # 34/34（真实 exe，截图存 Temp/ui-shots）
```

packaged exe：`apps/desktop/release/ChatAgent Setup 0.1.0.exe`（约 78 MB，NSIS，`--server=` / `CHATAGENT_SERVER_URL` / `config.default.json` 三种方式指定服务端地址）。

## 11. 仍然存在的限制（不粉饰）

- **第三方 IM 真实投递未验证**（BLOCKED）：无钉钉/飞书/企业微信/QQ 凭据，默认关闭外部通道，`simulated` 表示**未投递**，不计为完成。
- **依赖 CVE 扫描未执行**（BLOCKED）：本机 registry 无 audit 端点。
- **单进程 JSON 存储**：无租约/多实例互斥；`data/*.json` 在服务运行时被整体重写，手工编辑必须在停机状态下进行。
- **组织管理员可读本组织全部会话**（设计如此，已文档化）；若某部署不接受，需要把 `canReadConversation` 的管理员分支改成显式授权。
- 群成员语义：**建群只增不减**；键已存在且调用者不是参与者时返回 409（必须由现有成员邀请），因此「退群」是持久的；成员移除目前只有「自己退出」，没有管理员踢人接口（若要做，需要显式审计的移除操作）。
- AI 回复不逐条写审计（只记录任务与工作台发送路径）；若合规要求「AI 说过的每句话可追溯」，应在 `appendAssistantMessage` 增加结构化审计（不含正文）。
- 依赖 CVE 扫描未执行（本机 registry 无 audit 端点）；压缩炸弹/解析资源上限未做。
