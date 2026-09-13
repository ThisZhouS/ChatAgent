# ChatAgent 验收报告 / Acceptance Report

日期: 2026-09-06

## 已验证命令

| 命令 | 结果 |
| --- | --- |
| `pnpm install` | 通过（esbuild 构建已授权） |
| `pnpm typecheck` | 通过，无错误 |
| `pnpm test` | 通过：4 个测试文件，11 个测试 |
| `pnpm build` | 通过：类型检查 + server tsup 打包 + web vite 构建 |
| `pnpm start`（`node apps/server/dist/index.js`） | 服务启动，`/health` 返回 `{"ok":true}` |

## 已验证功能

- 前端静态托管：`GET /` 返回 Vue 3 + Element Plus 应用入口（`apps/web/dist`）。
- 账号：默认账号自动创建；`GET /api/accounts` 返回账号；`POST /api/accounts` 可创建。
- 消息 → 任务 → Agent 回复：`POST /api/messages` 创建会话与任务，任务 `completed`，助手回复写入会话消息流。
- 文档生成：`POST /api/documents/generate/word` 与 `/generate/excel` 生成可下载文件，返回体不含 `buffer`。
- 文档解析：下载生成物后 `POST /api/documents/parse`（multipart）正确提取 Word 文本。
- 消息驱动文档生成：发送“请生成一份 Word 文档”后，MockProvider 调用 `create_word_document`，任务产物包含 `.docx`，事件日志完整（queued → started → progress/tool_call → completed）。
- Agent 状态：`GET /api/agent/status` 返回 provider、账号统计、任务统计与工具列表。

## 第二轮：开箱即用与持久化

- 生产模式单进程托管前端 + API：`pnpm build && pnpm start` 后 `GET /` 与 `/api/*` 均在 `:8787` 可用。
- 数据持久化：账号/会话/消息/任务/上传文件/生成文件均落盘到 `data/`；重启后账号列表与历史任务保留（已验证 `ops` 账号在重启后仍在）。
- 容器化交付：新增 `Dockerfile` + `docker-compose.yml`（本机无 Docker，未做容器运行验证）。
- 优雅停机：`SIGINT`/`SIGTERM` 触发 `app.close()`，停止任务引擎与网关。

## 第三轮：前端切换为 Element Plus

- `apps/web` 从 React 改写为 Vue 3 + Element Plus（`el-container/el-menu/el-card/el-table/el-form/el-upload/el-tag` 等）。
- 保留全部六视图：工作台/会话/任务/文件/账号/设置，交互状态覆盖加载/空态/错误/禁用。
- 类型检查：`vue-tsc --noEmit` 通过；生产构建：`vite build` 通过（Element Plus 全量引入，bundle 约 1.2MB，内网可接受）。
- 真实浏览器交互仍未验证（无可用浏览器 provider）；已通过构建与静态资源加载验证。

## 第四轮：客户端打包为 Windows exe

- 新增 `apps/desktop`（Electron + electron-builder）。
- `pnpm build:desktop` 成功产出：
  - 安装包 `apps/desktop/release/ChatAgent Setup 0.1.0.exe`
  - 免安装版 `apps/desktop/release/win-unpacked/ChatAgent.exe`
- 已启动免安装版验证进程可正常运行（Electron 多进程启动成功）。
- 连接地址支持 `--server=` / `CHATAGENT_SERVER_URL` / `config.default.json` 覆盖，默认 `http://localhost:8787`。
- 构建期 Electron 二进制使用 `npmmirror` 镜像下载；`win.signAndEditExecutable=false` 规避 rcedit 在 Windows 上修改 exe 元数据失败的问题。

## 第五轮：Gate 1/2 可信身份与任务完整性（2026-09-13）

- 认证与对象授权：`apps/server/src/auth.ts`，production 需 bearer token，development 为显式注入边界；账号/会话/任务/文件/SSE 全部按组织与参与者授权。
- Webhook：验签（HMAC/token）+ 时间窗 + 去重；未配置验证材料时生产 401，dev 标注 `simulated`。
- 任务终态：`RunOutcome` + 终态 CAS，新增 `waiting_approval`/`incomplete`；取消竞态与「必须有产物」验收已覆盖。
- 产物归属：`saveArtifact` 接收服务端 scope，移除全局差集认领，新增 `listByTask` 与下载/列表/转发再授权。
- 验证命令与结果：`pnpm typecheck` 通过；`pnpm test` 8 文件 / 50 用例通过；`pnpm build` 通过。
- 现场（Mock/test profile）验证：伪造 `senderId/senderName` 的请求落库 sender 为 `dev-owner`，任务 `completed` 且产物 `taskId` 与任务一致。
- 未验证（BLOCKED）：真实 DeepSeek/Hermes、真实 IM 网关、真实收件人交付。
- 详见 `docs/gate1-2-identity-task-integrity.md`。

## 第六轮：Gate 4 审批 + Outbox + 幂等回执（2026-09-13）

- `Approval` 实体：`sha256(工具名+目标+artifact 版本+载荷)` 摘要、TTL、单次消费、自审禁止；发送前重新校验组织/成员/审批人角色。
- 外发唯一入口：outbox 查重 → 审批闸门 → 网关一次 → 持久回执；未命中审批时网关调用为 0。
- `SendResult.state`：`simulated|accepted|delivered|failed|unknown`；`unknown` 不自动重发；`ok` 仅 accepted/delivered。
- 任务终态：`approvalRequired → waiting_approval`；`simulated/unknown → incomplete(delivery_unknown)`；`failed → incomplete(delivery_failed)`。
- API：`GET /api/approvals`、`POST /api/approvals/:id/decision`、`GET /api/outbox`、`POST /api/tasks/:id/resume`。
- 验证：`pnpm typecheck` 通过；`pnpm test` 9 文件 / 59 用例通过（新增 `approval-outbox.test.ts` 9 例）；`pnpm build` 通过。
- 现场走通：发送请求 → `waiting_approval` + outbox 空 → 自审 403 → owner 审批 → resume → outbox 一条 `simulated` → 任务 `incomplete` → 再次 resume 返回 `already_finished`。
- **BLOCKED**：真实 IM 凭据缺失，实际投递只能是 `simulated`；`accepted/delivered` 仅由测试 fake gateway 覆盖，不代表真实送达。

## 第七轮：独立原生客户端（2026-09-13, ADR-0001）

- 方向：产品独立于 QQ/企业微信/钉钉/飞书；外部 IM 适配器默认关闭（`CHATAGENT_ENABLE_EXTERNAL_CHANNELS=false`，关闭时 `/api/webhooks/:channel` 返回 404）。
- 原生身份：成员令牌换取会话令牌（`POST /api/auth/login`），支持 `Authorization: Bearer` 与 HttpOnly Cookie（供 SSE 使用）；`/api/auth/me`、`/api/auth/logout`。
- 原生聊天：`GET /api/contacts`（同事 + AI 账号）、`POST /api/conversations`（agent/member 目标）、`POST /api/conversations/:id/messages`（AI 会话触发任务，成员会话投递到对方收件箱）。
- 实时：`GET /api/events/stream` SSE，按订阅者逐条重新授权（消息/任务/审批事件）。
- 前端：新增登录页与原生聊天视图（默认入口），移除旧「会话」测试台视图。
- 验证：`pnpm typecheck` 通过；`pnpm test` 10 文件 / 66 用例通过（新增 `native-chat.test.ts` 6 例）；`pnpm build` 通过。
- 现场走通：签发 u_alice / u_bob 令牌 → 登录 → 联系人 → 与 AI 会话发消息得到任务与回复 → 成员间会话 Bob 可读、Carolf 越权 404（测试覆盖）。
- 未验证：真实第三方 IM 投递（BLOCKED，且已非产品依赖）、浏览器/Electron 端到端。

## 第八轮：独立原生化与安全加固（2026-09-13）

- 原生投递：`NativeImGateway` 让 AI 主动消息落到成员原生会话并返回 `delivered`；`resolveDeliveryGateway` 优先 native。
- 独立安全审查（子 agent，只读）产出 P0/P1/P2 清单，已修复 P0-1（默认模式下匿名即 owner）、P0-2（跨组织文档读取）、P1-1（审批非原子）、P1-2/3（SSE 吊销与 DoS）、P1-4（账号越权使用与 system 历史注入）、P1-5（出站跨组织泄露）与 5 项 P2。
- 成员管理 API + 「成员」页；审批中心页（待审批/历史/outbox）。
- 聊天交互与主题：未读、预览、搜索、日期分隔、合并气泡、自动滚动、快捷提示、附件下载、深色模式。
- 验证：`pnpm typecheck` 通过；`pnpm test` 14 文件 / 92 用例通过；`pnpm build` 通过；现场确认安全响应头、无效 Bearer→401、LAN→401、webhook 默认 404。
- 仍未评估：依赖 CVE（registry 无 audit 端点）、压缩炸弹、浏览器端 CSP 实测。

## 第九轮：群聊、搜索、持久化治理（2026-09-13 03:20）

- 群聊：`POST /api/groups` + 前端「＋群聊」；组内消息对所有参与者可见可发，重复创建同组复用会话。
- 搜索：`GET /api/search`（仅参与会话、≥2 字、上限 50），前端防抖搜索框。
- 未读：`ConversationSummary.unreadCount`/`lastMessage` + `/read` 游标 + 导航徽标。
- 持久化：消息/会话/读游标改防抖写入，关闭时 flush（新增重启回归测试）。
- 体验：中文语言包、Ctrl/Cmd+K、aria-live、深色模式。
- 验证：`pnpm typecheck` 通过；`pnpm test` 15 文件 / 97 用例通过；`pnpm build` 通过；现场验证群聊 + 搜索 + Bob 未读=1。

## 第十轮：独立验证修复 + 管理/可观测性补齐（2026-09-13 03:40）

- 独立只读验证子 agent 复核全部加固项：8 项 VERIFIED、3 项 PARTIALLY、1 项 CONTRADICTED（终态 CAS 竞态已复现）。
- 已修复 F1–F11：串行化任务提交链、上传文件按 owner 授权、webhook 5xx→unknown、write-ahead outbox、SSE 凭据与会话区分 + 任务流加固、转发附件真实 id 与去 localPath、owner 才能管理 owner、写失败可见与审计 flush、出站视图所有者隔离、开发档位启动警告。
- 新增能力：`/api/agent/status` 扩充（待审批、回执、队列深度、实时连接数、会话数）；工作台展示对应卡片；账号编辑弹窗（人设/白名单/状态）；任务「重试」；新消息桌面通知与标题未读数。
- 新增 `docs/security-checklist.md`（部署清单）与 `scripts/smoke.mjs`（27 项端到端自检）。
- 验证：`pnpm typecheck` 通过；`pnpm test` 17 文件 / 111 用例通过；`pnpm build` 通过；`node scripts/smoke.mjs` 16/16 通过；`pnpm build:desktop` 重新产出 exe（03:28）。

## 第十一轮：分页/组件测试/验收材料（2026-09-13 03:35）

- 消息分页：`GET /api/conversations/:id/messages?limit=&before=`，前端「加载更早的消息」（默认 50 条/页），并有分页回归测试。
- 前端组件测试：引入 vitest + jsdom + @vue/test-utils，`ChatView.test.ts` 4 例（未读预览渲染、分页加载+已读、发送调用、搜索/群聊入口）。
- SSE 断线横幅、账号编辑弹窗、任务重试、桌面通知、标题未读数。
- 桌面 exe 重新打包并启动验证（4 个 Electron 进程正常拉起后清理）。
- 交付：`docs/acceptance-guide.md`（10 分钟验收步骤）、`docs/security-checklist.md`。
- 验证：`pnpm typecheck` 通过；`pnpm test` 17 文件 112 用例 + 前端 1 文件 4 用例通过；`pnpm build` 通过；`node scripts/smoke.mjs` 16/16。

## 第十二轮：第二轮独立验证修复（2026-09-13 03:45）

- 只读子 agent 复核 F1–F11 与新增功能，新发现 9 项问题，已全部修复：转发附件真实 id 与去路径、成员令牌 SSE 复核、存储健康（`/health` 503 + `storage.pending/lastError`）、网关异常回执与审批归还、`POST /api/outbox/:id/resolve` 对账、流配额幂等释放、claim 窗口可取消、@ 去重、失效游标返回空页、事件缓冲上限 500。
- 新增：审计日志查看接口与设置页表格；前端组件测试（ChatView 4 例，vitest + jsdom + @vue/test-utils）。
- 验证：`pnpm typecheck` 通过；`pnpm test` 17 文件 117 用例 + 前端 4 用例通过；`pnpm build` 通过；`node scripts/smoke.mjs` 16/16；`/health` 返回存储状态。

## 第十三轮：访问控制修复 + 真实客户端 E2E（2026-09-13 04:10）

第三轮由独立对抗性复核子 agent 逐条复现（自带干净实例与数据目录），本轮修复全部发现，详见 `docs/gate6-access-control-fixes.md`。

- **P0 会话劫持**：`POST /api/messages` 的调用方自选 `chatId` + `findOrCreate` 静默加人 → 任意成员可读/注入同事的 AI 私聊。修复后实测：他人 `chatId` → `403 forbidden`、读历史 `404`、合法自建会话仍 `200`。
- 退出群聊后失去该会话任务的读取/事件/取消权限（`assertTaskVisible`）。
- 建群复用同一 `chatId` 时按请求成员集合**对账**（`setParticipants`），退群不再被隐式拉回。
- 超限上传不再静默截断：`file.file.truncated` → 413 + 审计（此前 25/40 MiB 会以 200 落盘 20 MiB 截断内容）。
- smoke 审批人令牌移出仓库（`os.tmpdir()`，支持 `SMOKE_APPROVER_TOKEN`）。
- SSE 补安全头与 CSP；成员增删/建群/发消息写审计；自助令牌重置拒绝 dev 回退身份；群内生成的产物对参与者可下载。
- **AI 产物进入会话**：生成文件后追加 `kind:'file'` 消息，前端渲染为可下载的 `📎` 附件。
- **真实客户端 E2E**：`scripts/ui-e2e.mjs` 经 CDP 驱动**打包后的 exe**（登录 → AI 回复 → 生成 Word → 聊天内下载 → 深色模式 → 1024×720 → 7 个导航页），**34/34 通过**，截图存 `Temp/ui-shots/`。
- **可访问性修复**：E2E 计算 WCAG 对比度，发现浅色次级文字仅 2.8:1、深色 4.3:1 → 调整 `--ca-muted` 后为 **4.54 / 5.10**。
- 运维：`scripts/restart-server.mjs`（按端口杀进程 + 等 `/health`），修掉本轮真实遇到的「旧进程占端口导致新构建未生效」。
- 验证：`pnpm typecheck` 通过；`pnpm test` **21 文件 / 193 用例**通过（含新增 `membership-security.test.ts` 38 例、Web 测试 25 例与 document 包 13 例）；`pnpm build` 通过；`node scripts/smoke.mjs` 27/27；`node scripts/ui-e2e.mjs` 34/34。

## 06:00 验收结论（2026-09-13 05:26 终态）

**验收对象**：独立内网 AI 工作助手（AI 为独立账号 + 工作代理），服务端 + Web 客户端 + Windows exe + 五个共享包。

| 维度 | 结论 | 证据 |
| --- | --- | --- |
| 完整性 | 聊天/群聊/任务/审批/文件/账号/成员/设置 8 个页面全部可用；消息→任务→工具→产物→回复闭环；审批与投递回执闭环；消息撤回、已读回执、群成员面板、群改名/移出、AI 回复审计、会话管理、在线状态、会话导出 Word 均已落地；冒烟 27/27 | `apps/web/src/views/*`、`scripts/smoke.mjs`、`docs/gate6-access-control-fixes.md` |
| 实用性 | Word/Excel 生成与解析（zip 炸弹防护 + 输出限长）、文件转发、群内 @AI、全文搜索、消息分页、产物直接在会话中下载、撤回/回执/会话导出/丢失设备撤销 | 冒烟 27/27；UI E2E 的「生成 Word → 会话内下载 → 撤回」 |
| 交互性 | 登录/会话切换/发送/群邀请退出/令牌自助重置/主题切换/响应式；真实客户端 E2E **34/34** | `scripts/ui-e2e.mjs`、`Temp/ui-shots/*.png` |
| 美观性 | 浅/深两套主题实测对比度 **4.54 / 5.10**（WCAG AA），无横向溢出、无文字裁切、1024×720 布局稳定 | UI E2E 的对比度与布局检查 |
| 安全性 | **五轮**独立对抗性复核逐条复现并修复：会话劫持（P0）、越权任务、上传截断、令牌铸造、SSE 头、审计盲区、任务快照与任务事件撤回脱敏、zip 炸弹（改为**实测**解压，挡住撒谎的中央目录）、解析失败 400、先解析后落盘；`production` 档位无凭据 401 | `docs/gate6-access-control-fixes.md`、`apps/server/src/membership-security.test.ts` |

**终态验证命令与结果**（2026-09-13 05:26）：

```bash
pnpm typecheck                      # 0 错误（tsc + vue-tsc）
pnpm test                           # 21 文件 / 193 用例全绿
pnpm build                          # tsup + vite 通过
node scripts/restart-server.mjs     # server 8787 healthy（storage.pending=false）
pnpm build:desktop                  # 重新打包 exe（2026-09-13 04:38）
node scripts/smoke.mjs              # 27/27
node scripts/ui-e2e.mjs             # 34/34（真实打包 exe，含截图）
node scripts/acceptance.mjs         # 一条命令 6/6 步（类型检查→186 用例→构建→重启→冒烟 27/27→客户端 34/34）
SMOKE_MEMBER=owner_local SMOKE_TOKEN=... CHATAGENT_URL=http://localhost:8797 node scripts/smoke.mjs   # production 档位 27/27
node scripts/ui-e2e.mjs --server http://localhost:8796                                              # production 档位 34/34
```

**全新实例开箱验证**：空数据目录 + `production` 档位，仅签发一个成员 → 冒烟 **27/27**（默认 AI 账号自动创建，会话/任务/Word 产物/审批/原生投递/搜索/建群全部通过）。

**交付物**：`apps/desktop/release/ChatAgent Setup 0.1.0.exe`（NSIS，78 MB）、`start-server.cmd`、`Dockerfile` + `docker-compose.yml`、`docs/`（含部署安全清单与验收指南）、`scripts/`（签发成员 / 重启 / 冒烟 / 客户端 E2E）。

## 未验证/受限

- 真实浏览器 UI 验证：**已具备**——`scripts/ui-e2e.mjs` 用 Electron 的 CDP 端口驱动打包客户端完成端到端操作并截图（本会话无外部浏览器 provider，故走客户端内置 Chromium）。CSP 的**拦截效果**仍是静态断言，未构造真实 XSS 载荷。
- 真实模型接入未执行（需用户提供内网模型网关与密钥）。
- 真实 IM 平台 Webhook 未端到端联调（仅单元测试覆盖规范化器与新增的验签/去重逻辑）。

## 已知缺口

- 持久化：账号/会话/消息/任务/上传/产物元数据均为 JSON 文件 + 磁盘文件，非数据库；并发写为整文件覆盖。
- 任务恢复只有「running → pending 重取」，没有租约与多实例互斥（code-audit TASK-03）。
- 外发交付：审批/outbox/回执已具备（Gate 4 + NativeImGateway）；未配置真实平台时状态为 `simulated`（不计为送达），`unknown` 需人工对账。
- 文档处理未覆盖 PDF / 图片 OCR。
- IM 真实账号登录/风控未接入；平台原生签名算法未实现。
- 破坏性操作仅有审计记录，无人工审批流。

详见 `docs/tasks.md` 后续方向。
