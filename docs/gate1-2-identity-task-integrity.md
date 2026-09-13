# Gate 1/2：可信身份与任务完整性

日期：2026-09-13 · 范围：服务端身份与对象授权、任务结果与取消竞态、产物归属

对应 Prompt：`Prompt/2026-09-13-chatagent-gate1-security-task-integrity.md`
对应基线问题：`skills/chatagent-engineering/references/code-audit.md` 的 AUTH-01/02/03、TASK-01/02、FILE-01、TOOL-02、TEST-01（部分）。

## 1. 认证模型

单组织内网 MVP，两档显式模式（`CHATAGENT_AUTH_MODE`，缺省：`NODE_ENV=production` → `production`，否则 `development`）：

| 模式 | 行为 |
| --- | --- |
| `production` | 只有 `Authorization: Bearer <token>` 命中成员目录才认证；请求体与 `x-chatagent-principal-*` 头一律忽略；无凭据 = 匿名 → 401。 |
| `development` | 显式 test/dev profile：`x-chatagent-principal-id/org/name` 是开发 principal 注入边界；无头时映射到配置的 owner（默认 `dev-owner`）。响应头 `x-chatagent-auth-mode: development` 与 `x-chatagent-principal: <id>` 标明降级。 |

- 成员目录：`data/members.json`，仅保存 `tokenHash = sha256(token)`，明文 token 只存在于调用方环境。
- 请求体中的 `senderId` / `senderName` 只用于展示兼容，**永不参与身份判定**；`POST /api/messages` 落库的 sender 一律为已认证 principal。
- 反向代理登录、UUID 难猜、前端隐藏按钮都不构成对象授权。

## 2. 对象授权矩阵

| 对象 | 读 | 写 / 管理 |
| --- | --- | --- |
| 账号 AgentAccount | 同组织成员 | owner 或 `agentIds` 委托者或组织 owner/admin |
| 会话 Conversation | 同组织且 `participantIds` 含调用者，或组织 admin | 由消息投递隐式写入参与者 |
| 任务 TaskRecord | 同组织且（requester 本人 / 账号 owner / 组织 admin） | 取消同上 |
| 产物 Artifact | 同组织且（owner 本人 / 组织 admin / 能读其 task） | 只能由服务端 scope 写入 |
| 上传文件 Upload | 同组织且（上传者本人 / 组织 admin） | 上传者 |
| SSE `/api/tasks/:id/stream` | 先做任务读授权，未授权不写任何字节 | — |

拒绝语义：跨组织/非成员/非参与者统一 404（不泄漏对象是否存在）；同组织权限不足（如非 owner 改账号）返回 403。

## 3. Webhook 验证

`POST /api/webhooks/:channel` 在进入 `injectMessage` 之前必须通过：

1. **签名**：配置 `CHATAGENT_<CHANNEL>_SIGNING_SECRET` 时，要求 `x-chatagent-signature: sha256=<hex>`，对原始 body 做 HMAC-SHA256 定时安全比较。
2. **静态 token**：配置 `CHATAGENT_<CHANNEL>_TOKEN` 时，校验 `x-chatagent-webhook-token` 或 `?token=`。
3. **时间窗**：payload 含 `timestamp`/`create_time` 时，超过 `CHATAGENT_WEBHOOK_MAX_SKEW_SECONDS`（默认 300s）拒绝。
4. **无验证材料**：`production` fail closed（401）；仅当 `CHATAGENT_AUTH_MODE=development` 且 `CHATAGENT_WEBHOOK_ALLOW_UNVERIFIED=true` 时放行，并在响应 `verificationMode: "simulated"` 标注。
5. **去重**：`channel:channelMessageId`（缺省用 raw body sha256）记录在 `data/webhook-dedupe.json`，保留 7 天；重放不产生第二条消息或任务。

## 4. 任务终态与结果传播

`packages/hermes` 的 `RunResult.outcome` 是判别式结果：

| status | 触发 |
| --- | --- |
| `succeeded` | 模型返回非空文本且 `finish_reason != length` |
| `failed` | provider 异常（`provider_error`）、空响应（`empty_response`）等 |
| `cancelled` | AbortSignal / AbortError |
| `incomplete` | 达到工具步数（`step_limit`）或输出截断（`output_limit`） |

`TaskEngine` 状态机（终态加粗）：

```text
pending → running → **completed**
                  → **failed**
                  → **cancelled**
                  → **incomplete**
                  → waiting_input / waiting_approval → running
```

- 只有 handler 返回 `completed`（或兼容的字符串）才写 `completed`；异常 → `failed`；取消 → `cancelled`；步数/截断/产物缺失 → `incomplete`。
- 终态由 `commit()` 保护：终态记录拒绝任何后续写入，取消后迟到的 handler 结果不会覆盖为 completed（测试 `engine.test.ts › keeps cancelled ...`）。
- 完成先提交时 `cancel()` 返回 `{ ok:false, reason:'already_finished', state:'completed' }`。
- 生成类目标（Word/Excel/文档/表格）声明 `succeeded` 但没有任何绑定产物时降级为 `incomplete(delivery_unknown)`，不再用「任务已执行」兜底。
- `start()` 恢复持久化任务：`pending` 重新入队，`running`（上次进程崩溃遗留）重置为 `pending` 再入队；队列带去重集合，避免重复领取。
- `stop()` 停止领取、abort 所有在飞 controller，并等待在飞任务收敛（`stopTimeoutMs` 上限）。

## 5. 产物归属

- `ArtifactStore.save(buffer, name, mimeType, scope)` 的 `scope = { organizationId, ownerId, taskId?, runId? }` 只能来自服务端：`ToolContext` 由 runtime 从 `RunRequest` 透传，模型参数无法覆盖。
- 文档工具在缺少 `organizationId/ownerId` 时直接拒绝生成，不写无归属文件。
- `service.runTask` 用 `artifacts.listByTask(taskId)` 绑定产物，**移除**原来的「全局产物列表前后差集」认领。
- 下载、列表、转发均再次执行对象授权；转发还要求产物属于当前 task 或当前 owner。

## 6. 错误码

| HTTP | 含义 | 场景 |
| --- | --- | --- |
| 401 | `authentication required` / `webhook rejected` | 匿名访问、凭据无效、webhook 未通过验证 |
| 403 | `forbidden` | 同组织但非 owner 改账号、非 requester/owner 取消任务 |
| 404 | `resource not found` | 跨组织或非参与者访问账号/会话/任务/文件 |

错误响应只包含通用描述，验证失败原因只写日志，不回传内部策略。

## 7. 数据迁移（旧 JSON 兼容）

读取时补齐，不破坏旧文件；下一次写入时落盘新字段。

| 文件 | 迁移 |
| --- | --- |
| `accounts.json` | 缺 `organizationId` → `CHATAGENT_ORGANIZATION_ID`（默认 `org_local`）；缺 `ownerId` → `CHATAGENT_LEGACY_OWNER_ID`（默认 `dev-owner`） |
| `conversations.json` | 同上；缺 `participantIds` → `[legacyOwnerId]` |
| `tasks.json` | 缺 `organizationId`/`requesterId` → 同上；产物补 `taskId` 与归属 |
| `uploads.json` / `artifacts.json` | 缺 `organizationId`/`ownerId` → 同上 |
| 旧任务状态 | 仅新增 `waiting_approval` / `incomplete`，旧值语义不变 |

## 8. 本次未实现（明确登记）

- `TASK-03` 完整租约/崩溃恢复：当前只有「running → pending 重取」，没有租约、没有多实例互斥。
- `DELIVER-01` outbox / 回执 / unknown 对账：`WebhookImGateway` 无 `sendUrl` 时仍只写本地记录，未标记 `simulated/delivered`。
- `TOOL-01` 审批：发送/转发的收件人授权与人工审批未实现（本次只做了「未知网关/空收件人拒绝 + 产物归属校验」）。
- `MODEL-01` reasoning/thinking、超时、截断字段保留：未实现。
- 签名仅支持通用 HMAC header，未实现各平台原生签名算法（钉钉 `sign`、飞书 `X-Lark-Signature` 等）。
