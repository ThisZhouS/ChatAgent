# ChatAgent UI 蓝本 / UI Blueprint

前端技术：Vue 3 + Element Plus + Vite。服务端契约见 `docs/architecture.md` 与 `apps/server/src/app.ts`。

## 信息层级与导航

- 侧边导航（`el-menu`，深色侧栏）：工作台 / 会话 / 任务 / 文件 / 账号 / 设置。
- 移动端（<900px）侧栏转为横向滚动，内容列自动堆叠为单列。

## 页面交互

### 工作台 DashboardView

- 触发：登录后默认进入。
- 展示：模型运行时、账号在线/总数、任务统计、可用工具标签、快速入口。
- 状态：加载中显示占位；接口失败显示 `el-alert` 错误；无工具显示空态。

### 会话 ConversationsView

- 触发：点击“会话”。
- 输入：账号下拉、发送者、消息文本；回车或点击发送。
- 校验：无账号或空消息时不允许发送。
- 加载：发送按钮 loading；消息流每 1.5s 轮询刷新。
- 成功：新建/切换到目标会话并展示消息；失败顶部 `el-alert`。
- 空态：无会话/无消息显示 `el-empty`。
- 恢复：选择会话后重新拉取消息并恢复轮询。

### 任务 TasksView

- 触发：点击“任务”。
- 输入：账号、目标文本域；点击“创建并执行”。
- 加载：创建后自动选中任务；任务详情通过 SSE 实时追加事件。
- 状态：`pending/running/waiting_input/completed/failed/cancelled` 映射为 `el-tag` 类型。
- 取消：仅 running/pending 可取消，完成后禁用。
- 恢复：重选任务重放历史事件并重新订阅 SSE。

### 文件 DocumentsView

- 触发：点击“文件”。
- 上传解析：`el-upload` 拖拽/点击，自动上传关闭，手动调用 `/documents/parse`。
- 生成 Word：标题 + 段落文本域。
- 生成 Excel：文件名、Sheet、表头、数据行。
- 状态：解析 loading、结果预览、失败 `el-alert`、空态 `el-empty`。
- 文件库：`el-table` 展示上传/生成物，生成物可下载。

### 账号 AccountsView

- 触发：点击“账号”。
- 输入：账号名、显示名、平台、人设、白名单（逗号分隔）。
- 校验：账号名/显示名必填。
- 操作：上线/下线切换；列表实时刷新。
- 状态：`online/busy/offline` 映射 `el-tag`。

### 设置 SettingsView

- 展示运行状态与真实模型接入方式（只读）。

## 组件状态规范

每个数据面板覆盖：加载中、空态、错误、成功、禁用、恢复路径。按钮统一使用 `loading`/`disabled` 表达进行中与不可用；错误统一 `el-alert`。

## 响应式与可访问性

- `el-row/el-col` 栅格：桌面双列/三列，窄屏单列。
- 所有交互控件为原生可聚焦组件；输入框带 `label`。
- 消息列表与事件日志可滚动，固定高度避免布局跳动。
- 颜色不单独承载状态，状态同时以文本标签呈现。

## 验证命令

```bash
pnpm --filter @chatagent/web run typecheck
pnpm --filter @chatagent/web run build
pnpm dev   # 浏览器验证（需可用浏览器 provider）
```
