# ChatAgent

让 AI 以**独立 IM 账号**身份进入企业内网聊天工具，像真人助理一样接收指令、执行真实工作并回传结果 —— 而不是做一对一聊天框或群聊 @ 的问答机器人。

核心能力：以 Hermes 风格的 agent 运行时为基础，**自带完整聊天客户端**（成员登录、联系人、会话/群聊、消息、撤回、已读回执、在线状态、附件、审批卡、会话导出），处理 Word、Excel、文件转发等企业工作。

**当前状态（2026-09-13 06:00 验收态）**：8 个页面全部可用，`node scripts/acceptance.mjs` 一条命令 6/6 步通过（类型检查 0 错误 · 21 文件 / 199 用例 · 构建 · 服务端 `/health` · 接口冒烟 27/27 · 真实客户端 E2E 34/34）；安全面经**五轮独立对抗性复核**逐条复现并修复（含 1 个 P0 会话劫持）。详见 [`docs/acceptance-report.md`](docs/acceptance-report.md)。

> **独立产品**：ChatAgent 不依赖 QQ / 企业微信 / 钉钉 / 飞书等第三方社交或办公软件即可完整运行；这些平台只作为默认关闭的可选适配器（见 [`docs/adr-0001-standalone-native-chat.md`](docs/adr-0001-standalone-native-chat.md)）。

## 架构一览

```text
apps/desktop (Electron Windows 客户端，可打包为 exe)
   └── 指向 http://localhost:8787
apps/web (Vue 3 + Element Plus 原生聊天客户端：登录 / 聊天 / 任务 / 文件 / 账号)
   └── REST + SSE（/api/events/stream）
apps/server (Fastify 组合根)
   ├── @chatagent/im-gateway   IM 消息规范化与收发抽象
   ├── @chatagent/task-engine  任务状态机、队列、重试、取消
   ├── @chatagent/hermes       Agent 运行时（工具循环 / 模型提供商 / 记忆）
   ├── @chatagent/document     Word/Excel 解析与生成 + Agent 工具
   └── @chatagent/contracts    共享类型与 Zod 契约
```

详细设计见 [`docs/architecture.md`](docs/architecture.md)。

## 快速开始

要求：Node ≥ 20.19，pnpm ≥ 9。

### 生产模式（推荐，开箱即用）

```bash
pnpm install
pnpm build
pnpm start
```

打开 http://localhost:8787 即可使用工作台。单进程同时托管前端静态资源与 `/api` 服务端，数据持久化在 `data/` 目录。

一键端到端自检（会创建临时管理员、跑完文档任务与审批投递闭环）：

```bash
node scripts/smoke.mjs
```

Windows 下也可以直接双击根目录的 `start-server.cmd`：缺少构建产物时会自动执行安装与构建，然后启动服务端。

### 开发模式

```bash
pnpm dev
```

- 前端工作台（热更新）：http://localhost:5173
- 服务端 API：http://localhost:8787
- 健康检查：http://localhost:8787/health

### Docker（可选）

```bash
docker compose up --build
```

打开 http://localhost:8787 。数据卷 `chatagent-data` 持久化在容器外。

### Windows 客户端（exe）

先确保服务端可访问（默认 `http://localhost:8787`），然后：

```bash
pnpm build:desktop
```

产物：

- 安装包：`apps/desktop/release/ChatAgent Setup 0.1.0.exe`
- 免安装版：`apps/desktop/release/win-unpacked/ChatAgent.exe`

客户端连接地址可通过以下方式覆盖（优先级从高到低）：

1. 命令行：`ChatAgent.exe --server=http://your-server:8787`
2. 环境变量：`CHATAGENT_SERVER_URL`
3. 配置文件：`apps/desktop/config.default.json`

> 国内网络下若 Electron 下载失败，`.npmrc` 已内置 `npmmirror` 镜像；若仍失败，在构建命令前加 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

未配置模型密钥时，服务端使用内置 **MockProvider**，整条链路（消息 → 任务 → 工具调用 → 文件产物）可以离线跑通。

## 验证命令

一条命令跑完整条验收链（类型检查 → 测试 → 构建 → 重启服务 → 接口冒烟 → 真实客户端 E2E）：

```bash
node scripts/acceptance.mjs        # 6/6 步骤，任一步失败即非零退出；--skip-e2e 可在无桌面环境运行
```

分步执行：

```bash
pnpm typecheck                     # 全仓库类型检查（tsc + vue-tsc）
pnpm test                          # 单元/集成测试：21 文件 / 199 用例
pnpm build                         # 服务端打包 + 前端构建
node scripts/restart-server.mjs    # 按端口重启并等待 /health（Windows 上可靠）
node scripts/smoke.mjs             # 27 步端到端冒烟（真实 HTTP）
node scripts/ui-e2e.mjs            # 真实客户端 E2E：驱动打包 exe，34 项检查 + 截图
pnpm start                         # 前台运行服务端产物（同时托管前端 dist）
```

`scripts/ui-e2e.mjs` 通过 Electron 的 CDP 端口操作**打包后的客户端**：填表登录 → 打开与 AI 的会话 →
发消息等回复 → 让 AI 生成 Word → 校验聊天里的下载链接 → 切换深色模式 → 1024×720 响应式，
并把截图写到 `Temp/ui-shots/`、报告写到 `Temp/ui-e2e-report.json`。

## 接入真实模型

复制 `.env.example` 到 `apps/server/.env`（Docker 则写入 `docker-compose.yml` 的环境变量）：

```env
CHATAGENT_MODEL_BASE_URL=https://your-openai-compatible-gateway/v1
CHATAGENT_MODEL_API_KEY=sk-...
CHATAGENT_MODEL_NAME=your-model
```

服务端自动从 MockProvider 切换到 `OpenAICompatibleProvider`，支持 vLLM / Ollama / 内网模型网关等任意 OpenAI 兼容接口。

## 功能一览

| 能力 | 说明 |
| --- | --- |
| 原生聊天 | 登录 → 联系人（同事 + AI 账号）→ 会话/群聊 → 消息、附件、未读徽标、消息搜索 |
| AI 执行 | 会话内发消息即创建任务；`parse_document` / `create_word_document` / `create_excel_document` / `send_message` / `forward_file` |
| 群聊 @AI | 群内 `@AI 助手` 召唤（前端「召唤 AI」按钮），AI 回复与产物落回群会话 |
| 审批与投递 | 外发动作需审批；write-ahead outbox 保证一次外发；回执 `delivered/accepted/simulated/failed/unknown` |
| 成员管理 | 管理员签发/重置令牌（只存 sha256），角色 owner/admin/member |
| 安全 | 对象级授权、审计日志、限流、安全响应头、Cookie 只读、会话吊销、组织/所有者隔离 |
| 体验 | 深色模式、中文语言包、`Ctrl/Cmd+K` 搜索、桌面通知、Electron 客户端（exe） |

## 使用原生客户端

1. 签发成员令牌（只需一次，重启服务端后生效）：

```bash
node scripts/add-member.mjs u_alice "Alice" "your-strong-token" org_local member
```

2. 打开 http://localhost:8787 ，用「成员 ID + 访问令牌」登录。
3. 左侧「联系人」里同时列出同事与 AI 账号；点击 AI 账号即可开始对话，发送消息会自动创建任务，AI 回复出现在同一会话中。
4. 会话内可直接发文件（附件会先上传，AI 可用 `parse_document` 解析），任务进入 `waiting_approval` 时聊天窗口内会出现审批卡（有权限的成员可批准/驳回）。

原生接口：`POST /api/auth/login`、`GET /api/auth/me`、`GET /api/contacts`、`POST /api/conversations`、`POST /api/conversations/:id/messages`、`GET /api/events/stream`（SSE）。

## 认证与安全档位（Gate 1）

服务端有两档显式认证模式，由 `CHATAGENT_AUTH_MODE` 控制（缺省：`NODE_ENV=production` 时为 `production`，否则 `development`）：

| 模式 | 行为 |
| --- | --- |
| `development` | 显式 test/dev profile。`x-chatagent-principal-id/org/name` 头是开发身份注入边界；无头时映射到配置 owner（默认 `dev-owner`）。响应头带 `x-chatagent-auth-mode` / `x-chatagent-principal` 标明。 |
| `production` | fail closed。只有 `Authorization: Bearer <token>` 命中成员目录才认证；请求体字段与 dev 头一律忽略；无凭据返回 401。 |

生产模式下为成员签发 token（只写入 sha256）：

```bash
node scripts/add-member.mjs u_alice "Alice" "your-strong-token" org_local owner
# 或：pnpm member:add u_alice "Alice" "your-strong-token" org_local owner
```

随后重启服务端，调用方带 `Authorization: Bearer your-strong-token`。

对象授权：账号按组织可读、仅 owner/委托者可改；会话仅参与者（或组织 admin）可读；任务仅 requester/账号 owner/组织 admin 可读与取消；产物与上传文件按 owner 或所属 task 授权；SSE 订阅先授权再发送字节。跨组织统一返回 404，不泄漏对象是否存在。

Webhook 必须先通过验签：配置 `CHATAGENT_<CHANNEL>_SIGNING_SECRET`（HMAC-SHA256，`x-chatagent-signature: sha256=<hex>`）或 `CHATAGENT_<CHANNEL>_TOKEN`（`x-chatagent-webhook-token` / `?token=`），并满足时间窗；未配置验证材料时生产返回 401。重复投递按 `channel:channelMessageId` 去重，不会产生第二个任务。

详见 [`docs/gate1-2-identity-task-integrity.md`](docs/gate1-2-identity-task-integrity.md)。

## 外发审批与投递回执（Gate 4）

`send_message` / `forward_file` 不能直接发送，必须走同一条路径：

```text
outbox 查重（stepKey） → 审批闸门（digest + 有效期 + 成员/角色复核） → 网关一次 → 持久回执
```

- 动作摘要 `digest = sha256(工具名 + 目标 + chatType + 载荷 / artifactId+版本)`；载荷或目标变化即失效。
- 未命中审批时 **网关调用数为 0**，任务进入 `waiting_approval`，并生成一条 pending 审批。
- 审批单次消费、默认 30 分钟过期（`CHATAGENT_APPROVAL_TTL_SECONDS`），发起人不能自审。
- 投递状态：`simulated`（无真实通道，仅本地记录）/ `accepted`（网关 2xx 且无业务错误）/ `delivered`（明确回执）/ `failed`（可重试）/ `unknown`（超时或传输错误，**不自动重发**）。
- 只要不是 `accepted`/`delivered`，任务就不会记为完成：`simulated`/`unknown` → `incomplete(delivery_unknown)`，`failed` → `incomplete(delivery_failed)`。

```bash
# 1) 查看待审批
curl localhost:8787/api/approvals
# 2) 审批（需同组织且非发起人的 owner/admin）
curl -X POST localhost:8787/api/approvals/<id>/decision \
  -H 'Content-Type: application/json' -d '{"decision":"approved"}'
# 3) 继续被阻塞的任务
curl -X POST localhost:8787/api/tasks/<taskId>/resume
# 4) 查看外发回执
curl localhost:8787/api/outbox
```

> **未接入真实 IM 凭据时所有投递都是 `simulated`，不计为已送达**，也不会有 `accepted`/`delivered` 记录。

详见 [`docs/gate4-approval-outbox.md`](docs/gate4-approval-outbox.md)。

AI 的主动消息默认走**内置原生通道**：`send_message`/`forward_file` 的目标是本组织成员（`self` 表示发起人），投递后写入该成员的原生会话并返回 `delivered` 回执；只有显式启用第三方通道时才会走外部网关。

部署前请逐项核对 [`docs/security-checklist.md`](docs/security-checklist.md)（尤其 `CHATAGENT_AUTH_MODE=production` 与 `CHATAGENT_ALLOW_DEV_AUTH=false`）。

## 目录

```text
packages/contracts   共享类型与 Zod 校验
packages/hermes      Agent 运行时（工具循环、Mock/OpenAI 提供商、记忆）
packages/document    Word/Excel 解析与生成 + 工具封装
packages/im-gateway  IM 网关抽象 + 平台规范化（钉钉/飞书/企微/QQ）
packages/task-engine 任务状态机、队列、重试、取消、JSON 持久化
apps/server          Fastify 组合根：REST、SSE、Webhook、文件
apps/web             Vue 3 + Element Plus 工作台
apps/desktop         Electron Windows 客户端（打包为 exe）
docs/                项目简报、调研、需求、任务、架构、环境
scripts/             签发成员 / 重启服务 / 冒烟 / 客户端 E2E
Prompt/              增量 Prompt 留痕（每轮变更的原始指令与决策）
```

### 文档索引

| 文档 | 用途 |
| --- | --- |
| [`docs/acceptance-guide.md`](docs/acceptance-guide.md) | 10 分钟人工验收步骤（含会话边界与安全自检命令） |
| [`docs/acceptance-report.md`](docs/acceptance-report.md) | 逐轮验收结论与终态验证命令 |
| [`docs/gate6-access-control-fixes.md`](docs/gate6-access-control-fixes.md) | 第三轮对抗性复核的全部修复、N1–N6 与三次复核证据 |
| [`docs/security-checklist.md`](docs/security-checklist.md) | 部署安全清单与已知缺口 |
| [`docs/adr-0001-standalone-native-chat.md`](docs/adr-0001-standalone-native-chat.md) | 「独立产品」决策记录 |
| [`Prompt/2026-09-13-chatagent-gate6-access-control-and-client-e2e.md`](Prompt/2026-09-13-chatagent-gate6-access-control-and-client-e2e.md) | 本轮增量 Prompt 留痕 |

## 群成员与自助令牌

原生客户端支持群聊的成员管理，并允许成员自助重置令牌：

```bash
# 邀请成员（或 AI 账号）进群：调用者必须是群成员
curl -s -X POST localhost:8787/api/conversations/<conversationId>/members   -H "authorization: Bearer $SESSION" -H 'content-type: application/json'   -d '{"memberId":"u_bob"}'

# 群改名 / 移出成员（仅群成员可调用；被移出者立即失去该会话访问权）
curl -s -X PATCH localhost:8787/api/conversations/<conversationId> -H "authorization: Bearer $SESSION" -H 'content-type: application/json' -d '{"title":"新群名"}'
curl -s -X DELETE localhost:8787/api/conversations/<conversationId>/members/<memberId> -H "authorization: Bearer $SESSION"

# 退出群聊（退出后即失去该会话消息与该会话任务的读取/取消权限）
curl -s -X POST localhost:8787/api/conversations/<conversationId>/leave   -H "authorization: Bearer $SESSION"

# 重置自己的访问令牌（必须出示凭据；旧令牌与所有会话立即失效）

# 查看 / 撤销登录会话（丢失设备时）
curl -s localhost:8787/api/auth/sessions -H "authorization: Bearer $SESSION"
curl -s -X DELETE localhost:8787/api/auth/sessions -H "authorization: Bearer $SESSION"   # 撤销其他所有设备
curl -s -X POST localhost:8787/api/auth/token/rotate -H "authorization: Bearer $SESSION"
```

前端入口：会话头部「邀请成员 / 退出群聊」，设置页「重置我的访问令牌」。
建群语义为**「建群即声明成员集合」**：复用同一群（标题 + 成员集合相同）时按请求对账成员，退出者不会被隐式拉回。

AI 生成的文件会自动以文件消息出现在会话里（`📎 文件名`），同会话成员均可下载。

会话头部「导出记录」可把会话导出为 Word 记录（撤回内容只留 `[已撤回]` 占位）；任意消息可「转发」到同事或群聊（附件随消息共享给目标会话成员），也可「引用」回复（只记消息 id，撤回后引用条显示「已撤回」，不会留下正文）。

发送者可在 120 秒内撤回自己的消息：`POST /api/messages/:id/recall`，撤回后正文与附件从会话历史、搜索、会话预览与模型上下文中同时消失（审计仍留痕且不含正文）。

## 已知缺口

- 在线状态基于「事件流是否在线」；离线成员显示为不在线（不做「最近活跃」）。
- 真实第三方 IM 账号登录与平台凭据未接入（产品不依赖它们）；平台原生签名算法未实现，仅支持通用 HMAC/token。
- 文档解析只覆盖 Word/Excel/CSV/文本；PDF 与图片 OCR 未实现。
- 持久化使用 JSON 文件（账号/会话/消息/任务/文件元数据），生产可平滑替换为数据库；**服务运行期间不要手工编辑 `data/*.json`**（会被整体重写），请停机修改。
- 任务恢复只有「running → pending 重取」，没有租约与多实例互斥。
- ~~`production` 模式下前端未接入登录态~~ → **已接入并验证**：客户端登录页用成员令牌换取会话令牌（HttpOnly Cookie + Bearer），`production` 档位下 `scripts/smoke.mjs` 27/27、`scripts/ui-e2e.mjs` 34/34（实测 `CHATAGENT_AUTH_MODE=production`，无凭据 `GET /api/accounts` 返回 401）。
- 依赖漏洞扫描：`node scripts/audit-deps.mjs`（走公共 npm registry，默认 high/critical 非零退出）；桌面端 dev 工具链（electron 33 / electron-builder 25）的告警为已接受风险（镜像不稳定，无法在线升级）。文档解析具备 zip 炸弹防护（**实测**每个条目的真实解压字节数与压缩比，超限 413；不信任中央目录声明）与输出限长；嵌套压缩包与 PDF 解析上限未做。
- 组织管理员可读本组织全部会话（设计如此，见 `docs/gate6-access-control-fixes.md` §9）。

详见 [`docs/tasks.md`](docs/tasks.md) 的后续方向。
