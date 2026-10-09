# 继续项目的开发与完善（第 64 轮：把「睡一觉再断言」改成等条件）

日期：2026-10-09；项目：E:\ChatAI；关联：`Prompt/2026-10-09-continue-project.md`（第 63 轮：同一任务被执行两次）、`docs/product-decomposition-gap-matrix-2026-09-17.md` §3.29/§3.30。

## 原始指令

> 继续

## 整理（规范化，不改意图）

- 起点：第 63 轮记的「20 次全绿」之后，紧接着 10 次抽样挂了 1 次——是**同文件里另一条**用例。说明真缺陷修掉了，但**并存的脆弱断言还在**。
- 本轮范围：① 把有证据的「睡一觉再断言」改成等条件；② 给验收链每一步加超时；③ 顺手订正第 63 轮的结论。
- 验收信号：连续多轮全绿；被改的用例在负载下不再依赖固定睡眠。

## 实施留痕（2026-10-09）

| 项 | 值 |
| --- | --- |
| 受影响 package/符号 | `packages/agent-host/src/authorization-refresh.test.ts`（两处 `sleep` → `waitFor`）；`scripts/acceptance.mjs`（每步超时 + `ETIMEDOUT` 识别） |
| 前置权限 | 无新增权限面 |
| 数据分类 | 无新增落盘数据 |
| 是否外发 | 否 |
| 幂等/取消语义 | 无产品行为改动（只改测试与验收脚本） |
| 测试 profile | 根套件 **57 文件 / 471 用例**、`tsc`/`vue-tsc` 0 错；**连续 15 次全量跑全绿**（第 63 轮修复后累计 45 次跑、1 次挂，那一次已在本轮修掉） |
| 未验证边界 | `retention` 的 `auditFailures` 未复现（10 次带探针全量跑，全为 0），**不当作已解决**；全仓另有 68 处固定睡眠未处理 |

落盘文件：`packages/agent-host/src/authorization-refresh.test.ts`、`scripts/acceptance.mjs`；文档 `docs/tasks.md`（第 64 轮 + 第 63 轮订正）、差距矩阵 §3.30。

## 1. 用固定 sleep 等调度结果（真脆弱断言）

`authorization-refresh.test.ts` 的 `does not run work whose delegation the service revoked after submission`：

```ts
await host.resume();
await new Promise((resolve) => setTimeout(resolve, 150));
const after = await host.get('t-revoked');
expect(after?.state).toBe('failed');        // ← 负载高时还是 'queued'
```

实测签名：`expected 'queued' to be 'failed'`。150ms 在空载时够用，在 16 路并行的全量跑里不够。改成 `waitFor(状态 === 'failed')`。

同文件的另一条（`unknown` 委派应**保持** queued）是**否定断言**：睡一觉无法区分「被 hold 住」与「还没被看到」，所以先等**肯定信号**（`status().authorization.heldTasks >= 1`），再断言它没被启动。

**只改有证据的两处**：全仓测试还有 68 处 `setTimeout(resolve, N)`，多数是正当的（`waitFor` 的轮询间隔、清理时的 `Promise.race` 上限）。批量改写 68 处的风险大于收益。

## 2. `acceptance.mjs` 每一步都没有超时（真缺陷）

`run()` 用 `spawnSync` 且不传 `timeout`：卡住的 `ui-e2e` / `build` 会把整条验收链**永久挂住**，且不打印任何原因。这与第 60/61 轮反复强调的「挂死的检查比失败的检查更糟」是同一条口径，只不过这次在**验收链**上。

修法：每步上限（默认 20 分钟）+ 识别 `spawnSync` 的 `ETIMEDOUT`，超时按**失败**报出并写明原因。

**验证方式**：把上限临时设为 1ms 跑 `node scripts/acceptance.mjs --skip-e2e`，六步全部报 `timed out after 0s` 且退出码 1——超时路径端到端成立，不是只看代码。

**这个探针顺带抓出了我自己的一个 bug**：`let detail = timedOut ? ... timeoutMs ...` 里的 `timeoutMs` 当时并未定义（我只在 `spawnSync` 里内联写了 `options.timeoutMs ?? DEFAULT`），于是六步全部 `step crashed: timeoutMs is not defined`。**如果没有真跑一次，这个改动会带着一个必然崩溃的 bug 提交。**

## 3. 订正第 63 轮的结论

第 63 轮写「修复后连续 20 次全量跑全绿」。那是真的，但**不足以说明套件已经稳定**——紧接着的 10 次抽样挂了 1 次（同文件另一条用例）。正确的结论是：第 63 轮修掉的是「同一任务跑两次」这个**真缺陷**（已证明），而套件里**还并存**着与负载相关的脆弱断言，本轮修掉其中一条。

## 未决与边界

- **`retention.test.ts` 的 `auditFailures` 非 0**：带探针跑 10 次全量没有复现（`auditFailures` 全为 0）。**不当作已解决**；其签名指向「瞬时文件系统错误被计入断言」，若再出现应单独处理。
- **68 处固定睡眠**：只改了有证据的两处。
- 第 60–62 轮记的残留仍未动（其余检查共用固定状态目录、三条产品口径未决）。
- 本轮未改产品源码，因此未重建 bundle、未复跑桌面壳七项。
