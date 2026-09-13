---
name: project-driver
description: 项目驱动与端到端开发协调（project driver, idea-to-implementation, major feature, project development）。适用于从想法或重大变更开始，测量开发环境、调研已有方案、确定项目核心、制定计划，并协调框架、UI、测试和增量 Prompt 工作。
---

# 项目驱动 / Project Driver

## ChatAgent 专项路由

先做产品边界决策：内网原生聊天、第三方 IM 适配、管理工作台是不同交付物；AI 独立账号必须有 owner、生命周期、委托权限和 AI 标识。用户说“以 Hermes 为基础”时，核实是上游 Hermes 集成还是本地 TS 实现，不以包名或架构相似替代证据。

ChatAgent 的每个阶段必须走一条完整闭环：真实身份 → 会话 → 持久任务 → 受限工具 → 产物/副作用 → 审批 → 交付回执。优先级固定为认证/对象授权、任务终态/取消/恢复、文件归属、审批幂等，再是更多平台、模型参数和视觉增强。

开发 Harness、产品运行时、模型网关和真实 IM 凭据分开测量。Mock 仅用于离线门；没有真实凭据时标记阻塞，不把 Webhook 模拟或 provider HTTP 200 写成真实交付。所有外发和文件写入都要在计划中列出回滚/对账策略。

用于新项目、重要功能、重构、界面重设计或跨模块变更。小型孤立修改不必调用，除非用户明确要求完整开发流程。

## 执行约定 / Operating Contract

1. 在提出代码修改前，检查仓库、已有代码和本地规则。保留与当前任务无关的用户修改。
2. 测量真实开发环境：操作系统、Shell、仓库状态、语言和运行时版本、包管理器、构建工具、数据库、容器、浏览器工具，以及相关凭据或配置是否存在。项目已有 `docs/` 时，把命令和结果记录到 `docs/environment.md`，否则放在最接近的现有文档位置。
3. 对理念驱动的请求，在实现前创建或更新项目简报。必须说明使用场景、要解决的问题、灵感或依据、非目标、后续方向和验收信号。使用 [references/project-intake.md](references/project-intake.md)。
4. 对新项目或重要新能力，除非用户明确要求仅离线工作，否则进行网络调研。比较已有项目、相近项目、相关理论、许可证、实现约束和可复用开源代码，并在研究文档中记录来源。小型孤立修改且不受外部事实影响时可以跳过调研。
5. 将简报和调研结果提炼为少量项目原则，用来拒绝无关功能并评估后续技术决策。
6. 把原则拆解为能力、需求、接口、数据流和质量属性，选择满足目标的最小成熟技术栈。优先复用本地代码，其次复用兼容的开源项目，最后才从零实现。
7. 创建包含依赖、风险、验证命令和具体交付物的阶段计划。按小任务执行，并根据新证据持续调整。
8. 按以下顺序调用专项技能；后续证据改变范围时，回看并更新前面的记录：
   - `$incremental-prompt`：处理需要长期指令记录的二次开发或 Bug 修复。
   - `$project-framework`：处理目录、框架、Tree 文档和构建隔离。
   - `$ui-workflow`：处理 Web 或 Element UI 交互和浏览器验证。
   - `$project-testing`：处理阶段门、集成、安全、性能和最终验收。
   - `$project-driver` 继续负责协调最终计划与决策。
9. 每个阶段实现最小完整切片，运行该阶段的测试或构建，并记录失败和修复，不要把全部验证推迟到最后。
10. 最后输出状态报告，覆盖已实现范围、已验证命令、已知缺口、文档和建议的后续任务。

## 证据规则 / Evidence Rules

- 未实际测量前，不要声称工具、运行时、依赖、构建或测试可用。
- 测试需要密码、令牌、私有端点或其他秘密时，在测试前向用户索取。不得编造值或静默跳过真实路径。
- 外部仓库只是候选方案，不是权威设计。复用前检查许可证、活跃度、兼容性、安全性和集成成本。
- 临时生成器放在项目的 `Temp`/`tmp` 区域；除非它是长期维护的项目工具，否则使用后清理。
- 除非用户明确要求，不重组 `.git`、`.codex`、`.clude` 和其他点目录。

## 项目记录 / Required Project Records

只创建符合现有仓库约定的记录。新项目优先使用：

`docs/`
- `project-brief.md`：项目简报
- `research.md`：调研记录
- `requirements.md`：需求
- `tasks.md`：任务
- `environment.md`：环境
- `bugs.md`：Bug 与修复
- `acceptance-report.md`：验收报告

`Prompt/` 保存增量工作的用户原始 Prompt。`Tree/Tree.md` 和各目录 Tree 文档由 `$project-framework` 维护。

从想法开始时阅读 [references/project-intake.md](references/project-intake.md)；涉及网络调研或外部代码复用时阅读 [references/research-record.md](references/research-record.md)。
