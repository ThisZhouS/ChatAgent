# Tree / packages

## 用途

可复用库包，按边界拆分；`apps/server` 是唯一组合根。包之间只允许依赖 `@chatagent/contracts` 或向下的稳定包。

## 目录说明

- `contracts/`
  - `src/types.ts` 领域类型（Principal/MemberRecord、账号/会话（origin/targetKind/targetId）/任务/产物归属、`TaskState`、`TERMINAL_TASK_STATES`、Gate 4 的 `ApprovalRecord`/`ApprovalAction`/`OutboxRecord`/`DeliveryState`、`DEFAULT_ORGANIZATION_ID`/`LEGACY_OWNER_ID`、文档摘要、Agent 事件）
  - `src/schemas.ts` Zod 入站/生成契约（sender 字段可选且不参与认证）
  - 消费者：所有其他包与前端。
- `hermes/`
  - `src/runtime.ts` `HermesAgentRuntime` 工具调用循环，返回判别式 `RunOutcome`
  - `src/types.ts` `RunOutcome`/`RunFailureCode`/`ToolContext`（含可信 scope）
  - `src/tools.ts` `ToolRegistry`、`makeTool`
  - `src/providers/mock.ts` 离线确定性提供商
  - `src/providers/openai-compatible.ts` OpenAI 兼容提供商
  - `src/system-prompt.ts` 账号人设与工具说明组装
  - `src/memory.ts` 会话记忆
  - 测试: `src/runtime.test.ts`、`src/runtime.outcome.test.ts`
- `document/`
  - `src/word.ts` Word 解析(`mammoth`)与生成(`docx`)
  - `src/excel.ts` Excel 解析/生成(`xlsx`)
  - `src/document-service.ts` 文件类型检测与统一解析
  - `src/tools.ts` 文档 Agent 工具（`parse_document` / `create_word_document` / `create_excel_document`），zod 严格校验 + `ArtifactScope` 归属
  - 测试: `src/document-service.test.ts`
- `im-gateway/`
  - `src/types.ts` `ImGateway` 接口、`NormalizedInbound`、`WebhookVerificationResult`、`SendResult.state`（simulated|accepted|delivered|failed|unknown）
  - `src/normalizers.ts` 钉钉/飞书/企业微信/QQ payload 规范化
  - `src/memory-gateway.ts` 内存模拟网关（send → `simulated`，verify → simulated）
  - `src/webhook-gateway.ts` Webhook 网关：HMAC/token 验签、时间窗、未配置材料时 fail closed；出站超时/业务错误映射为 `unknown`/`failed`
  - 测试: `src/normalizers.test.ts`
- `task-engine/`
  - `src/engine.ts` `TaskEngine`（claim/终态 CAS/结果映射/恢复/`resume`/停止）
  - `src/types.ts` `TaskOutcome`/`TaskHandlerResult`/`CancelResult`
  - `src/memory-store.ts` 内存任务存储
  - `src/json-file-store.ts` JSON 持久化 + 旧记录迁移
  - 测试: `src/engine.test.ts`（含取消竞态、恢复、stop）

## 关键符号

- `HermesAgentRuntime.run(request)` — 执行一次 Agent 回合。
- `ModelProvider.complete(request, signal)` — 模型抽象。
- `createDocumentTools(options)` — 文档工具工厂。
- `ImGateway.handleWebhook(payload)` / `accept(message)` — IM 入站。
- `TaskEngine.submit(input)` / `cancel(id)` / `onEvent(listener)` — 任务编排。
