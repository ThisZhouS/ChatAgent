# ChatAgent 初始 Prompt

> 用户原始需求（2026-09-06）

构建应用级项目：ChatAgent

项目理念：QQ，微信，钉钉，飞书等聊天软件大部分已然接入了 agentbot。但目前只能作为单一对话（即与 AI 进行一对一的聊天框对话），或者群聊 bot。始终未推出或者未实现 AI 独立运行一个单独的账号和作为一个助手的功能。该项目旨在实现 AI 作为 Chat 助手，真实的进行任务的实现，而非聊天机器人。以 hermes 为基础，构建 AI agent 的内网聊天社交工具。以将其真实的纳入企业实际工作中，处理工作（word，excel，文件消息转发等）。

## 澄清结果

- “以 hermes 为基础” = 类似 OpenClaw / Hermes / CodexGUI 的 agent 框架思路，而非具体某个 SDK。
- 技术栈 = TypeScript 全栈 Monorepo。
- 首批交付 = 完整可运行骨架 + 核心能力实现。
