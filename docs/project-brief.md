# ChatAgent 项目简报 / Project Brief

## 2026-09-15 生命周期简化（最新决策）

后台运行绑定客户端关窗常驻：Host 由 Electron 主进程管理，关闭窗口继续，明确退出应用即停止 Host/Hermes 并清理自有进程。不要求主进程退出后继续运行，不新增独立守护进程或系统服务。下方历史“独立 Host”仅保留模块化职责，不作为独立进程部署要求。详见 `docs/adr-0003-window-resident-agent.md`。

## 2026-09-14 客户端目标补充（生命周期部分已被上方决策取代）

ChatAgent 同时是独立 Agent 工具与员工原生聊天客户端。员工使用电脑时 Hermes 可在后台并行执行；无人操作或关闭界面后，已明确授权的工作可由独立 Host 继续。前台聊天与后台执行不是互斥模式，单机 Agent 入口不以组织聊天服务器为前提，主流聊天平台仍不是依赖。

此次目标要求核实真实 Hermes 集成，不以本地同名 TS 包替代。后台常驻、OS 注销、锁屏与睡眠的支持范围须分别验收，不隐含安装系统服务或取得无限权限。详见 `docs/adr-0002-dual-mode-client-agent-host.md`；新增架构尚未实现，原有聊天/任务能力应复用。

## 项目核心 / Project Core

- 临时名称 / Working name: ChatAgent
- 一句话目的 / One-sentence purpose: 让 AI 以独立 IM 账号身份进入企业内网聊天工具，像真人助理一样接收指令、执行真实工作并回传结果，而不是做一对一或群聊里的问答机器人。
- 主要用户与使用场景 / Primary user and use scenario: 企业内网员工、团队负责人、行政/数据/文档岗位。员工使用 **ChatAgent 自带客户端**（Web/桌面）登录，在原生聊天里把 AI 账号当作同事：直接发消息或丢文件，它自动完成 Word/Excel 处理、文件转发、信息汇总、任务跟进等。第三方 IM 不是依赖项（见 `docs/adr-0001-standalone-native-chat.md`）。
- 要解决的问题 / Problem being solved: 现有 IM 内的 agent bot 大多只是“对话接口”：用户必须一对一地在聊天框里聊，或者 @ 群聊 bot。它们没有稳定的独立账号身份、没有跨会话任务状态、没有面向文件/文档/转发的执行能力，因此难以进入真实工作流。
- 当前解决的必要性 / Why this problem matters now: Agent 框架（OpenClaw、Hermes Agent、Codex 等）已经具备工具调用与自主执行能力，但缺少一个“企业 IM 内网账号层 + 工作执行层”的收敛产品；企业实际工作中的大量协作围绕 Word、Excel 和文件转发展开。
- 灵感或相关先例 / Inspiration or related precedent:
  - OpenClaw（trusted gateway + channels + tools，助手以账号身份接入既有聊天工具）
  - Nous Research Hermes Agent（持久记忆、技能、工具发现、网关、cron 的 agent 运行时）
  - OpenAI Codex / Codex GUI（以“执行”而非“对话”为中心的 agent-first 交互）
- 非目标 / Non-goals:
  - 不做通用聊天大模型产品，不追求闲聊体验。
  - **不把产品建立在第三方社交/办公软件之上**：身份、会话、消息、文件均由 ChatAgent 自身提供；QQ/企业微信/钉钉/飞书 仅作为可选适配器（默认关闭）。
  - 不实现每个 IM 平台的完整 SDK，只保留规范化网关与适配器骨架。
  - 不替代 OA/审批/网盘，只做可插拔集成。
  - 不做公网 SaaS 多租户，先聚焦内网单租户/单组织部署。
- 约束后续开发的原则 / Principles that constrain later development:
  1. Agent 是执行者，不是聊天框：一切能力最终落到可观察的任务与文件结果。
  2. 独立优先：产品不依赖外部聊天/办公软件即可完整运行；每个 AI 账号是独立主体，具有权限、白名单、审计。
  3. 可插拔：IM 平台、模型提供商、文档处理器、任务存储均可替换。
  4. 最小可信：任何破坏性/外发操作必须有可审计记录和人工确认点。
  5. 复用成熟开源组件，许可证兼容，不重复造轮子。

## 可行性 / Feasibility

- 可复用的本地代码或资源 / Existing local code or assets to reuse: **立项时**本仓库为空，无本地代码可复用（这句描述的是 2026-09-06 的事实，保留在此作为留痕）。现状：仓库已有可复用资产——`packages/`（hermes / document / im-gateway / task-engine / agent-host / contracts）、`apps/`（server / web / desktop）、`scripts/` 下的验收脚本，以及 `docs/product-decomposition-gap-matrix-2026-09-17.md` 里按功能域整理的差距矩阵；需求基线见已重建的 `docs/requirements.md`。
- 相近或竞争项目 / Similar or competing projects:
  - OpenClaw（MIT，Node/TS，gateway/channels/tools）
  - NousResearch/hermes-agent（MIT，Python，agent/gateway/cron/skills）
  - 各 IM 官方 bot/智能助手（能力多限于单聊问答与群 @）
- 相关理论、标准或实现模式 / Relevant theory, standards, or implementation patterns:
  - ReAct / tool-use loop；OpenAI-compatible tool calling；IM webhook 规范化；任务状态机 + 幂等 + 重试；SSE 流式事件。
- 必需的集成和外部依赖 / Required integrations and external dependencies:
  - 模型：OpenAI 兼容 HTTP 接口（可接 vLLM / Ollama / 内网模型网关）。
  - 文档：`docx`（生成 Word）、`mammoth`（解析 Word）、`xlsx`（解析/生成 Excel）。
  - 服务：Fastify、Vue 3 + Element Plus + Vite、Zod、TypeScript。
- 主要可行性风险 / Key feasibility risks:
  - 真实 IM 账号登录/风控需各平台凭据，骨架用 Webhook + 模拟网关先行。
  - 模型可用性与网络策略；因此提供 MockProvider 使全链路无密钥可跑通。
- 许可证或数据使用约束 / Licensing or data-use constraints: OpenClaw 与 Hermes Agent 均为 MIT；本项目默认内部使用，代码可后续选择 MIT/Apache-2.0，使用第三方包需保留其许可证。

## 范围 / Scope

- 最小可用切片 / Minimum useful slice:
  - 单服务 + 单前端工作台；AI 账号注册/白名单；消息注入（Web 工作台 + Webhook）；Hermes 运行时带工具循环；Word/Excel 解析与生成工具；任务队列与 SSE 进度；文件转发（模拟网关内回传）。
- 后续方向 / Later directions:
  - 真实 QQ（NapCat/OneBot）、企业微信、钉钉、飞书凭据接入；持久化 PostgreSQL；cron 定时任务；MCP 工具接入；审批/确认工作流；多租户与角色。
- 可观察的验收信号 / Observable acceptance signals:
  - 前端工作台可创建 AI 账号、发消息、看到 agent 的思考/工具调用/任务进度。
  - 上传 docx/xlsx 可被解析并生成结构化摘要；可生成 Word/Excel 文件。
  - 无模型密钥时用 MockProvider 全链路跑通；接入真实模型时同一路由切换。
- 明确的开放问题 / Explicit open questions:
  - 目标组织具体使用哪几个 IM 平台及其 webhook 鉴权方式。
  - 破坏性操作（群发、删除、转发到外部）的审批策略与阈值。
  - 内网模型网关的协议兼容范围。

## 决策记录 / Decision Log

- TypeScript 全栈 Monorepo（用户选定），pnpm workspace，packages 用源码直引 + apps 打包。
- 以“Hermes 风格 agent 运行时”为核心包 `@chatagent/hermes`，向上对接 IM/任务/文档，向下接 OpenAI-compatible 模型。
- 用 MockProvider 保证离线可运行，用 OpenAICompatibleProvider 保证真实可接。
- 先以 SSE 而非 WebSocket 做事件流，减少依赖与复杂度，后续可替换。
