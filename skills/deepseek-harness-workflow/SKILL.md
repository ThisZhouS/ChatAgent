---
name: deepseek-harness-workflow
description: 使用 DeepSeek Harness（dsh）开发、加载 skills 和验证 ChatAgent；适用于模型配置、插件/技能工作流与 agent-first 开发，不把 dsh 当作 ChatAgent 生产运行时。
---

# DeepSeek Harness 工作流

## 先确认事实

截至 2026-09-13，官方仓库是 `deepseek-ai/deepseek-harness`，入口示例是 `npx @deepseek-ai/dsh web`，默认 Web UI 为 `127.0.0.1:3080`。不要凭记忆编造 CLI 参数；先读项目随附文档或 pinned commit。若命令、网络或安装不可用，记录阻塞并用当前仓库测试继续，不静默声称已用 dsh。

Harness 的本地技能优先级包含项目 `.dsh/skills`、项目 `.agents/skills`、配置的 customSkillDirs、用户 dsh/agents 目录和 bundled 目录；只支持直接 bundle 的 `<name>/SKILL.md` 或 `<name>.md`，不假设深层递归发现。技能名用 kebab-case。用户指定的外部目录应配置为 customSkillDirs 或复制/链接到项目可审查目录；优先项目内 `.dsh/skills` 以便版本化。

不要把大体积 zip、缓存和凭据放入技能目录。每项技能只提供会改变决策的约束；详细 schema、脚本和样例放 references。加载技能后先输出适用范围和不适用范围，再执行任务。

## ChatAgent 的配置纪律

把开发模型配置和产品运行配置分开。生产代码中的 provider 不能读取 Harness 的会话状态、密钥或 workspace 权限；开发环境产生的提示词和工具调用样本脱敏后才能进入 `Prompt/` 或测试 fixture。

用户要求 DeepSeek V4.1 Flash 时，不把版本名直接当 API model id：官方模型页当前将版本写为 DeepSeek-V4.1-Flash，OpenAI 格式模型名为 `deepseek-flash`，基础地址为 `https://api.deepseek.com`。实际内网网关可能使用别的 id，必须以网关能力探针为准并记录日期/端点类型。

该模型支持工具调用和 thinking。OpenAI-compatible Chat Completions 下按官方文档验证 `reasoning_effort` 与 `extra_body.thinking` 的兼容性；thinking 响应可能包含 `reasoning_content`。不要把推理原文广播给聊天成员，也不要因为 provider 未保存该字段就声称工具多轮已兼容。thinking 模式对 temperature 等参数有约束，发送前以官方文档和网关实测为准。

## 能力探针（不含密钥）

按顺序验证：健康/鉴权 → 最小文本 → 结构化 JSON → 单工具 → 多轮工具结果回传 → 超时取消 → 截断 → 并发/限流。记录模型 id、协议、status、finish reason、是否产生工具调用和脱敏错误；不保存 key、完整文件内容、推理原文或私人载荷。

失败分类为配置、网络、认证、限流、协议、模型能力和业务权限。模型能力失败不能切换到 Mock 伪造通过；只有显式 demo/test profile 才能使用 Mock。

## 与 ChatAgent 交接

每次开发任务先读取 `chatagent-engineering`；每次改变任务、工具、文件、IM 或 UI，再读取对应 references。完成后输出：已加载 skill、实际 dsh 命令、固定版本、改动文件、测试结果、未验证真实边界和后续 Prompt。不要自动安装依赖、发送真实消息或修改全局 dsh 配置。
