# 继续项目的开发与完善（第 60 轮）

日期：2026-10-08；项目：E:\ChatAI；关联：`Prompt/2026-09-30-continue-project.md`（上一轮：测试基线与保留审计预算）、`docs/product-decomposition-gap-matrix-2026-09-17.md` §3.25/§3.26。

## 原始指令

> 根据项目继续完善。

## 整理（规范化，不改意图）

- 起点：第 59 轮的改动在本机复验通过（根套件 464/464、web 83/83、`tsc` 0 错、工作台 18/18），但**「桌面壳七项 92/92」复现不出来**——不是某几项失败，而是没有任何一条命令能跑出那个合计。
- 本轮范围：① 让七项检查有一条可复现的命令（运行器表 + 单脚本超时 + 一行合计）；② 订正第 59 轮记错的合计；③ 把第 59 轮删掉的那条保留审计断言改写成可证明的形式补回；④ 连跑两轮验证幂等。
- 非目标：Gate 7A.3（真实 Hermes + 真实模型凭据，本机不具备）、Electron 版本切换与 Windows Job Object（需网络/原生模块）、服务端委托台账（另一条独立主线）、任何产品源码改动。
- 验收信号：一条命令跑出七项合计且**连跑两轮同结果**；合计里的分母被钉死（脚本少跑一项即失败）；工作台那条不变量精确成立。

## 实施留痕（2026-10-08）

| 项 | 值 |
| --- | --- |
| 受影响 package/符号 | 新增 `scripts/desktop-shell-checks.mjs`（运行器表 + 单脚本超时 + 合计 + 钉死分母）；`scripts/acceptance.mjs`（改调新运行器、补 `host-smoke`、删未用的 `existsSync`）；五个 node 脚本各加运行器守卫；`scripts/electron-receipt-sync-check.mjs`（状态目录改 `mkdtempSync`、退出按进程树杀）；`scripts/electron-workbench-check.cjs`（+1 条不变量断言） |
| 前置权限 | 无新增权限面。只动本机检查脚本与文档，**未触碰产品源码** |
| 数据分类 | 无新增落盘数据；`receipt-sync` 的状态目录从仓库内固定路径改到系统临时目录下的一次性目录 |
| 是否外发 | 否。不联网、不调用模型、不启动真实 Hermes、不发消息 |
| 幂等/取消语义 | 七项检查现在**可重复运行**（连跑两轮同结果）；单脚本超时按**失败**报出并杀进程树；`receipt-sync` 退出时按进程树清理，不再把子进程留给下一次运行 |
| 测试 profile | 离线 MockProvider；根套件 **57 文件 / 464 用例**、`tsc` 0 错、web **83 用例** + `vue-tsc` 0 错；桌面壳七项 **92/92、退出码 0**，连跑两轮（lock 18、receipt-sync 21、host-smoke 6、workbench 19、quit 10、csp 5、nav 13） |
| 未验证边界 | 与第 59 轮相同：Gate 7A.3（真实 Hermes + 真实模型凭据）、双机局域网、安装包 GUI 人工验收、长跑设备（>2000 批次）实机观测；本机沙箱无窗口管理器，置顶仍只能验证「不谎报」 |

落盘文件：

- `scripts/desktop-shell-checks.mjs`（新增）。
- `scripts/acceptance.mjs`、`scripts/electron-lock-check.mjs`、`scripts/electron-receipt-sync-check.mjs`、`scripts/electron-quit-check.mjs`、`scripts/electron-csp-check.mjs`、`scripts/electron-nav-check.mjs`、`scripts/electron-workbench-check.cjs`。
- 文档：`docs/tasks.md`（第 60 轮段 + 第 59 轮订正）、差距矩阵 §3.25 订正 + §3.26、`docs/handoff-2026-09-18.md`（合计订正 + 运行器指引订正）、`docs/acceptance-guide.md`（改为一条命令 + 条数更新）。

## 本轮抓到的四个问题

1. **七项检查没有单一运行器，且 `acceptance.mjs` 用错了运行器**（真缺陷）。七项里五项是 *node* 脚本（自己 spawn Electron，头部写着 `Usage: node …`），只有 `electron-workbench-check.cjs` 与 `electron-host-smoke.cjs` 是 *electron* 脚本；`acceptance.mjs` 却用 Electron 二进制启动全部六项（还漏了 `host-smoke`）。本机实测：`electron-lock-check.mjs` 在 Electron 下 `process.execPath` 变成 `electron.exe`，它派生的两个 `node -e` 辅助进程变成 Electron 调用，第二个场景永远等不到 stale 锁写入，**检查只打印前 5 项后无限卡住**（无超时、无诊断）。修法：运行器表 + 超时（默认 300s，超时按失败报出并杀进程树）+ 合计。
2. **合计本身是错的**（证据订正）。第 59 轮记的「92/92」逐项合计实为 **91**（18+21+6+18+10+5+13）。四处记录已订正为 91 并标注订正时间与原因。
3. **`receipt-sync` 的状态目录耦合**（加固，不是仍可达的缺陷）。它用固定目录 `Temp/receipt-sync-check` + 启动时 `rmSync(…, {force:true})` 重置，退出只杀直接子进程。**实测触发路径**：我最初把五项 node 检查误用 `electron` 启动（正是第 1 条那个缺陷），误启动的实例留下 Electron 子进程占着 profile 目录，随后用 `node` 正确启动的 `receipt-sync` 就在重置处抛 `EPERM`，或退化成一份**更短的检查列表**（实测 `14/15 checks passed`，干净状态下 21/21）。修法：状态目录改为每次运行唯一（`mkdtempSync`）、退出按进程树杀（`taskkill /T /F`）。**不夸大**：误启动这条路已由第 1 条的守卫堵住；旧行为（固定目录 + 只杀直接子进程）与 csp / nav / quit 相同，而这三者在正确运行器下实测零残留（退出后 3s/15s 均 0 个 Electron 进程），`receipt-sync` 改后同样零残留。所以这是**加固**，不是修一个仍可达的缺陷。**仍存的边界**：五项检查共用仓库内固定状态目录，**两个并发清扫会互相踩**（独立复核复现过一次纯由碰撞造成的假失败）；顺序跑可复现，并发不在本轮验收口径内。
4. **20 行种子差额收口**。第 59 轮删掉的那条断言补回并改写成两个数都取自读者会看的那两处（审计文件 + `status()`）：每个种子批次要么还在文件里、要么被裁剪计数。实测 **`kept=1196 dropped=904 seeded=2100`**，精确成立。

## 由此得到的一条口径（写进运行器）

**自洽的合计不等于完整的合计。** 第 3 条里脚本自报的 `14/15` 本身自洽，一个只检查「N/M 都过」的合计会把 15 当成完整的 15 项吸收掉——合计照样全绿，证据却少了两成。所以运行器给七个脚本各钉了预期条数（18 / 21 / 6 / 19 / 10 / 5 / 13），分母不等于钉死值即判失败。这与「critical 门通过 ≠ 没有高危」是同一条口径。

## 独立复核（子代理，只读）

复核子代理逐条对抗六项声明（A 运行器表是否全对 / B 超时是否真杀进程树 / C 不变量是否空洞 / D `acceptance.mjs` 改动 / E 守卫是否破坏 node 路径 / F 是否存在「没跑也算过」），给出原始命令输出。结论：

- **A / B / C / E 判为「不是缺陷」**：A 逐脚本核对 `require('electron')` 与头部 `Usage:`，七项分类全对（但它指出运行器头注释把两个 electron 脚本的头部误引成 `Usage: electron …`，实际是 `Run: …/electron …`——已改）；B 在干净环境实测 3/3 次超时后进程树全清（`electron_at_t3=4 → after_exit=0`），只有「`taskkill` 失败或后代进程占住 stdio 管道则 `close` 永不触发」这条**代码级残留风险**——已加**第二个截止时间**（杀不掉时 15s 后自行判失败，不再可能挂死）；C 独立推出该不变量「非种子行若被丢会让和 **>2100 而失败**，不存在把它算成通过」的路径，并实测 `kept=1196 dropped=904 seeded=2100`；E 实测守卫均在 import 之后、任何可能挂死的动作之前，两个 electron 脚本没有守卫。
- **F 判为「描述版本里的确存在，磁盘版本已闭合」**：旧版 `ok = code === 0`，脚本若退出 0 但不打印合计会被报成 `PASS 0/0`。这正是我在复核进行中补上 `expect` 钉死分母的原因；复核自己也观察到它触发（一次与并发清扫碰撞的 csp 运行打印不出合计 → `FAIL csp — ran 0/0, expected 5 checks`）。
- **D 判为「CONFIRMED（次要）：合计被三倍计数」——复核这一条我实测后判为误报**。它说 `acceptance.mjs` 的 summary 会把每条检查行、汇总行、总计行三处 `N/M checks passed` 求和，于是 10 项那步被报成 30。实际：旧模式 `/\d+\/\d+ checks passed/` **没有捕获组**，`match[1]` 是 `undefined`，求和分支根本不会走，落到 `matches[0][0]` 也就是原样打印 `10/10 checks passed`——不会三倍。我把 `run()` 的 summary 分支原样抄出来跑，旧模式得 `10/10 checks passed`、新模式得 `10 cases`。仍然改了模式（锚定到 `[desktop-shell]` 那行并加捕获组），理由是**读起来与其他步骤一致**（都是 `N cases`），以及一旦有人补上捕获组它就会真的三倍计数；改动的注释已按实测结论写，不写「修了三倍计数」。
- D 还指出一处**真实语义变化**：旧代码用 `if (existsSync(electronBin))` 包住，没有 Electron 时静默跳过六项、验收仍可能 PASS；新步骤总会跑，没有 Electron 时运行器退出 2 → 验收**失败**。这与项目既有口径一致（「脚本化验收不得把没跑到当成成功」），是有意为之，已在文档写明。

## 未决与边界

- **未消除**：第 59 轮记的「外来锁落在最后一次复查与 rename 之间仍会被覆盖」是 check-then-act 的固有窗口，本轮未动。
- **20 行差额的边界**：现在能说「新断言精确成立」，**不能**说「已查明第 59 轮那条旧断言错在哪一行」——旧断言从未提交，工作树里只有删掉后的状态，不可恢复。
- **`acceptance.mjs` 仍未给其他步骤加超时**（`spawnSync` 无 `timeout`）：桌面壳这一步现在不会挂死了，但 `ui-e2e` 等步骤仍可能长时间无输出。属已知残留，本轮未处理。
- **五项检查共用仓库内固定状态目录**：**两个并发的清扫会互相踩**（独立复核复现过一次纯由碰撞造成的假失败）。顺序跑已实测可复现（连跑两轮 92/92）；并发不在本轮验收口径内，列为下一轮候选（改 `mkdtempSync` 即可，与 `receipt-sync` 本次的做法相同）。
- **运行器的超时是单脚本级**，不限制整轮总时长；七个脚本各自 300s，最坏情况整轮可达 ~35 分钟。
- 本轮不改界面文案、不改产品行为（与第 58/59 轮口径一致）。
