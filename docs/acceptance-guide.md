# ChatAgent 验收指南（10 分钟）

面向 2026-09-13 06:00 的人工验收。全部步骤都可复现，命令从仓库根目录执行。

## 0. 启动

```bash
pnpm install
pnpm build
pnpm start                 # 或双击 start-server.cmd
```

打开 http://localhost:8787 。服务端日志会提示当前认证档位：本机开发档位会给回环调用者 owner 身份，
**共享网络必须**按 `docs/security-checklist.md` 设置 `CHATAGENT_AUTH_MODE=production`。

## 0.5 五分钟极速验收（可选）

不想逐步走查时，按顺序执行下面四条即可覆盖五大维度：

```bash
node scripts/acceptance.mjs                   # 一条命令：类型检查 → 测试 → 构建 → 重启 → 冒烟 → 依赖审计 → 客户端 E2E（7/7）
```

需要分步时：

```bash
pnpm typecheck && pnpm test && pnpm build     # 完整性/安全性基线：0 错误 + 21 文件/181 用例 + 构建通过
node scripts/restart-server.mjs               # 服务端可启动（等待 /health）
node scripts/smoke.mjs                        # 27 项接口验收：任务/审批/投递/撤回/回执/导出/会话/在线
node scripts/ui-e2e.mjs                       # 34 项真实客户端验收（自动截图到 Temp/ui-shots）
```

UI 手工看三眼：① 联系人里同事头像的**绿点**（在线）与 AI 会话里生成文件的**📎 下载**；
② 发一条消息后点**撤回**，正文立即消失、搜索也搜不到；③ 群会话头部**改名/成员/移出**与设置页**我的登录会话**。

## 1. 登录与身份（1 分钟）

- 本机（回环）直接打开即进入工作台，左下角显示当前身份。
- 生产/多用户模式：先签发令牌再登录。

```bash
node scripts/add-member.mjs u_alice "Alice" "alice-strong-token" org_local member
# 重启服务端后在登录页输入 成员ID=u_alice / 令牌=alice-strong-token
```

预期：登录后侧栏显示「聊天」，顶部显示成员名；用错令牌返回「成员 ID 或访问令牌不正确」。

## 2. 与 AI 对话并产出文件（3 分钟）

1. 左侧「联系人」→ 点击 `ChatAgent 助理`（带 AI 标签）→ 打开会话。
2. 发送：`请生成一份 Word 周报，内容包括：验收通过`。
3. 观察会话底部出现任务状态条（running → completed），AI 回复中出现「已完成：Created Word document …」。
4. 在「任务」页可以看到该任务：目标、状态、产物、事件日志；点击产物可下载 `.docx`。
5. 发送 `你好` 之类无工具请求：AI 直接回复，不产生文件。

预期：消息 → 任务 → 工具调用 → 产物 → 回复全部落在**同一个原生会话**里。

## 3. 群聊与 @AI（2 分钟）

1. 会话列表右上「＋群聊」→ 输入群名，选择同事（可同时选择 AI 账号）→ 创建。
2. 群内点击「召唤 AI：@ChatAgent 助理」→ 输入框出现 `@ChatAgent 助理`，补上 `请生成一份 Excel 数据表` → 发送。
3. 观察：群里出现 AI 回复与任务状态条；「任务」页中该任务的会话是群会话；未 @ 的消息不会触发 AI。

## 3.05 消息撤回与已读回执（1 分钟）

- 在 AI 或同事会话里发一条消息，气泡右下出现「撤回」：点击后气泡变成「你撤回了一条消息」，正文与附件立刻消失；搜索该内容不再命中（AI 若已引用该内容，那条回复会保留——那是另一条消息）。
- 撤回窗口默认 120 秒（`CHATAGENT_RECALL_WINDOW_SECONDS`，0 表示禁用）；只有发送者本人能撤回，其他人的消息没有「撤回」入口。
- 联系人列表：与你在同一组织、且客户端已连接（事件流在线）的同事头像右上角有绿点，副标题显示「· 在线」。
- 会话头部「导出记录」把当前会话导出为 Word 聊天记录（含撤回占位），适合归档。
- 任意消息气泡「引用」会在输入框上方生成引用条，回复后气泡里显示被引用内容；「转发」可转发到同事或群聊（附件一并共享给目标会话成员）；会话里的 `📎` 附件对**会话参与者**都可下载。
- 与同事的 1:1 会话里，自己最后一条消息下方显示「已读 / 未读」；群聊显示「N 人已读」（AI 不计入），对端打开会话后变为「已读」（群聊不显示部分计数）。

## 3.1 群成员与自助令牌（1 分钟）

1. 打开一个**群会话**：会话头部出现「邀请成员」「退出群聊」；点「邀请成员」选一位同事 → 侧栏群会话人数 +1，被邀请者立即能看到历史（**加人即授予历史读取权，因此该操作写审计**）。
2. 点「退出群聊」：该群从你的列表消失；此后读该群消息/任务/产物都是 404，重新加入**只能由群内成员邀请**（自己再建一次同名同成员的群会被拒：`409`）。
3. 群头部「成员」可查看当前群成员（AI 会带 `AI` 标签），每行可「移出」；「改名」可修改群名，其他在线成员的侧栏标题即时更新。
4. 设置页 →「我的登录会话」：列出你自己的会话，非当前设备可单独「撤销」，也可一键「撤销其他会话」（设备丢失时使用）；令牌与哈希从不显示。
5. 设置页 →「重置我的访问令牌」：旧令牌与所有会话立即失效，页面只显示一次新令牌（重新登录请用新令牌）。

## 4. 搜索、未读、主题（1 分钟）

- 侧栏「搜索聊天记录」输入 `验收`（≥2 字）→ 出现命中列表，点击跳转到对应会话。
- 用另一个成员身份发消息给当前账号 → 会话出现未读徽标，导航「聊天」出现未读总数，浏览器标题显示 `(n)`。
- 左下「深色模式 / 浅色模式」切换，刷新后保持。
- `Ctrl/Cmd + K` 聚焦搜索框；`Enter` 发送，`Shift+Enter` 换行。

## 5. 审批与投递回执（2 分钟）

1. 与 AI 会话发送：`请发送通知给李四`。
2. 任务变为 `waiting_approval`，会话内出现审批卡；此时「审批」页有一条待审批，**outbox 为空**（未外发）。
3. 用发起人自己点「批准」→ 403（不允许自审）；换一个有 owner/admin 角色的成员批准。
4. 批准后点击任务「resume」（或在任务页操作）→ 任务继续执行。
5. 「审批」页 outbox 出现一条记录：
   - `delivered`：内置原生通道把消息投递到成员收件箱（AI 主动消息出现在对应会话）；
   - `simulated`：未配置任何投递通道（不计为送达）；
   - `unknown`：结果未知，**不会自动重发**，需要人工对账。

## 6. 安全自检（1 分钟）

```bash
curl -s localhost:8787/health                       # {"ok":true,"authMode":"..."}
curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer garbage' localhost:8787/api/accounts   # 401
curl -sD - -o /dev/null localhost:8787/ | grep -i content-security-policy                                  # 有 CSP
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8787/api/webhooks/dingtalk -H 'Content-Type: application/json' -d '{}'   # 404（外部通道默认关闭）
```

生产档位下再加一条：无凭据 `GET /api/accounts` 必须返回 401；来自局域网 IP 的请求不再是 owner。

会话边界（G6，可手工复现）：

```bash
# 用 u_bob 的会话令牌尝试写进 u_alice 的 AI 会话（chatId 可推导）→ 必须 403
curl -s -o /dev/null -w '%{http_code}
' -X POST localhost:8787/api/messages   -H "authorization: Bearer $BOB_SESSION" -H 'content-type: application/json'   -d '{"accountId":"<ai-account-id>","chatType":"direct","chatId":"native:agent:<ai-account-id>:u_alice","kind":"text","text":"hi"}'
# 无凭据重置令牌（开发档位回环）→ 必须 401
curl -s -o /dev/null -w '%{http_code}
' -X POST localhost:8787/api/auth/token/rotate
# 超限上传（>20 MiB）→ 必须 413，且 data/uploads/ 不变
```

## 7. 自动化验证

```bash
pnpm typecheck      # tsc + vue-tsc
pnpm test           # 服务端/包 18 文件 173 用例 + 前端 3 文件 26 用例（共 21 文件 / 163）
pnpm build          # tsup + vite
node scripts/restart-server.mjs # 按端口重启服务端并等待 /health
node scripts/smoke.mjs          # 27 项端到端自检（本机开发档位）
node scripts/ui-e2e.mjs         # 真实客户端 E2E：34 项检查 + 截图（Temp/ui-shots）
pnpm build:desktop  # 重新打包 Windows exe → apps/desktop/release/
```

## 8. 桌面端本机 Agent（Gate 7A.2，可手工复现）

安装/解包后的 ChatAgent 桌面客户端（`apps/desktop/release/win-unpacked/ChatAgent.exe`）或开发态 `pnpm desktop:dev`：

1. **关窗常驻**：登录后关闭窗口 → 进程仍在托盘；此时提交的本机任务继续跑完，重开窗口后状态与产物仍在（自动化：`scripts/electron-host-smoke.cjs` 6/6）。
2. **离线工作台**：断开/停掉组织服务器，刷新客户端 → 出现“无法连接到 ChatAgent 服务”，点“打开本机工作台”（或托盘菜单“打开本机工作台（不依赖服务器）”）：可看到设备、执行器、任务列表、提交文档任务、取消/重试、暂停/继续，页面不依赖服务器（自动化：`scripts/electron-workbench-check.cjs` 11/11）。
3. **副作用任务不会被本机批准**：以“副作用任务”提交 → 立即失败并在“说明”列显示 `delegation_missing`，执行次数为 0；只有组织服务下发委托并由用户批准后才可能执行。
4. **显式退出即停止**：托盘“退出（停止后台 Agent）”或工作台“退出” → 后台 Agent 与自有子进程树被清理，任务库锁释放，再次启动可正常接管；直接关窗不会停止 Agent。
5. **稳定设备标识**：设置页本机卡片中的设备号为 `desktop-<uuid>`，重启客户端后不变（存放在用户数据目录 `device.json`）。

## 9. 已知缺口（不是回归）

- 真实第三方 IM 凭据未接入（产品不依赖它们，外部通道默认关闭）。
- 依赖 CVE 未扫描（本机 registry 无 audit 端点）。
- 任务恢复没有租约/多实例互斥；JSON 存储为单进程写入。
- 本机 Agent 的 Gate 7A.3（真实 Hermes + 真实模型的安全办公闭环）未验收；打包 exe 需重跑 `pnpm build:desktop`（本机无网络，electron-builder 无法下载依赖）。
- UI 证据：`pnpm build` + 组件测试（20 例）+ **真实客户端 E2E 34/34**（`scripts/ui-e2e.mjs` 经 CDP 驱动打包 exe，含截图与 WCAG 对比度实测）；CSP 的实际拦截效果未构造 XSS 载荷验证。
- 详细清单见 `docs/security-checklist.md` 第 7 节与 `docs/tasks.md` 的未完成项。
