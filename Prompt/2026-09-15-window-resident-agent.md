# 后台生命周期简化

日期：2026-09-15；项目：E:\ChatAI；关联：2026-09-14-dual-mode-client-background-hermes.md、2026-09-15-project-review-next-direction.md。

## 原始指令

> 后台运行就与关窗常驻绑定，避免后续后台关闭复杂化

## 整理与结果

后台绑定 Electron 应用生命周期：关窗托盘常驻，明确退出即停止 Host/Hermes；不另做守护服务，不要求主进程退出后继续运行。单机工作台、可信授权、真实 Hermes、安全任务语义仍保留。

新增 ADR-0003 并更新简报/任务/审查结论。旧 Prompt 保留原文且增加被新决策覆盖的标记。此次只修改文档，不运行后台服务或修改业务代码。沿用 Markdown 留痕，不新增向量存储。

## 实施留痕（2026-09-15）

| 项 | 值 |
| --- | --- |
| 受影响 package/符号 | 无（仅文档；不改 `packages/agent-host`、`apps/desktop`、`apps/server`、`apps/web`） |
| 数据分类 | 仅决策与审查文字，无凭据、无员工数据、无载荷 |
| 是否外发 | 否（未启动服务、未调用模型或真实 Hermes、未安装/启动任何后台进程） |
| 幂等/取消语义 | 不适用（文档变更）；决策本身规定停派发→取消活动执行→有界等待→保存状态→清理自有进程树 |
| 测试 profile | 未新增或运行代码测试；沿用 `docs/review-2026-09-15-host-gaps-roadmap.md` 的 208/39 用例与类型检查基线 |

落盘文件：

- 新增 `docs/adr-0003-window-resident-agent.md`（当前生命周期决策与验收口径）。
- 更新 `docs/project-brief.md`（最新决策置顶）、`docs/tasks.md`（覆盖旧阶段顺序与 Gate 7A 待办）、`docs/review-2026-09-15-host-gaps-roadmap.md`（A 项与 H-05 标注被 ADR-0003 取代/降级，其他六项观察不变）、`docs/review-2026-09-14-native-roadmap.md`（生命周期指向 ADR-0003）。
- 旧记录加覆盖标记：`docs/adr-0002-dual-mode-client-agent-host.md`、`Prompt/2026-09-14-dual-mode-client-background-hermes.md`、`Prompt/2026-09-14-gate7a-local-agent-host-hermes-poc.md`、`Prompt/2026-09-15-project-review-next-direction.md`；原文保留。
- 索引：`README.md` 文档索引与 `Tree/Tree.md` 补 ADR-0002/0003、Gate7A 报告、当前复核报告与 `packages/agent-host/`。

未决与边界：Gate 7A.1（H-01～H-06）修复、Gate 7A.2 单机工作台与退出清理、Gate 7A.3 真实 Hermes 安全办公验收均未完成，本次不宣称任何新增验收通过；`Prompt/2026-09-15-window-resident-agent.md` 本身也是本轮唯一新增 Prompt 记录，未发现可复用的向量写入接口，继续 Markdown 留痕。
