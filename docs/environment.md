# ChatAgent 环境 / Environment

## 2026-09-16 Gate 7A.1 加固验证

同一台 Windows 机器、Node v24.11.0，继续使用已存在的 `node_modules` 本地入口（未安装依赖、未联网）。根 Vitest：30 文件 / 296 用例通过（含真实进程树回收、锁接管、保留策略、回执单调性与契约一致性、隔离行不可执行/不可重试、能力下限 fail-closed，以及桌面回执同步 CJS 单测 13 例）

桌面壳（真实 Electron）检查：离线工作台 11/11、主机冒烟 6/6、显式退出 10/10、回执同步 19/19、单 writer 锁 9/9、远程页面 CSP 5/5、导航与桥面 7/7。；`apps/web` Vitest：6 文件 / 40 用例通过；`tsc --noEmit` 与 `vue-tsc --noEmit` 退出码均为 0；新回归 `host-security.test.ts` 18 项与 `host-security-verify.test.ts` 17 项全绿（agent-host 共 63 项（含新增 store-integrity.test.ts 9 项））。Electron 侧检查已在真实运行时跑过（断网工作台 11/11、关窗常驻 6/6、显式退出 10/10）；打包 exe 与打包后客户端 E2E 未重跑。真实 Hermes 二进制被调用过两次，但均以“未配置 provider 的诚实失败”结束（主机级 Flow8、桌面退出检查），没有接入任何模型凭据。详见 `docs/iteration-2026-09-16-gate7a1-hardening.md`。

## 2026-09-15 审查补测

PowerShell，Node v24.11.0，当前 PATH 未找到 pnpm；使用现有 node_modules 本地入口，无依赖安装。获批沙箱外运行 Vitest v4.1.11：根目录 22 文件/208 用例通过，apps/web 6 文件/39 用例通过；tsc 与 vue-tsc 退出码均为 0。命令、范围及日志路径见 `docs/review-2026-09-15-host-gaps-roadmap.md`。

另有 6 项 Temp 隔离诊断复现错误行为，不计入安全通过数量。本轮不重跑安装包/E2E、依赖联网扫描或真实 Hermes/模型调用；下方旧环境与验收数字是历史记录。

测量日期: 2026-09-06

| 项目 | 值 | 备注 |
| --- | --- | --- |
| OS | Windows 11 (MINGW64 / Git Bash) | 路径形如 `/e/ChatAI`，实际盘符 `E:\` |
| Shell | bash (Git Bash) | 命令经 `bash -c` |
| Node | v24.11.0 | 满足 >=20.19 |
| npm | 11.6.1 | |
| pnpm | 11.6.0 | workspace 包管理器 |
| git | 2.53.0.windows.1 | 仓库无远程 |
| Docker | 缺失 | 已提供 `Dockerfile` 与 `docker-compose.yml`，本机未做容器验证 |

## 关键命令

```bash
cd /e/ChatAI
pnpm install
pnpm typecheck
pnpm build
pnpm test
pnpm start        # 生产模式：单进程托管前端 + API，http://localhost:8787
pnpm dev          # 开发模式：Vite(5173) + API(8787)
```

## 数据持久化

`pnpm start` 从仓库根运行，默认 `CHATAGENT_DATA_DIR=./data`，生成：

- `data/accounts.json`、`data/conversations.json`、`data/messages.json`
- `data/tasks.json`
- `data/uploads.json` + `data/uploads/`（上传文件）
- `data/artifacts.json` + `data/artifacts/`（生成文件）

重启后账号、会话、消息、任务与文件元数据均保留。

## 验证（2026-09-13 终态）

```bash
node scripts/acceptance.mjs    # 一条命令 6/6 步：typecheck → 186 用例 → build → 重启 → 冒烟 27/27 → 客户端 E2E 34/34
node scripts/restart-server.mjs  # 只重启服务端并等待 /health
```

`.env.example` 已覆盖服务端读取的**全部**环境变量（含 `CHATAGENT_RECALL_WINDOW_SECONDS`），并在文末单列仅供脚本/客户端使用的变量（`CHATAGENT_URL`、`SMOKE_*`）。

## 桌面壳（Electron）可用的开关

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `CHATAGENT_SERVER_URL` | 外壳加载的组织服务地址 | `http://127.0.0.1:8787` |
| `CHATAGENT_HOST_ROOT` | 本机 Agent 的数据目录（任务库、回执同步状态、锁与审计） | 应用 userData |
| `CHATAGENT_NO_PROMPT=1` | 无人值守：即使是歧义锁也不弹窗（锁获胜，不接管） | 关闭 |
| `CHATAGENT_OPEN_EXTERNAL=off|0|false|no` | 外链只记日志、不拉起系统浏览器（终端服务器/共享机器） | 打开外链 |
| `CHATAGENT_HERMES_EXE` | 指定真实 Hermes 运行时（缺省用 fake 适配器，仅用于契约测试） | 自动探测 |

## 配置

复制根目录 `.env.example` 到 `apps/server/.env` 并按需填写。不填模型参数时使用 MockProvider，全链路离线可运行。
