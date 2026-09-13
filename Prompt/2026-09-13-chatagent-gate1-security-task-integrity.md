# ChatAgent 下一阶段开发 Prompt：Gate 1/2 可信身份与任务完整性

你现在使用 DeepSeek Harness 开发 `E:\ChatAI` 中的 ChatAgent。请先加载并遵守以下 skills：

- `chatagent-engineering`
- `deepseek-harness-workflow`
- `incremental-prompt`
- `project-driver`
- `project-framework`
- `project-testing`

本次是一次增量开发，不是重新搭建项目。请先阅读仓库 `AGENTS.md`（如存在）、`README.md`、`docs/project-brief.md`、`docs/architecture.md`、`docs/tasks.md`、`docs/skills-upgrade-2026-09-13.md`，以及 `skills/chatagent-engineering/references/code-audit.md`。保留现有用户修改，不重置、不提交 Git、不重组 `.git`、`.codex` 或其他点目录。

## 产品目标

ChatAgent 是内网聊天中的 AI 工作主体，不是只返回文本的聊天机器人。任何“已完成”都必须有真实、可验证的任务结果。当前优先建立可信基础：合法成员才能委托 AI，任务失败不能伪装成功，取消不能被完成覆盖，产物不能串到其他任务。

## 本次范围（只做这些）

### A. 服务端身份与对象授权

1. 先复核当前 API 和 contracts，不假定已有认证。选择与当前单组织内网 MVP 相匹配的最小服务端认证方案；如果没有真实用户目录，建立明确的 development/test principal 注入边界，不能把请求体中的 `senderName` 或 `senderId` 当成可信身份。
2. 为账号、会话、消息、任务、文件/产物和 SSE 增加对象级授权入口。至少区分：匿名、合法成员、非成员、同组织其他成员、AI 账号 owner/delegate。
3. Webhook 必须在进入 `injectMessage` 前完成来源验证、签名/token 策略、时间窗（若平台支持）和消息去重。生产默认 fail closed；未配置验证材料时只允许显式 test/mock profile，并在响应和日志中标明。
4. 未授权入站消息不得污染模型历史、创建任务或触发工具。拒绝响应不泄漏内部策略细节。
5. 不把“前端隐藏按钮”“反向代理已登录”“UUID 难猜”当作对象授权。

### B. 任务结果与取消竞态

1. 检查 `packages/hermes/src/types.ts`、`runtime.ts`、`apps/server/src/service.ts` 和 `packages/task-engine/src/engine.ts` 的真实接口，设计最小兼容的结构化执行结果。
2. 修复 provider 异常、工具失败、无效工具参数、空响应、输出截断、达到工具步数、超时和 Abort 的结果传播。不要用空字符串或“任务已执行”表示成功。
3. `TaskEngine` 只有满足明确成功条件才写 `completed`。异常写 `failed`，取消写 `cancelled`，需要审批/补充信息/外部回执未知时使用现有状态扩展或新增明确状态，并同步 contracts、API 和 Web 展示。
4. 用可控 Promise 写取消/完成竞态测试：取消提交成功后，迟到的 handler 不能覆盖为 completed；完成先提交时取消必须明确返回已完成。
5. `start/stop` 的本次最小目标是不要丢失或重复领取持久任务；如果完整恢复/租约超出范围，记录为后续任务，不能伪称已实现。

### C. 产物归属

1. 移除通过全局 artifact 列表前后差集认领任务结果的设计，或提供等价的严格 task/run/owner 绑定方案。
2. 生成工具保存产物时必须得到服务端可信的 `taskId/runId/ownerId/organizationId`，而不是模型自由传入。
3. 增加并发测试：两个任务交错生成文件，只能各自看到/关联自己的产物。下载、列表和转发再次执行对象授权。

## 明确不做

- 不接入 QQ、微信、钉钉、飞书真实凭据。
- 不改成微服务，不引入 Redis/Kafka/PostgreSQL/向量数据库。
- 不重写 Vue 页面，只补充必要的状态类型和错误展示。
- 不整体 fork 或安装上游 Hermes；当前 `packages/hermes` 是自研 TS 实现，若发现需要真实 Hermes 适配，只留下接口/ADR，不冒充已完成。
- 不把 DeepSeek Harness 当成 ChatAgent 生产运行时。
- 不调用真实收件人、不外发真实文件，不把任何密钥写入代码、测试或 Prompt。

## 实现要求

- 先给出 10 行以内的实施计划、受影响文件和不变接口；再编辑。
- 复用现有 contracts、stores、TaskEngine、Fastify 和 Vitest 结构，最小化改动。
- 所有状态迁移、错误码和兼容旧 JSON 数据的策略写入文档或测试。
- 不使用 `any` 绕过类型，不以 `String()` 将错误输入强行转换成业务值，不吞异常。
- 日志脱敏；不要持久化 token、密码、完整敏感文件或模型 reasoning 原文。
- 如果发现现有实现与本 Prompt 或项目文档冲突，先在结果中列出冲突及选择，不静默改产品方向。

## 必须新增或更新的测试

至少覆盖：

1. 匿名请求拒绝；合法成员通过；非成员访问其他会话/任务/文件拒绝。
2. 伪造 sender 字段不能认证；未验签 webhook 不写消息/任务；同一外部消息重放不产生第二个任务。
3. provider 抛错最终为 failed；空模型响应不能 completed；工具参数 JSON/schema 错误不执行副作用。
4. 取消与完成竞态；Abort 传播；失败重试不重复已确认的副作用。
5. 两个并发任务的 artifact 归属与下载授权。
6. SSE 访问授权；至少确保未授权订阅拿不到别人的事件。

确认 `vitest.config.ts` 会收集 `apps/server` 测试；若修改 include，避免把构建产物或 node_modules 纳入测试。

## 验证与交付

从仓库根目录执行能执行的最小命令，优先：

```text
pnpm typecheck
pnpm test
pnpm build
```

若 pnpm、模型网关、真实身份服务或浏览器不可用，准确标记 BLOCKED，不替换成“通过”。本次只需 Mock/test profile 验证服务端安全和任务语义；真实 DeepSeek、真实 Hermes、真实 IM 另列未验证项。

完成时输出：

1. 修改文件和每个修改的根因。
2. 新增/修改的 contracts、状态、授权和数据迁移语义。
3. 实际执行的命令、测试数量和结果。
4. 仍未解决的 P0/P1 问题，引用 `code-audit.md` 中的 ID。
5. 是否真实使用 DeepSeek Harness、使用的 dsh 命令和固定版本；若未使用，说明阻塞原因。
6. 下一条最小 Prompt：优先审批/outbox/幂等或真实内网聊天网关，不要泛泛写“继续优化”。

---

## 实施结果（2026-09-13）

状态：已实施 A/B/C 三项，Mock/test profile 验证通过；真实模型、真实 Hermes、真实 IM 未验证。

### 变更文件与根因

| 文件 | 根因 |
| --- | --- |
| `packages/contracts/src/types.ts` | 缺 `Principal/MemberRecord`、账号/会话/任务/产物归属字段与 `waiting_approval/incomplete` 状态 |
| `packages/contracts/src/schemas.ts` | `inboundMessageSchema` 把 sender 设为必填，容易被误解为可信身份 → 改为可选且不参与认证 |
| `packages/hermes/src/types.ts`、`runtime.ts` | provider 异常/空响应/截断/步数/Abort 无结构化结果；无效工具参数被 `{}` 兜底 |
| `packages/task-engine/src/{types,engine,json-file-store}.ts` | handler 正常返回即 completed；取消可被覆盖；start/stop 不恢复也不停止 |
| `packages/document/src/tools.ts` | `saveArtifact` 无归属参数；`String()` 兜底把错误输入变成业务值 |
| `packages/im-gateway/src/{types,webhook-gateway,memory-gateway}.ts` | `verify` 无 token 即放行，路由从未调用 |
| `apps/server/src/auth.ts`（新增） | 无认证/对象授权入口 |
| `apps/server/src/{app,service,agent,stores,config}.ts` | 路由无授权、webhook 无验签与去重、产物靠全局差集认领 |
| `apps/web/src/views/TasksView.vue` | 新增状态未映射标签 |
| `vitest.config.ts` | 只收集 packages 测试，apps/server 测试不会被执行 |
| `docs/gate1-2-identity-task-integrity.md`（新增） | 记录状态机、错误码、授权矩阵与迁移策略 |

### 权限 / 数据分类 / 幂等

- 前置权限：`production` 需 bearer token；`development` 是显式注入边界，响应头标注。
- 数据分类：token 仅存 sha256；日志不含 token/明文载荷；产物含 `organizationId/ownerId/taskId/runId`。
- 幂等：webhook 以 `channel:channelMessageId`（或 raw body sha256）7 天去重；任务终态 CAS 不可覆盖。
- 是否会外发：本 Gate 不新增真实外发；`sendUrl` 未配置时仍只写本地记录（DELIVER-01 未解决）。

### 测试 profile

- 执行：`pnpm typecheck`（tsc + vue-tsc）、`pnpm test`（8 文件 / 50 用例）、`pnpm build`。
- Profile：Mock 离线 + Fastify inject 集成；真实 DeepSeek、真实 Hermes、真实 IM 网关标记未验证。

