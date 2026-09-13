# Tree / apps

## 用途

可运行应用。`apps/server` 组合所有包；`apps/web` 只通过 `/api` 与 SSE 消费服务端。

## apps/server

- `src/config.ts` `loadConfig()`：端口、数据目录、模型配置、`auth`（development/production）与 `webhook`（allowUnverified / maxSkewSeconds / 每通道 token 与签名密钥）。
- `src/auth.ts` `MemberDirectory`（token 只存 sha256）、`resolvePrincipal()`、授权矩阵 `canReadAccount/canManageAccount/canReadConversation/canReadTask/canCancelTask/canReadArtifact/canReadUpload`。
- `src/events.ts` `NativeEventHub`：有界订阅（总数/单主体上限）的原生事件广播。
- `src/native-gateway.ts` `NativeImGateway`：内置投递通道，AI 主动消息写入成员原生会话并返回 `delivered`。
- `src/audit.ts` `AuditLog`：JSONL 审计（登录、拒绝、限流、成员与审批操作），字段截断、无 query。
- `src/rate-limit.ts` `RateLimiter`：login/loginIp/webhook/write/upload 桶。
- `src/approvals.ts` `computeActionDigest()`、`computeArtifactVersion()`、`stepKeyFor()`、`ApprovalStore`、`OutboxStore`、`evaluateApproval()`（发送时重新校验有效期/组织/成员/角色）、`canDecideApproval()`。
- `src/stores.ts` JSON 持久化 `AccountStore`/`ConversationStore`/`MessageStore`/`UploadedFileStore`/`ArtifactStore`（含旧数据迁移与 scope 字段）+ `WebhookDedupeStore`。
- `src/agent.ts` `buildProvider`、`buildDocumentTools`（scope 透传到 `saveArtifact`）、`buildMessageTools`（精确网关匹配、outbox 查重 → 审批闸门 → 网关 → 回执）。
- `src/service.ts` `ChatAgentService`：认证注入、对象授权、任务提交/取消/resume、审批决策与 outbox 查询、`RunOutcome → TaskHandlerResult` 映射、产物按 `taskId` 绑定。
- `src/app.ts` `buildApp()`：raw body 捕获、principal 中间件、路由、SSE 授权、Webhook 验签+去重、`ServiceError` → HTTP 状态、静态托管、优雅停机。
- `src/test-helpers.ts` 测试夹具：临时数据目录、dev principal headers、`seedMember`、`poll`。
- 测试：`auth.test.ts`（principal/授权）、`app.security.test.ts`（认证/越权/Webhook/SSE）、`artifacts.test.ts`（并发产物归属与下载授权）、`approval-outbox.test.ts`（审批闸门/幂等/回执语义/端到端）、`native-chat.test.ts`（原生登录/联系人/会话/成员投递/SSE/独立默认）、`membership-security.test.ts`（会话劫持、退群后任务越权、建群只增不减、退群不可自复活、上传 413、SSE 安全头、审计覆盖、令牌重置与 dev 回退）。
- 构建: `pnpm --filter @chatagent/server run build`（tsup，产出 `dist/index.js`）。
- 启动: `node apps/server/dist/index.js`（同时托管 `apps/web/dist`）。

## apps/web

- `src/main.ts` 创建 Vue 应用并全局注册 Element Plus 与图标。
- `src/App.vue` 侧边导航（`el-menu`）与视图切换。
- `src/api.ts` `api` 客户端封装。
- `src/views/` 各页面 SFC：Login/Chat(原生)/Dashboard/Tasks/Approvals/Documents/Accounts/Members/Settings。
- 主题：`main.ts` 引入 Element Plus dark CSS 变量，App 内切换并持久化。
- `src/api.ts` 同时维护会话令牌（localStorage，供 fetch 使用）与 HttpOnly Cookie（供 SSE 使用）。
- `src/style.css` 应用级样式与布局 Token。
- 构建: `pnpm --filter @chatagent/web run build`（Vite + `@vitejs/plugin-vue`）。
- 类型检查: `pnpm --filter @chatagent/web run typecheck`（vue-tsc）。
- 组件测试: `pnpm --filter @chatagent/web run test`（vitest + jsdom + @vue/test-utils）：`ChatView.test.ts`（会话列表/分页已读/发送/搜索与建群入口/群邀请/退群/私聊无群操作）、`SettingsView.test.ts`（自助令牌重置只显示一次）、`views.render.test.ts`（逐个页面渲染守卫：SFC 模板损坏时 `vite build` 不报错，只有渲染测试能拦住）。
- 开发: `pnpm --filter @chatagent/web run dev`（Vite dev，代理 `/api` 到 8787）。

## apps/desktop

- `main.cjs` Electron 主进程：解析 `--server=` / `CHATAGENT_SERVER_URL` / `config.default.json`，加载服务端 URL；`did-fail-load` 时回退本地 `error.html`。
- `preload.cjs` 通过 `contextBridge` 暴露平台与版本信息。
- `error.html` 连接失败页（支持重试）。
- `config.default.json` 默认 `serverUrl`。
- 构建: `pnpm --filter @chatagent/desktop run build`（electron-builder `--win nsis`）。
- 产物: `apps/desktop/release/ChatAgent Setup 0.1.0.exe` 与 `release/win-unpacked/ChatAgent.exe`。

## 关键端点

- `GET /health`、`GET /api/agent/status`
- `GET/POST /api/accounts`、`PATCH /api/accounts/:id`
- `GET /api/conversations`、`GET /api/conversations/:id/messages`
- `POST /api/messages`（工作台消息注入）
- `POST /api/webhooks/:channel`（IM Webhook）
- `GET/POST /api/tasks`、`GET /api/tasks/:id/stream`（SSE）、`POST /api/tasks/:id/cancel`、`POST /api/tasks/:id/resume`
- `POST /api/auth/login`、`GET /api/auth/me`、`POST /api/auth/logout`（原生登录）
- `GET /api/contacts`、`POST /api/conversations`、`POST /api/conversations/:id/messages`（原生聊天）
- `GET/POST /api/members`、`PATCH /api/members/:id`、`POST /api/members/:id/token`（成员管理，令牌一次性）
- `POST /api/conversations/:id/read`（未读游标）、`POST /api/groups`（群聊）
- `GET /api/search?q=`（参与会话内检索）
- `GET /api/events/stream`（原生 SSE：消息/任务/审批）
- `GET /api/approvals`、`POST /api/approvals/:id/decision`（Gate 4）
- `GET /api/outbox`（Gate 4 外发回执）
- `POST /api/documents/parse`、`POST /api/documents/generate/word|excel`
- `GET /api/files/:id`
