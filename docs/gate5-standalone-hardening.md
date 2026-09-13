# Gate 5：独立原生化 + 安全加固

日期：2026-09-13 · 关联：`docs/adr-0001-standalone-native-chat.md`、`docs/gate4-approval-outbox.md`

本轮在「独立产品」方向上补齐了三件事：**原生投递通道**、**独立安全审查后的加固**、**成员与审批的自助管理**。

## 1. 原生投递通道（NativeImGateway）

此前 AI 的主动外发（`send_message` / `forward_file`）只能走第三方网关，未配置通道时是 `simulated`，任务以 `incomplete(delivery_unknown)` 结束。

现在内置 `apps/server/src/native-gateway.ts`：

- `to` 解析为**本组织成员**（`self`/`me` → 发起人），跨组织或未知收件人直接 `failed`，不静默兜底；
- 写入该成员与 AI 账号的**同一个原生会话**（`chatId = native:agent:<accountId>:<memberId>`），因此 AI 主动消息会立刻出现在聊天窗口；
- 返回 `{ state: 'delivered', gatewayMessageId }` 并记录 outbound 回执（可在「审批」页查看）。

投递通道选择规则（`resolveDeliveryGateway`）：精确通道匹配（排除本地回显 `memory`）→ 内置 `native` → 最后才回落到 `memory`（测试/无通道部署）。

因此在默认部署下，「用户让 AI 通知某人 → 审批 → resume」会以 `delivered` 收尾，任务判定为 `completed` 而不是 `incomplete`。

## 2. 安全加固（基于独立安全审查）

审查发现并已修复（按风险从高到低）：

| ID | 问题 | 修复 | 证据 |
| --- | --- | --- | --- |
| P0-1 | 默认 `development` 认证模式下，**任何能访问端口的调用者都会变成组织 owner**；无效 Bearer 还会回落成 dev principal | 无效凭据一律匿名（两种模式）；dev 注入仅限**回环地址**或显式 `CHATAGENT_ALLOW_DEV_AUTH=true` | `auth.ts` `resolvePrincipal`、`config.ts` `allowDevAuth`；实测：`192.168.63.63:8787/api/accounts → 401`，`127.0.0.1 → 200` |
| P0-2 | `parse_document` 按文件名在**全租户**查找上传文件，可跨组织读取文档并写成产物 | 新增 `UploadedFileStore.resolveInOrg(ref, org)`，工具按 `ToolContext.organizationId` 解析；`resolveFile(ref, context)` 接口化 | `stores.ts`、`agent.ts`、`packages/document/src/tools.ts`；测试 `security-regression.test.ts` |
| P1-1 | 审批「单次使用」不是原子的：校验与消费之间隔着网络调用，两个任务可同时通过 | 新增 `ApprovalStore.claim(id, stepKey)`（无 await 的 CAS），**先占用再发送**；明确失败时 `release()` 归还；审批同时绑定 `taskId` | `approvals.ts`、`agent.ts`；测试：三个并发 claim 只有一个成功 |
| P1-2 | 登出/吊销后，已建立的 SSE 仍持续推送 | SSE 携带凭据哈希，每 15s 复核会话，失效即断开 | `app.ts` `streamNativeEvents` |
| P1-3 | SSE 无订阅上限、无心跳、无背压 | `NativeEventHub` 限制总订阅 200 / 单主体 5（超出 503）、20s 心跳、`write()` 返回 false 即断开 | `events.ts`、`app.ts`；测试：第 6 条流 503 |
| P1-4 | 任何组织成员可驱动任意 AI 账号，并可注入 `role: "system"` 历史 | `canUseAccount`（空 allowlist = 全组织；非空 = 显式授权）用于会话/任务入口；`createTaskSchema` **移除 `input`**，历史一律服务端按会话重建 | `auth.ts`、`service.ts`、`schemas.ts`；测试：注入的 system 文本不出现在任务历史中 |
| P1-5 | `/api/gateway/outbound` 返回全部组织的出站记录 | 按调用者组织过滤 | `service.ts` `listOutbound`；测试：跨组织返回空 |
| P2 | 终端任务仍可被同状态补丁改写 | `commit()` 对终态一律拒绝写入 | `packages/task-engine/src/engine.ts`；测试：取消后迟到写入无效 |
| P2 | 超大上传返回 500 | 映射 `FST_REQ_FILE_TOO_LARGE → 413`（**不充分**：框架可能不抛错，见 `docs/gate6-access-control-fixes.md` G6-4，现改为显式检查 `file.file.truncated`） | `app.ts` |
| P2 | 审计/日志可能记录 webhook `?token=` | 审计目标统一去掉 query | `app.ts` `auditPath()` |
| P2 | 单 IP 可对无限成员 ID 猜密码 | 新增 `loginIp` 桶（60/min），与按身份桶并存 | `rate-limit.ts`、`app.ts` |
| P2 | 任务队列无上限 | `maxQueueDepth`（默认 200），超出拒绝入队 | `packages/task-engine` |
| P2 | 产物/上传路径泄露到 API 与外部网关 | 任务产物不再返回 `localPath`；转发改用 `/api/files/:id` | `service.ts`、`agent.ts` |

仍**未评估**：依赖 CVE（`pnpm audit` 在 npmmirror registry 上无 audit 端点）、压缩炸弹、浏览器侧 CSP 实测。

## 3. 成员与审批自助管理

- `GET /api/members`、`POST /api/members`、`PATCH /api/members/:id`、`POST /api/members/:id/token`（组织管理员；令牌只返回一次，落库只存 sha256，重置令牌会吊销该成员全部会话）。
- 前端新增「成员」页（创建/改角色/重置令牌，令牌一次性展示+复制）与「审批」页（待审批列表、批准并继续、历史审批、outbox 回执表）。

## 4. 交互与美观

- 聊天：未读徽标与总数、最后一条消息预览、会话/联系人搜索、日期分隔、5 分钟内同人消息合并、自动滚动、`Enter` 发送 / `Shift+Enter` 换行、附件气泡可点击下载、加载骨架、AI 会话快捷提示词、任务状态条（运行中脉冲动画）。
- 主题：跟随系统的浅色/深色切换（Element Plus dark CSS 变量 + 项目自有 token），侧栏一键切换并持久化。
- 任务/审批状态在聊天窗口内以卡片形式呈现，审批人可直接「批准并继续」。

## 5. 验证

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过（tsc + vue-tsc） |
| `pnpm test` | 通过（本轮时点）：14 文件 / 92 用例；**当前总量见 `docs/gate6-access-control-fixes.md` §8（19 文件 / 133 用例）** |
| `pnpm build` | 通过 |
| 现场 | 安全响应头、无效 Bearer→401、LAN→401/回环→200、webhook 默认 404 |

新增测试文件：`native-delivery.test.ts`（原生投递与通道选择）、`security-hardening.test.ts`（Cookie 只读/安全头/限流/上传白名单/审计/会话吊销）、`security-regression.test.ts`（跨组织文档、审批原子性、历史注入、出站隔离、SSE 上限）、`members.test.ts`（成员管理）。

## 6. 群聊、搜索与持久化治理（同轮追加）

- **群聊**：`POST /api/groups`（`title` + `memberIds`），会话 `targetKind: 'group'`，参与者全部可读可发；组名相同的同一批成员会复用同一会话（chatId 由 org+成员+标题的 sha256 派生；**复用时的成员对账语义见 G6-3**）。前端侧栏「＋群聊」对话框多选同事创建；AI 入群与 `@` 触发任务见 G5b-17a。
- **消息搜索**：`GET /api/search?q=`（≥2 字，上限 50 条），只在调用者参与的会话内检索，绝不跨组织；前端侧栏搜索框带 250ms 防抖，点击结果跳转到该会话。
- **未读与预览**：`ConversationSummary` 提供 `unreadCount` 与 `lastMessage`；`POST /api/conversations/:id/read` 维护读游标；侧栏与顶部导航显示未读徽标。
- **持久化治理**：消息/会话/读游标改用 `JsonFileWriter` 合并写入（默认 150ms 防抖，避免每条消息整文件重写的 O(n²)），关闭时 `onClose` 强制 flush；测试覆盖「关闭后重启消息仍在」。
- **体验细节**：Element Plus 中文语言包、`Ctrl/Cmd+K` 聚焦搜索、消息区 `aria-live`、深色模式 token 全覆盖。

## 7. 独立验证轮（子 agent，只读）与修复

第二个只读子 agent 对上述改动逐条复核，结论：认证回落、组织级文档隔离、审批 CAS、结果传播、终端不可写、出站隔离等 **已确认**；同时用确定性探针**证伪**了一处并给出 10 项待改进。已全部处理：

| ID | 级别 | 问题 | 修复 |
| --- | --- | --- | --- |
| F2 | 高（已证伪） | `commit()` 的「读 → 判断 → 写」跨越 await，同一微任务批次内 `cancel()` 与迟到结果都读到取消前的记录，终态仍可能被写成 `completed`（复现率 5/12） | 每个 taskId 一条串行化提交链（`serialize()`），`claim()`/`commit()` 全部走锁；新增同 tick 竞态回归测试 |
| F1 | 高 | `parse_document` 只按组织解析上传文件，同组织其他成员的文件也能被 AI 读取 | `resolveInOrg(ref, org, {ownerId, isAdmin})`；`ToolContext.isOrgAdmin` 由服务端按 requester 角色注入 |
| F3 | 中 | webhook 出站把 5xx/408/429 一律判为 `failed` → 释放审批 → 可能重复外发 | 只有 4xx 判 `failed`，5xx/408/429 判 `unknown`（附 5 例状态映射测试） |
| F4 | 中 | 发送与回执之间崩溃会留下「已发送但无回执」，重试会重发 | 先写入 write-ahead 意图（state=`unknown`）再发送；该状态永不自动重发 |
| F5 | 中 | SSE 会话复核把**成员 API token**也当会话查询，15s 后误断合法 CLI 流 | 仅当凭据确实来自会话存储时才启用复核；补 `.catch()` 防止未处理拒绝 |
| F6 | 中 | `/api/tasks/:id/stream` 无心跳/上限/背压/会话复核 | 与原生流统一：`StreamLimiter`（单主体 8 条）、20s 心跳、`write()===false` 断开、会话复核 |
| F7 | 中 | 转发的文件附件 id 是随机值（前端 404），且 `localPath` 仍出现在工具输出与消息里 | 传真实 artifact/upload id（`SendFileInput.artifactId`）；工具输出与消息不再包含服务器文件路径 |
| F8 | 中 | 组织 admin 可创建/夺取 owner（含重置 owner 令牌） | 只有 owner 能创建/提升 owner、重置 owner 令牌；admin 不能修改自己的角色 |
| F9 | 低 | 合并写入吞掉写失败；审计队列在关闭时未 flush | `JsonFileWriter` 保留失败批次并回调错误（由 Fastify logger 记录）；`onClose` 调用 `audit.flush()` |
| F10 | 低 | `/api/gateway/outbound` 对普通成员暴露全组织出站内容 | 非管理员只看自己名下账号的记录 |
| F11 | 低（部署） | 反向代理同机部署时远程调用看起来像回环，dev owner 回落会给未认证用户 owner | 启动时打印显著警告；文档与 `.env.example` 要求生产设置 `CHATAGENT_AUTH_MODE=production` 且 `CHATAGENT_ALLOW_DEV_AUTH=false` |

修复后：`pnpm typecheck` 通过、`pnpm test` **17 文件 / 111 用例**通过、`pnpm build` 通过，端到端冒烟 **27/27 通过**（含自审拒绝、二次管理员审批、resume 后 `completed`、回执 `delivered`）。

## 7b. 第二轮独立验证（03:38）与修复

第二个只读子 agent 复核了 F1–F11 与新增功能，判定 8 项 VERIFIED、若干 PARTIALLY，并新发现 9 个问题。已全部处理：

| ID | 级别 | 问题 | 修复 |
| --- | --- | --- | --- |
| G1 | 高 | `forward_file` 未填 `SendFileInput.artifactId`，原生通道因此生成随机附件 id → 前端 `/api/files/<id>` 404；上传分支还把 `localPath` 写进消息（群成员可见） | 两处调用都填 `artifactId`；上传用 `/api/files/<uploadId>`，彻底不再传服务器路径（新增回归测试断言载荷中无 `localPath`/数据目录） |
| G2 | 中高 | 成员 API token 的 SSE 流不再复核（只有会话才复核），令牌重置后旧流仍收消息 | 复核函数同时查会话与成员目录；任一命中即视为有效，否则断开 |
| G3 | 中 | 合并写入让 200 不再代表落盘，且写失败只有日志 | `JsonFileWriter` 记录 `lastError`，`/health` 暴露 `storage.pending/lastError` 并在失败时返回 **503** |
| G4 | 中 | 网关调用抛异常时没有回执、审批也不归还，`unknown` 无法对账 | `deliver()` 捕获异常 → 写 `failed` 回执并归还审批；新增 `POST /api/outbox/:id/resolve`（管理员或记录所有者把 `unknown` 收敛为 `delivered/failed`，其它状态 409） |
| G5 | 中低 | `StreamLimiter` 可能重复释放（心跳 close 后 socket close 再次触发），配额被放大 | `close()`/`closeStream()` 增加幂等 `closed` 守卫 |
| G6 | 中低 | `cancel()` 在 `claim()` 窗口内无法中止，handler 仍会执行副作用 | 先注册 AbortController 再 claim，claim 后复核 `aborted` 与状态；不符即中止并清理 |
| G7 | 低 | 同一条消息重复 @ 同一 AI 会创建多个任务 | 提及 id 去重 |
| G8 | 低 | 未知分页游标回退到最新一页，前端会重复插入 | 未知游标返回空数组 |
| G9 | 低 | 单任务事件回放缓冲无上限；任务存储非原子写 | 事件缓冲上限 500 条（保留终态事件） |

修复后：`pnpm typecheck` 通过、`pnpm test` 17 文件 / **117 用例** + 前端 1 文件 / 4 用例通过、`pnpm build` 通过、冒烟 27/27 通过。

## 8. 一键验收

```bash
pnpm start                       # 或双击 start-server.cmd
node scripts/smoke.mjs           # 全链路冒烟（本机开发档位）
SMOKE_MEMBER=u_alice SMOKE_TOKEN=... node scripts/smoke.mjs   # 生产档位
```

冒烟脚本会依次验证：健康检查 → 身份 → 联系人 → 原生会话 → 文档任务与产物下载 → 审批门禁与自审拒绝 → 二次管理员审批 → resume → 投递回执 → 搜索 → 群聊，并输出 PASS/FAIL 表。

## 9. 未完成（下一轮候选）

- 群内 @AI 触发任务、成员在线状态、已读回执、消息撤回。
- 消息分片/JSONL 归档（当前仍是单文件 + 防抖写）。
- 依赖 CVE 扫描（需要可用的 audit 端点或离线漏洞库）。
- `simulated`/`unknown` 的人工对账流程（当前只能查看 outbox）。
- 浏览器端到端回归（本机无可用浏览器 provider）。
