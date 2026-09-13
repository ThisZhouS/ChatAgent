---
name: project-framework
description: 项目框架与目录治理（project framework, project structure, Tree documentation, build isolation）。适用于搭建或修复可维护的项目结构、框架边界、构建隔离、文档布局和 Tree 索引。
---

# 项目框架 / Project Framework

## ChatAgent 专项边界

保持 `contracts → domain packages → apps` 单向依赖：contracts 管身份、资源归属、任务/审批/交付状态和事件；task-engine 不依赖 Fastify/模型；Hermes 通过 executor/adapter 端口接入；IM 与文档适配器不能自行绕过授权和审计。

目录中明确区分生产代码、测试、Prompt、研究、运行数据、构建产物和 skills。不得把模型密钥、真实文件、收件人信息或 Harness 会话状态放进仓库。新增持久化实体必须说明 organization/owner/task 归属、版本和迁移/回滚策略。

结构验收不仅看 Tree：检查跨用户对象权限、任务恢复入口、artifact 下载授权、SSE 游标和 outbox 是否有明确归属。不要为了“应用级”提前拆微服务或引入消息队列/向量库。

用于项目脚手架、代码库重组、框架结构选择，或需要明确文件归属的跨模块变更。不要为了树形结构整齐而重组无关文件。

## 工作流 / Workflow

1. 检查现有目录树、包清单、构建脚本、测试、文档和本地规则。在约定合理时保持仓库原有方式。
2. 根据项目复杂度、运行时、部署模式和团队工作流选择结构。优先采用能明确归属并快速定位错误的最小结构。使用 [references/structure-contract.md](references/structure-contract.md)。
3. 分离生产代码、测试、文档、临时生成器、Prompt 和生成产物。一次性脚本不要放在长期维护的应用代码旁边。
4. 除非用户明确要求，不重组 `.git`、`.codex`、`.clude` 和其他点目录。
5. 创建或更新：
   - `Tree/Tree.md`：当前的高层文件和目录结构。
   - `Tree/<directory-name>.md`：每个重要目录一份说明，列出便于导航的文件、函数、类和模块。
   - 当项目没有现成等价文档时，补充需求、任务、使用、环境、Bug 和验收文档。
6. 让构建和测试命令可以从仓库根目录复现。结构修改后运行真实构建或最接近的有效命令，并修复路径、导入和配置错误。
7. 优先复用本地代码和兼容的开源组件，而不是增加新样板代码。在调研或架构文档中记录复用代码及许可证决策。
8. 需要重复生成目录索引时，使用附带的 Tree 生成器：

```text
python scripts/update_tree.py <project-root> --output <project-root>/Tree
```

该脚本只是清单工具，不能代替人工审查文件归属，也不能代替重要符号的说明文档。

## 完成标准 / Completion Criteria

- 文件具有明确的归属和位置。
- 临时代码已删除，或被明确纳入长期维护。
- 构建和测试入口仍然可用。
- 最终 Tree 索引与仓库一致。
- 新结构的文档足以让后续 Agent 快速定位文件、模块、类或函数。
