# Electron 运行时升级调研与离线彩排（2026-09-17）

## 结论先说

- 桌面壳当前钉在 **Electron 39.8.10**（Chromium M142 / Node 22）。该分支 **2026-05-05 已 EOL**，最后一次发版就是 39.8.10 —— 也就是说自 5 月起本项目用的运行时**不再收到 Chromium/Node 安全修复**。这是本轮调研发现的最高优先级技术债。
- 目标：升到 **Electron 44.x**（当前稳定 44.4.1，Chromium M152 / Node 24，支持到 2027-03-02）。42/43/44 都在支持期内，实际路径是 **39 → 42 → 44**（42 作中转，2026-10-20 EOL）。
- 本轮在**无外网**条件下完成了能做的最强验证：把本地缓存的 Electron 42.4.1 运行时解出来，让**全部桌面壳检查 + 打包后的客户端 E2E**都跑在 42.4.1 上，**全绿**。因此“升级会不会把 7A 的防线跑坏”已有证据，剩下的只是把依赖版本换掉（需要 registry 网络）。

## 调研事实（来源）

- Electron 官方支持策略：只支持**最新 3 个稳定大版本**，8 周一个大版本（[electron-timelines](https://electronjs.org/docs/latest/tutorial/electron-timelines)）。
- 版本/EOL 数据（[endoflife.date/electron](https://endoflife.date/electron)，页面更新时间 2026-09-17）：

| 版本 | Chromium | Node | 发布时间 | 支持结束 | 最新补丁 |
| --- | --- | --- | --- | --- | --- |
| 39（当前） | M142 | 22 | 2025-10-28 | **2026-05-05 已结束** | 39.8.10（2026-05-05） |
| 42 | M148 | 24 | 2026-05-05 | 2026-10-20 | 42.11.4（2026-09-15） |
| 43 | M150 | 24 | 2026-06-30 | 2027-01-05 | 43.7.1（2026-09-15） |
| 44 | M152 | 24 | 2026-08-25 | 2027-03-02 | 44.4.1（2026-09-16） |

- 破坏性变更提示：32 位 Windows 平台支持随 v43 EOL（2027-01）一并终止（[breaking-changes](https://electronjs.org/docs/latest/breaking-changes)）。本项目交付物是 win32-x64，不受影响；若组织内仍有 32 位终端，需在 2027-01 前处理。

## 离线彩排（本轮实际做的验证）

本地缓存里已有 `electron-v42.4.1-win32-x64.zip`（位于 `%LOCALAPPDATA%/electron/Cache`），把它解到临时目录当作发行版使用：

```bash
python -c "import zipfile; zipfile.ZipFile(cache_zip).extractall('Temp/electron-42')"
```

为了让检查脚本可以指向别的运行时（同时也方便将来试 beta），新增两个覆盖点：

- `CHATAGENT_ELECTRON_BIN`：`electron-lock-check` / `electron-receipt-sync-check` / `electron-quit-check` / `electron-csp-check` / `electron-nav-check` 用它替换默认的 `apps/desktop/node_modules/electron/dist/electron.exe`；`electron-host-smoke` 与 `electron-workbench-check` 本身就是用当前 Electron 解释器执行，直接用 42 的 `electron.exe` 启动即可。
- `--exe <path>` / `CHATAGENT_CLIENT_EXE`：`scripts/ui-e2e.mjs` 用它指向任意客户端构建（默认仍是 `apps/desktop/release/win-unpacked/ChatAgent.exe`）。

结果（Electron **42.4.1**，同一份源码、同一批断言）：

| 检查 | 39.8.10（当前交付） | 42.4.1（升级彩排） |
| --- | --- | --- |
| 单 writer 锁（含心跳/持有者身份） | 18/18 | **18/18** |
| 回执同步（含失败分级、授权刷新断言） | 21/21 | **21/21** |
| 主机冒烟（关窗常驻） | 6/6 | **6/6** |
| 离线工作台（含保留策略可见性） | 13/13 | **13/13** |
| 显式退出（进程树回收） | 10/10 | **10/10** |
| 远程页面 CSP | 5/5 | **5/5** |
| 导航与桥面 | 7/7 | **7/7** |
| 打包后客户端 E2E（38 项：登录/会话/AI 回复/Word 生成与下载/转发/附件/撤回/主题/响应式/7 个视图） | 38/38 | **38/38**（`release-42` 构建） |

42 的打包构建用本地发行版完成，全程无外网（`electronDist` 是关键：默认路径会去下载 Electron 校验文件，断网即失败）：

```bash
cd apps/desktop && node node_modules/electron-builder/out/cli/cli.js --win dir -c.electronVersion=42.4.1 -c.electronDist=<Temp/electron-42> -c.directories.output=release-42
```

彩排产物与临时运行时已删除，仓库里只保留 39.8.10 的正式 `release/`。

## 切换步骤（等能访问 npm registry 时执行）

1. `pnpm --filter @chatagent/desktop add -D electron@42.11.4`（或直接 44.4.1；一次跳两个大版本也可以，代价是破坏性变更要一次看全）。
2. `node apps/desktop/build-agent-host.mjs` 后重跑上表全部检查 + 打包：`pnpm --filter @chatagent/desktop run build`。
3. 先用 `CHATAGENT_ELECTRON_BIN` 指向新运行时跑一轮检查，再跑打包后 E2E（`node scripts/ui-e2e.mjs`），最后才改交付物。
4. 关注点：主进程 Node 22 → 24（本项目主进程是 CJS，`main.cjs` 只用 `app/session/Tray/ipcMain/dialog/shell/nativeImage`，彩排已覆盖）；`session.fromPartition`、`sandbox: true`、`contextIsolation` 行为不变（CSP/导航检查已覆盖）；32 位平台见上。
5. 升级后把 `docs/environment.md`、本文件与 `docs/acceptance-report.md` 的版本号一并更新，避免文档与交付物不一致。

## 本轮未做（诚实记录）

- **没有**更换依赖版本：`pnpm add` 需要 registry 网络，当前环境无外网（`electron-builder` 在不给 `electronDist` 时会因拉取校验文件而 TLS 失败，这条也已记录）。
- **没有**在 43/44 上彩排：本地缓存只有 30.5.1 / 31.7.7 / 33.2.0 / 39.8.10 / 42.4.1 五个版本。
- 因此 Gate 7A.3（真实 Hermes 运行时 + 真实模型凭据）依旧未开始，与本文件的升级工作无关，不得宣称完成。

