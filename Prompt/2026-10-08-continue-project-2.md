# 继续项目的开发与完善（第 61 轮：扇出审计）

日期：2026-10-08；项目：E:\ChatAI；关联：`Prompt/2026-10-08-continue-project.md`（同日第 60 轮：桌面壳证据收口）、`docs/product-decomposition-gap-matrix-2026-09-17.md` §3.25/§3.26/§3.27。

## 原始指令

> fan out subagents 继续

## 整理（规范化，不改意图）

- 目标：用多子代理扇出**找缺陷**，而不是继续加范围——延续第 59/60 轮「先把基线跑成可信的」的口径。
- 形态：六个只读发现子代理按面并行（桌面壳检查 / 宿主存储与锁 / 宿主授权 / 服务端对象授权与审计 / 投喂闸门 / 测试质量），每条发现再由 **3 个独立复核子代理**从「能否复现 / 有没有守卫 / 影响是否成立」三个角度对抗，多数否证即丢弃，最后由综合子代理去重排序。
- 验收信号：每条进入「已修」的发现都要有**会失败的用例**（变异验证），且不得把未验证的发现写成已解决。

## 实施留痕（2026-10-08）

| 项 | 值 |
| --- | --- |
| 受影响 package/符号 | `apps/server/src/agent-intake.ts`（`mayIntake` 选项 + `deliver()` 提交前复查 + `mayIntake()` 私有方法）；`apps/server/src/service.ts`（`contactMayIntake`）；`apps/server/src/app.ts`（接线 `mayIntake`、`onEvent` 补 `cancelled` 审计）；`apps/server/src/stores.ts`（`cancelReason` 增 `tier_ignored`）；`packages/agent-host/src/store.ts`（`beforeLockCommit` 测试缝）；两处测试 |
| 前置权限 | 无新增权限面。`mayIntake` 只读当前 tier；测试缝只在测试里传 |
| 数据分类 | 新增审计字段仅 reason 码（`tier_ignored`），**不含消息正文**；取消记录本就在本机/服务端数据目录内 |
| 是否外发 | 否。不联网、不调用模型、不发消息 |
| 幂等/取消语义 | `tier_ignored` 取消与 `recalled` 同构：已提交的投喂不受影响（跑起来的活不被事后撤销）；`mayIntake` **抛错不等于放行**，走既有重试预算而不是静默交出 |
| 测试 profile | 离线 MockProvider；根套件 **57 文件 / 467 用例**（+3）、`tsc`/`vue-tsc` 0 错、web **83 用例**；重建 `agent-host.bundle.cjs` 后桌面壳七项复跑 |
| 未验证边界 | 四条发现因**配额 429** 未取得裁决（跨组织审计、审批不写审计、webhook 恒 owner 档、审批两期规则矛盾）与一条探针线索；Gate 7A.3、双机局域网、安装包 GUI 人工验收、长跑设备（同前几轮） |

落盘文件：

- `apps/server/src/agent-intake.ts`、`service.ts`、`app.ts`、`stores.ts`、`agent-intake-wiring.test.ts`、`audit.test.ts`。
- `packages/agent-host/src/store.ts`、`host-security-verify.test.ts`。
- 文档：`docs/tasks.md`（第 61 轮段 + 第 59 轮订正）、差距矩阵 §3.25 订正 + §3.27。

## 本轮收下的三个缺陷

1. **`ignore` 级在「排队中的投喂」上不生效**（真缺陷，3 个复核全部确认并端到端复现）。延迟模式下 confirm 级联系人发消息 → 所有者在撤回窗口内改成 `ignore` → 窗口到点投喂**照样提交**，任务跑完并把助手回复发进会话。最严的一档反而最不被执行。根因：`deliver()` 只复查 `recalledAt`；`runTask()` 里 `policy` 是死变量。修法：提交前复查 tier，不通过按 `tier_ignored` 取消；抛错不当放行。
2. **非撤回类的投喂取消不留审计**（修第 1 条时发现）：闸门只对 `failed` 写审计，`tier_ignored` 取消毫无痕迹。修法：`cancelled` 也写一行（含 reason、不含正文），排除 `recalled` 以免与撤回路径重复计数。
3. **两处「审计不写密钥」断言里有一处是死的**（测试质量）：`audit.test.ts` 断言不含一个在该测试里从来不是输入的字面量，任何实现都能过。修法：真的传多余字段并断言不落盘 + 字段截断用例。
4. **第 59 轮的锁内容修复此前没有会失败的用例**（测试质量）：原断言匹配的是**读时**分支，提交点检查从未被走到（改回 mtime 套件仍全绿）。修法：`beforeLockCommit` 测试缝 + 两文件同一时间戳；变异验证改回 mtime 时该用例失败（`held: true`）。

## 变异验证（每条「已修」都必须有会失败的用例）

| 发现 | 变异 | 结果 |
| --- | --- | --- |
| `ignore` 排队投喂 | 短路 `mayIntake` 检查 | 用例失败：`expected [...] to have a length of +0 but got 1` |
| 审计不写密钥 | writer 改成 `{at, ...event}` | 两条都失败：token 出现、长度 500 > 65 |
| 锁内容比较 | 提交点改回 mtime 比较 | 用例失败：`held: true`（旧检查看不出来，会照样 rename 覆盖） |
| 登录路由不记 token | 路由加 `detail: parsed.data.token` | 姊妹集成用例失败（证明它**不是**空洞断言） |

## 独立复核（子代理，只读）

复核子代理逐条对抗，其中**一条被本轮的变异验证否证**：复核称姊妹用例 `security-hardening.test.ts` 那条「同样空洞」，实测**不成立**——它是集成用例（真 token POST 给真登录路由），把路由改成记录 token 会让它失败。它守的是调用点，不是 `AuditLog`；复核把「对 `AuditLog` 的变异无效」误当成了「对系统无效」。**只修了确实死掉的那一处。**

## 过程留痕（两个失败，不掩饰）

1. **首轮 workflow 被中断**，13 个结果之后没有产出综合报告；结果从 `journal.jsonl` 逐条取回，未做二次综合。
2. **第二轮 25 个子代理全部 429**（5 小时配额耗尽，`agents_done: 0`）。四条发现因此**既未确认也未否证**，已按此措辞记入文档，不得当作已解决。
3. **首轮的复核子代理违反了只读约束**：往仓库写了探针测试与日志，还手工复制了一整份 `packages/agent-host/src/iso/`——会被 `vitest.config.ts` 的 `packages/*/src/**/*.test.ts` 收集成测试。证据已移到 `Temp/agent-probes/` 并从仓库删除（`git status` 归零、套件复跑全绿）；第二轮的提示词已把「只在仓库外的临时目录里复现，必要时整仓复制到仓库外再改」写成硬规则。

## 未决与边界

- **未验证（配额耗尽）**：`GET /api/audit` 是否跨组织（若成立最严重）、审批决定是否不写审计、webhook 发送者是否恒被解析为 owner 档、审批的决定期与发送期规则是否互相矛盾；探针线索「外来锁是否会被心跳覆盖」疑似探针假象。**这五条既未确认也未否证。**
- **本轮不改界面文案、不改产品行为之外的东西**；`runTask()` 里的死变量 `policy` 保留了（本轮把门加在闸门层，已提交任务的行为不变），若要把它变成运行时硬门需另做决定。
- 第 60 轮记的两条残留（`acceptance.mjs` 其余步骤无超时、五项检查共用固定状态目录）本轮未动。
