# ChatAgent Skills 升级记录

日期：2026-09-13（Asia/Shanghai）

## 目标

为 DeepSeek Harness 驱动的 ChatAgent 补足产品方向、代码审查、Hermes 运行时边界、企业权限/审批、办公文件安全、交付阶段和验收规则。此次只升级 skills，不修改 ChatAgent 业务代码。

## 交付

- `skills/chatagent-engineering/SKILL.md`：ChatAgent 专项路由与核心不变量。
- `skills/chatagent-engineering/references/`：产品架构、实现契约、代码基线、办公安全、开发阶段、验收矩阵、UI 设计。
- `skills/deepseek-harness-workflow/SKILL.md`：dsh 技能加载、模型配置、能力探针和产品交接规则。
- 原有五个 skill 已升级并同步：`incremental-prompt`（权限/外发/幂等/脱敏记录）、`project-driver`（产品分层与阶段闭环）、`project-framework`（组织/任务/产物边界）、`project-testing`（安全与真实交付分档验收）、`ui-workflow`（审批/交付/断线状态）。
- 已复制到用户指定目录：`E:\软件\项目\新建文件夹 (2)\skills\`。

## 关键决策

1. DeepSeek Harness 是开发工具，Hermes 是产品运行时；本地 `packages/hermes` 的自研 TS 循环不自动等于上游 Hermes 集成。
2. DeepSeek 官方当前把 DeepSeek-V4.1-Flash 的 OpenAI 格式模型名写为 `deepseek-flash`；实际内网网关以能力探针和日期记录为准。
3. 先修身份、对象授权、结构化任务终态、取消竞态、产物归属、审批和幂等，再扩展真实 IM 平台。
4. Mock、Webhook 模拟、真实模型、真实 Hermes、真实收件人分别验收，不能互相冒充。

## 已验证

- `python C:/Users/zs/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/chatagent-engineering`：通过。
- 同脚本校验 `skills/deepseek-harness-workflow`：通过。
- 原有五个 skill 在项目副本和指定目录分别校验，10 次全部通过。
- 通过官方 DeepSeek 文档、DeepSeek Harness GitHub 仓库、NousResearch Hermes Agent GitHub 元数据做了外部核查；网络访问和模型密钥未用于业务调用。

## 未解决

代码基线中 AUTH-01、AUTH-02、TASK-01、TASK-02、TOOL-01、FILE-01 等问题仍在 ChatAgent 代码中，见 `skills/chatagent-engineering/references/code-audit.md`。下一次开发应从 Gate 1 的真实身份与对象授权开始，而不是先增加更多工具或 IM 平台。
