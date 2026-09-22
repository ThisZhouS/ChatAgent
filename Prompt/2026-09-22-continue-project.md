# 继续项目的完善（第 57 轮）

日期：2026-09-22；项目：E:\ChatAI；关联：`Prompt/2026-09-17-product-decomposition.md`（同一目标下的续做）、`docs/decision-memo-nine-questions-2026-09-21.md`（本轮实现的决定 5）、`docs/design-1c-8b-5-2026-09-21.md`（决定 1/8 的落地方案）。

## 原始指令

> 继续项目的完善

## 整理（规范化，不改意图）

- 目标：按已确认的产品决定继续推进剩余切片，而不是新增范围。所有者此前的确认是 **1C（实为 (a) 组织目录可搜）、2A、3B、4A、5 用户可设置、6A、7A、8B、9C**，其中 3B、9C 已交付，2/4/6/7 现状即答案，剩下的执行顺序是 **5 → 1 → 8**（决策备忘「所有者确认」段）。
- 本轮范围：**只做第 5 条**（队列栈粒度 = 每人一份）。第 1 条与第 8 条本轮不动代码，只在文档里保留已核实的落点。
- 约束：口径由所有者原话给定（「用户设置」＝每人一份），不再自行猜测；不改变沟通模型（1C 试做被 35 个用例否证并回退的教训）；不留未验证的半成品。
- 验收信号：入队与澄清两条路径**真的**读请求者的设置（有用例观察到被切掉的条数），越界必须 400 而不是静默夹紧，设置重启后仍在，且只能改自己。

## 实施留痕（2026-09-22）

| 项 | 值 |
| --- | --- |
| 受影响 package/符号 | `packages/contracts`（`MemberPreferences`、`MEMBER_PREFERENCE_MIN/MAX`、`DEFAULT_CLARIFY_HISTORY_LIMIT`、`memberPreferencesSchema`）；`apps/server/src/stores.ts`（`MemberPreferencesStore`）；`apps/server/src/agent-intake.ts`（`contextLimitFor`）；`apps/server/src/service.ts`（`getPreferences`/`updatePreferences`/`agentContextOverride`/`preferencesFor`，提交与澄清两处生效点）；`apps/server/src/app.ts`（store 构造、`GET/PATCH /api/preferences`） |
| 前置权限 | 需要已认证成员（`requireMember`）；两条路由都**不接受成员 id**，因此「只能改自己的设置」是结构性约束，不存在越权路径 |
| 数据分类 | 个人偏好数值（两个 1–200 的整数）与审计行（只写改动前后的数字）；无凭据、无消息正文、无收件人载荷 |
| 是否外发 | 否。不调用模型、不启动 Hermes、不发送消息；偏好只影响后续请求带多少历史进模型 |
| 幂等/取消语义 | PATCH 幂等（同样的 patch 结果相同）；单字段 patch 不改另一字段；存储层「后写覆盖」，与发送/任务状态机无交互，取消与撤回语义不变 |
| 测试 profile | 离线 MockProvider；`preferences.test.ts` 6 例 + `agent-intake.test.ts` +3 例；根套件 **53 文件 / 426 用例**、`tsc` 0 错 |

落盘文件：

- `packages/contracts/src/types.ts`、`packages/contracts/src/schemas.ts`：偏好类型与校验。
- `apps/server/src/stores.ts`：`MemberPreferencesStore`（文件 `data/member-preferences.json`，只存显式改动）。
- `apps/server/src/agent-intake.ts`：`contextLimitFor(requesterId)`：按请求者取窗口，缺失/查不到/越界回落配置默认（查不到只记日志，不阻断投喂）。
- `apps/server/src/service.ts`、`apps/server/src/app.ts`：偏好读写、路由与两处生效点。
- `apps/server/src/preferences.test.ts`（新增）、`apps/server/src/agent-intake.test.ts`（+3 例）。
- 文档：`docs/product-decomposition-gap-matrix-2026-09-17.md` §3.19、`docs/tasks.md`、`docs/handoff-2026-09-18.md`。

## 未决与边界

- **界面未做**：设置页还没有这两个数字的入口，成员目前只能用 API 改。已写进 `docs/tasks.md` 作为本条的下一片；在它落地前不得对用户宣称「助手上下文可设置」。
- 第 1 条（(a) 组织目录可搜）与第 8 条（唯一 handle）本轮**未动代码**；落地方案与「先 grep `contacts()` 消费点」的前置检查见 `docs/design-1c-8b-5-2026-09-21.md`。
- 未运行 Electron 七项、打包后客户端 E2E 或 Gate 7A 自检（本轮只改服务端与契约，不涉及客户端与宿主；如需全量复验按 `docs/handoff-2026-09-18.md` 的「一条命令复现验证」执行）。
- 仍不使用向量库：项目现有检索是 JSON 存储 + 进程内搜索，本轮 Prompt 沿用 Markdown 留痕（无新增向量写入需求）。
