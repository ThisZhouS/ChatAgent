# Electron 升级与环境结论（2026-09-16 调研）

## 现状（实测）

```
ELECTRON_RUN_AS_NODE=1 apps/desktop/node_modules/.bin/electron -e "console.log(process.versions)"
→ node 22.22.1, electron 39.8.10, chrome 142.0.7444.265
→ require("node:sqlite") 可用（DatabaseSync/StatementSync/backup），但会打印 ExperimentalWarning
```

Electron 39 于 **2026-05-05 结束支持**（来源：[endoflife.date/electron](https://endoflife.date/electron)，页面更新于 2026-09-16）。当前仍受支持的主线：

| 主线 | Chrome | Node | 支持截止 | 最新版 |
| --- | --- | --- | --- | --- |
| 44 | M152 | 24 | 2027-03-02 | 44.4.1（2026-09-16） |
| 43 | M150 | 24 | 2027-01-05 | 43.7.1（2026-09-15） |
| 42 | M148 | 24 | 2026-10-20 | 42.11.4（2026-09-15） |
| 41 / 40 / 39 | — | — | 均已结束（41：2026-08-25；40：2026-06-30；39：2026-05-05） | — |

结论：**当前 39.8.x 已落后 4 个主线**，属于已知风险（`docs/security-checklist.md` §7）。本机无外网，`electron` 二进制无法下载，因此升级本身不能在本轮完成，**不得声称已完成**。

## 升级目标与影响面（预研）

- 目标：先到 **42.11.x**（App 用到的东西最少变动），再到 43/44；Node 从 22 跳到 24。
- 代码里与版本相关的点（都需要在升级后回归）：
  - `app.enableSandbox()`、`BrowserWindow.webPreferences.{sandbox,partition,contextIsolation}`；
  - `session.fromPartition(...).webRequest.onHeadersReceived`（远程工作台 CSP 注入）、`cookies.get`；
  - `ipcMain.handle` / `event.senderFrame.url` 发送方校验；
  - `Tray` + `nativeImage`（托盘图标缺失时的降级已实现）；
  - `dialog.showMessageBox` / `showErrorBox`；
  - 打包：`electron-builder` 26.16.x（需随之升级并重跑 `--win nsis`）。
- 升级后必须重跑（全部为真实 Electron 检查，不需要组织服务）：`scripts/electron-workbench-check.cjs`（11）、`scripts/electron-host-smoke.cjs`（6）、`scripts/electron-quit-check.cjs`（10）、`scripts/electron-receipt-sync-check.mjs`（19），以及 `scripts/gate7a-verify.mjs`（22）与根/web 测试。
- 风险提示：Node 22 → 24 会改变 `node:sqlite` 与若干 Node API 的稳定性；`sandbox: true` 下 preload 只能用 CommonJS（现状满足）。

## 任务库为什么**不**换 `node:sqlite`

实证：Electron 39 的 Node 22.22.1 里 `node:sqlite` 仍是 experimental（运行即打印 ExperimentalWarning，API 可能变动）。把它作为任务库的持久层会引入一个会随运行时升级而变动的依赖，且当前 JSON + 单 writer 锁 + CAS 已经满足需求（跨进程互斥、写失败可观测、载入校验与隔离）。

因此：**保留 JSON 任务库**，并在 Electron 升级（Node 24）后再评估 `node:sqlite`（WAL + 事务能简化 CAS 与并发写）。此处记录为"有证据的决策"，不是遗漏。

## 本轮已完成的桌面加固（不依赖升级）

- 远程工作台使用独立**持久**分区 `persist:chatagent-workbench`（cookie/存储与默认会话隔离，登录可跨重启）；
- 响应头加固：服务端未给 CSP 时由主进程补一份保守 CSP（`default-src 'self'` 等），服务端已有 CSP 时**不削弱**，只记录；同时补 `X-Content-Type-Options`、`Referrer-Policy`；
- 该分区上的权限请求与权限检查一律拒绝；
- `status().shell` 暴露 `partition / remoteResponses / cspInjected / cspFromServer`，便于验收与排障（真实 Electron 检查已断言：stub 服务无 CSP → 注入 1 次、页面仍正常渲染）。

拦截效果已验证：`scripts/electron-csp-check.mjs`（真实 Electron，5/5）证明服务端不发 CSP 时注入的策略**真的拦住**页面内联脚本、同时不误伤同源外链脚本；服务端自带 CSP 时桌面不覆盖（内联允许仍按服务端的策略生效）。仍未覆盖的是完整 XSS 利用链（含被信任第三方脚本），不要把它当作"XSS 已全面防护"。
