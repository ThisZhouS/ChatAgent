# 产品功能树差距矩阵与实施计划（2026-09-17）

审查基线：`458a41d`（main）。规格来源：`Prompt/2026-09-17-product-decomposition.md`（用户给出的六域功能树，以及「把 agent 与自建聊天工具整合、把 agent 的能力关在笼子里」的总体目标）。

方法：四个只读子代理按域审计现有代码（只用 grep/read，逐条给出行号证据），然后本轮实现其中一个最小切片并验证。**「已有」只表示代码与测试同时存在，不代表本轮重新实测过。**

## 0. 结论

- 成体系的部分：**原生聊天基础设施**（会话/消息/SSE 推送/附件/撤回窗口/未读）、**群聊基础**（建群/邀请/踢人/退群/改名）、**任务与授权骨架**（审批/投递/回执/委托校验/能力下限）、**桌面壳**（关窗常驻/显式退出回收/单写者锁/离线工作台）。
- 缺失或只有半成品的部分：**好友关系与验证**、**消息提醒分级**、**转发署名与原时间**、**图片/表情渲染**、**窗口置顶与隐藏**、**UI 主题与背景**、**Agent 联系人级权限分级**、**关键词钩子**、**群公告/群主权限/解散群**、**断线补差**、**目录外访问授权**。
- 与「笼子」目标直接相关的两条已经落地：**消息投喂闸门**（本轮，见 §3）与既有的**权限硬门**（审批摘要、委托校验、能力下限、工作目录限制）。仍缺的是**工具开关的单一来源**与**被拒绝原因进入提示词**。

## 1. 差距矩阵（按域，节选关键项）

### 1.1 聊天系统

| 功能节点 | 状态 | 证据（文件:行） | 缺口 |
| --- | --- | --- | --- |
| 文件·快速拖入 | 缺失 | 聊天区只有点击选择 `ChatView.vue:1215`；全仓无 ondrop/dataTransfer | 拖文件进聊天窗口没有反应 |
| 文件·选择 | 部分 | `api.ts:257` → `POST /documents/parse` | 只有单文件，且强绑文档解析；pptx/mp4 等被白名单挡掉 |
| 文件·大小 | 已有 | `app.ts:108`（20MiB、files:1）、`documents-upload.test.ts:199` | 硬编码常量，无组织/用户配额 |
| 文件·类型 | 部分 | `app.ts:1441`（扩展名白名单） | 只看扩展名，无 MIME/魔数校验 |
| 文件·安全 | 部分 | `app.ts:341`、`service.ts:1815`、`zip-guard.ts:19` | 无内容扫描；附件数上限 5（`schemas.ts:163`） |
| 消息同步 | 部分 | SSE `app.ts:1317`、逐事件鉴权 `app.ts:1410`、客户端按 id 去重 `ChatView.vue:660` | 断线不补差（无 Last-Event-ID），重连只改状态不重拉 `ChatView.vue:645` |
| 消息队列栈 | 部分 | `events.ts:21`（进程内广播）、`approvals.ts:251`（持久 outbox）、`receipt-sync.cjs:13`（桌面离线队列） | 聊天消息本身没有出站队列与自动重试 |
| 撤回·根源撤回 | 已有 | `service.ts:711`、`service.ts:2424`（清正文与附件）、搜索/预览/模型/导出同步隐藏 | 无管理员/发送者视角的撤回审计入口 |
| 撤回·转发级联 | 部分 | `service.ts:591`（转发=新消息，只有 forwardedFrom） | 撤回源消息不连带撤回副本 |
| 撤回·时间权限 | 已有 | `config.ts:140`（默认 120s）、`service.ts:730` | 全局配置，无按会话/角色的差异化 |
| 转发·消息署名 | 缺失 | `service.ts:605` 写了 forwardedFrom，界面不渲染（`ChatView.vue:1101` 只渲染正文） | 收件人看不到「转发自谁」 |
| 转发·消息时间 | 缺失 | `service.ts:603` 副本用当前时间 | 转发后原始发送时间丢失 |
| 渲染·图片预览 | 缺失 | 附件统一渲染成文件链接 `ChatView.vue:1102` | 图片不能内联预览/放大 |
| 渲染·表情/表情包 | 缺失 | 契约与界面均无（`schemas.ts:146`） | 无表情选择器与贴纸实体 |
| 提醒·弱提醒 | 缺失 | 只有未读徽标 `ChatView.vue:710`；会话契约无 mute 字段 | 不能对某个会话免打扰 |
| 提醒·强提醒 | 缺失 | `ChatView.vue:716` 通知不判 mentions；无公告实体 | 「@我」与普通消息同等提示 |
| 窗口·置顶 | 缺失 | `main.cjs:145` 无 setAlwaysOnTop | 聊天窗口不能置顶 |
| 窗口·隐藏 | 部分 | 关窗常驻托盘 `main.cjs:781`；桥面无 hide 命令 | 没有「隐藏窗口」的可控命令 |

### 1.2 好友系统与群聊系统

| 功能节点 | 状态 | 证据（文件:行） | 缺口 |
| --- | --- | --- | --- |
| 好友添加/删除/验证 | 缺失 | `service.ts:369`（联系人是组织全员 + AI 账号）、`app.ts:605`（只有 GET） | 没有好友关系表，也没有申请-同意流程 |
| 好友拉黑 | 缺失 | `types.ts:64` 无相关字段；全仓无 block/blacklist 命中 | 无拉黑存储，也无投递拦截点 |
| 好友备注 | 缺失 | 同上；全仓无 remark/alias | 不能给联系人设备注名 |
| 好友搜索 | 部分 | `ChatView.vue:69`（前端过滤已加载集合）、`app.ts:607` 无查询参数 | 无服务端按 ID/备注搜索 |
| 个人介绍简介 | 缺失 | `types.ts:64`、`schemas.ts:112` 无 bio 字段 | 成员档案没有简介 |
| 个人 ID 唯一标识 | 已有 | `auth.ts:82`（Map 主键）、`schemas.ts:106`（格式校验） | 只是登录账号，没有对外可分享的个人号 |
| 拉入邀请好友 | 已有 | `service.ts:448`、`service.ts:655`、`app.ts:809`、`native-chat.test.ts:490` | 邀请即入群，无需对方同意 |
| 踢出群聊 | 部分 | `service.ts:628`、`app.ts:782`、`membership-security.test.ts:1505` | 任何成员都能踢任何人 |
| 群聊名称 | 已有 | `service.ts:522`、`app.ts:763`、`membership-security.test.ts:1450` | 改名对全员生效，没有「仅自己可见」的群名 |
| 群内备注 | 缺失 | `types.ts:223`（participantIds 只是 string[]） | 没有成员级备注/别名 |
| 个人昵称 | 缺失 | `service.ts:303`（改成员需组织管理员） | 普通成员不能自改昵称 |
| 群名称备注 | 缺失 | `service.ts:522`（rename 直接广播） | 没有按人隔离的群备注名 |
| 群内公告 | 缺失 | 契约/路由/界面均无公告痕迹 | 无公告存储、接口与展示位 |
| 群管理与权限 | 部分 | `service.ts:535/641/668` 只校验是否参与者 | 没有群主、管理员、禁言等分级 |
| 解散群聊 | 缺失 | `app.ts:782/796` 只有踢人与退群；`stores.ts:241` 无 delete | 无人能解散群，会话永久保留 |
| 群 ID 唯一性 | 部分 | `service.ts:473`（chatId=sha256(成员+标题)）、`stores.ts:347` 判重不含 organizationId | 对外群 ID 是随机 UUID；判重键未按组织隔离 |

### 1.3 Agent / 消息接口 / UI / 服务器

| 功能节点 | 状态 | 证据（文件:行） | 缺口 |
| --- | --- | --- | --- |
| Agent·用户（主权限） | 已有 | `auth.ts:286`、`types.ts:47` | 主权限是服务端派生身份，没有独立配置面 |
| Agent·好友分级（确认/聊天/忽略） | 缺失 | 契约只有 persona/allowlist/ownerId（`types.ts:207`）；全仓无等级命中 | **本轮发现的最关键缺口**：没有按联系人的等级与判定分支 |
| Agent·忽略级硬拒绝 | 缺失 | 入站仅 `canUseAccount`（`service.ts:2026`） | 忽略级没有可以拦截的判定点 |
| Agent·过撤回窗口再投喂 | 缺失 | 旧实现：`service.ts:2135`、`service.ts:869` 发消息即建任务 | 撤回后只能做事后脱敏（本轮已修复，见 §3） |
| Agent·风险与消耗预处理 | 缺失 | `system-prompt.ts` 无相关指令，也没有预处理模块 | 无消息级风险/成本预估与回执 |
| Agent·按权限上报用户 | 部分 | `agent.ts:288/306`、`ApprovalsView.vue:106` | 上报只由外发动作触发，与联系人分级解耦 |
| Agent·用户确认后执行 | 已有 | `agent.ts:306`（未批准零网关调用）、`agent.ts:330`（claim 防重放） | 缺「确认级联系人默认强制」 |
| Agent·先响应再拆分任务 | 部分 | `service.ts:2278` 边跑边发；`service.ts:897` 丢弃 progress | 无子任务拆分，进度不下发到聊天 |
| 接口·群聊 @ | 部分 | `service.ts:857`（mention→任务，最多 3 个） | 没有「该群的 AI 可读上下文长度」配置（buildHistory 原为全量） |
| 接口·无法判断则询问 | 缺失 | waiting_input 只在引擎侧 `task-engine/src/engine.ts:308` | 运行时不会产出澄清提问 |
| 接口·自定义内容钩子 | 缺失 | 检索是子串包含 `stores.ts:459` | 没有正则钩子，也没有窗口读取长度 |
| UI·界面风格 | 部分 | `App.vue:39`（深浅色 + localStorage） | 只有明/暗一键切换，没有风格方案 |
| UI·界面背景 / 指定窗口背景 | 缺失 | `style.css:1`；Conversation 无外观字段 | 用户不可配背景，会话级外观无处存储 |
| 服务器·消息分发与同步 | 已有（推送非轮询） | SSE `app.ts:1317` + 心跳，事件逐条重新鉴权 | 无事件游标（Last-Event-ID） |
| 服务器·消息存储（本地） | 已有（JSON 文件） | `app.ts:118`（accounts/messages/…json）、`stores.ts:42`（防抖合并写） | 无事务与索引，只允许单进程（`security-checklist.md:26`） |

### 1.4 安全笼子（规格第三条）

| 功能节点 | 状态 | 证据（文件:行） | 缺口 |
| --- | --- | --- | --- |
| 工作目录硬限制 | 已有 | `packages/agent-host/src/sandbox.ts:48`、`host.ts:351`、`host.test.ts:314` | 只有单一 workRoot，调用方传入的 workDir 被改写 |
| 目录外访问的权限获取 | 缺失 | `sandbox.ts:54` 命中即抛；全仓无 extraRoot/allowedDirs | 没有单次授权/申请流程 |
| 被拒绝后注入提示词 | 部分（本轮已补规则） | 拒绝分支只写记录 `host.ts:335/352`；规则已加入 `system-prompt.ts` | 拒绝原因仍未回灌到该次运行的上下文 |
| 工具硬代码开关 | 部分 | `host.ts:797`（DOCUMENT/FORBIDDEN）、`adapter.ts:22/75/149` | 两份 FORBIDDEN 列表不一致；side_effect 要到执行期才被适配器拒 |
| 开关与权限注入提示词 | 缺失（本轮已补） | `packages/hermes/src/system-prompt.ts` 新增 OPERATING_RULES | 提示词为辅、代码为主，两者需要同步维护 |
| 权限硬代码控制 | 部分 | `authorization.ts:297`、`host.ts:317`；`service.ts:1501` 只认 approval | 委托没有签发/台账路径（真实部署副作用恒为 delegation_missing） |

## 2. 分阶段计划

以「一条完整闭环」为单位推进，而不是按功能树广度铺开（沿用 `project-driver` 的执行约定）。每条都给出改动点与验收命令。

### P0-1 消息投喂闸门 —— 本轮已实现（见 §3）

### P0-2 Agent 联系人级权限分级（确认级 / 聊天级 / 忽略级）—— 已实现（见 §3.2）

- 目标：员工能按联系人（含 AI 账号）设定等级。`ignore` 在代码层直接拒绝入站、不建任务；`chat` 只允许会话性回复（不产生副作用）；`confirm` 允许规划，但副作用必须走审批；默认等级由配置决定，并把当前等级注入提示词。
- 改动点：`packages/contracts/src/types.ts`（账号/联系人策略字段 + zod `.strict()`）、`packages/contracts/src/schemas.ts`、`apps/server/src/auth.ts`（纯函数 `resolveContactTier`）、`apps/server/src/service.ts`（`service.ts:2026` 附近的入站判定与拒绝点）、`apps/web/src/views/AccountsView.vue`（等级设置）、`packages/hermes/src/system-prompt.ts`（等级作为规则注入）。
- 验收：新增 `apps/server/src/contact-tier.test.ts`：`ignore` → 0 任务且写审计；`chat` → 有回复、无副作用工具调用；`confirm` → 副作用进入审批；契约拒收未知等级。命令：`node node_modules/vitest/vitest.mjs run apps/server/src/contact-tier.test.ts`。

### P0-3 工具开关单一来源 + 拒绝原因回灌 —— 已实现（见 §3.3）

- 目标：`browser/computer_use/cronjob/delegation/homeassistant/spotify` 等被拒工具在任何入口（提交期与执行期）都被拒；把「本次被拒绝的动作与原因」作为一条观察消息交给模型，并声明不可绕过。
- 改动点：抽出 `packages/agent-host/src/policy.ts` 作为唯一的允许/禁止来源（`host.ts:797` 与 `adapter.ts:50` 都改为引用它）、`packages/agent-host/src/host.ts`（拒绝时写 `blockedReason`）、`packages/hermes/src/runtime.ts`（把拒绝记录注入一次）。
- 验收：`packages/agent-host/src/host-security.test.ts` 增加一例 `kind:'side_effect', toolsets:['browser']` → 提交期即 `capability_not_granted`。

### P1-1 断线补差与消息幂等 —— 已实现（见 §3.4）

- 目标：SSE 带事件 id 与游标，重连后按 since 补拉；发送带 `clientMsgId` 幂等键。
- 改动点：`apps/server/src/app.ts:1437`（写 `id:`）、`apps/web/src/views/ChatView.vue:645`（重连重新拉取并去重）、`packages/contracts`（发送输入加幂等键）。
- 验收：`ChatView.test.ts` 的 FakeEventSource 断言重连触发重新拉取；服务端新增「同一个 clientMsgId 只产生一条消息」的用例。

### P1-2 好友关系与验证（最小可用）—— 已实现（见 §3.5）

- 目标：申请 → 同意/拒绝 → 备注 → 拉黑 → 删除，含服务端存储与投递拦截（拉黑后消息不得投递）。
- 改动点：`packages/contracts` 关系模型、`apps/server/src/stores.ts`（关系表）、`apps/server/src/service.ts`（关系用例）、`apps/web`（联系人面板）。
- 验收：新 `apps/server/src/friends.test.ts`：申请→同意→备注→拉黑后投递被拒。

### P1-3 群治理（群主 / 公告 / 解散）—— 已实现（见 §3.6）

- 目标：Conversation 增加 `ownerId`（+ 管理员）；改名/踢人/公告限群主或组织管理员；解散群（存储 + 事件 + 界面）。
- 改动点：`types.ts:223`、`service.ts:500/522/628`、`app.ts:763`、`ChatView.vue:785`。
- 验收：`membership-security.test.ts` 补「普通成员改名/踢人 403」与「公告仅参与者可读」。

### P1-4 消息呈现（转发署名 + 图片预览 + @强提醒 + 免打扰）—— 已实现（见 §3.7）

- 目标：转发气泡显示「转发自 X · 原时间」；图片内联预览；@我 触发强提醒；会话可静音。
- 改动点：`service.ts:605`（存源消息时间）、`ChatView.vue:1081/1102/716`、会话契约加 `muted`。
- 验收：`native-chat.test.ts`（转发署名与时间）+ `ChatView.test.ts`（图片预览、@提醒、静音）。

### P2 其余（按需排期）

文件拖入与类型/魔数校验、关键词正则钩子、澄清提问（waiting_input 打通到聊天）、窗口置顶/隐藏命令（需新增 Electron 检查）、界面风格与背景、表情与贴纸、群成员别名表、事件游标与本地存储演进（SQLite 评估）。

## 3. 已交付切片：消息投喂闸门

- 规则（用户原话）：**一切消息默认在过撤回时间后再交给 agent**。实现：`apps/server/src/agent-intake.ts` 的 `AgentIntakeGate` + 持久队列（`AgentIntakeStore`，落 `data/agent-intake.json`）。
- 链路：发消息 → 立即落库并广播 → **入队**（`dueAt = 现在 + 撤回窗口`）→ 到期 tick 重新读消息 → 已撤回则取消，否则用**窗口化历史**建任务。
- 硬编码边界：没有任何 API 参数、工具或提示词能让消息提前交给 agent（唯一开关是部署配置 `CHATAGENT_AGENT_INTAKE_MODE=immediate`，启用时启动会告警）；撤回会取消**未投喂**的入队项；已投喂的任务不会被撤回撤销（避免静默作废用户已经看到开始的执行）。
- 上下文窗口：`buildHistory` 从「全量会话」改为「最近 N 条」（`CHATAGENT_AGENT_CONTEXT_MESSAGES`，默认 20，范围 1-200），既省 token，也避免远古消息被重新翻出来。
- 提示词侧（为辅）：`packages/hermes/src/system-prompt.ts` 新增 `OPERATING_RULES`：撤回内容不可索要/重建、目录外访问被拒即终局、被关闭的工具不存在、授权由代码判定、被挡住要报告缺失而不是绕路。
- 可见性：`status().intake`（模式/延迟/队列计数）、`/api/agent/status`、SSE `agent_intake` 事件、聊天输入框上方「助手待读：撤回窗口结束后才会交给助手，撤回即取消」。
- 验证：`apps/server/src/agent-intake.test.ts`（9 例：窗口前不投喂、撤回取消、消息已被撤回时丢弃、重启不重放不丢失、失败退避重试、窗口化历史、immediate 模式、状态、停表）、`apps/server/src/agent-intake-wiring.test.ts`（4 例真实 HTTP：排队→到期建任务、窗口内撤回→永不建任务且审计可查、群 @ 撤回取消、状态回报策略）、`apps/web/src/views/ChatView.test.ts`（排队提示文案）。
- 顺带修掉一个真实缺陷：**锁心跳与释放的竞争**。`packages/agent-host/src/store.ts` 的心跳原先允许重叠，而 `releaseLock()` 只 await 最新一次心跳，旧心跳可能在释放之后把锁文件写回（这正是第三方审查 PR-01 观察到的现象）。现改为心跳串行链 + rename 前二次校验；`electron-lock-check` 18/18，全量并行下不再复现。

### 3.2 联系人权限分级（P0-2，同日第二轮）

- 语义：`owner`（账号负责人与组织管理员，派生、不可配置）> `confirm`（默认：可规划与回复，副作用需负责人批准）> `chat`（仅会话与读文档）> `ignore`（消息根本不到助手）。
- 硬编码判定点（三处，都是代码而不是提示词）：
  1. **入站闸门**：`service.ts` 在 1:1 与群 @ 两条路径上先算等级，`ignore` 直接不投喂（消息照常落库与投递给人，写审计 `agent_intake.ignored`，**不告知发送者**——这是负责人的策略）；
  2. **运行时工具面**：`packages/hermes/src/runtime.ts` 新增按次 `allowedTools`，被关掉的工具既不出现在提示词与 provider 的工具表里，模型万一仍点名它也会在执行处被拒（`Tool X is not available in this run`），执行器一次都不会被调用；`chat` 级只保留 `parse_document`；
  3. **API 门**：`POST /api/tasks` 对 `ignore` 级直接 403（`contact_tier_ignored`），聊天不是唯一的入口。
- 数据模型：`AgentAccount.contactTiers`（按成员 ID）+ `defaultTier`，zod 校验（未知等级/超大表直接 400），存储层克隆与迁移都补齐（历史行按 `confirm` 处理，而不是“无限制”）。
- 提示词（辅助）：按次注入一行规则（`tierPromptRule`），说明本次请求来自谁、等级意味着什么。
- 界面：`apps/web/src/components/AccountTierEditor.vue`（账号编辑弹窗内）设置默认等级与逐联系人等级，列表列显示「默认等级（N 人单独设定）」。
- 验证：`apps/server/src/contact-tier.test.ts` 8 例（解析与回退、工具面、HTTP：忽略级不投喂且审计可查、忽略级 API 403、聊天级负责人仍能出文档而联系人不能）、`packages/hermes/src/runtime-allowlist.test.ts` 4 例（不广播 + 执行处拒绝 + 无白名单时不受影响 + 提示词含规则）、`apps/web/src/components/AccountTierEditor.test.ts` 5 例。根套件 37 文件 / 349 用例、web 48 用例、`tsc`/`vue-tsc` 0 错。

### 3.3 工具开关单一来源与边界注入（P0-3）

- 问题（审计发现）：能力名单**存在两份**——`host.ts` 拒 `*`/terminal/code_execution/node/python/shell/custom，`adapter.ts` 拒 terminal/code_execution/**browser**/computer_use/cronjob/delegation/homeassistant/spotify。交集之外的名字可以**过提交门、在执行期才失败**，任务只看到一条不透明的执行器错误。
- 现在只剩一份：`packages/agent-host/src/policy.ts` 是唯一来源（13 个禁止项 + 文档能力下限 + `refusedToolsets()`/`refuseCapabilities()`/`capabilityBrief()`），`host.ts` 与 `adapter.ts` 都从它导入；`adapter.ts` 为兼容仍 re-export 旧名字。
- 拒绝发生在门口：`kind:'side_effect' + toolsets:['browser']` 现在**提交即失败**并带 `blockedReason: capability_not_granted`（attempts 保持 0），不再进入执行器。空名单规则保持 fail-closed（持久化行为空 → 拒绝；省略名单是唯一被接受的简写，且落库时写成显式 `['document']`）。
- 边界进提示词（为辅）：`capabilityBrief(granted)` 由**同一份名单**生成，随本机 Hermes 调用的 goal 一起注入：可用工具集、被关闭的清单、以及「关闭即不存在：不得模拟、不得手写其输出、不得寻找等价路径；缺少能力就停下并报告缺哪一个」。
- 拒绝信息可归因：执行器失败信息区分「switched off: …」与「not a capability: …」，运维与任务卡都能看懂为什么没跑。
- 验证：`policy.test.ts` 5 例（含两份旧名单漂移的 6 个名字逐一在提交期被拒）、`host-security.test.ts` +2 例（提交期拒绝 / 空名与省略名单的区别）、`adapter.test.ts` +1 例（goal 里确实带上了边界文案与关闭清单）与拒绝信息断言。根套件 38 文件 / **358 用例**、Electron 检查（锁 18/18、回执 21/21、冒烟 6/6、工作台 13/13）全绿。

### 3.4 断线补差与消息幂等（P1-1）

- 问题：SSE 只写 `data:`，没有事件 id；客户端重连只把状态改回 open，断线期间的消息只能靠整页刷新找回；发送也没有幂等键，超时重试会多发一条。
- 事件带序号：`NativeEventHub.publish()` 给每个事件分配递增 `seq`，并保留**有界**重放缓冲（默认 500 条，内存不是日志）；`since(afterSeq)` 返回更新的事件。
- 重连即补差：SSE 每条事件写 `id: <seq>`，浏览器重连时自动带上 `Last-Event-ID`（也支持显式 `?since=`），服务端把仍持有的新事件**逐条重新鉴权后**回放——游标不是通行证（测试里非参与者用 `since=0` 什么都拿不到）。
- 客户端兜底：`ChatView` 在重连时重新拉取当前会话的最新一页并按 id 合并（回放与重拉重叠也不会重复气泡），之后刷新会话列表。
- 发送幂等：`nativeMessageSchema` 新增 `clientMsgId`；服务端维护**按（发送者, 会话, key）**的有界、10 分钟 TTL 台账，重试同一个 key 返回首次那条消息（含其 intake/任务），不同 key 仍是新消息。客户端每次发送生成一个 key，失败后重试同一文本会复用该 key。
- 验证：`apps/server/src/event-replay.test.ts` 4 例（hub 序号与有界缓冲、`Last-Event-ID` 回放带 id、回放逐条鉴权、重试同 key 只落一条且不同 key 不受影响）、`ChatView.test.ts` 新增重连补拉一例。根套件 39 文件 / **362 用例**、web 49 用例、`tsc`/`vue-tsc` 0 错。

### 3.5 好友关系与验证（P1-2）

**假设（待确认）**：规格里的「用户好友」按**人际好友（成员↔成员）**实现，与「用户↔AI 账号」的联系人等级（P0-2）分开；拉黑属于聊天域（决定私聊投递），不等价于忽略级。**目录本身不变**：组织通讯录仍然全员可见，好友关系只影响“谁被接受、如何显示、能否私聊”。

- 数据：`data/relations.json`（`RelationStore`，有界）保存申请与「一人一行」的关系（好友、备注、拉黑）。
- 流程：申请 → 只有**被申请人**能同意/拒绝；同意后**双向**建立好友关系（友谊是相互的，单方无法自称好友）；拒绝后可以再申请；同一对成员不会堆叠重复的待处理申请。
- 私密性：备注只属于设置者（对方视图不受影响，也不用于称呼）；拉黑不告知被拉黑者——被拉黑者得到的回答与陌生人一致。
- 投递规则（硬）：被拉黑者的**私聊**被拒绝（403 `blocked_by_recipient`，消息不落库、不投递），且不能再发起好友申请；**群聊不受影响**——否则一个人拉黑就能让整个群对他禁言。
- 界面：联系人卡片显示关系状态（好友/待我确认/待对方确认/已拉黑）与备注名；顶部「好友申请」入口带未处理数量徽标，可直接同意/拒绝；联系人设置里可加好友、改备注、拉黑/解除拉黑。
- 验证：`apps/server/src/friends.test.ts` 6 例（双向好友、仅被申请人可决定、重复申请折叠、拒绝后可再申请、自我申请与跨组织 404、备注私密与非法字段 400、拉黑阻断私聊与申请、解除后恢复、群聊不受影响）+ `ChatView.test.ts` 3 例（申请收件箱与同意、备注与拉黑、加好友走申请）。根套件 40 文件 / **368 用例**、web 52 用例、`tsc`/`vue-tsc` 0 错。

### 3.6 群治理（P1-3）

- 问题（审计）：任何参与者都能改名/踢人；没有群主与管理员；没有公告；不能解散群；群查找键不含组织。
- 群主：建群人成为 `ownerId`（重建同名群不会改变群主，因此「建群」不能用来夺取他人的群）；**管理员**由群主授予（`adminIds`），群主本身不可被降级；组织管理员等同于管理员。
- 权限：改名、发公告、踢人、解散群都需要群主/管理员；**管理员不能踢群主，也不能踢其他管理员**；普通成员一律 403 `group_manager_required`；群主**必须先交接或解散**才能退群（409 `owner_must_transfer`），否则群会失去可管理状态。
- 公告：群主/管理员可设（≤500 字，可清除），所有参与者可见，通过新事件 `conversation_announcement` 实时广播。
- 解散：软删除（`dissolvedAt`）——**历史仍可读，但不能再发消息**（409 `group_dissolved`），也不接受治理操作；重复解散是幂等的。删行会把「说过什么」抹掉，那不是「解散」的含义。
- 群身份：`findByChatId` 增加组织维度（此前忽略组织），同组织的同名同成员群仍然复用（保留原有语义），跨组织即使 chatId 相同也不共享。
- 界面：群内公告横幅（所有人可见）、已解散提示、群成员面板里的公告编辑/发布/清除、设为/取消管理员（群主）、两段式解散确认；非管理者看不到这些控件。
- 验证：`group-governance.test.ts` 6 例（群主/管理员分权与越权 403、管理员不能动群主与其他管理员、群主交接、公告可见性与清除、解散后不可发送但历史可读、幂等解散、组织维度查找）+ `ChatView.test.ts` 2 例（公告横幅与发布/解散流程、非管理者看不到控件）。根套件 41 文件 / **374 用例**、web 54 用例、`tsc`/`vue-tsc` 0 错。

### 3.7 消息呈现与提醒（P1-4）

- 转发来源：转发时把**原作者与原发送时间**写进 `metadata.forwardedFrom.createdAt`（此前只有作者名，且界面完全不渲染），气泡现在显示「转发自 X · 原 <本地时间>」——转发件不能把自己伪装成刚刚写下的内容。
- 图片预览：`image/*`（或没有 mime 但扩展名是图片的）附件在内联缩略图中渲染（`el-image` + `preview-src-list`，可放大），非图片附件仍是文件链接；两者并存，下载路径不变。
- 提醒决策抽成纯函数 `apps/web/src/notifications.ts` 的 `decideNotification()`：窗口可见 / 正是当前会话 / 权限未授予 → 不提醒；**会话免打扰 → 不提醒，但被 @ 时仍然提醒**（被点名不是噪音），标题加 `[@我]` 前缀。
- 会话免打扰：`muted` 存在**每人每会话**的已读状态行上（`ReadStateStore`），接口 `POST /api/conversations/:id/mute`，会话摘要里返回 `muted`；**未读数照常统计**——免打扰只影响提醒，不影响事实。
- 验证：`apps/server/src/presentation.test.ts` 3 例（转发携带原作者与原时间、免打扰只影响本人且未读数照常、未认证 401 与非法载荷 400）+ `apps/web/src/notifications.test.ts` 5 例（普通提醒、当前会话/可见窗口/无权限静默、免打扰静默、**@ 突破免打扰**、纯附件文案）+ `ChatView.test.ts` 3 例（转发署名与时间、图片预览与文件链接并存、免打扰标签与切换）。根套件 42 文件 / **377 用例**、web 62 用例、`tsc`/`vue-tsc` 0 错。

### 3.8 文件发送边界与快速拖入（P2 第一项）

- 问题（审计）：上传只看**扩展名**，不看字节；聊天窗口没有拖入落点。
- 新增 `apps/server/src/file-signature.ts`：按**文件签名**校验声明的扩展名——docx/xlsx/zip 必须是 ZIP 容器、doc/xls 必须是 OLE 复合文档、pdf/png/jpeg/gif/webp 各自签名、csv/txt/md 必须是可读 UTF-8 且不含 NUL。不匹配一律 **415**（`extension_content_mismatch` 等机器可读原因），并写审计 `upload.rejected`（含原因与文件名）。fail-closed：空文件、未知扩展名、无法识别的容器都拒绝，`.exe` 改名成 `.docx` 不再能进入解析器，也不会以「Word 文档」的名义被下载。
- 界面：聊天区支持**拖入单文件**（拖入时显示落点提示），与「附件」按钮走同一条上传路径；客户端先做明显的类型/大小（20MB）检查以免白跑一趟，并提供 `accept` 白名单；多文件拖入直接说明「一次只能一个文件」而不是静默丢弃。**服务端仍然独立校验字节**——前端检查只是体验。
- 验证：`file-signature.test.ts` 5 例（各家族接受、改名拒绝、OOXML 容器不通用、未知容器/空文件/超范围扩展名、文本正反例）+ `documents-upload.test.ts` +2 例（PDF 改名 .docx → 415 且审计与零落库；真 docx/UTF-8 csv 接受、PNG 改名 .txt 拒绝）+ `ChatView.test.ts` +2 例（拖入上传、明显错误本地拒绝且不打扰服务端）。根套件 43 文件 / **384 用例**、web 64 用例、`tsc`/`vue-tsc` 0 错。

### 3.9 窗口置顶与隐藏（P2 第二项）

- 问题（审计）：`main.cjs` 从未调用 `setAlwaysOnTop`，也没有 hide/show 命令；两项都**没有自动验收入口**。
- 主进程：新增 `chatagent:window` IPC（动作是固定动词 `pin`/`unpin`/`toggle-pin`/`hide`/`show`，不接受坐标、路径或窗口 id；发送者仍按既有规则校验），托盘菜单加入「窗口置顶/取消置顶」与「隐藏窗口（后台继续运行）」，标签按**实时状态**生成。
- 状态可核对：`status().window` 返回 `{pinned, visible, focused}`，且 `pinned` 是向窗口本身询问（`isAlwaysOnTop()`）而不是缓存布尔值——操作系统/窗口管理器也能改变置顶，缓存会与会话现实不符。
- 页面侧：`preload.cjs` 暴露 `chatagent.window.set(action)`；聊天头部在**桌面壳内**才显示「窗口置顶/隐藏窗口」按钮，普通浏览器里根本不渲染（`window.chatagent?.window` 不存在），按钮文案跟随主进程回报的状态。
- 验证：**真实 Electron 检查** `electron-nav-check.mjs` 新增 5 项断言（页面可达、置顶后 `pinned:true`、`status().window` 同步、隐藏后 `visible:false`、show/unpin 复原、未知动作被拒），并把桥面白名单更新为包含 `window`（13/13）；`ChatView.test.ts` 新增 1 例（浏览器里不渲染控件、桌面壳里调用并跟随回报状态）。既有 Electron 检查全部复跑通过（锁 18/18、回执 21/21、冒烟 6/6、退出 10/10、CSP 5/5、工作台 13/13）。

### 3.10 自定义内容钩子（P2 第三项）

- 问题（审计）：检索只有子串包含，**没有正则钩子**，也没有「按窗口设置的读取长度」（读取长度已由 P0-1 的上下文窗口解决）。
- 规则：群主/管理员可为群设置**每行一条正则**的内容规则（≤20 条、单条 ≤200 字），命中即召唤本群助手，**无需 @**；被召唤的助手在目标里被告知「由内容规则触发：<命中的规则>」，因此会话记录可解释。
- 与既有不变量一致：钩子走**同一条投喂闸门**（过撤回窗口才投喂、撤回即取消）、同一套**联系人等级**判定（忽略级不会被规则召唤）、同一份审计；**@ 提及优先**于规则，不会因为两者同时命中而重复建任务。
- 安全（正则本身是攻击面）：设置时校验——必须能编译、长度上限、**拒绝嵌套量词/重复选择等灾难性回溯形态**（`(a+)+$`、`(a|aa)+$`、`a{10000}`）；匹配时——只扫描 ≤4000 字的文本、编译结果有界缓存、每条消息 25ms 预算，超出则**跳过剩余规则**（不命中是安全方向），无法编译的规则上报审计 `agent_intake.hook_invalid` 而不抛错。
- 界面：群管理面板新增「内容规则」编辑框（每行一条）与保存按钮，只有管理者可见；非管理者 403 `group_manager_required`，且拒绝不会改变已存规则。
- 验证：`content-hooks.test.ts` 7 例（校验/拒绝形态/列表去重与上限/匹配顺序/空文本与超长文本/无法编译/预算耗尽）+ `content-hooks-wiring.test.ts` 3 例（无规则不召唤→设规则后召唤且目标可解释→删除规则后不再召唤；普通成员 403 与三类非法规则 400 且已存规则不变；@ 与规则同时命中只建一个任务）+ `ChatView.test.ts` 1 例（编辑器读取与保存、空行丢弃）。根套件 45 文件 / **394 用例**、web 66 用例、`tsc`/`vue-tsc` 0 错。

### 3.11 澄清提问打通（P2 第四项）

- 问题（审计）：`waiting_input` 只在任务引擎里存在；Hermes 运行时不会产出澄清提问，服务端也没有把提问发回会话、把回答接回任务的路径。规格「如无法判断，则直接询问」这一环是断的。
- 工具：新增 `ask_user`（无副作用）。它返回 `clarificationRequired.question` 标记；`runTask` 检测到后**把提问作为助手消息发进原会话**（用户有地方回答）、写审计 `task.clarification_requested`，并让任务停在 `waiting_input`。澄清先于审批判定——「缺信息」和「缺权限」是两种等待。
- 回答闭环：请求者在同一会话里的**下一条消息**就是答案——服务端把答案追加进该任务的历史（`TaskEngine.appendInput`，有界）并 `resume`，**不新建任务**（否则助手会在一无所知的情况下重新开始）。其他成员的消息、其他会话的消息都不会被当作答案；一次只允许一个未回答问题（`(account, conversation, requester)` 唯一），避免「这条消息回答的是哪个问题」的歧义。
- 可恢复：问题存在任务里而不是内存里，重启后仍在等待；手动 `POST /api/tasks/:id/resume` 依然可用（不需要发消息）。
- 离线 provider：`MockProvider` 的意图表新增一条——请求里明说「信息不足/请向我确认/澄清」时调用 `ask_user`，这样整条链路在没有模型凭据时也能被验证（生产行为由真实模型决定，不由这张表决定）。
- 验证：`clarification.test.ts` 3 例（提问→等待→答案续跑同一任务且只存在一个任务；他人消息不被当作答案；重复读取不消耗问题且手动 resume 仍可用）。根套件 46 文件 / **397 用例**、`tsc` 0 错。

### 3.12 会话外观（P2 第五项）

**假设（待确认）**：规格的「指定窗口背景」按**会话窗口背景**实现（Electron 窗口背景与主题关系更弱，且真正需要“指定窗口”的通常是某个会话）。

- 数据：`Conversation.appearance = { background?: 预设 id, color?: #rrggbb }`，**闭集**——预设 id 由客户端提供调色板，服务端只存 id；或一个普通十六进制色值（服务端统一转小写）。任何参与者都可设置（它是房间级外观，如同群名，不携带权限也不携带数据）。
- 为什么是闭集：这个值会被**每个客户端渲染**。自由格式的样式串是 CSS 注入面——背景里的 url(...) 能让客户端发出用户从未要求的请求。因此 url(...)、分号拼接、大小写变体、五位色值、多余字段全部 400 拒绝，且拒绝不改变已存值。
- 渲染：预设映射到客户端自己的色值，写成 background（不是 background-image）；深色房间（slate 或亮度低于 128 的自定义色）自动切换房间文字为浅色。**气泡保留自己的实色背景**，因此消息对比度不依赖房间颜色——这也是对比度检查（4.5:1）继续成立的原因。
- 验证：`appearance.test.ts` 3 例（预设与十六进制往返且可见于所有参与者、清除恢复默认；六类非法载荷全部 400 且零落库；非参与者 404）+ `ChatView.test.ts` 2 例（应用预设并发送所选、深色房间切浅色文字且气泡不受影响）。根套件 47 文件 / **400 用例**、web 68 用例、`tsc`/`vue-tsc` 0 错。

### 3.13 会话别名（P2 第六项）

**假设（待确认）**：规格的「群内备注 / 个人昵称 / 群名称备注」按**每群一张别名表**实现，且是**查看者私有**的（存在该查看者自己的已读行上）——这样谁也不能给别人改名，也没有人知道别人怎么称呼自己。

- 数据：`conversationAliases[viewerId][conversationId] = { title?, members?: { memberId: label } }`，随 `status`/会话摘要以 `aliases` 返回（只返回调用者自己的）。`title` 覆盖该查看者看到的会话名（`titleOf` 优先用它），`members` 覆盖气泡里的发送者名与联系人列表里的显示名，也包含「我在本群的昵称」。
- 校验：标签 ≤32 字、整表 ≤200 项、多余字段拒绝；**只能给本会话成员起别名**（否则是无法渲染的孤儿标签）；空串即清除（「没有别名」只有一种表示）；非参与者 404。
- 验证：`aliases.test.ts` 3 例（往返且对本人可见、对他人不可见且真实群名不变；空串清除与外部成员 400/非参与者 404；超长/多余字段/超量 400）+ `ChatView.test.ts` 2 例（侧栏与气泡用私有标签、保存调用与载荷）。根套件 48 文件 / **403 用例**、web 70 用例、`tsc`/`vue-tsc` 0 错。

### 3.14 事件游标与存储决策（P2 第七项）

- **存储决策已落文档**：新增 `docs/adr-0004-storage-and-event-cursor.md`，结论是**继续用 JSON 文件存储**（内网单机、备份即复制目录、写入已具备原子替换/fsync/单写者锁），并写出**迁移触发条件**（单组织消息 > 200k 条或 > 100MB；任一 store 写入 p95 > 200ms；需要跨实体原子操作；出现多实例需求）与迁移路径（store 已是端口，替换实现即可；SQLite 需先验证 Windows 打包 ABI）。已知代价写明：无跨 store 事务（靠顺序 + 幂等兜底）、全量重写随历史增长、无查询能力。
- **游标缺陷修复**：回放缓冲是内存的，重启即空。旧实现对一个已是旧游标的 `since` 返回**空列表**，客户端会合理地相信“离线期间什么都没发生”，于是永久少一段消息——这是会静默丢内容的缺陷。现在 `since()` 返回 `{ entries, truncated }`：游标早于仍持有范围，或缓冲为空而客户端声称看过事件（说明缓冲被重启重置）时 `truncated = true`；SSE 在回放前先发 `event: resync`（`reason: cursor_expired`），客户端收到即重载当前会话与会话列表（复用既有重连补拉）。
- **为什么不落盘事件日志**：那等于再实现一份消息表，而消息表已是权威来源；游标过期时重读权威来源更简单，也不会出现两份历史不一致。
- 验证：`cursor-expiry.test.ts` 3 例（hub 截断判定含“空缓冲但客户端声称看过事件”这一重启情形、HTTP 上旧游标先收 resync 而新连接不收、空缓冲 + 游标 0 不误报截断）+ `event-replay.test.ts` 更新为断言 `truncated` + `ChatView.test.ts` 1 例（收到 resync 即重拉）。根套件 49 文件 / **406 用例**、web 71 用例、`tsc`/`vue-tsc` 0 错。

## 4. 需要产品确认的语义（审计不确定项汇总）

1. 「用户好友」分级指的是人际好友（成员↔成员），还是「用户↔AI 账号」关系？现有契约只有联系人列表与 `agentIds`。
2. 「拉黑」属于聊天域还是 Agent 权限域（是否等价于忽略级）？
3. 「转发撤回」是否要求级联撤回所有副本？（当前设计：各自撤回自己的副本）
4. 「公告」是群公告还是系统公告？
5. 「消息队列栈」的目标粒度：服务端 MQ、客户端离线队列，还是两者都要？
6. 「文件安全」是否要求内容扫描/杀毒？（当前只有扩展名白名单 + zip 炸弹限额）
7. 「指定窗口背景」是会话窗口还是 Electron 窗口？
8. 「个人 ID 唯一标识」是否指对外可分享、可用于加好友的个人号（区别于登录 member id）？
9. 目录外访问授权是「单次人工确认某个目录」，还是仅指 workRoot 配置项？

## 5. 残留风险与未验证边界

- 本轮所有验证都是本地单机、无真实模型凭据：「风险与消耗预处理」「意图不明则询问」这类模型行为无法端到端验证（Gate 7A.3 未开始）。
- 窗口置顶/隐藏位于 Electron 主进程，现有自动化（root vitest + Electron 检查）没有对应入口，需要新增检查脚本。
- `docs/requirements.md` 与 `docs/project-brief.md` 仍是旧口径（以 IM 平台/Webhook 为主，brief 正文还留着「仓库当前为空」的历史描述），与本功能树的产品方向存在漂移，建议按功能树重建需求基线。