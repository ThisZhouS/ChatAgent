# 继续项目的开发与完善（第 63 轮：根套件不稳定 = 同一个任务跑了两次）

日期：2026-10-09；项目：E:\ChatAI；关联：`Prompt/2026-10-08-continue-project-3.md`（第 62 轮末尾记下「根套件在 HEAD 上并非稳定全绿」）、`docs/product-decomposition-gap-matrix-2026-09-17.md` §3.28/§3.29。

## 原始指令

> 继续

（承接第 62 轮末的选择：下一轮优先修根套件的不稳定。）

## 整理（规范化，不改意图）

- 目标：把「根套件 4 次挂 1 次」从**测量**推进到**根因 + 修复 + 会失败的用例**。
- 方法：先测频率、再逐条取失败签名、再构造确定性复现，最后变异验证。
- 验收信号：修复后连续多轮全绿；修复的用例在去掉修复时会失败。

## 实施留痕（2026-10-09）

| 项 | 值 |
| --- | --- |
| 受影响 package/符号 | `packages/agent-host/src/host.ts`（`dispatch()` 在 `await claim` 之后复查 `active.has(taskId)` 与并发上限）；`packages/agent-host/src/host.test.ts`（新增确定性用例） |
| 前置权限 | 无新增权限面 |
| 数据分类 | 无新增落盘数据 |
| 是否外发 | 否 |
| 幂等/取消语义 | **本轮修的就是幂等性**：同一个 taskId 不再可能被并发执行两次（此前 `claim` 对 running+同持有人的幂等返回会让第二次 `compareAndSet` 匹配） |
| 测试 profile | 根套件 **57 文件 / 471 用例**（+1）、`tsc`/`vue-tsc` 0 错；**连续 20 次全量跑全绿**（修复前 6 次挂 1 次） |
| 未验证边界 | `security-regression` 与 `retention` 两条修复前的偶发未单独证明已消除（见下）；桌面壳七项本轮未重跑（未改 `agent-host` 对外行为，但改过 host.ts，应重建 bundle 后复跑一次） |

落盘文件：`packages/agent-host/src/host.ts`、`host.test.ts`；文档 `docs/tasks.md`、差距矩阵 §3.29。

## 根因

`dispatch()` 在 `await store.claim(...)` **之前**检查 `active.size`；`claim` 对「状态 `running`、租约持有人相同」的任务是**幂等返回**的，**不 bump version**。于是：

1. 调度 B 在 `active` 还空的时候通过了那道检查；
2. 调度 A 抢先 claim 并把任务跑起来（`active` 里有了它）；
3. B 的 `claim` 这时才返回——看到 running + 同一持有人 → **幂等返回，版本号没变**；
4. B 的 `execute` 用这个版本号 `compareAndSet` → **正好匹配** → **执行器再跑一次**。

负载越高，`list()`/`claim()` 的延迟抖动越大，越容易撞上——所以它只在全量并行下偶发。生产 `maxConcurrency` 默认 1（`main.cjs` 不设），该窗口在 1 下同样可达。

## 证据链

1. **频率**：6 次全量跑挂 1 次。
2. **签名**：失败是 `authorization-refresh.test.ts` 的「holds new side-effect work while the check fails…」，`calls.sort()` 期望 `['t-doc','t-running']`，实测 `t-doc` 出现 **5 次**。
3. **排除用例本身**：该文件单独跑 **25 次全绿** → 必须复现「并发调度」这个条件，不是用例脆弱。
4. **确定性复现**：新增用例把**第二次** `claim` 卡住直到第一次已跑起来，再放行 → 修复前 `expected [ 'overlap-1', 'overlap-1' ] to deeply equal [ 'overlap-1' ]`。
5. **变异验证**：去掉 `active.has` → 用例失败；加回 → 通过。

## 两个过程中的坑（记录以免重蹈）

- **第一版复现失败**：我最初把 `claim` 整体卡住，结果所有 claim 在版本号上依次 bump，`compareAndSet` 只让最后一个赢——**恰好掩盖了这个缺陷**。真正的窗口要求「claim 发生在任务已经 running 之后」。
- **并发度必须是 2**：在 `maxConcurrency: 1` 下，我补的「并发上限复查」会先挡住第二次执行，于是**去掉 `active.has` 用例照样通过**——用例钉不住真正要钉的性质。改到 2 之后，`active.has` 才成为唯一防线，变异验证才成立。

## 效果与边界（不夸大）

- 修复后**连续 20 次全量跑全绿**（471 用例/次）。修复前 6 次挂 1 次；若真频率仍是 25%，20 次全绿的概率约 **0.3%**。
- **直接解释**的是 `authorization-refresh` 那条（同一签名，已证明）。
- `security-regression` 与 `retention` 两条修复前各只见到一次、修复后 20 次未复现——**20 次不足以单独证明它们也被修好**，只能说与该修复相容。`retention` 的签名（`auditFailures` 非 0，即瞬时文件系统错误被计入断言）指向另一类原因，若复现应单独处理。

## 未决与边界

- 上面两条未单独证明。
- 本轮改过 `packages/agent-host/src/host.ts`，按项目约定应重建 `apps/desktop/agent-host.bundle.cjs` 并复跑桌面壳七项。
- 第 60–62 轮记的残留仍未动（`acceptance.mjs` 其余步骤无超时、其余检查共用固定状态目录、三条产品口径未决）。
