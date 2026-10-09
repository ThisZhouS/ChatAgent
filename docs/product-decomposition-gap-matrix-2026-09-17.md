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

### 3.15 表情与贴纸（P2 第八项）

- 表情：composer 增加表情选择器，插入的是**普通字符**（不改消息类型、不改服务端），因此没有新的注入面。
- 贴纸：**闭集目录**（`STICKER_IDS = ok/thanks/question/done/wait/cheer`，定义在 contracts）。消息只携带 id（`ChatMessage.sticker`），每个客户端用自己的内置资源渲染；**未知 id 由服务端 400 拒绝**（`sticker: 'data:image/svg+xml,<svg onload=…>'` 这类载荷进不来），客户端遇到不认识的 id 也只是不渲染徽章，不会去取任何远程内容。
- 语义：贴纸是一条**独立消息**（无需文本与附件即可发送，服务端把「text/attachments/sticker 至少有一个」作为校验），可以与文本并存（“谢谢 + 辛苦了”）；会话预览按图片类型显示。
- 界面：贴纸在气泡里渲染为「大表情 + 标签」的徽章，不加载外部图片。
- 验证：`stickers.test.ts` 2 例（目录内贴纸可作为独立消息存储并在预览中出现；目录外 id 400 且零落库、空消息仍 400、贴纸与文本可并存）+ `ChatView.test.ts` 2 例（贴纸徽章渲染与即时发送、表情插入只改草稿不发送）。根套件 50 文件 / **408 用例**、web 73 用例、`tsc`/`vue-tsc` 0 错。

### 3.16 投喂重试预算与失败可见性（补 P0-1 的收尾）

- 问题：投喂失败原本是「指数退避、永不放弃」。环境坏了（没配模型凭据、工作目录被锁、队列满）时请求永远停在排队——发送者看不到答复也看不到原因，助手看起来像在无视他，运维也没有任何计数可查。
- 实现：每条入队项带 `maxAttempts`（默认 8，可用 `CHATAGENT_AGENT_INTAKE_MAX_ATTEMPTS` 调 1-100，默认退避累计约 10 分钟）；预算用尽后置 **终态** `failed`（不再重试，行仍保留可查），同时向会话发 `agent_intake` 事件（`reason: retry_exhausted` + 已尝试次数），`GET /api/agent/status` 增加 `failed`/`stalled`/`maxAttempts` 计数，审计写 `agent_intake.failed`。
- 边界（不许被误读）：**等待撤回窗口不算失败、不消耗预算**——只有真正尝试过并抛错才计数；`failed` 之前的状态语义（pending/submitted/cancelled）全部不变；重试期间失败过一次的行计 `stalled`，供运维判断「队列在卡」。
- 安全：会话只拿到**闭集原因码与次数**，原始错误文本不出现在任何客户端可见事件里（只留在服务端日志与运维状态面），审计 detail 也只写原因码与次数。
- 验证：`agent-intake.test.ts` +2 例（预算耗尽→`failed` 且终态不再被拾取、事件与状态计数正确、事件 JSON 不含原始错误；撤回窗口等待不消耗预算、`stalled` 计数与非终态退避仍可用）；`ChatView.test.ts` +1 例（SSE 报失败时提示「已重试 N 次，请稍后重发」）。根套件 50 文件 / **410 用例**、web 74 用例、`tsc`/`vue-tsc` 0 错。

### 3.17 转发级联撤回（产品决定 3B，2026-09-21 确认后实现）

- 背景：原先撤回只作用于原文，转发副本继续可读——「我已经撤回了」与事实不符。所有者确认选择 **B：级联撤回所有转发副本**。
- 实现：`recallMessage` 标记原文后，按**来源**（`metadata.forwardedFrom.messageId`）找出仍在的副本（**可能在别的会话**），逐个标记撤回、取消其未投喂的投喂项、广播 `message_recalled`，并写审计 `message.recall_cascade`（detail `forwards:N`）；副本若已被其自身发送者撤回则不重复处理。
- 不变量保持：只有**原文发送者**能发起（他人仍 403 `sender_only`）；撤回窗口仍按原文判定；副本行保留在存储里可审计，但所有读取路径不再返回正文；不递归（副本没有更深一层）。
- 验证：新增 `recall-cascade.test.ts` **3 例**（跨会话副本被级联撤回且正文被清空；副本已被自身发送者撤回时不重复处理；非发送者仍 403）；根套件 **51 文件 / 413 用例**、`tsc` 0 错。**线上实测**：运行实例上撤回原文后，另一会话里的副本 `recalledAt` 已置位、正文为空（首次实测失败是因为服务端仍在跑改动前的构建，重新构建并重启后通过——记录在此以免后人重踩）。
### 3.18 管理员预置的允许目录（产品决定 9C，2026-09-21 确认后实现）

- 语义：所有者选的是 **C：管理员预置允许目录白名单**（不是「按任务审批的临时放行」），所以它是**配置**，不是每个任务一个开关。
- 实现：`assertInsideWorkRoot(root, candidate, grantedRoots)` 先判工作根，未命中再逐个判授权根；授权根同样先做 `realpath`，因此指向别处的软链接不会意外扩大范围；**空白条目被跳过**（否则 `resolve('')` 等于进程工作目录）；判定仍是「是否在目录内」，前缀相似不算（`shared-evil` 不会被 `shared` 放行）。
- 宿主与配置：`LocalAgentHost` 新增 `grantedWorkRoots`（默认空 = 与改动前完全一致），桌面主进程从 `CHATAGENT_AGENT_GRANTED_ROOTS` 读取（按平台路径分隔符切分）。
- 验证：新增 `workdir-grant.test.ts` **4 例**（授权目录放行而其它仍拒绝、授权根内 `..` 逃逸仍拒绝、前缀相似目录不放行、空白授权被忽略、软链接先解析）；根套件 **52 文件 / 417 用例**、`tsc` 0 错；`gate7a-verify` **21 passed / 0 failed / 1 blocked**（Flow8 仍缺真实 Hermes 运行时），其中 **Flow6「工作目录逃逸被拒绝」仍然 PASS**——这是放开一条不变量后最关键的一条回归证据；Electron 宿主冒烟 **6/6**（含「产物落在工作根内」与「重启后仍可读」）。
- 仍未做：授权根的**使用**没有单独的审计行（任务记录里已有 `workDir`，但不会标注用了哪条授权）。若要，下一步给宿主加审计回调。

### 3.19 队列栈粒度改为每人一份（产品决定 5，2026-09-22 实现）

- 语义：所有者对第 5 条（「队列栈」粒度）的答复是「用户设置」，据此定案为**每个成员自己的一份**——不是每个 AI 账号一份（那是我的建议 A，被原话覆盖），也不是继续写死的部署默认。
- 契约：新增 `MemberPreferences{ agentContextMessages, clarifyHistoryLimit }` 与 `memberPreferencesSchema`（`.strict()`、1–200 整数、**空 patch 拒绝**）。越界一律 **400 而不是静默夹紧**：夹紧会让「设了但没生效」看起来像生效。
- 存储：新增 `MemberPreferencesStore`（`data/member-preferences.json`，Map + `JsonFileWriter`，模板沿用 `ReadStateStore`），**只存显式改过的字段**。未设置的字段在读取时回落到部署默认值，因此调整 `CHATAGENT_AGENT_CONTEXT_MESSAGES` 仍会影响所有没设过的人；把默认值抄进每一行等于把昨天的数字冻在成员身上。
- 接口：`GET/PATCH /api/preferences`。两条路由都**不接受成员 id**——「只能改自己」是结构性的，而不是一处可能被忘记的授权判断；PATCH 写审计 `member.preferences_updated`，detail 记录改动前后（回答「我的助手怎么突然读得少了」这类问题）。
- 生效点（这才是功能所在，两处）：① **入队上下文**：`AgentIntakeGate` 新增 `contextLimitFor(requesterId)`，投喂时按请求者取覆盖值，缺失 / 查不到 / 越界都回落到配置默认；② **澄清追加**：`appendInput(..., { limit })` 改用请求者的 `clarifyHistoryLimit`（缺省仍是引擎的 50）。
- 验证：新增 `preferences.test.ts` **6 例**（默认值可读；单字段改动不影响另一项且不影响他人；0/201/5.5/字符串/空 patch/带 `memberId` 的 patch 全部 400 且什么都没存；重启后仍在；**入队只带 3 条**且更旧的消息确实被切掉、未设置的成员仍是部署默认；**澄清后历史被切到 2 条**且最后一条是这条回答）；`agent-intake.test.ts` **+3 例**（按请求者取窗口、越界夹回 1–200、偏好读取抛错时仍以默认投喂而不是不回话）。根套件 **53 文件 / 426 用例全绿**、`tsc` 0 错。
- **客户端入口（同日补齐）**：设置页新增「我的助手偏好」卡片——两个 1–200 的数字、保存按钮、以及由**服务端确认**的「当前生效：x / y」（保存失败时保留旧值并显示错误，因为一个看起来生效的失败保存比报错更糟）。证据：`SettingsView.test.ts` +3 例（显示解析后的默认值、保存两个数字并回报确认值、被拒时不改「当前生效」），web 套件 **80 用例**、`vue-tsc` 0 错、生产构建通过。至此本条在服务端与客户端都成立。

### 3.20 好友可见性落在发现层（产品决定 1C-(a)，2026-09-22 实现）

- 口径：所有者选 **(a) 组织目录可搜**（`docs/decision-memo-nine-questions-2026-09-21.md`）。可见性作用于**发现层**，不作用于**沟通层**——「非好友不能开单聊」那次试做让 10 文件 / 35 用例失败并回退，说明后者改的是沟通模型。
- 服务端（三个落点）：
  - `listContacts`（`GET /api/contacts`）只返回**有关系记录的人**：好友、任一方向的待处理申请、被拉黑或起过私有备注的人，外加 AI 账号。判据是存储层的**关系行或待处理申请**，不是渲染出来的 `state`——备注/拉黑本身也是关系记录，否则「你给某人起的备注」将永远无法再被编辑或撤销。
  - `listMembers`（`GET /api/members`）保留为**发现入口**：整个组织仍可列出、可按姓名搜索，但 `online` 只对自己与好友出现。**姓名与 roles 对所有人保留**（这是对原方案「只回最小字段」的一处有意偏离）：`MembersView` 管理台就从这个接口读 roles，剥掉会让管理员看不到成员角色；在线状态才是这次要收的那条信息。
  - `presence`（`GET /api/presence`）同样收窄到**自己与好友**。只收窄联系人列表而放着这个接口不动等于没做：同一个问题（「这位同事在不在工位」）仍然有答案。
- 客户端：联系人卡片新增「搜索组织目录（添加同事）」输入框，结果只显示姓名 + 「加好友」，**不显示状态**；`peerOf` 与群成员名解析回落到目录（与没有加好友的同事的单聊仍要显示姓名而不是 id）；新建群的成员候选改为目录（否则拉群也被友谊卡住）；@ 候选**不存在**——客户端的 mentions 只用于召唤 AI 账号（核对结果，设计稿里那条担心代码里没有对应物）。
- 验证：新增 `contact-visibility.test.ts` **4 例**（无关系者：不在联系人里、在目录里、发申请后双方可见、接受后是好友；备注/拉黑后仍可见因而可撤销；presence 只给自己与好友而目录对陌生人无 `online`；**非好友的单聊与群聊照常可用**——这条正是被打回过的那个语义，回归钉死）。改到 4 个既有用例，都是**编码了旧「全组织可见」假设**的断言：`native-chat.test.ts` 的「联系人包含同事 Bob」与 presence 用例、`friends.test.ts` 的「拒绝申请后关系为 none」（现在应为**不在联系人里**）。`scripts/smoke.mjs` 的 1:1 对端改从 `/api/members` 取，否则一旦没有好友，那段撤回验收会被**静默跳过**。根套件 **54 文件 / 430 用例**、web **77 用例**、`tsc`/`vue-tsc` 0 错。
- 仍未做：`docs/gate6-access-control-fixes.md` P4 那句「`/api/members` 同样填充 online」是旧口径，已被本条取代（该文件是历史记录，保留原文）；`8B` 唯一 handle 之后要让目录搜索支持按 handle 搜。

**运行态实测（2026-09-22，独立实例）**：`node ../../node_modules/tsup/dist/cli-default.js` 重建 `apps/server/dist` 后，用**临时数据目录**在 `:8791` 起了第二个实例（不动开发实例 `:8787`，探完即停并删除临时目录），实测：`GET /api/preferences` → `{agentContextMessages:20, clarifyHistoryLimit:50}`；`PATCH {agentContextMessages:7}` → 200 `{7,50}`；`PATCH {agentContextMessages:201}` → **400**（zod 字段错误，回读仍是 `{7,50}`，说明拒绝确实没写入）；`GET /api/contacts` → 只有自己与 AI 账号（陌生人不在联系人里）；`GET /api/members` → 全组织成员且**非好友没有 `online` 字段**；`GET /api/presence` → `{online:[]}`（没有好友时为空）。这些是**同一台机器上真实构建产物**的 HTTP 证据，不等于 Gate 7A.3，也不覆盖浏览器端（web 侧由组件用例与生产构建覆盖）。

### 3.21 个人 ID（唯一 handle，产品决定 8B，2026-09-22 实现）

- 口径：所有者选 **B（可自定义、可搜索的唯一 handle）**，按设计稿的四条建议值落地；这是九问里的最后一条。
- 规则（契约里一处定义，客户端与服务端共用）：`[a-z0-9._-]`、3–24 字、**首字符必须是字母**、保留词拒绝（`ai`/`admin`/`owner`/`system`/`everyone` 等 17 个）；**先规范化再校验**（`Alice.Wang` → `alice.wang`），因为句柄本来就是大小写不敏感的，拒绝一个可以顺手规范化的输入只是无谓摩擦。
- 唯一性与防冒充：组织内唯一（**409 `handle_taken`**）；改名后旧名字进入**保留期**（默认 90 天，`CHATAGENT_HANDLE_RETENTION_DAYS`），期间**别人**拿到它是 **409 `handle_retired`**，但本人可以随时拿回自己的旧名；保留期到期后自动释放（`isRetired` 与 load 两处都判过期，所以 0 天保留是真的立刻放开，而不是等重启）。
- 改名冷却：默认 30 天（`CHATAGENT_HANDLE_CHANGE_COOLDOWN_DAYS`，0 表示关闭），冷却内改名 **429 `handle_change_cooldown`**，错误信息带上可以再次修改的时间；**首次分配不算改名**（老成员不会被自己的初始名锁住）。
- 老成员惰性分配：`MemberDirectory.ensureHandles` 在 `GET /api/auth/me` 与 `GET /api/members` 上触发，从成员 id（必要时用显示名）派生一个合法且未被占用的名字；id 以数字开头或含非法字符时会被修好（用例用 `7carol!x` 钉住）。**没有单独的迁移步骤**，因此也没有「忘了跑迁移」这种状态。
- 接口：`PATCH /api/auth/handle`，**请求里没有成员 id**——「只能改自己」是结构性的；审计写 `member.handle_set`（detail 只记 `旧->新`）。目录（`GET /api/members`）与联系人里都带 handle，前端目录搜索同时匹配显示名与 handle，结果行显示 `@handle`。
- 存储：`data/members.json` 由「裸数组」变为 `{members, retiredHandles}`，**两种形态都能读**（老部署原样读入，下一次写入时改成新形态）；过期保留项在读取时被丢弃，文件不会随着改名史无限增长。
- **运行态实测（2026-09-22，独立实例 `:8792` + 临时数据目录，探完即停并删除）**：全新实例上 `GET /api/auth/me` 直接返回派生 handle `dev-owner`（惰性分配真的在跑）；`PATCH {handle:'Alice.Wang-1'}` → 200 且存成 `alice.wang-1`；保留词 `admin` → **400 `handle_reserved`**；太短的 `ab` → 400（schema 字段错误）；紧接着的第二次改名 → **429 `handle_change_cooldown`**，消息带上可再次修改的时间 `2026-10-22T…`；两次被拒之后 `GET /api/auth/me` 仍是 `alice.wang-1`（拒绝确实没写入），`GET /api/members` 也带上了该 handle。
- 验证：新增 `handles.test.ts` **6 例**（派生与幂等、设置后全组织可见、格式/保留词拒绝且不落库、跨大小写重名 409、冷却 429 且 0 天时放行、旧名保留期内他人 409 而本人可取回且 0 天保留即刻释放）；web 侧 `SettingsView.test.ts` +2 例（显示服务端确认的当前 handle 并保存、被拒时显示服务端原因且当前值不变）与 `ChatView.test.ts` +1 例（按 handle 搜到同事）；根套件 **55 文件 / 436 用例**、web **83 用例**、`tsc`/`vue-tsc` 0 错。


### 3.22 第 57 轮的端到端复验（打包后客户端 E2E，2026-09-22）

本轮改了服务端、契约与两个 web 视图（联系人卡片、设置页），所以按交接文档第 5 步做了真实客户端复验，而不是只停在组件用例：

- 按 HEAD 重建 `apps/web/dist` 与 `apps/server/dist`，用 `scripts/restart-server.mjs` 重启开发实例（`:8787`，本次重启顺带让上一节记录的新接口真正上线），再跑 `scripts/ui-e2e.mjs`。
- 结果：**38/38 全部通过**（真实 Electron 客户端 + 重建的 web 包）。其中与本轮直接相关的几条：`view "设置" renders — cards: 8`（新增「我的个人助手偏好」与「我的个人 ID」两张卡片后，卡片数由 6 变 8）、`view "成员" renders`、`no error toasts visible`、`no horizontal page overflow`、`no clipped text in bubbles or sidebar`、亮/暗主题对比度 ≥ 4.5、1024×720 布局保持。
- 边界：E2E 覆盖的是客户端行为与界面结构，**不覆盖** handle 的唯一性/冷却、偏好越界 400 这类服务端语义（那些由 `handles.test.ts`、`preferences.test.ts` 与运行态实测覆盖）；也不等于 Gate 7A.3。

### 3.23 第 57 轮的两条可重复验证（2026-09-22）

**运行态边界自检**：在 HEAD 构建的开发实例上复跑 `node scripts/live-boundary-check.mjs` → **7/7，退出码 0**（健康、回环开发主体注入、认不出的凭据 401、投喂预算字段、审批带 digest、非参与者发送 403、字节与扩展名不符 415）。脚本本身也打印「这只是运行态行为，不是 Gate 7A.3」。

**桌面壳回归（Electron 七项）**

本轮改过 web 视图与契约类型，桌面壳也要证明没被牵连。七项全部在 HEAD 上复跑，**全部通过**（共 86 项检查）：

| 检查 | 结果 |
| --- | --- |
| `node scripts/electron-lock-check.mjs` | **18/18** |
| `node scripts/electron-receipt-sync-check.mjs` | **21/21** |
| `electron scripts/electron-host-smoke.cjs` | **6/6** |
| `electron scripts/electron-workbench-check.cjs` | **13/13** |
| `electron scripts/electron-quit-check.mjs` | **10/10** |
| `electron scripts/electron-csp-check.mjs` | **5/5** |
| `electron scripts/electron-nav-check.mjs` | **13/13** |

覆盖到的关键点（来自脚本自身的断言名）：本机任务库的单写者锁、回执同步的分级退避、宿主冒烟含「产物落在工作根内」与「重启后仍可读」、工作台在断网时的保留/授权/回执提示、退出后任务终态仍落盘、CSP 注入与不覆盖服务端策略、页面桥只有固定动词且跨源跳转被拦。七项都不依赖网络与真实模型，因此它们能在本机作为**回归证据**重复执行。

### 3.24 保留策略的逐条留痕（第 240 行「下一轮建议」第 7 条第 4 项，2026-09-22 实现）

**问题**（第四轮复核记录）：保留策略此前只上报「本次运行已清理 N 条」这样一个内存计数，被清掉的具体 taskId 无从追溯；当时的结论是「如果审计需要逐条追溯，应落审计而非界面」。

**做法**（三处，都在本机、不经过服务端）

1. `packages/agent-host/src/retention.ts`：新增 `selectExpiredRecordsDetailed()`，为每条被淘汰记录返回 `{taskId, state, reason: 'age' | 'count', updatedAt}`；原 `selectExpiredRecords()` 改成它的 id 投影，既有调用点与用例语义不变。**每条记录带自己的原因**，不把「这一批为什么被清」笼统记成一种。
2. `packages/agent-host/src/store.ts`：新增逐条审计落盘 `<tasks.json>.retention-audit.jsonl`（与既有的 `.lock-audit.jsonl` 同一形态），**默认开启**、可用 `retentionAudit: false` 关闭或改路径；每次写入成功后的淘汰批次追加一行 JSON（`action: task_store.pruned`、`actor: local-host`、`reason`、`count`、`tasks[]`）。审计文件写失败**不让调用方的任务写入失败**（记账问题不该拖垮任务库），但失败会被计数并在 `retentionStats()` 与 `status().storeIntegrity.retentionAuditFailures/lastAuditError` 上报，主进程另打一行 `console.error`。
3. 顺手修掉一个真实缺陷：淘汰计数原本在 `persist()` **之前**自增，写入失败回滚记录后计数不回退，于是「本次运行已清理 N 条」会多报。现在计数与审计都只在写入成功后发生（用例钉死）。

**边界**：id 列表只进审计文件，界面继续只说「N 条」（产品在第四轮已定：逐条追溯落审计，不落界面）；`interrupted`（可重试）与进行中的行依旧永不淘汰；载入只报告不改写文件的既有语义未变。

**证据**：`retention.test.ts` 8 → **15 例**（新增：明细原因与 id 投影一致、审计逐条含 state/reason/updatedAt 且不含未淘汰的排队任务、age 与 count 可在同一份trail 区分、被拒写入不写审计且计数为 0、审计路径不可写时任务写入照常成功且失败被计数、显式关闭后不产生审计文件、非终态永不被标注原因）；根套件 **55 文件 / 443 用例**、`tsc` 0 错；真实 Electron `electron-workbench-check.cjs` **13 → 16 项**（520 条终态记录种子下：审计文件存在且每行结构正确、审计里的 id 条数与 `status().storeIntegrity.pruned` **逐条相等**、被清理的 id 只进文件不进页面），退出码 0。

**桌面壳整体回归**：本轮改的是宿主包（`packages/agent-host`），而桌面壳直接 `require` 它的 bundle，所以七项在 HEAD 上全部复跑，**89/89、全部退出码 0**：lock **18/18**、receipt-sync **21/21**、host-smoke **6/6**、workbench **16/16**、quit **10/10**、csp **5/5**、nav **13/13**。运行方式必须按 §3.23 表格左列：`electron-lock-check.mjs` 与 `electron-receipt-sync-check.mjs` 用 `node` 跑（脚本内部用 `process.execPath` 派生「存活的无关进程」「已死进程」，用 electron 跑会让它变成 electron.exe 并卡住），其余五个必须用 `electron` 跑。

**已知缺口（本轮有意不做）**：审计文件本身是**只追加、不轮转**的——每次「已满后接受一次写入」通常追加一行，一台每天几百个任务的设备长期运行会让它线性增长（相对任务库的 500 条上限，这是唯一还在长的文件）。旋转需要先定策略（按天/按大小的保留窗口、截断动作自身要不要写meta行、崩溃安全的截断方式），属于要产品口径的决定，因此记进 `docs/tasks.md` 的候选，而不是先塞一个半成品。**→ 已于第 59 轮实现，见 §3.25。**

### 3.25 第 59 轮：三处由「基线跑出两个失败用例」牵出来的真实缺陷 + 审计文件自己的预算（2026-09-30）

本轮起点不是功能清单，而是**基线测量**：根套件在干净 HEAD 上并不是 57/57 全绿——首跑 2 文件失败（`lock-takeover` 稳定失败、`membership-security` 之一为竞态），复跑失败文件换成了 `host-security-verify`。三个失败用例分别指向三处真实问题，逐个定位后连同审计文件的增长治理一起收口。

**1. 锁心跳的最终归属校验用了 mtime，粒度不足（真缺陷）**
`store.ts` 的 beat 在提交（rename）前用 `stat().mtimeMs` 比较「文件是否被改过」。Windows/NTFS 的时间戳粒度约 15ms（且两次写入可能拿到同一个戳），所以在这一个 tick 内落地的**外来锁会被漏检**，随后 rename 会把它覆盖掉——等于第二个写者被静默接替。改为**比较锁内容**（pid + 本次获取的 token）：不变量是「文件还是我们的」，而不是「字节没变」，因此自己下一次 beat 落地不会被误判。~~`host-security-verify.test.ts` 的 lostReason 断言随之更新（`taken over while heartbeating`）~~ **订正（第 61 轮）**：那处断言其实匹配不到提交点分支——测试在 `refreshLock()` 之前就写好外来锁，读到的是**读时**检查（`held by pid`），提交点检查从未被走到；把提交点改回 mtime 比较，套件照样全绿。第 61 轮补了确定性用例（`beforeLockCommit` 测试缝 + 两个文件同一时间戳），并用变异验证：改回 mtime 时该用例失败（`held: true`）。

**2. 心跳把「读不到锁文件」当成「锁没了」（真缺陷，独立复核提出）**
改成读文件后，`readFile` 的瞬时失败（杀毒/备份占用导致 EBUSY/EPERM）会被当成「文件消失」→ `loseLock()` 永久退出持有。现在**只有 ENOENT 才算消失**，其他读取失败计一次 `heartbeatFailures` 并跳过本次 beat（与 `stat` 时代的行为一致）。顺带修掉一个潜伏问题：`refreshLock()` 直接调 beat、绕过串行链，而所有 beat 共用同一个 `.beat` 临时文件，两个并发 beat 可能发布截断的锁载荷；现在 `refreshLock()` 走与定时器相同的串行链。

**3. `AuditLog` 首条记录可能永久丢失（真缺陷）**
`apps/server/src/audit.ts` 用 `ready` 标志缓存「数据目录已建」——但 `mkdir` 与 `appendFile` 是两次 await，第一条 append 若在目录建好前失败，标志已经置位，**此后整个进程的审计行全部静默失败**（服务端审计从头就是空的）。改成每次 append 都 `mkdir`（已存在时为 no-op）；新增 `apps/server/src/audit.test.ts` 4 例（目录不存在时首条落盘、进程中途目录被删后仍能续写、sink 不可写时不打断请求路径且不抛、按序追加）。

**4. 三处「读审计文件」的测试竞态**
`membership-security` / `security-hardening` / `agent-intake-wiring` / `contact-tier` 里 8 处 `readFile(dataDir/audit.jsonl)` 直接在请求返回后读文件：审计写入排在请求路径之后的队列里，文件可能还没被创建 → 抛 ENOENT（就是本轮首跑看到的失败）。统一改为 `test-helpers.waitForAudit(dataDir, predicate)`：容忍 ENOENT、轮询到预算耗尽、返回最后看到的内容（失败时表现为「缺少那一行」而不是文件系统错误）。三项「再读一次要求内容完全相等」的断言被删除——它在本轮修竞态的同时又引入了一个新竞态。

**5. 保留审计文件自己的预算（§3.24 的已知缺口，本轮实现）**
新模块 `packages/agent-host/src/retention-audit.ts`：`rotateRetentionAudit(path, {maxLines, maxBytes, slackLines})`。要点：

- **双预算**：行数（默认 1200）与字节（默认 1 MiB）。只有行预算时，几条超大批次会让文件远超字节上限却永不缩（独立复核实测：4 条粗行 158KB 对 40KB 预算，每行都触发一次「什么都没丢」的重写）——字节规则因此**按整批丢弃**直到放得下。
- **高水位 + 滞后**：在 `maxLines + slack`（默认 +32）触发，裁回 `maxLines`。首版在预算处触发、只裁到预算，于是饱和后**每次任务写入都要重写整个文件**（复核实测：40 次追加 40 次重写、52MB 写放大、单次任务写入中位数 31.4ms vs 1.7ms）。现在一次裁剪换来 32 次纯追加。
- **meta 行**：裁剪写入 `{"action":"task_store.retention_audit_rotated","reason":"lines|bytes|lines+bytes","droppedLines":N,"droppedTasks":[...]}`（最多 200 个 id + 精确的 `droppedTasksTruncated`），并保留上一条 note，这样「这段历史为什么从这里开始」可读；note 只接受 `droppedLines > 0` 的裁剪，且不会让 note 自己成为无界增长源。
- **崩溃安全**：tmp 文件 → fsync → rename，断电只留旧文件或新文件。
- **绝不让记账拖垮任务写入**：模块自身不抛（返回 `{error}`），存储层把裁剪与追加拆成两个独立 try——裁剪失败仍尝试追加，否则「真的淘汰了 N 条」会连一行痕迹都没有。
- **计数可见**：`retentionStats()`/`status().storeIntegrity` 增 `retentionAuditRotations`、`retentionAuditLinesDropped`、`retentionAuditMaxLines/Bytes`；**界面（设置页与离线工作台）仍然只说「N 条」**，与 §3.24 的产品口径一致。

**证据**：`retention-audit.test.ts` **14 例**（含水位滞后、字节规则、单批超大时不重写、note 上限、坏行不中断、预算非法值钳制、不可写时不抛）；`retention.test.ts` 15 → **17 例**（存储层驱动 60 次写入：行数不越水位、裁剪次数 < 写入数/4、note 里能追到被丢的 id）；`audit.test.ts` 新增 4 例；根套件 **57 文件 / 464 用例**、`tsc` 0 错、web **83 用例** + `vue-tsc` 0 错；真实 Electron `electron-workbench-check.cjs` **16 → 18 项**（种 2100 行饱和审计：裁剪确实发生、note 与 `retentionAuditLinesDropped` 一致、文件不超过 `retentionAuditMaxLines`、裁剪后最新批次仍在、被清理 id 只进文件不进页面）；桌面壳七项在 HEAD 上复跑 **91/91、退出码全 0**（lock 18、receipt-sync 21、host-smoke 6、workbench 18、quit 10、csp 5、nav 13）。**订正（2026-10-08 第 60 轮）**：原写「92/92」，逐项合计实为 91，且当时没有单条命令能复现该合计（第 60 轮补 `scripts/desktop-shell-checks.mjs` 并改 `acceptance.mjs`）。

**独立复核（子代理，只读）**：逐条对抗 5 项改动，实测确认了 mtime 同戳（plain write 40/300、write+rename 27/300）与「重写放大」两项前提，并**否证了本设计的首版**（字节预算形同虚设、饱和后每次追加都重写、快速通道永不命中、note 可无界、预算未钳制、声明行数永久超 1）——这些否证直接变成上面第 5 条的改造与新增用例。

**6. 窗口置顶的「成功」是假的（真缺陷，本轮末尾由桌面壳复跑抓出）**
`electron-nav-check.mjs` 在同一份代码上出现 13/13 与 11/13 两种结果。探针（`BrowserWindow` + `setAlwaysOnTop(true)`，pinned 运行时 Electron 39.8.10）实测：**调用后 `isAlwaysOnTop()` 始终为 false**（立即、50ms、300ms 都是 false），而 `applyWindowAction` 无论结果如何都回 `{ok:true, result: windowState()}`——也就是说界面（与检查）被告知「已置顶」，实际没有。这类「把请求当成结果」的回报在本项目里已有明确口径（桌面壳的 `status()` 一律读窗口真实状态而不是本地标志位），因此改为：动作执行后**回读窗口状态并与请求比对**，不一致就返回 `{ok:false, error:'window_state_not_applied', result}`。`electron-nav-check.mjs` 的两条断言相应改为「必须报告真实状态，或明确失败，绝不谎报成功」（两种结局都通过，假 `ok:true` 不通过）。

**边界**：置顶本身是否真的生效，取决于桌面会话有没有可用的窗口管理器/合成器——本机这个沙箱会话里 `setAlwaysOnTop` 不生效（窗口 `visible:false`），因此这里只能验证「不谎报」；「置顶真的把窗口钉在最前」仍需在真实桌面上人工确认（`docs/acceptance-guide.md` 已补该步骤）。

**已知边界与未解**：① 复核测到「外来锁落在最后一次复查与 rename 之间」仍会被覆盖（60 次尝试中 36 次），这是 check-then-act 的固有窗口，本轮未消除；② ~~`electron-workbench-check` 里「种子行数 + 裁剪行数 = 2100」这条断言出现过 20 行的差额~~ **（第 60 轮收口，见 §3.26）**；③ 未在真实长跑设备上观察（>2000 批次的设备级行为由模块与存储层用例覆盖，不是实机观测）。

### 3.26 第 60 轮：桌面壳证据收口——七项检查没有单一运行器，且 `acceptance.mjs` 用错了运行器（2026-10-08）

复验第 59 轮时，「桌面壳七项 92/92」复现不出来。查下去不是某几项失败，而是**没有任何一条命令能跑出那个合计**——而且 `scripts/acceptance.mjs` 里那条命令本身就是错的。

**1. 七项检查的运行时不同，但调用方只有一种（真缺陷）**
七项里五项是 *node* 脚本，自己 spawn Electron（脚本头部写着 `Usage: node scripts/…`）：`electron-lock-check.mjs`、`electron-receipt-sync-check.mjs`、`electron-quit-check.mjs`、`electron-csp-check.mjs`、`electron-nav-check.mjs`；只有 `electron-workbench-check.cjs` 与 `electron-host-smoke.cjs` 是 *electron* 脚本（直接用 Electron API）。`acceptance.mjs` 却用 Electron 二进制启动**全部六项**（顺带漏掉了 `host-smoke`，所以是「六项」不是「七项」）。后果本机实测：`electron-lock-check.mjs` 在 Electron 下 `process.execPath` 是 `electron.exe`，它用来派生「存活持有者」与「已死 pid」的 `node -e` 辅助进程变成 Electron 调用，第二个场景永远等不到那行 stale 锁写入，**检查只打印前 5 项后无限卡住**——脚本里没有任何超时，所以「卡住」与「很慢」不可区分。

**修法**：新增 `scripts/desktop-shell-checks.mjs`，把运行器选择收进**一张表**（每个脚本对应它自己声明的运行器），每项带超时（默认 300s，超时按**失败**报出并杀进程树），最后打印一行合计；`acceptance.mjs` 改为调用它。同时给五个 node 脚本加了运行器守卫：在 Electron 下立即打印原因并 `exit 2`，把「卡死」变成「明确失败」。

**2. 合计本身是错的（证据订正）**
第 59 轮记的「桌面壳七项 92/92」逐项合计实为 **91**（lock 18 + receipt-sync 21 + host-smoke 6 + workbench 18 + quit 10 + csp 5 + nav 13）。四处记录（`docs/tasks.md`、`docs/handoff-2026-09-18.md`、本矩阵 §3.25、`Prompt/2026-09-30-continue-project.md`）已订正为 91 并标注订正时间与原因。口径与「critical 门通过 ≠ 没有高危」一致：**一个不可复现的合计不是证据**。

**3. 20 行种子差额收口**
第 59 轮删掉的那条断言（「种子行数 + 裁剪行数 = 2100」）现在补回，并改写成两个数都取自读者会看的那两处（审计文件 + `status().storeIntegrity`）：**每个种子批次要么还在文件里、要么被裁剪计数，`kept + dropped === seeded`**。实测 **`kept=1196 dropped=904 seeded=2100`**，精确成立。那条旧断言不可恢复（第 59 轮从未提交，工作树里只有删掉后的状态），因此它的具体构造无法检视；但它当时的失败**不是数据缺陷**——同一批数字在当轮也自洽（第 59 轮自己记了 1196+904=2100），差额只可能出在断言的构造上。**边界**：这是「断言现在精确成立」，不是「已查明旧断言错在哪一行」。

**4. 交接文档里的运行器指引本身是错的**
`docs/handoff-2026-09-18.md` 原写 quit / csp / nav「必须用 `electron` 跑」，与这三个脚本自己的 `Usage: node …` 相反。本机实测三者在 `node` 下分别 10/10、5/5、13/13 全过（它们显式解析 `devElectron` 路径，不依赖 `process.execPath`），已改为「两个必须用 electron，其余五个用 node，一律走 `desktop-shell-checks.mjs`」。

**证据**：`node scripts/desktop-shell-checks.mjs` → **92/92、退出码 0**（lock 18、receipt-sync 21、host-smoke 6、workbench 19、quit 10、csp 5、nav 13），**连跑两轮同结果**；`electron scripts/electron-lock-check.mjs` → 退出 2 + 明确原因；`node scripts/desktop-shell-checks.mjs --only lock --timeout-ms 15000` → 15s 后报 FAIL（超时）且不留残留进程。根套件 57 文件 / 464 用例、`tsc` 0 错、web 83 用例 + `vue-tsc` 0 错未受影响。

**5. `receipt-sync` 的状态目录耦合（加固，不是仍可达的缺陷）**
它用固定目录 `Temp/receipt-sync-check` 并在启动时 `rmSync(…, {force:true})` 重置，退出只杀直接子进程。**实测触发路径**：把五项 node 检查误用 `electron` 启动（正是第 1 条那个缺陷）后，误启动的实例留下 Electron 子进程占着 profile 目录，随后用 `node` 正确启动的 `receipt-sync` 在重置处抛 `EPERM … Temp\receipt-sync-check`，或退化成一份**更短的检查列表**（实测 `14/15 checks passed`，干净状态下 21/21）。修法：状态目录改为**每次运行唯一**（`mkdtempSync`）、退出按**进程树**杀（`taskkill /pid <pid> /T /F`）。

**不夸大**：① 误启动这条路已由第 1 条的运行器守卫堵住，所以这不是修一个仍可达的缺陷，而是加固；② 旧行为（固定目录 + 只杀直接子进程）与 csp / nav / quit 相同，而这三者在**正确运行器**下实测零残留（退出后 3s / 15s 均为 0 个 Electron 进程），`receipt-sync` 改后同样零残留。**仍存的边界**：五项检查共用仓库内固定状态目录，**两个并发清扫会互相踩**——独立复核复现过一次纯由碰撞造成的假失败（csp 打印 `0/0`）。单条命令顺序跑可复现（连跑两轮同结果），并发不在本轮验收口径内，列为下一轮候选。

**6. 运行器不再相信脚本自报的分母**
上面那次退化是决定性的反例：脚本自报的 `14/15` **本身自洽**，一个只检查「N/M 都过」的合计会把 15 当成完整的 15 项吸收掉——合计照样全绿，而证据已经少了两成。所以 `desktop-shell-checks.mjs` 给七个脚本各钉了预期条数（18 / 21 / 6 / 19 / 10 / 5 / 13），分母不等于钉死值即判失败（`the script's assertion set changed`）。这与第 2 条同一个道理：**自洽的合计不等于完整的合计**。

**边界**：本轮只改检查脚本与文档，未触碰产品源码；桌面壳七项仍受本机沙箱限制（无窗口管理器 → 置顶只能验证「不谎报」，见 §3.25 边界）。

### 3.27 第 61 轮：扇出审计收下的三个缺陷（2026-10-08）

六个只读发现子代理按面报缺陷，每条再由 3 个独立复核子代理从「能否复现 / 有没有守卫 / 影响是否成立」对抗，多数否证即丢弃。首轮跑到 13 个结果时进程中断（无综合报告，结果从 journal 取回）；第二轮 25 个子代理**全部 429**，所以只有首轮拿到裁决的发现进入本轮。

**1. `ignore` 级在「排队中的投喂」上不生效（真缺陷，3 个复核确认并端到端复现）**
延迟模式下，confirm 级联系人发来消息；所有者在撤回窗口内把他改成 `ignore`；窗口到点后投喂**照样提交**，任务跑完并把助手回复发进会话。最严的一档反而最不被执行——所有者的指令只对「下一条消息」有效。根因：`deliver()`（`agent-intake.ts`）只复查 `recalledAt`，不复查 tier；`runTask()`（`service.ts:3400`）里 `const policy = tierPolicy(tier)` 是**死变量**，算了从不读。这是既有的四处 `tierPolicy(...).intake` 硬门之外的第五条路径——闸门的 `submit` 直接接到 `taskEngine.submit`，绕过了 `submitTask` 的门。

修法：`AgentIntakeGate` 新增 `mayIntake` 选项（`app.ts` 接到新的 `service.contactMayIntake`），在 `deliver()` **提交前**复查一次，理由与 `recalledAt` 完全相同——世界会在投喂等待时改变。不通过则按 `tier_ignored` 取消；`mayIntake` **抛错时不当作放行**，而是抛进既有重试路径，让投喂等待重试，而不是被未验证地交出。已提交的投喂仍不受影响（与撤回语义一致：跑起来的活不被事后撤销）。

**证据**：`agent-intake-wiring.test.ts` 新增用例（排队 → 降级 → 窗口过后：无任务、`cancelled=1`、`submitted=0`、审计含 `tier_ignored` 不含正文）。**变异验证**：短路该检查 → 用例失败（`expected [...] to have a length of +0 but got 1`，任务真的被创建）。

**2. 非撤回类的投喂取消不留审计（真缺陷，修第 1 条时发现）**
闸门 `onEvent` 只对 `failed` 写审计行，`cancelled` 一律不写；撤回路径之所以有 `agent_intake.cancelled`，是服务端在撤回处自己补的一条。所以第 1 条的 `tier_ignored` 取消**在审计里毫无痕迹**（实测审计文件只有 `auth.login` 与 `message.sent`）。修法：`onEvent` 对 `cancelled` 也写一行（含 reason、不含正文），**排除 `recalled`**——那条由撤回路径自己写且知道行为人，否则每次撤回都重复计数。

**3. 两处「审计不写密钥」断言里有一处是死的（测试质量）**
`audit.test.ts` 断言审计文件不含 `super-secret-token`，但该字面量在这个测试里**从来不是输入**，任何 `AuditLog` 实现都能通过。修法：真的传一个多余字段并断言它**不落盘**——这才是 writer「只写它认识的字段」的不变量；另加「每个字段都被截断」一例。**变异验证**：writer 改成 `{at, ...event}` 时两条都失败（token 出现、长度 500 > 65）。
**同轮否证**：复核称姊妹用例 `security-hardening.test.ts`「同样空洞」——**不成立**。它是集成用例（真 token POST 给真登录路由），把路由改成记录 token 会让它失败（实测 1 失败）。它守的是调用点，不是 `AuditLog`；复核把「对 AuditLog 的变异无效」误当成了「对系统无效」。

**4. 第 59 轮的锁内容修复此前没有会失败的用例（测试质量，见 §3.25 订正）**
`host-security-verify.test.ts` 在 `refreshLock()` 之前就写好外来锁，读到的是**读时**检查（`held by pid`），提交点检查从未被走到；断言写成容忍正则 `/held by pid|taken over while heartbeating/`，看起来覆盖了两条分支，其实只覆盖一条——把提交点改回 mtime 比较，套件照样全绿。（进一步实测：那条用例的结局此前**取决于 `load()` 排出的 beat 是否正好在飞**，所以两种结局都可能。）
修法：新增 `beforeLockCommit` 测试缝（生产不传，与 `heartbeatMs` 同类），在提交窗口内落一把外来锁，并把两个文件设成**同一时间戳**，让 mtime 比较真的分辨不出。**变异验证**：提交点改回 mtime → 该用例失败（`held: true`，旧检查看不出来会照样 rename 覆盖）。既有那条改成确定性命中读时分支（先 drain 再写外来锁），断言收紧为 `held by pid`。

**过程留痕（不掩饰）**：首轮的复核子代理**违反了只读约束**，往仓库写了探针测试与日志，并手工复制了一整份 `packages/agent-host/src/iso/`——它会被 `vitest.config.ts` 的 `packages/*/src/**/*.test.ts` 收集成测试。证据已移到 `Temp/agent-probes/` 并从仓库删除（`git status` 归零、套件复跑全绿）；第二轮把「只在仓库外的临时目录里复现」写成硬规则。

**本轮未验证（配额耗尽，既未确认也未否证）**：`GET /api/audit` 是否跨组织（若成立最严重）、审批决定是否不写审计、webhook 发送者是否恒被解析为 owner 档、审批的决定期与发送期规则是否互相矛盾；以及一条探针线索（外来锁是否会被心跳覆盖，疑似探针假象）。

**证据汇总**：根套件 **57 文件 / 467 用例**（+3）、`tsc`/`vue-tsc` 0 错、web **83 用例**；重建 `agent-host.bundle.cjs` 后桌面壳七项复跑 **92/92、退出码 0**。

### 3.28 第 62 轮：把中断的审计跑完（2026-10-08）

配额恢复后重跑扇出：2 个发现子代理（补第 61 轮没跑完的两个面）+ 对第 61 轮**五条未验证发现**的 3 人复核 + 综合。36 个子代理全部完成、0 错误；**仓库零改动**（第 61 轮把「只在仓库外的临时目录里复现」写成硬规则后，违规没再发生）。

**1. `GET /api/audit` 不按组织隔离（跨租户读，最严重）**
`listAudit` 只做 `requireOrgAdmin`，把全局 `audit.jsonl` 原样返回；服务端其他所有列表面都过 `sameOrganization`，只有这里没有。**实测**：`org_other` 的 owner 用真 token 拿到了 `org_local` 的行。修法：`AuditLog` 加默认组织（写时给没有组织的行盖章）+ `listAudit` 读时过滤，**以行为人所属组织为准**（查成员记录，不信任行上的字段），查不到行为人的行按盖章组织判断，两者都没有则不展示（fail closed）。**变异验证**：去掉过滤后能看到 `u_theirs`。**边界**：单组织部署下这条读路径此前等于没有过滤，行为不变。

**2. 失败的写入会被并发写入「撤销回滚」**
`persist()` 在入队**之前**抓快照，而 `commit()` 只回滚自己那条——第二个提交的快照里含着第一个的改动，于是把已回滚的状态写回磁盘。调用方被告知失败，磁盘上却留着，重启后照跑。修法：**整个读-改-写**串行化（`commitChain`），不只是文件写。**变异验证**：去掉串行化后 3 个提交重叠（`expected 3 to be 1`）。**边界**：该用例钉的是「提交不重叠」这一机制——并发下让磁盘写失败无法确定性构造，已在注释里写明。

**3. 审批决定不写审计**
`POST /api/approvals/:id/decision` 解锁一次真实外发却不在追加台账留痕（兄弟接口 `/api/outbox/:id/resolve` 有）。修法：补 `approval.decided`（行为人 + 决定，不抄自由文本 reason）。**变异验证**：改掉 action 名后用例失败。**订正**：决定本身在 `approvals.json` 里有记录（可变文件，非追加台账）。

**4. 导航检查把「CDP 连接掉了」读成「宿主拒绝了未知命令」**
`evaluate(...).catch(...)` 的兜底让超时/断连也满足 `ok !== true`，那一行在**没观测到宿主**时打印 PASS。修法：去掉兜底并钉住真实拒绝码 `invalid_command`。收紧后仍 13/13。

**5. `acquireLock` 把「读不到的锁」当成「没有锁」（fail-open）**
`inspectLock` 把任何非 ENOENT 的读失败塌成 `raw=undefined` → `no_lock`/`stale` → 删掉**活持有者**的锁。修法：读失败时改用 `stat`（拒绝读的共享模式下仍成功），「存在但读不到」判为 `owner_unknown`/`stale:false`/`ambiguous:true`。**变异验证**：还原后变回 `no_lock`。

**6. CSP 检查把「测不出来」当成「被拦住了」（加固）**：`inline === undefined || === false` 接受了探针超时/报错。改为要求 `ok && value === false`。

**判为否证，不改**：① 心跳「读与 rename 之间」的 check-then-act 窗口——**3/3 否证**：窗口是代码事实，但**仓库里没有写入者能落在那里**（`flag:'wx'`、beat 自己的 rename、`rm`、接管时的改名移走），探针用的是裸 `writeFile` 覆盖存在的锁（生产不做），且只在同进程内复现（跨进程 0/1400）；**探针假象**。② 三处 shell 检查断言是字面量 `true`——**2/3 否证**：事实为真，但被声称的危害都有别处兜着，属 harness 卫生问题（约 3% 虚高）。

**三票分裂、按「未决」记录（不得当作已确认）**：webhook/IM 发送者恒被解析为 owner 档；审批「决定期」接受账号所有者而「发送期」要求目录 owner/admin（「反之亦然」那半被三票一致否证——决定期只会更宽松）；生产环境委托路径惰性。三条都需要产品口径，见 §4。

**同轮顺带修掉的用户可见问题**：桌面壳检查驱动**真实应用**，于是每项都在桌面上闪一个窗口显示检查用的桩页面（导航检查会把窗口指向 `/app.js`，浏览器把 JS 当源码渲染，窗口上出现 `window.__ready = 1;`）。修法：`main.cjs` 新增 `CHATAGENT_NO_WINDOW=1`（创建但不呈现），运行器为七项统一设置；导航检查**按设计**仍短暂呈现窗口（它验的就是窗口状态），顺带把 `show` 做成与 `pin` 同口径——回读真实可见性，没生效就如实返回失败。

**本轮验证**：根套件 **57 文件 / 470 用例**（+3）、`tsc`/`vue-tsc` 0 错、web 83 用例；重建 `agent-host.bundle.cjs` 后桌面壳七项 **92/92、退出码 0**（全程无窗口）。

**新发现、本轮未处理**：**根套件在 HEAD 上并非稳定全绿**。实测 HEAD（7fc0e97）4 次挂 1 次（`security-regression.test.ts` 的 outbound 组织隔离），带本轮改动时另见 `authorization-refresh.test.ts` 与 `retention.test.ts` 各挂一次；**三次挂的是三个不同用例**，且单独跑都通过，指向**并行执行下的资源争用**而非某个用例坏了（`retention` 那次挂在 `auditFailures` 非 0，即瞬时文件系统错误被计入）。与第 59 轮的起点同类，列为下一轮首要候选。

### 3.29 第 63 轮：同一个任务被执行两次——根套件不稳定的真因（2026-10-09）

第 62 轮记的「根套件在 HEAD 上 4 次挂 1 次」不是用例坏了，是**宿主调度器的真缺陷**：同一个任务会被**并发执行两次**。

**机制**：`dispatch()`（`host.ts`）在 `await store.claim(...)` **之前**检查 `active.size`；而 `claim`（`store.ts`）对「状态 `running`、租约持有人相同」的任务是**幂等返回**的，**不 bump version**。于是：一个调度在 `active` 还空时通过了检查 → 等它真正 `claim` 时另一个调度已经把任务跑起来了 → `claim` 幂等返回 → `execute` 的 `compareAndSet` 版本号**正好匹配** → 执行器**再跑一次**。负载越高、`list()`/`claim()` 延迟抖动越大越容易撞上——这正是它只在全量并行下偶发的原因。

**修法**：在 `await claim` 之后重新检查——`active.has(taskId)`（挡住「同一个任务跑第二次」）并补上并发上限复查（此前只在 await 前查）。生产 `maxConcurrency` 默认 1（`main.cjs` 不设；`service.ts:212` 的 2 是服务端 TaskEngine 的），该窗口在 1 下同样可达。

**确定性复现**（`host.test.ts` 新增用例）：把**第二次** `claim` 卡住直到第一次已跑起来，再放行 → 修复前 `expected [ 'overlap-1', 'overlap-1' ] to deeply equal [ 'overlap-1' ]`。并发度取 **2**：在 1 下并发上限复查会先挡住，用例就钉不住真正要钉的性质。**变异验证**：去掉 `active.has` → 用例失败；加回 → 通过。

**现场证据**：全量跑 6 次挂 1 次，失败签名是 `authorization-refresh.test.ts` 的 `calls.sort()` 里 `t-doc` 出现 **5 次**（应 1 次）；该文件单独跑 25 次全绿，所以必须复现「并发调度」这一条件。

**效果与边界**：修复后**连续 20 次全量跑全绿**（471 用例/次）；修复前 6 次挂 1 次（若真频率仍是 25%，20 次全绿的概率约 0.3%）。**不夸大**：这直接解释 `authorization-refresh` 那条（同一签名，已证明）；另两条（`security-regression`、`retention`）修复前各只见到一次、修复后 20 次未复现——**20 次不足以单独证明它们也被修好**。`retention` 的签名（`auditFailures` 非 0，瞬时文件系统错误被计入断言）是另一类原因，若复现应单独处理。

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
- ~~`docs/requirements.md` 与 `docs/project-brief.md` 仍是旧口径~~ **已处理（2026-09-22 第 57 轮）**：`docs/requirements.md` 按已交付产品重建（R1~R9，每条指向可执行的证据文件），`docs/project-brief.md` 里「仓库当前为空」那句标注为立项时的事实并补上现状（可复用的 packages/apps/scripts 与差距矩阵）。留痕保留原文，避免下一个人以为从未漂移过。