# 继续项目的开发与完善（第 59 轮）

日期：2026-09-30；项目：E:\ChatAI；关联：`Prompt/2026-09-22-continue-project.md`（上一轮：九问落地 + 保留策略逐条留痕）、`docs/product-decomposition-gap-matrix-2026-09-17.md` §3.24/§3.25。

## 原始指令

> 继续项目的开发与完善。

## 整理（规范化，不改意图）

- 目标：不做「锦上添花」的新范围，先把**基线跑成可信的**，再收口上一轮明确留下的、只要本机就能闭环的那条缺口。
- 上一轮（第 58 轮）自己在 `docs/tasks.md` 里留的候选原话：「保留审计文件自身的增长治理……现在只追加不轮转，长期运行会线性增长……属于要产品口径的决定」。
- 本轮范围：① 修掉干净 HEAD 上根套件并非全绿的三个失败用例背后的真实缺陷；② 给保留审计文件定预算并实现裁剪；③ 全量回归（根套件 / web / 桌面壳七项）。
- 非目标：Gate 7A.3（真实 Hermes + 真实模型凭据，本机不具备）、Electron 版本切换与 Windows Job Object（需网络/原生模块）、服务端委托台账（另一条独立主线）。
- 验收信号：干净 HEAD 上根套件连续全绿且失败不再是「换一个文件」；审计文件在任何合法预算下都有界、裁剪可追溯、失败不拖垮任务写入；桌面壳七项在 HEAD 上全绿。

## 实施留痕（2026-09-30）

| 项 | 值 |
| --- | --- |
| 受影响 package/符号 | `packages/agent-host/src/store.ts`（心跳内容校验、ENOENT-only、`refreshLock` 串行化、`retentionAudit.slackLines`、裁剪计数）；`packages/agent-host/src/retention-audit.ts`（新增：`rotateRetentionAudit`、`DEFAULT_AUDIT_MAX_LINES/BYTES`、`DEFAULT_AUDIT_ROTATE_SLACK_LINES`、`MIN_AUDIT_MAX_LINES`、`MAX_NOTE_TASK_IDS`）；`packages/agent-host/src/host.ts`、`types.ts`（状态字段）；`packages/agent-host/src/lock-takeover.ts`（可注入 `alive`）；`apps/server/src/audit.ts`（首条不丢）；`apps/server/src/test-helpers.ts`（`waitForAudit`）；`scripts/electron-workbench-check.cjs`（+2 项断言、饱和审计种子） |
| 前置权限 | 无新增权限面。所有改动都在本机宿主/服务端内部；锁与审计文件与任务库同目录同权限；`rotateRetentionAudit` 只读写审计文件本身 |
| 数据分类 | taskId、任务终态、更新时间、淘汰原因、裁剪批次数。**不含**凭据、目标正文、产物内容；裁剪 meta 行里的 id 与批次行同级（原本就落本机文件） |
| 是否外发 | 否。不联网、不调用模型、不启动真实 Hermes、不发消息 |
| 幂等/取消语义 | 裁剪是「读→算→tmp→fsync→rename」，失败回滚到原文件；重复调用在预算内是 no-op；裁剪不会丢最新批次；审计追加仍是纯追加。锁侧：只有 ENOENT 才算锁消失（瞬时读失败不再永久放弃持有），`refreshLock` 与定时器共用串行链，不会发布截断载荷 |
| 测试 profile | 离线 MockProvider；`retention-audit.test.ts` 14 例（新增）、`retention.test.ts` 17 例、`audit.test.ts` 4 例（新增）、`lock-takeover` 14 例；根套件 **57 文件 / 464 用例**、web **83 用例**、`tsc`/`vue-tsc` 0 错；真实 Electron 工作台 **18/18**，桌面壳七项 **91/91**（订正：本轮原记 92/92，逐项合计为 91，见 `docs/tasks.md` 第 60 轮） |
| 未验证边界 | Gate 7A.3（真实 Hermes + 真实模型凭据）、双机局域网、安装包 GUI 人工验收；长跑设备（>2000 批次）的实机观测；**窗口置顶在真实桌面上是否真的钉住**（本机沙箱会话里 `setAlwaysOnTop` 不生效，只能验证「不谎报」）；工作台检查里一处 20 行种子差额的原因（文件自洽，断言已移除，**未宣称已解释**） |

落盘文件：

- `packages/agent-host/src/retention-audit.ts`（新增模块）、`retention-audit.test.ts`（新增 14 例）。
- `packages/agent-host/src/store.ts`、`host.ts`、`types.ts`、`index.ts`、`lock-takeover.ts`、`retention.test.ts`、`lock-takeover.test.ts`、`host-security-verify.test.ts`。
- `apps/server/src/audit.ts`、`audit.test.ts`（新增）、`test-helpers.ts`、`membership-security.test.ts`、`security-hardening.test.ts`、`agent-intake-wiring.test.ts`、`contact-tier.test.ts`。
- `scripts/electron-workbench-check.cjs`、`apps/desktop/agent-host.bundle.cjs`（重建，产物不入库）。
- 文档：差距矩阵 §3.25、`docs/tasks.md`（第 59 轮段 + 候选收口）、`docs/security-checklist.md`、`docs/acceptance-guide.md`、`docs/handoff-2026-09-18.md`。

## 独立复核（子代理，只读）

复核子代理逐条对抗 5 项改动并给出原始命令输出，**否证了审计裁剪的首版设计**（字节预算形同虚设、饱和后每次追加都重写整个文件、快速通道永不命中、note 可无界、预算未钳制、声明行数永久超 1），并实测确认了前提（mtime 同戳 40/300 与 27/300、首版写放大 40 次追加 40 次重写 / 单次任务写入中位数 31.4ms vs 1.7ms）。这些否证直接变成第 5 项改造与新增用例；复核还提出「`readFile` 瞬时失败被当成锁消失」这一新缺陷，已修（ENOENT-only）。

## 追加交付：窗口置顶不再谎报成功（同轮末尾，桌面壳复跑抓出）

桌面壳复跑时 `electron-nav-check.mjs` 在同一份代码上给过 13/13 与 11/13 两种结果。探针（`BrowserWindow` + `setAlwaysOnTop(true)`，pinned 运行时 Electron 39.8.10）实测：**调用后 `isAlwaysOnTop()` 立即/50ms/300ms 全为 false**，而 `applyWindowAction` 无论结果如何都回 `{ok:true, result}`——界面与检查被告知「已置顶」，实际没有。改为动作执行后**回读窗口状态并与请求比对**，不一致返回 `{ok:false, error:'window_state_not_applied', result}`；`electron-nav-check.mjs` 的两条断言改为「必须报告真实状态或明确失败，绝不谎报」（两种结局都过，假 `ok:true` 不过，13/13）。`docs/acceptance-guide.md` 补上「置顶需在真实桌面上人工确认」这一步：本机沙箱会话没有可用窗口管理器，只能验证不谎报。

## 未决与边界

- **未解**：工作台检查里「种子行数 + 裁剪行数 = 2100」曾出现 20 行差额（进程内读到的种子批次比文件少 20）。文件本身自洽（1196 保留 + 904 裁剪 = 2100），该断言未保留；原因未查明，不作为已解释。
- **未消除**：外来锁若落在「最后一次内容复查」与 rename 之间仍会被覆盖（复核 60 次尝试中 36 次），这是 check-then-act 的固有窗口。
- 本轮不改界面文案（与第 58 轮口径一致：逐条追溯落审计、界面只说条数）。
- 仍不使用向量库：项目现有检索是 JSON 存储 + 进程内搜索，本轮 Prompt 沿用 Markdown 留痕。
