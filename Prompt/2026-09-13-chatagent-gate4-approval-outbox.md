# ChatAgent 增量 Prompt：Gate 4 审批 + Outbox + 幂等回执

日期：2026-09-13（Asia/Shanghai） · 关联：`Prompt/2026-09-13-chatagent-gate1-security-task-integrity.md`（前置 Gate 1/2）

## 原始指令（脱敏后全文）

实施 Gate 4 最小切片：审批 + outbox + 幂等回执。为 send_message/forward_file 增加 Approval 实体（绑定 action digest = hash(工具名+目标+artifact 版本+载荷)）与 waiting_approval 消费路径；发送前必须命中未过期审批且组织/成员/权限未变，否则拒绝且网关调用数为 0；新增持久 outbox（taskId+stepKey 幂等键），重试与重复 webhook 只产生一次外发；SendResult 扩展为 simulated|accepted|delivered|failed|unknown，unknown 不自动重发、留待对账。必须新增测试：未审批零外发、重复投递不重复外发、审批后撤权拒绝、审批载荷变更拒绝、unknown 不重发。真实 IM 凭据未就绪时标 BLOCKED，不以 Mock 冒充交付。

## 元数据

| 项 | 值 |
| --- | --- |
| 受影响 package | `@chatagent/contracts`、`@chatagent/im-gateway`、`@chatagent/task-engine`、`apps/server` |
| 受影响符号 | `ApprovalRecord`/`OutboxRecord`/`DeliveryState`、`SendResult.state`、`buildMessageTools`、`TaskEngine.resume`、`ChatAgentService.{listApprovals,decideApproval,listOutbox,resumeTask}` |
| 前置权限 | requester 发起需任务读权限；审批需同组织且非 requester 的 owner/admin 或账号 owner；outbox 读取限本人/组织 admin/任务读者 |
| 数据分类 | 审批只存动作摘要与规范载荷（不含 token/密钥）；outbox 只存目标与回执状态 |
| 是否外发 | 是（受审批与 outbox 约束）；无真实凭据时全部 `simulated` |
| 幂等/取消语义 | `stepKey = sha256(taskId\|runId : digest)`；`failed` 可重试，`unknown` 与已完成态不重发；审批单次消费 |
| 测试 profile | Mock 离线 + Fastify inject 集成（`apps/server/src/approval-outbox.test.ts`） |
| 未验证边界 | 真实 IM 投递（BLOCKED）、业务回执查询、多实例并发、UI 审批 |

## 实施结果

- 契约：新增 `ApprovalStatus`/`ApprovalRecord`/`ApprovalAction`/`DeliveryState`/`OutboxRecord`；`SendResult` 增加必填 `state`，`ok` 收紧为仅 `accepted`/`delivered`。
- 服务端：新增 `apps/server/src/approvals.ts`（digest、stepKey、`ApprovalStore`、`OutboxStore`、`evaluateApproval`、`canDecideApproval`）；`agent.ts` 的 `send_message`/`forward_file` 统一走「查重 → 审批闸门 → 网关 → outbox 回执」；`service.ts` 将 `approvalRequired` 映射为 `waiting_approval`，把 `simulated/unknown/failed` 映射为 `incomplete(delivery_unknown|delivery_failed)`；`task-engine` 新增 `resume()`。
- API：`GET /api/approvals`、`POST /api/approvals/:id/decision`、`GET /api/outbox`、`POST /api/tasks/:id/resume`。
- 验证：`pnpm typecheck` 通过；`pnpm test` 9 文件 / 59 用例通过（新增 9 例）；`pnpm build` 通过；现场 curl 走通「阻塞 → 自审 403 → owner 审批 → resume → outbox 一条 simulated → 任务 incomplete → 再次 resume 拒绝」。
- BLOCKED：真实 IM 凭据缺失，实际投递只能是 `simulated`；`accepted/delivered` 仅由测试 fake gateway 覆盖。
