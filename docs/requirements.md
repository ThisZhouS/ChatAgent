# ChatAgent 需求 / Requirements

> 以验收信号为优先级排序。每个需求标注 F(功能)/Q(质量)/C(约束)。

## R1 账号与权限（F/C）

- R1.1 系统可创建、启停、编辑 AI 账号；账号属于某个 IM 平台并具有独立显示名与系统人设。
- R1.2 每个账号可配置发送者白名单；非白名单消息可被忽略或要求人工确认。
- R1.3 账号状态（online/offline/busy）可在工作台查看。

## R2 消息接入（F）

- R2.1 提供规范化 IM 消息模型：direct/group、text/file/image/mixed、mentions、附件。
- R2.2 提供 Webhook 接收端点 `/api/webhooks/:channel`，可按平台规范化钉钉/飞书/企业微信/QQ 的入站消息。
- R2.3 提供内存模拟网关与工作台消息注入，保证无真实凭据可演示。

## R3 Agent 运行时（F）

- R3.1 以工具调用循环执行任务：模型规划 → 工具调用 → 观察结果 → 继续/完成。
- R3.2 支持 OpenAI 兼容模型提供商与内置 MockProvider。
- R3.3 运行时事件可流式订阅：思考/工具开始/工具结果/最终回复/错误。
- R3.4 工具注册表可扩展，工具具有名称、描述、JSON Schema 输入。

## R4 文档处理（F）

- R4.1 解析 .docx 提取正文文本与表格结构摘要。
- R4.2 解析 .xlsx/.xls/.csv 提取工作表与行列数据。
- R4.3 生成 Word 文档（标题、段落、表格）。
- R4.4 生成 Excel 工作簿（多 sheet）。
- R4.5 将文档处理能力暴露为 Agent 工具：`parse_document`、`create_word_document`、`create_excel_document`。

## R5 任务引擎（F/Q）

- R5.1 任务具备 pending/running/waiting_input/completed/failed/cancelled 状态机。
- R5.2 任务异步执行，支持并发上限、失败重试、取消。
- R5.3 任务可携带输入（消息、文件、目标描述）并产生结果/产物/事件日志。
- R5.4 任务执行事件通过 SSE 推送到工作台。

## R6 文件转发（F）

- R6.1 网关抽象支持 `sendMessage` / `sendFile`。
- R6.2 在无真实凭据时，转发动作记录到网关出站邮箱并在工作台展示。

## R7 工作台 UI（F/Q）

- R7.1 侧边导航：会话、任务、文件、账号、设置。
- R7.2 会话视图可查看消息、注入测试消息、查看 AI 回复与工具调用事件。
- R7.3 任务视图可创建/取消任务并实时看进度。
- R7.4 文件视图可上传解析、生成 Word/Excel 并下载。
- R7.5 账号视图可创建/启停账号并设置白名单。
- R7.6 关键流程有加载、空态、错误与成功反馈；键盘可聚焦；控制台无项目错误。

## R8 质量与运维（Q/C）

- R8.1 根目录可复现：`pnpm install`、`pnpm typecheck`、`pnpm build`、`pnpm dev`。
- R8.2 配置通过环境变量注入，示例在 `.env.example`；不提交密钥。
- R8.3 核心包具备单元测试（hermes 工具循环、文档解析/生成、任务状态机）。
- R8.4 健康检查 `/health` 与 agent 状态 `/api/agent/status`。
- R8.5 无外部模型依赖时全链路可运行（MockProvider）。

## 非功能验收信号

- 一个用户从“发消息/上传文件”到“看到结果文件与事件日志”的闭环可在本地完成。
- 接真实 OpenAI 兼容模型时，仅改环境变量即可切换，不改业务代码。
