# Gate 4：审批 + Outbox + 幂等回执

日期：2026-09-13 · 范围：外发审批、持久 outbox、投递回执语义
前置：`docs/gate1-2-identity-task-integrity.md`（身份/授权/终态/产物归属）

## 1. 目标与不变式

- 任何外发（`send_message` / `forward_file`）都必须命中一条**未过期、内容一致、权限未变**的审批，否则拒绝且**网关调用数为 0**。
- 同一次外发（同一 task + 同一动作摘要）在重试、恢复、重复投递中**只执行一次**。
- HTTP 2xx 不等于送达：只有 `accepted`/`delivered` 才算提交成功；`simulated`/`unknown` 一律不当作交付。
- `unknown` 绝不自动重发，留给人工对账。

## 2. Approval 实体

`data/approvals.json`，契约见 `packages/contracts/src/types.ts` 的 `ApprovalRecord`：

| 字段 | 说明 |
| --- | --- |
| `action` | 规范动作：`tool` + `target` + `chatType` + `kind` + `text` / `artifactId` + `artifactVersion` + `artifactName` |
| `digest` | `sha256(JSON(action))`，**工具名 + 目标 + 载荷 + 产物版本** 任一变化即变化 |
| `status` | `pending → approved / rejected`，超时置 `expired`，发送成功置 `consumed` |
| `expiresAt` | 创建时间 + `CHATAGENT_APPROVAL_TTL_SECONDS`（默认 1800s） |
| `approverId` | 审批人；发送时会重新校验其在目录中的组织与角色 |
| `consumedByStepKey` | 单次消费标记，绑定唯一 outbox 步骤键 |

产物版本 = `artifactId:sizeBytes:createdAt`（`computeArtifactVersion`），因此重新生成的文件不会被旧审批放行。

**发送时重新校验**（`evaluateApproval`，任一不满足即拒绝）：状态、有效期、组织一致、requester 仍在组织、approver 仍在组织且仍具 `owner/admin`、非自审、未被其它步骤消费。

## 3. 外发路径（唯一入口）

```text
工具参数校验（非空 to / text / 会话上下文 / 服务端可信 scope）
  → stepKey = sha256(taskId|runId : digest)
  → outbox 查重：已存在且 state != failed      → 直接返回既有回执（不调用网关）
  → 审批闸门：findApproved + evaluateApproval
       未通过 → 创建/复用 pending Approval → 返回 approvalRequired（网关 0 次调用）
  → 调用网关一次
  → 写入 outbox 回执（state/attempts/gatewayMessageId/error）
  → state != failed 时 consume 审批
```

## 4. 投递状态（`SendResult.state`）

| state | 含义 | 是否可重试 |
| --- | --- | --- |
| `simulated` | 未配置真实投递通道，仅本地记录 | 否（不视为交付） |
| `accepted` | 网关 2xx 且业务响应无错误 | 否（已提交） |
| `delivered` | 网关返回明确送达回执 | 否 |
| `failed` | 非 2xx 或业务错误码 | 是（同一审批可重试） |
| `unknown` | 超时/传输错误，可能已送达 | **否**，等待对账 |

`ok` 仅在 `accepted`/`delivered` 时为 true。2xx 响应体会检查 `ok:false` / `errcode|code != 0` 判定业务失败。

## 5. 任务终态映射

| Agent 侧信号 | 任务终态 |
| --- | --- |
| 任一工具返回 `approvalRequired` | `waiting_approval`（不是完成） |
| 外发 `simulated` / `unknown` | `incomplete(delivery_unknown)` |
| 外发 `failed` | `incomplete(delivery_failed)` |
| 无外发且无产物要求的成功回答 | `completed` |

`waiting_approval` 非终态，可通过 `POST /api/tasks/:id/resume` 继续；终态任务 resume 返回 `already_finished`。

## 6. API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/approvals` | 我发起的 + 我有权审批的（同组织） |
| POST | `/api/approvals/:id/decision` | `{decision:'approved'\|'rejected', reason?}`；requester 自审返回 403 |
| GET | `/api/outbox` | 外发回执（本人 / 组织 admin / 能读所属任务） |
| POST | `/api/tasks/:id/resume` | 继续等待审批/输入的任务 |

典型操作序列：

```bash
curl -X POST localhost:8787/api/approvals/<id>/decision -H 'Content-Type: application/json' \
  -d '{"decision":"approved"}'
curl -X POST localhost:8787/api/tasks/<taskId>/resume
curl localhost:8787/api/outbox
```

## 7. 数据与迁移

- 新增 `data/approvals.json`、`data/outbox.json`，旧数据文件不受影响（Gate 1/2 的迁移策略不变）。
- `SendResult` 新增必填 `state`；`ok` 语义收紧为「真实提交成功」。旧的调用方若只看 `ok`，行为从「一律 true」变为「仅 accepted/delivered 为 true」——这是刻意的语义修正，已在 `docs/bugs.md` 记录。

## 8. 测试（`apps/server/src/approval-outbox.test.ts`，9 例）

1. 未审批 → 网关 0 次调用、outbox 空、生成 pending 审批。
2. 审批后发送一次；重复执行返回 `replayed`，网关仍 1 次。
3. 审批载荷变更（内容 A → B）→ 拒绝、0 次调用、生成新 pending。
4. 审批后撤权（approver 降为 member）→ `approver_revoked`、0 次调用。
5. 审批过期 → 拒绝、0 次调用。
6. `unknown` → 记录一次，第二次返回既有回执且不重发。
7. `simulated` → 记录但不视为送达（`ok:false`）。
8. `failed` → 允许用同一审批重试，outbox attempts 递增且仍只有一条记录。
9. 端到端：任务被阻塞为 `waiting_approval` → 自审 403 → owner 审批 → resume → outbox 一条 `simulated` → 任务 `incomplete`；再次 resume 被拒。

## 9. 未完成 / BLOCKED

- **真实 IM 凭据未就绪（BLOCKED）**：仓库内所有通道都无 `sendUrl`，实际投递只能是 `simulated`；`accepted`/`delivered` 路径仅由测试中的 fake gateway 覆盖，**不代表真实送达**。
- 回执对账：没有 `unknown` 的人工对账流程与 UI，只能通过 `/api/outbox` 查看。
- 审批 UI：工作台还没有审批列表与一键批准/驳回（当前用 API/curl）。
- 审批恢复是手动的：批准后需要显式 `resume`，没有自动续跑。
- 平台原生业务回执（钉钉/飞书的 message id 查询）未接入，`accepted` 不等于 `delivered`。
- 多实例：outbox/approval 为单进程 JSON 存储，无跨实例唯一约束（与 TASK-03 同类问题）。
