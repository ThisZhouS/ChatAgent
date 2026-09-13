# ChatAgent 环境 / Environment

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

## 配置

复制根目录 `.env.example` 到 `apps/server/.env` 并按需填写。不填模型参数时使用 MockProvider，全链路离线可运行。
