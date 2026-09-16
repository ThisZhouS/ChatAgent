# 项目增量审查请求

日期：2026-09-15；项目：E:\ChatAI；基线：b33c64d。

> 2026-09-15 生命周期要求已更新：见 `docs/adr-0003-window-resident-agent.md`。下文「Gate 7A.2 独立 Host/本地工作台」按新决策解释为 Electron 主进程内 Host + 关窗常驻/托盘重开/明确退出清理，不再规划独立守护进程或主进程退出后继续运行；仅更正该表述与范围，本轮审查结论和 Gate 7A.1 修复项不变。

## 用户原始指令

> 项目已进一步开发，重新查看项目状况，给出下一步开发方向。

关联：2026-09-14-dual-mode-client-background-hermes.md、2026-09-14-gate7a-local-agent-host-hermes-poc.md。相同措辞但代码基线和阶段已变化，本次新增记录而不复用上一轮结论。

## 约束与产出

保留独立聊天、单机 Agent、员工并行工作与后台 Hermes 的产品要求。此次只审查、测试、给方向；不修业务、不启动模型/真实任务、不提交 Git。未发现本次可直接使用的 Prompt 向量写入路径，继续 Markdown 留痕。

结果：新增 `docs/review-2026-09-15-host-gaps-roadmap.md`。现有后端 208、前端 39 用例通过，类型检查通过；六项隔离探针复现 Host 的幂等、授权、持久错误、终态、租约和 IPC 结果形状问题。探针绿色表示错误行为已被观察，不是修复通过。

下一步优先 Gate 7A.1 修可信性和跨层契约，再做 Gate 7A.2 独立 Host/本地工作台（此处“独立 Host”按 `docs/adr-0003-window-resident-agent.md` 解释为 Electron 主进程内 Host + 关窗常驻）、Gate 7A.3 真实 Hermes 安全办公验证。之前的 Gate7A 总 PASS 不足以证明用户目标整体完成。
