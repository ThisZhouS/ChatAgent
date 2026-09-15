# 迭代计划与记录：2026-09-14 晚 → 2026-09-17 23:00 验收

目标：按 **完整性、实用性、交互性、安全性** 四个维度持续迭代 ChatAgent，每轮保持全量验证绿，最终产出四维验收报告。
约束：不动用户未提交文件（Prompt/2026-09-14-*.md、docs/project-brief.md、docs/tasks.md）；不接付费模型、不发真实消息、不自动装重型依赖；提交仅限本人文件且显式列路径。

## 基线（2026-09-14 22:20 实测）

- `tsc --noEmit` / `vue-tsc --noEmit`：0 错
- vitest：根 192 通过（20 文件）+ web 28 通过（3 文件）= 220 用例
- scripts/acceptance.mjs：6/7 步通过；client E2E 33/34（dark contrast 2.56 为负载下偶发，重跑 34/34，worst dark=6.52 / light=5）
- `pnpm audit`（npmjs）：41 advisories（0 critical / 12 high / 22 moderate / 7 low）
- 服务器已具备：CSP/nosniff/frame-options/referrer-policy/permissions-policy/COOP、登录限流（IP+账号）、HttpOnly+SameSite=Strict 会话 Cookie、app.security.test.ts 12 项

## 审计发现（含子代理失败的替代：本地定向审计）

### 安全性
1. ✅【已修】Electron IPC 未校验 sender（官方清单 #17）→ main.cjs 增加 `isTrustedSender`（仅本应用 frame 可调 host 桥/quit-app）。
2. ✅【已修】ini@1.3.4 原型污染（high，dev 链）→ override ^1.3.8。
3. ✅【已修】esbuild@0.27.7 开发服务器任意文件读（low，dev 链）→ override ^0.28.2。
4. ✅【已修】vitest/@vitest/mocker 路径穿越（moderate，dev 链）→ vitest ^3.0.5 → ^4.1.11（192+28 用例全过）。
5. ⏳【评估中】Electron 33.2.0 → 39.8.x：可消掉 ~25 条 high/moderate（渲染进程逃逸升级链）。当前渲染面已最小化（仅加载本服务源、导航锁定、权限拒绝、CSP、sandbox），利用前提苛刻，但升级是正解。步骤：镜像下载 win32-x64 zip → electron 缓存 → install.js → 全量回归 + 桌面启动/冒烟 → 失败即回退。
6. ⚠️【记录】extract-zip <=2.0.1（high，符号链接逃逸）：官方 advisory 声称 >=2.0.2 已修但 npmjs 最新仍为 2.0.1，无可用补丁版；仅 electron 安装器（dev 时）使用，不影响产品运行时。持续关注。
7. ⚠️【记录】app-builder-lib/builder-util-runtime（electron-updater 相关，high）：仅打包链使用；升级需与 electron-builder 26 大版本联动，安排在桌面 exe 重建批次一起评估。
8. ✅【确认无问题】localStorage token：CSP `script-src 'self'` 且无 v-html/eval，注入面已堵；企业内网可接受，记录为设计决定。

### 交互性
1. ✅【已修】E2E 对比度检查在主题过渡期可能误报 → 增加一次 900ms 复测 + 失败时输出逐选择器明细（明/暗两处）。
2. ⏳【待做】聊天细节：Enter 发送/Shift+Enter 换行确认、滚动锚定、未读徽标一致性、断线重连提示（待 UI 定向审计补充）。

### 完整性
1. ⏳【待做】桌面 exe 重建（NSIS）：Gate 7A 构建链已接好但未打包；验收前应产出可安装包。
2. ⏳【待做】本地任务回执 → 服务端可见性（Gate 7A 报告的"下一步"）。
3. ✅【确认】源码无 TODO/FIXME 残留；文档密钥扫描仅命中文档示例。

### 实用性
1. ⏳【待做】（待定）会话/消息检索、任务列表筛选、文档预览入口——待进一步审计后择优。

## 验证记录

| 时间 | 命令 | 结果 |
|---|---|---|
| 09-14 22:20 | tsc + vue-tsc | 0 错 |
| 09-14 22:20 | vitest 根 / web | 192 / 28 通过 |
| 09-14 22:41 | pnpm install（overrides ini/esbuild） | 成功，audit 41→39 |
| 09-14 22:52 | vitest ^4.1.11 升级 + 根/web 回归 | 192 / 28 通过，audit 39→37 |
| 09-14 22:5x | ui-e2e 重跑 | 34/34，dark worst=6.52 |
| 09-14 22:41 | acceptance（修改前基线） | 6/7（E2E 33/34 为偶发） |
| 09-14 23:0x | electron 33.2.0→39.8.10（镜像 zip→缓存→手动解包） | 启动测试+关窗续跑 smoke 6/6 通过 |
| 09-14 23:1x | electron-builder 25.1.8→26.16.1（消 app-builder-lib/builder-util-runtime high） | audit 37→2 |
| 09-14 23:2x | 桌面 exe 重建（NSIS，102MB，electron 39.8.10） | 成功（镜像偶发 504/DNS，重试后通过） |
| 09-14 23:3x | 新 exe client E2E（scripts/ui-e2e.mjs） | 34/34 通过 |
| 09-15 00:4x | 本地任务回执闭环（contracts+server store/路由+web api+设置页同步+任务页展示） | tsc/vue-tsc 0 错；local-tasks.test.ts 7/7 |
| 09-15 00:5x | 测试发现并修复真实缺口：local-tasks 路由缺 isAuthenticated（生产模式匿名可写） | 已修，测试 7/7 |
| 09-15 00:5x | 根 vitest 全量 | 199/199（21 文件）；web 28/28 |
| 09-15 01:0x | E2E 自身消息等待 20s→40s（acceptance 负载下超时偶发） | acceptance 重跑确认 |

## 截止调整说明

用户将验收截止从 2026-09-17 23:00 提前至 **2026-09-15 08:00**。相应收缩范围：跳过"消息检索"等新功能项，优先保证已开工批次全部收口（安全依赖批次、桌面 exe 重建、本地任务回执闭环）、全量验证绿、里程碑提交与四维报告。

## 下一步排序

1. ~~Electron 39 升级评估~~ ✅（已实施并回归）。
2. ~~桌面 exe 重建~~ ✅（builder 26.16.1 + electron 39.8.10，NSIS 102MB）。
3. ~~本地任务回执闭环~~ ✅（服务端+web+测试；含真实 auth 缺口修复）。
4. ~~UI 交互定向审计~~ ✅（审计确认 Enter/Shift+Enter、滚动锚定、未读徽标、断线横幅、空态/加载态均已具备；对比度检查加固复测）。
5. ~~acceptance 7/7 确认 → 里程碑提交 → 四维验收报告~~ ✅（5349ff6 + 3dbaa89 已推送）。

## 第二波（截止延至 2026-09-15 20:00）

用户将验收点延至 20:00。定向核对发现：消息级检索（`/api/search` + ChatView 防抖搜索）与持久化/召回排除测试**均已存在**（上轮报告误列为遗留项，已更正）。本波补齐三处真实缺口：

1. **搜索命中跳转 + 高亮**：`openSearchHit(hit)` 现在携带消息 id——选中会话后 `data-message-id` 定位气泡、平滑滚动居中并闪烁高亮 1.8s（长历史中可直接找到命中消息，而非只打开会话到最新页）；jsdom 缺 scrollIntoView 已在组件测试中 stub 验证（ChatView.test.ts 新增用例）。
2. **本机回执自动刷新**：任务页每 30s 轮询本地任务回执（卸载清理定时器），桌面端同步节奏变化无需手动刷新。
3. **审计日志筛选**（管理员）：动作关键字 + 结果级别（成功/拒绝/失败）客户端过滤，空态提示；SettingsView.test.ts 新增用例（admin 视角 + 行数断言限定审计卡片）。

验证：tsc/vue-tsc 0 错；根 vitest 199/199（21 文件）；web vitest **30/30**（+2 新用例）。

### 下一步

- acceptance 7 步回归确认 → 里程碑提交 → 更新四维报告（20:00 前）。

## 第三波（应用文档链路：E2E 驱动发现两个真实缺陷）

为"文件"页补端到端断言（此前只验证页面能渲染），在打包客户端里真实上传 CSV 并断言解析预览表格，结果暴露出两个真实缺陷：

1. **文档解析在桌面端必然 401**：`api.documents.parse` 用裸 `fetch`，既不带 `Authorization`，又因打包客户端页面来自 `file://`（跨源）而带不上会话 Cookie → 解析永远失败。同文件的 `api.documents.upload` 反而是对的，属实现不一致。修复：抽出带会话凭据的 multipart 助手 `postForm()`（保留 401 → 清 token + 通知监听者），`parse` 与 `upload` 统一走它；新增 `apps/web/src/api.test.ts` 回归（断言 Authorization 存在、FormData 不被塞 Content-Type）。
2. **UTF-8 中文 CSV 乱码**：SheetJS 对 buffer 文本会自行嗅探代码页且不选 UTF-8，中文表头/单元格变成 `é¡¹ç®®`。修复：分隔文本（CSV）改为自己解码——UTF-8（容忍 BOM）优先，失败回退 GBK（中文 Windows Excel 默认编码），再以 `type: 'string'` 交给 SheetJS；新增 3 个文档包测试（UTF-8 中文、GBK 回退、BOM）。

同时补齐实用性缺口：解析结果里**本就带**每表前 10 行预览数据，但界面只显示行列数——现在渲染成真实表格（列数上限 8，超出提示下载原文件；空表显式提示），并新增 `DocumentsView.test.ts`（走真实 file input 路径）。

证据：`ui-e2e` **37/37**（新增"documents view renders the parsed CSV preview table"，真实显示 `项目 预算 差旅 12000 培训 8000`）；根 vitest **202/202**；web vitest **34/34**；tsc/vue-tsc 0 错。
