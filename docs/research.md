# ChatAgent 调研记录 / Research Record

## 搜索问题 / Search Questions

1. 是否已有项目实现“AI 以独立账号身份接入聊天软件并执行任务”？
2. OpenClaw / Hermes Agent / Codex 的架构、许可证与可复用模式是什么？
3. Node 生态中 Word / Excel 解析与生成的可复用库与许可证？
4. 拟议的“IM 网关 + Agent 运行时 + 任务引擎 + 文档工具”架构是否可行？

## 来源 / Sources

- OpenClaw — Open-Source AI Assistant
  - URL: https://openclaw.ai/ ，仓库: https://github.com/openclaw/openclaw
  - 访问日期: 2026-09-06
  - 来源类型与维护者: 开源项目（社区/OpenClaw 组织），MIT
  - 相关发现: 核心是 Gateway（会话/工具/事件/通道连接的控制面）+ Channels（把助手带到 WhatsApp/Telegram/Slack/Discord 等）+ tools/skills/plugins。安全模型强调“trusted gateway, untrusted execution, deterministic policy”，DM 默认需要配对确认。
  - 来源未能证明的内容: 未验证其对企业内网 QQ/钉钉/飞书的中文场景适配深度。
  - 许可证: MIT。

- Hermes Agent — Nous Research
  - URL: https://hermes-agent.org/ ，仓库: https://github.com/nousresearch/hermes-agent
  - 访问日期: 2026-09-06
  - 来源类型与维护者: Nous Research，MIT
  - 相关发现: 包含 agent 循环、gateway、web、TUI、cron、tools、skills、state 等模块；强调持久记忆与自动技能创建。架构上 agent 运行时与通道/调度分离。
  - 来源未能证明的内容: 主要为 Python 实现，不能直接复用为 TS 包。
  - 许可证: MIT。

- OpenAI — Harness engineering: leveraging Codex in an agent-first world
  - URL: https://openai.com/index/harness-engineering/
  - 访问日期: 2026-09-06
  - 来源类型与维护者: OpenAI 官方博客
  - 相关发现: agent-first 交互强调以“执行/结果”为中心，而非单轮问答；仓库可完全由 agent 生成并面向 agent 优化。
  - 来源未能证明的内容: 不提供可直接嵌入的框架代码。
  - 许可证: 内容版权归 OpenAI，仅作理念参考。

- codexia — Lightweight Agent Workstation for Codex CLI
  - URL: https://github.com/milisp/codexia
  - 访问日期: 2026-09-06
  - 来源类型与维护者: 社区项目
  - 相关发现: Codex CLI 的远程控制/技能管理/提示本模式，证明“CLI/agent 执行 + 工作站 UI”的组合可行。
  - 来源未能证明的内容: 许可证与维护活跃度未进一步核实，仅作交互模式参考。

## 对比 / Comparison

| 候选 | 功能匹配 | 许可证 | 维护活跃度 | 技术兼容 | 安全 | 复用成本 |
| --- | --- | --- | --- | --- | --- | --- |
| OpenClaw | 高（gateway+channels+tools） | MIT | 极高 | Node/TS 原生 | 有明确安全模型 | 可作为参考，不整体内嵌 |
| Hermes Agent | 高（agent+gateway+tools） | MIT | 极高 | Python，需跨语言 | 有状态与工具发现 | 仅架构参考 |
| 各 IM 官方 bot | 中（单聊/群聊问答） | 闭源/平台 | 官方 | SDK 各异 | 平台绑定 | 适配层目标 |
| 自研 ChatAgent | 高（企业内网账号+文档+任务） | 自定 | 本仓库 | TS 全栈 | 可内建审计/白名单 | 从零，但结构收敛 |

## 结论 / Conclusion

- 已验证：OpenClaw 与 Hermes Agent 都采用“gateway/agent 运行时与 channel/工具分离”的架构，ChatAgent 采用同样的分层是可行的。
- 推断（未实测）：真实 IM 账号接入需要平台凭据与风控处理，骨架阶段应以 Webhook 规范化 + 内存/模拟网关交付，避免绑定单一平台 SDK。
- 复用决策：
  - 架构复用 OpenClaw/Hermes 的“网关 + 运行时 + 工具 + 技能”思想。
  - Node 依赖复用 `docx`（Word 生成）、`mammoth`（Word 解析）、`xlsx`（Excel 解析/生成）、`zod`（契约校验）、`fastify`（服务）、`vue`+`element-plus`+`vite`（前端）。
  - 不整体 fork 外部仓库；`@chatagent/hermes` 作为独立实现，接口可插拔。
