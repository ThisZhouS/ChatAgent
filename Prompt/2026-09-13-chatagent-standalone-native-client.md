# ChatAgent 增量 Prompt：独立产品与原生聊天客户端

日期：2026-09-13（Asia/Shanghai） · 关联：`Prompt/2026-09-13-chatagent-gate4-approval-outbox.md`、`docs/adr-0001-standalone-native-chat.md`

## 原始指令（脱敏后全文）

项目应该是独立的，脱离其他社交聊天办公软件的。

## 语义解析与决策

这不是措辞调整，而是**产品方向变更**：原简报把第三方 IM 联系人当作主入口、Web 仅作管理台（`docs/project-brief.md`、`docs/research.md`），与「内网聊天中的 AI 工作主体」冲突。按 `incremental-prompt` 的语义去重规则，目标与授权范围改变 → 新建记录并关联 Gate 1/2/4 记录。

采纳决策（ADR-0001）：

1. 原生优先：自带身份、会话、消息、文件、任务、审批与回执，无第三方凭据也能完整运行。
2. 第三方 IM 降级为可选适配器，默认关闭（`CHATAGENT_ENABLE_EXTERNAL_CHANNELS=false`）。
3. 不删除既有适配器代码（已测试、可复用），只改变默认装配与产品叙事。

## 元数据

| 项 | 值 |
| --- | --- |
| 受影响 package | `@chatagent/contracts`、`apps/server`、`apps/web` |
| 受影响符号 | `Conversation.{origin,targetKind,targetId}`、`ChatMessage.accountId?`、`SessionRecord`、`MemberView`、`NativeEvent`、`SessionStore`、`NativeEventHub`、`ChatAgentService.{login,logout,me,listContacts,openConversation,sendNativeMessage}`、`ChatView.vue`、`LoginView.vue` |
| 前置权限 | 登录需成员令牌；联系人与会话限同组织；发送要求是会话参与者；SSE 逐事件重新授权 |
| 数据分类 | 会话令牌只存 sha256；登录额外下发 HttpOnly Cookie（供 EventSource）；不持久化明文令牌 |
| 是否外发 | 原生消息在进程内投递；对外副作用仍受 Gate 4 审批/outbox 约束 |
| 幂等/取消语义 | 原生发送不产生重复任务（会话→任务一对一提交）；成员投递无外部副作用 |
| 测试 profile | Mock 离线 + Fastify inject 集成 + SSE 实测（`apps/server/src/native-chat.test.ts`） |
| 未验证边界 | 真实第三方 IM 投递（已非产品依赖）；浏览器/Electron 端到端；AI 主动消息的原生投递 |

## 实施结果

- 契约：`Conversation` 增加 `origin/targetKind/targetId`（`accountId` 可选）；新增 `SessionRecord`、`MemberView`、`NativeEvent`；新增 `loginSchema`/`openConversationSchema`/`nativeMessageSchema`。
- 服务端：`SessionStore`（sha256 + TTL）、`NativeEventHub`；`resolvePrincipal` 支持成员令牌 / 会话令牌 / Cookie / dev 注入；新增 `/api/auth/login|logout|me`、`/api/contacts`、`POST /api/conversations`、`POST /api/conversations/:id/messages`、`GET /api/events/stream`；外部通道默认关闭。
- 前端：`LoginView.vue`（成员令牌登录）、`ChatView.vue`（联系人/会话/消息/附件/任务与审批卡/SSE 实时）；聊天成为默认入口；移除旧「会话」测试台视图。
- 验证：`pnpm typecheck` 通过；`pnpm test` 10 文件 / 66 用例通过（新增 6 例）；`pnpm build` 通过；现场 curl 走通登录 → 联系人 → 与 AI 会话发消息得到任务与回复 → 成员间会话互通。


## 后续轮次（2026-09-13 03:00 前后，持续迭代）

用户追加指令：在 06:00 前围绕完整性/实用性/交互性/美观性/安全性持续迭代，可调用子 agent 与网络搜索。

### 本轮完成

- 原生投递通道（`NativeImGateway`）：AI 主动消息进入成员原生会话，回执 `delivered`；通道选择 native 优先。
- 独立安全审查（只读子 agent）→ 修复 P0-1/2、P1-1/2/3/4/5 与 5 项 P2（详见 `docs/gate5-standalone-hardening.md`）。
- 成员管理（API + 页面，令牌一次性签发/重置并吊销会话）、审批中心页（待审批/历史/outbox）。
- 聊天交互：未读徽标、最后消息预览、搜索、日期分隔、气泡合并、自动滚动、Enter/Shift+Enter、附件下载、快捷提示、任务状态条。
- 深色模式与主题 token。

### 验证

- `pnpm typecheck` / `pnpm test`（14 文件 92 用例）/ `pnpm build` 全绿。
- 现场：安全响应头、无效 Bearer→401、LAN→401 且回环→200、webhook 默认 404。

### 未完成 / BLOCKED

- 依赖 CVE 扫描（npmmirror registry 无 audit 端点）。
- 消息全文搜索、群聊、在线状态、已读回执。
- 存储写放大治理（每次消息整文件重写）。
