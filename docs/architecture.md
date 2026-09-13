# ChatAgent 架构 / Architecture

## 顶层分层

```text
┌────────────────── apps/web · apps/desktop (原生聊天客户端) ──────────────────┐
│  登录 / 聊天（联系人·会话·消息·附件·审批卡） / 任务 / 文件 / 账号 / 设置      │
└───────────────────────────────────┬─────────────────────────────────────────┘
                                    │ REST + SSE (Vite dev 代理 /api)
┌───────────────────────────────────▼─────────────────────────────────────────┐
│ apps/server (Fastify)                                                       │
│  - 装配：账号仓库、消息路由、任务引擎、IM 网关、Hermes 运行时、文档工具        │
│  - 端点：/health /api/* /api/webhooks/:channel                               │
└──────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────┘
       │              │              │              │              │
  im-gateway     task-engine      hermes         document      contracts
 (IM 适配/规范化) (任务状态机)   (Agent 运行时)   (Word/Excel)   (类型与校验)
```

## 数据流（一次消息驱动的任务）

1. 入站消息来自原生客户端（`POST /api/conversations/:id/messages`）或可选适配器 `POST /api/webhooks/:channel`（默认关闭）。
2. `im-gateway` 把平台 payload 规范化为 `Message`。
3. `server` 做账号路由与白名单校验，创建/延续 `Conversation`。
4. `task-engine` 创建任务 `pending → running`。
5. `hermes` 在任务上下文中运行工具循环，通过 SSE 发事件。
6. Agent 调用 `document` 工具或 `im-gateway` 出站动作，产生结果/产物。
7. `task-engine` 置 `completed`，结果写回会话并可由网关回传。

## 关键模块边界

- `@chatagent/contracts`：唯一稳定契约层，其他包都依赖它，不允许反向依赖。
- `@chatagent/hermes`：不依赖 IM/文档/任务，只依赖 contracts；通过 Tool 接口注入能力。
- `@chatagent/document`：纯处理库 + 工具工厂，不感知 IM。
- `@chatagent/im-gateway`：只做消息规范化与收发抽象，不感知文档/模型；**默认不启用任何第三方通道**（`CHATAGENT_ENABLE_EXTERNAL_CHANNELS=false`）。
- `@chatagent/task-engine`：只做任务编排与持久化，不感知具体工具。
- `apps/server`：唯一的组合根（composition root）。
- `apps/web`：仅通过 `/api` 与 SSE 消费服务端能力。

## 运行时设计

- `HermesAgentRuntime` 执行 ReAct 式循环：
  1. 组装 system prompt（账号人设、能力说明、安全规则）与历史消息。
  2. 调用 `ModelProvider.complete` 请求工具调用。
  3. 解析 tool_calls，逐个经 `ToolRegistry` 执行。
  4. 将工具结果作为 tool 消息回填，重复直至产生最终文本或达到 `maxToolSteps`。
- `MockProvider`：无网络，基于工具名给出确定性工具调用，保证离线验收。
- `OpenAICompatibleProvider`：`POST {base}/chat/completions`，支持任意 OpenAI 兼容网关。

## 任务状态机

```text
pending → running → completed
   │         │
   │         ├→ waiting_input → running
   │         ├→ failed
   │         └→ cancelled
```

## 持久化

`apps/server` 默认将数据写入 `CHATAGENT_DATA_DIR`（默认 `./data`）：

- `accounts.json` / `conversations.json` / `messages.json`
- `tasks.json`
- `uploads.json` + `uploads/`（上传文件）
- `artifacts.json` + `artifacts/`（生成文件）

文件内容按需从磁盘读取，元数据以 JSON 索引；重启后状态保留。生产环境可将各 Store 替换为数据库实现。

## 安全边界

- 入站消息一律视为不可信输入。
- 白名单在账号层生效；外发/破坏性工具默认记录审计事件。
- 模型密钥只从环境变量读取，永不落库、不返回给前端。
