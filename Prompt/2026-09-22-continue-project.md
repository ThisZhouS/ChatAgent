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
- 第 8 条（唯一 handle）本轮**未动代码**；落地方案见 `docs/design-1c-8b-5-2026-09-21.md`。
- 未运行 Electron 七项、打包后客户端 E2E 或 Gate 7A 自检（本轮只改服务端与契约，不涉及客户端与宿主；如需全量复验按 `docs/handoff-2026-09-18.md` 的「一条命令复现验证」执行）。
- 仍不使用向量库：项目现有检索是 JSON 存储 + 进程内搜索，本轮 Prompt 沿用 Markdown 留痕（无新增向量写入需求）。

## 追加交付（第 57 轮之二）：第 1 条 = 好友可见性落在发现层（1C-(a)）

同一句指令「继续项目的完善」之下，按决策备忘的执行顺序（5 → 1 → 8）继续做第 1 条。

- 口径来源：所有者在第 1 条上先答 **C**（人际好友管可见性、AI 分级管能力），再在 (a)/(b) 中选 **(a) 组织目录可搜**。落地前先按设计稿第 3 步做了消费点核对——结论与设计稿的担心一致：`native-chat.test.ts` 与 `friends.test.ts` 里有 4 处断言建立在「联系人返回全组织」之上，`scripts/smoke.mjs` 甚至用联系人找 1:1 对端（不改就会**静默跳过**撤回验收）。
- 改动：`listContacts` 只回「有关系记录或有待处理申请」的人 + AI 账号；`listMembers` 保留为发现入口但 `online` 只给自己与好友（姓名与 roles 有意保留，理由见差距矩阵 §3.20）；`presence` 同样收窄；客户端加目录搜索入口、`peerOf`/群成员名回落目录、新建群候选改用目录。@ 候选在代码里**不存在**（mentions 只用于召唤 AI 账号），设计稿的这条担心没有对应物。
- 验证：新增 `contact-visibility.test.ts` 4 例；改写的 4 处断言逐条说明是**旧口径**而非迁就实现；根套件 54 文件 / 430 用例、web 77 用例、`tsc`/`vue-tsc` 0 错。

| 项 | 值 |
| --- | --- |
| 受影响 package/符号 | `apps/server/src/service.ts`（`listContacts`/`listMembers`/`presence`/`areFriends`）；`apps/web/src/views/ChatView.vue`（目录搜索、`peerOf`、`groupCandidates`、`loadGroupMembers`、`loadDirectory`）；`scripts/smoke.mjs`（对端改取 `/api/members`） |
| 前置权限 | 已认证成员；目录读取仍是成员级（写操作才是组织管理员） |
| 数据分类 | 成员 id、显示名、roles、好友范围内的在线状态；不新增任何外发 |
| 是否外发 | 否（未启动服务、未调用模型；未跑打包后 E2E 与 Electron 检查） |
| 幂等/取消语义 | 不涉及发送与任务状态机；只读接口的可见范围变化，对已存在的会话与消息无回滚要求 |
| 测试 profile | 离线 MockProvider；`contact-visibility.test.ts` 4 例 + 4 处旧断言改写 + web 3 例 |
