# 持续迭代：Gate 7A.1 加固与可改进方向调研

日期：2026-09-16；项目：E:\ChatAI；基线：`b33c64d`（工作区含 2026-09-15 文档改动）。关联：`docs/review-2026-09-15-host-gaps-roadmap.md`、`docs/adr-0003-window-resident-agent.md`。

## 原始指令

> 在现在到2026年9月16日19时之间，不断完善迭代该项目。包括但不限于完整性，耦合性，实用性，简约性，安全性。可调用子代理，记得关闭。联网搜索，以了解项目的可改进方向。

## 语义与范围

时间盒内（当日 16:22→19:00）按“先修可信性、再补体验”的顺序推进，不新开产品方向：

1. 完整性/安全性：Gate 7A.1 的 H-01～H-06（提交幂等、可信授权、落盘错误、终态 CAS、单 writer、IPC 契约）。
2. 实用性/简约性：本机卡片显示未执行原因与重试；退出路径收敛为一条幂等拆除；稳定 deviceId。
3. 耦合性：授权判定集中在 agent-host，IPC 只传引用；桌面端只做生命周期与授予，不重复业务判断。
4. 调研：Electron 生命周期/单实例/单 writer、Electron 2026 安全清单、幂等与终态 CAS、Hermes 子进程集成的公开实践。

约束：不改聊天/任务主流程与安全语义；不接真实模型/真实 Hermes；不提交未验证的“已完成”；子代理用完即关；留痕仍用 Markdown，不新增向量存储。

## 结果

- 新增 `docs/iteration-2026-09-16-gate7a1-hardening.md`（本轮范围、变更、证据、未完成）。
- 代码：`packages/agent-host/src/{authorization.ts,host.ts,store.ts,ipc.ts,types.ts,adapter.ts,index.ts}`、`apps/desktop/{main.cjs,preload.cjs,error.html,workbench.html,package.json}`、`apps/web/src/views/SettingsView.vue`；回归 `host-security.test.ts`、`host.test.ts`、`SettingsView.test.ts`，真实 Electron 校验 `scripts/electron-workbench-check.cjs`（断网工作台 11/11）与 `scripts/electron-host-smoke.cjs`（关窗常驻 6/6）。
- 只改文档与上述源码；未改服务端业务、未加依赖、未调用真实模型；安装包重打包与 Electron 版本升级未做（记入技术债）。
- 对抗性复核（独立子代理，34 项探针）：复现 11 项攻击，全部修复并逐条加回归；复跑后 11/11 攻击失败、23 项 FIX-HOLDS 仍通过，报告存档 `docs/review-2026-09-16-adversarial-verification.md`；子代理已结束，无后台任务残留。
- 未决：Gate 7A.2 的 Host 侧持续回执同步与断网账号归属、Gate 7A.3 真实 Hermes 验收；Electron 支持窗口、CSP/session 分区、JSON→SQLite、Job Object 清理列入后续评估。

## 元数据

| 项 | 值 |
| --- | --- |
| 受影响 package/符号 | `@chatagent/agent-host`：`LocalAgentHost.{submit,retry,cancel,stop,close,finish}`、`TrustedAuthorizationRegistry`、`computeActionDigest`、`JsonFileAgentHostStore.{compareAndSet,close,AgentHostStoreLockedError}`、`handleHostCommand`；`apps/desktop` 生命周期与 `workbench.html`；`SettingsView.vue` 本机卡片 |
| 前置权限 | 本机任务默认许可；副作用任务需已登记委托＋已批准审批，且摘要与载荷一致；IPC 无授予命令 |
| 数据分类 | 任务记录仅存目标/状态/产物哈希与授权引用快照，不含凭据、模型推理或员工文件原文 |
| 是否外发 | 否；本轮不调用模型、不投递消息、不启动真实 Hermes |
| 幂等/取消语义 | 同 id 同载荷幂等返回；同 id 异载荷 `idempotency_conflict`；取消立即写终态，迟到结果按 version CAS 丢弃 |
| 测试 profile | 根 vitest 252、web vitest 40、tsc/vue-tsc 0、Electron 校验：工作台 11/11、关窗常驻 6/6、显式退出 10/10（真实应用）；打包 exe 与打包后 E2E 未重跑 |
| 未验证边界 | 真实 Hermes+模型、断网账号归属与回执持续同步、干净安装、多设备并发、主进程被强杀后的子进程回收 |
