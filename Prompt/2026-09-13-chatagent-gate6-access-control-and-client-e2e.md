# ChatAgent 增量 Prompt：Gate 6 访问控制修复 + 真实客户端 E2E

日期：2026-09-13（Asia/Shanghai） · 关联：`Prompt/2026-09-13-chatagent-standalone-native-client.md`、`docs/gate6-access-control-fixes.md`、`docs/gate5-standalone-hardening.md`

## 原始指令（脱敏后全文）

接下来从到 2026 年 9 月 13 日早上 6 点整之间的时间中，不断从项目的完整性，项目的实用性，项目的交互性，项目的美观性，项目的安全性进行不断完善迭代优化，可调用子 agent，多网络搜索了解。我在早上六点后进行验收。

## 语义解析与决策

这不是新增功能，而是**在固定时间盒内的多维度质量冲刺**：完整性/实用性/交互性/美观性/安全性五条线并行，允许用子 agent 做独立复核，产出必须可运行、可复现。

按 `incremental-prompt` 的去重规则：目标与上一轮（Gate 5 独立原生化）不同 —— 上一轮是「补齐能力」，本轮是「用独立证据把已交付能力证伪并修掉」，因此**新建记录**而不是追加到 Gate 5 记录末尾。判定依据：

1. 交付物形态不同：Gate 5 交付功能与页面；本轮交付**复核报告 + 回归测试 + 可复现验证脚本**（`scripts/ui-e2e.mjs`、`scripts/restart-server.mjs`、`apps/server/src/membership-security.test.ts`）。
2. 风险等级不同：本轮发现并修复了 1 个 P0（跨用户会话劫持）与 6 个 P2/P3，需要独立留痕以支撑安全审计。
3. 验证手段升级：从「构建 + 组件测试」升级为「真实打包客户端端到端」。

采用的方法论（可复用）：**每轮交给独立子 agent 全权复现 → 报告必须给出 file:line 与可复现命令 → 只修可复现项 → 修复后由同一子 agent 再验证**（第三轮复核 N1–N6 全部 CONFIRMED）。

## 元数据

| 项 | 值 |
| --- | --- |
| 受影响 package | `@chatagent/contracts`、`apps/server`、`apps/web`、`apps/desktop`、`scripts/*` |
| 受影响符号 | `ConversationStore.findOrCreate/findByChatId/addParticipant`（删除 `setParticipants`）、`ChatAgentService.{injectMessage,createGroup,leaveConversation,assertTaskVisible,canReadArtifactShared,appendArtifactMessage}`、`Principal.viaDevFallback`、`STREAM_SECURITY_HEADERS`、`createMemberSchema.id` / `isValidMemberId` |
| 前置权限 | 会话只对参与者开放（非参与者一律 404/403）；建群**只增不减**，键已存在且调用者非参与者 → 409；退群即失去该会话消息/任务/产物；令牌重置必须出示凭据 |
| 数据分类 | 审计新增 `conversation.member_added/left/group_created(含 denied)`、`message.sent`、`upload.rejected`；审计不含消息正文、不含令牌；smoke 审批人令牌移出仓库（`os.tmpdir()`，按地址分文件 + 使用前登录校验） |
| 是否外发 | 本轮不改变外发路径；AI 产物改为以文件消息进入会话，参与者可下载 |
| 幂等/取消语义 | 建群重复提交只做并集（不踢人）；退出后重建不再隐式回归；上传超限拒绝且不落盘 |
| 测试 profile | Mock 离线 + Fastify inject 集成 + Electron/CDP 真实客户端 E2E（`scripts/ui-e2e.mjs`）+ production 档位实测 |
| 未验证边界 | 真实模型/真实第三方 IM 凭据；依赖 CVE 扫描（registry 无 audit 端点）；多实例租约 |

## 实施结果

### 安全性（三轮独立复核）

- **P0 会话劫持**：`POST /api/messages` 的调用方自选 `chatId` + `findOrCreate` 静默加人 → 任意成员可读/注入同事私聊。修复：不再隐式加人 + `injectMessage` 参与者闸门（403 `not_a_participant`）。
- 退出群聊后仍可读/取消该群任务 → `assertTaskVisible`（含列表与 SSE 前置鉴权）。
- 退群不持久 → 建群只增不减 + 非参与者重建 409；孤儿群（无人）允许回收。
- 超限上传静默截断 → `file.file.truncated` + 413 + 审计。
- dev 回退身份可铸造 owner 令牌 → `viaDevFallback` 拒绝（401）；注入身份字符集校验（失败关闭）。
- SSE 缺安全头 → `STREAM_SECURITY_HEADERS`；成员增删/建群/发送/上传拒绝补齐审计；AI 产物对群友可下载。

### 交互性与美观性

- 群成员邀请/退出、个人令牌自助重置（前端 + API + 测试）。
- AI 产物以文件消息进入会话，气泡内即可下载。
- 真实客户端 E2E（`scripts/ui-e2e.mjs`）：**30/30**，含 7 个导航页渲染、深色模式、1024×720 响应式、WCAG 对比度实测（发现 2.8:1 → 修为 4.54/5.10）。
- 事故留痕：`SettingsView.vue` 的 `<style>` 曾误插进模板中间，`vite build` **不报错**、页面照常 200 → 补 `views.render.test.ts` 逐页渲染守卫。

### 完整性/实用性

- `scripts/restart-server.mjs`：按端口定位真实监听进程 + 等 `/health`（消除「旧进程占端口导致新构建未生效」）。
- `scripts/smoke.mjs`：审批人缓存按地址分文件并**使用前登录校验**。
- 空数据目录 + production 档位开箱验证：接口 **27/27**、打包客户端 **30/30**。

## 验证

```bash
pnpm typecheck                     # 0 错误
pnpm test                          # 21 文件 / 149 用例全绿
pnpm build                         # tsup + vite
node scripts/restart-server.mjs    # /health ok
node scripts/smoke.mjs             # 27/27
node scripts/ui-e2e.mjs            # 30/30（真实 exe + 截图）
```

独立子 agent 复核结论：P0 + 6 项 P2/P3 CONFIRMED FIXED，N1–N6 CONFIRMED，并给出 NEW-1/2/3 的收尾修复与 NEW-4（AI 回复不逐条审计）的明确取舍。

## 后续轮次（2026-09-13 04:20–04:35，同一时间盒内继续迭代）

### 本轮新增切片

- **消息撤回**（完整性/交互性）：`POST /api/messages/:id/recall`，仅发送者、窗口内（`CHATAGENT_RECALL_WINDOW_SECONDS`，默认 120s）、幂等；正文与附件从会话历史、搜索、会话预览、**模型上下文**同时消失，广播 `message_recalled` 让其他客户端即时替换气泡；前端自己的消息出现「撤回」，撤回后显示占位文案；审计 `message.recalled`（不含正文）。
- **长会话渲染缺陷修复（真实事故）**：`ChatView` 的「加载更早的消息」曾是消息列表的同级 `v-else-if` 分支，任何 >50 条的会话因此**只显示加载按钮、不显示气泡**。UI E2E 在演示会话自然超过一页后抓到（`conversation history rendered — 0 bubbles`），已移入线程内部并补前端回归测试。
- **会话管理**：`GET/DELETE /api/auth/sessions`（列出自己的会话、撤销单个、撤销其他全部；不含令牌/哈希），单成员会话上限 20，前端设置页表格与「撤销其他会话」。
- **在线状态**：`GET /api/presence` + `MemberView.online`（= 是否有已认证事件流），前端绿点与「· 在线」；现场实测开流/断流切换正确，仅同组织可见。
- **zip 层炸弹防护**：`packages/document/src/zip-guard.ts` 在解析前检查中央目录（条目 2000 / 单条目 64 MiB / 总量 200 MiB / 压缩比 200:1），超限 413；现场验证 71 KB 炸弹被拒、正常 docx 正常解析。
- **会话导出 Word 记录**：`POST /api/conversations/:id/export`（参与者限定、撤回内容仅 `[已撤回]`、导出件归属导出者、审计 `conversation.exported`），前端「导出记录」按钮。
- **文档解析资源上限**：`packages/document/src/limits.ts`（文本 20 万字符、段落 2000、工作表 50、单表 2 万行、预览 10 行；行数按真实值上报），补两项单元测试；zip 层炸弹检测仍未做（已记录）。
- **已读回执（1:1）**：`GET /api/conversations/:id/read-receipts`，仅参与者可读，AI 账号不计入；前端在自己最后一条消息下显示「已读/未读」，群聊不显示部分计数。
- **E2E 断言改为锚点式**：气泡计数会在分页裁剪时失效，改为「以唯一 marker 定位气泡、再断言其后/其本身的内容」，撤回断言进一步锚定到 `.bubble-row.mine`，避免被 AI 引用文本干扰。

### 验证

- `pnpm typecheck` / `pnpm build` 通过；`pnpm test` **21 文件 / 186 用例**（服务端与包 162 + Web 24）全绿；冒烟 27/27；客户端 E2E **33/33**。

### 复核轮 4（撤回/回执/审计/面板）与修复

- 独立复核确认撤回的 8 条读取面干净、回执越权正确、长会话修复有效；发现 4 项问题并全部修复：任务快照与 `goal` 的撤回脱敏（NEW-1）、`ai.message_sent` 挂错函数（NEW-2）、已撤回消息仍计未读（NEW-3）、群成员面板读缓存（NEW-5），另修 NEW-6/7/9（撤回窗口下发、禁用与过期区分、图标导入）。
- 验证：`pnpm typecheck` / `pnpm build` 通过；`pnpm test` **21 文件 / 178 用例**；冒烟 **27/27**（新增撤回/回执/导出/会话/在线等 11 项）；客户端 E2E **33/33**。

### 复核轮 5（zip 守卫与撤回脱敏）修复

- 复核确认群管理/会话管理/在线状态无缺陷；两个 P1 已修：zip 守卫改为**实测**解压（撒谎的中央目录不再能绕过，实测 71 KB 炸弹 413）、`resume` 改用脱敏 goal；另修任务事件脱敏、解析失败 400、解析先于落盘、online 字段一致、匿名批量撤销 401。

### 群聊已读计数与验收脚本

- 群聊显示「N 人已读」（复用既有回执接口，AI 不计入）；`scripts/acceptance.mjs` 一条命令跑完类型检查→测试→构建→重启→冒烟→客户端 E2E。
- 客户端 E2E 在**空数据目录 + production 档位**的全新实例上 33/33（顺带修掉脚本对「全新部署无会话」的假设）。

### 群管理（改名 / 移出成员）

- `PATCH /api/conversations/:id`（改名，参与者限定、广播 `conversation_updated`）与 `DELETE /api/conversations/:id/members/:memberId`（显式移出，被移出者立即失去访问权），均写审计；自助退出仍走 `/leave`。前端：群头部「改名」、成员面板「移出」。
- 验证：`pnpm test` **21 文件 / 181 用例**、冒烟 27/27、客户端 E2E 33/33。

## 未完成 / BLOCKED

- 依赖 CVE 扫描：BLOCKED（npmmirror 无 audit 端点）。
- 真实第三方 IM 与真实模型凭据：BLOCKED（未提供；默认关闭外部通道，`simulated` 不计为送达）。
- AI 回复未逐条写审计（取舍：避免日志放大；如需合规追溯应在 `appendAssistantMessage` 加不含正文的结构化审计）。
- 多实例租约/互斥、JSON 存储并发写、压缩炸弹与解析资源上限。
