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

## 运行态实测（第 57 轮，独立实例）

代码改完后没有停在「测试绿了」：用 tsup 重建 `apps/server/dist`，在 **临时数据目录** 上以 `:8791` 起了**第二个实例**（`:8787` 上正在跑的开发实例没有动，探完即停并删除临时目录），用 HTTP 实测两条新语义：

| 探测 | 结果 |
| --- | --- |
| `GET /api/preferences` | `{agentContextMessages:20, clarifyHistoryLimit:50}`（解析后的部署默认值） |
| `PATCH /api/preferences {agentContextMessages:7}` | 200 → `{7,50}`；随后回读仍是 `{7,50}` |
| `PATCH /api/preferences {agentContextMessages:201}` | **400**（zod 字段错误），且回读没有变化——拒绝确实没有写入 |
| `GET /api/contacts` | 只有自己 + AI 账号（没有关系记录的同事不在联系人里） |
| `GET /api/members` | 全组织成员，且非好友**不带 `online` 字段** |
| `GET /api/presence` | `{online:[]}`（自己之外没有好友时为空） |

边界：这是**同一台机器上的真实构建产物**的 HTTP 证据，不等于 Gate 7A.3（真实 Hermes + 真实模型凭据），也不覆盖浏览器端；web 侧由组件用例与生产构建覆盖。

## 未决与边界

- **第 8 条（唯一 handle）本轮未动代码**：落地方案见 `docs/design-1c-8b-5-2026-09-21.md`；做完后目录搜索要支持按 handle 搜。
- 未运行 Electron 七项、打包后客户端 E2E 或 Gate 7A 自检（本轮改动集中在服务端、契约与 web 视图；如需全量复验按 `docs/handoff-2026-09-18.md` 的「一条命令复现验证」执行）。
- 仍不使用向量库：项目现有检索是 JSON 存储 + 进程内搜索，本轮 Prompt 沿用 Markdown 留痕（无新增向量写入需求）。

## 追加交付（第 57 轮之三）：助手偏好的设置页入口

第 5 条的服务端语义在上一片已生效，但成员当时只能用 API 改；本条补上界面，使「用户可设置」在客户端也成立。

- `apps/web/src/api.ts` 增 `preferences.get/update`；`SettingsView.vue` 增「我的助手偏好」卡片：两个 1–200 的数字输入 + 保存；「当前生效：x / y」只显示**服务端确认过**的值，保存失败时保留旧值并显示错误（不把失败渲染成成功）。
- 验证：`SettingsView.test.ts` +3 例（显示解析后的默认值 20/50；保存两个数字并回报确认值；被拒时不改「当前生效」），web 套件 **80 用例**、`vue-tsc` 0 错、生产构建（vite build）通过。

| 项 | 值 |
| --- | --- |
| 受影响 package/符号 | `apps/web/src/api.ts`（`api.preferences`）、`apps/web/src/views/SettingsView.vue`（卡片与 `loadPreferences`/`savePreferences`） |
| 前置权限 | 已认证成员；接口无成员 id，只能读写自己的 |
| 数据分类 | 两个整数偏好值；页面只显示成员自己的值 |
| 是否外发 | 否 |
| 幂等/取消语义 | 保存是幂等的 PATCH；草稿与服务端确认值分开保存，取消/失败不会留下「看起来生效」的状态 |
| 测试 profile | 组件用例（jsdom + Element Plus），未使用真实服务端 |

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

## 追加交付（第 57 轮之四）：第 8 条 = 组织内唯一的个人 handle

九问的最后一条。按设计稿的四条建议值实现，未临时改口径。

- 契约：`handle` 规则（3–24 字、首字母、字母表、保留词）与 `checkHandle`/`normalizeHandle` 一处定义；`memberHandleSchema` **先规范化再校验形状**，保留词留给服务端判定，这样被拒的请求带的是 `handle_reserved` 这样的原因码而不是一句泛泛的字段错误。
- 存储：`MemberDirectory` 增 handle、改名时间、保留表；`data/members.json` 由裸数组变为 `{members, retiredHandles}` 且**两种形态都能读**；过期保留项在两处（load 与查询）都被丢弃——这是本轮唯一一个由用例抓出来的真实缺陷：先只在 load 判过期，于是「0 天保留」要等重启才生效。
- 服务端：`PATCH /api/auth/handle`（无成员 id = 只能改自己）；组织内唯一 409、保留期 409、冷却 429、格式/保留词 400；老成员在 `GET /api/auth/me` 与 `GET /api/members` 上惰性派生（数字开头或含非法字符的 id 会被修好）。
- 客户端：设置页「我的个人 ID」卡片（当前值来自服务端，被拒时显示服务端原因且当前值不变）；目录搜索同时匹配显示名与 handle，结果行显示 `@handle`。
- 验证：`handles.test.ts` 6 例、`SettingsView.test.ts` +2 例、`ChatView.test.ts` +1 例、根套件 **55 文件 / 436 用例**、web **83 用例**、`tsc`/`vue-tsc` 0 错。

| 项 | 值 |
| --- | --- |
| 受影响 package/符号 | `packages/contracts`（handle 常量与校验、`memberHandleSchema`、`MemberRecord/MemberView.handle`）；`apps/server/src/auth.ts`（`MemberDirectory.setHandle/ensureHandles/isRetired/findByHandle`、存储形态）；`apps/server/src/service.ts`（`setMyHandle`、`ensureOrgHandles`、`toMemberView`）；`apps/server/src/app.ts`；`apps/server/src/config.ts`（两个窗口）；`apps/web/src/api.ts`、`SettingsView.vue`、`ChatView.vue` |
| 前置权限 | 已认证成员；接口无成员 id，只能改自己；handle 不参与任何授权判定 |
| 数据分类 | 展示名与两个时间戳（改名时间、保留到期）；不含凭据；审计只记 `旧->新` |
| 是否外发 | 否 |
| 幂等/取消语义 | 设置同一个 handle 幂等且不消耗冷却；并发下由目录的单点写入串行化；保留项到期自动释放 |
| 测试 profile | 离线 MockProvider；冷却/保留期通过配置置 0 覆盖，不使用真实等待 |

**运行态实测（第 57 轮，独立实例）**：重建 `apps/server/dist` 后，用临时数据目录在 `:8792` 起了第二个实例（`:8787` 未动，探完即停并删除临时目录）实测：新实例 `GET /api/auth/me` 即返回派生 handle `dev-owner`（惰性分配生效）；`PATCH {handle:'Alice.Wang-1'}` → 200 存成 `alice.wang-1`；`admin` → 400 `handle_reserved`；`ab` → 400 schema 字段错误；紧随其后的第二次改名 → 429 `handle_change_cooldown`（带可再次修改的时间）；两次被拒后回读仍是 `alice.wang-1`，`GET /api/members` 也带该 handle。边界同前：真实构建产物的 HTTP 证据，不等于 Gate 7A.3，也不覆盖浏览器端。

## 追加交付（第 57 轮之五）：端到端复验（打包后客户端 E2E 38/38）

本轮动过服务端、契约与两个 web 视图，因此按交接文档第 5 步补上真实客户端复验：重建 `apps/web/dist` 与 `apps/server/dist` → `scripts/restart-server.mjs` 重启开发实例 → `node scripts/ui-e2e.mjs`，结果 **38/38 通过**（含 `view "设置" renders — cards: 8`，即新增两卡片后的界面结构；以及无错误提示、无横向溢出、无文字截断、亮/暗主题对比度、1024×720 布局）。开发实例的进程因此已从「改动前」变为 HEAD 构建——这一点已同步进交接文档，避免下一个人按旧提醒去重启。边界：E2E 覆盖客户端行为与结构，不覆盖服务端语义（由各服务端用例与运行态实测覆盖），也不等于 Gate 7A.3。

## 追加交付（第 57 轮之六）：桌面壳七项回归 86/86

既然本轮动过 web 视图与契约，桌面壳就不能只靠「理论上有测试」：在 HEAD 上复跑 Electron 七项（`electron-lock-check` 18/18、`electron-receipt-sync-check` 21/21、`electron-host-smoke` 6/6、`electron-workbench-check` 13/13、`electron-quit-check` 10/10、`electron-csp-check` 5/5、`electron-nav-check` 13/13），合计 **86/86 通过**，全部退出码 0。七项都不依赖网络与真实模型，因此是可重复的本机回归证据；差距矩阵 §3.23 记录了覆盖点。边界不变：它们不覆盖真实 Hermes 与真实模型凭据（Gate 7A.3），也不覆盖双机局域网与安装包 GUI 人工验收。
