# 实现契约

以下代码是待实施设计示例，不是现有导出。先修结果传播和取消竞态，再迁移持久化；不要把整页粘入一个 service。

```ts
type RunOutcome =
  | { status: 'succeeded'; summary: string; artifactIds: string[]; deliveryIds: string[] }
  | { status: 'failed'; code: string; message: string; retryable: boolean }
  | { status: 'cancelled'; reason: string }
  | { status: 'waiting_approval'; approvalId: string }
  | { status: 'waiting_input'; question: string }
  | { status: 'incomplete'; reason: 'step_limit' | 'output_limit' | 'delivery_unknown' };

interface ExecutionScope {
  organizationId: string;
  requesterId: string;
  agentId: string;
  conversationId: string;
  taskId: string;
  runId: string;
  policyVersion: number;
}

interface AgentExecutor {
  execute(scope: ExecutionScope, signal: AbortSignal): Promise<RunOutcome>;
}
```

正式接口还需任务输入、受限能力句柄等；这里展示结果和可信身份显式传递。模型参数不可覆盖 ExecutionScope。

## 第一刀：跨层结果

1. hermes/types 增加判别结果；统一领域结果或可识别异常约定，禁止空字符串猜失败。
2. runtime 向上传递 provider 失败、取消、截断、步数耗尽、无效响应；模型 stop 不是业务完成证明。
3. service.runTask 移除成功兜底，按任务种类验收产物/回执；待审批不能返回成功。等待必要异步消息写入，避免 void 丢失错误。
4. task-engine handler、contracts、Web 映射和旧存储兼容同步更新。

普通聊天回答不强制有文件；生成任务验证产物，发送任务验证定义好的交付证据。

## 状态与竞态

建议 pending → running → waiting_input/waiting_approval/retry_wait → running → completed/failed/cancelled。incomplete 映射明确可恢复状态或失败码，不算完成。迁移前不只加 UI 字符串。

- 状态通过集中状态机和持久 CAS 提交：id + version + 合法前置 state；提交后递增 version。
- 取消先提交则后来的完成 CAS 失败；完成先提交则取消报告已完成，不让双方都成功。
- 终态与事件同事务；事件监听器失败不能破坏任务业务记录。
- AbortSignal 传播模型请求、Hermes 协议/进程、支持取消的工具，并有 deadline。signal 不能保证撤回已经发生的外发。
- 外发中取消且上游结果未知，停止后续步骤并保留 unknown 供对账，不宣称全部撤销。
- 同会话历史、消息顺序和任务提交有一致顺序或明确并发分支；文件版本冲突拒绝覆盖或生成新版本。
- start 恢复持久待办/审批；running 用租约或等效机制处理崩溃，不全量重跑。stop 停止领取并等待/取消当前工作，释放租约。

## 统一工具入口

```text
校验工具名、参数、大小
 → 加载服务端 scope 与最新资源版本
 → requester ∩ delegation ∩ resource ACL ∩ tool policy
 → 解析唯一收件人和不可变 artifact ID
 → 必要审批（绑定 action digest）
 → 持久幂等记录与 outbox
 → 受限凭据、时限内执行适配器
 → 持久回执 / unknown / 错误与审计
```

审批消费与 outbox 写入尽可能同事务；审批后复核撤权、成员变化和到期。审批不能直接调用无授权的发送函数。

模型 tool call ID 只匹配协议，不是业务幂等键；重试可能换 ID。业务键基于任务、持久 step、目标及批准载荷版本。同键不同载荷冲突；用户有意重复发送应创建新的授权步骤。

本地事务不能保证远程 exactly-once。优先网关幂等/回执查询；超时先查证，不盲目重发；无查证能力标 unknown 由有权限的人确认。

## 参数、预算与文件

- 无效 JSON/schema/未知工具：结构化错误、零副作用，不 String(undefined)、不补虚构业务默认值。
- 数字/布尔/null 保持声明类型；路径、SQL、收件人、URL 不能自由扩大高权限范围。
- Mock 只在显式 demo/test 允许；生产缺配置报告未配置或拒绝启动。
- 区分认证/限流/服务故障/超时/协议损坏/业务拒绝；有限退避仅适用可安全重试步骤。
- 历史、文件、工具输出、模型输出、总时间均有预算；上下文上限不等于推荐填满。
- 原始错误与模型协议字段可能敏感，日志脱敏；UI 显示操作摘要而非推理原文。
- saveArtifact 接受可信 scope，保存时绑定 task/run/owner；返回 ID/版本/摘要，不暴露任意本地路径。
- 列表、预览、下载、转发再次授权；同名文件澄清，不靠 UUID 难猜充当权限，不用全局差集归属。

## SSE

任务进度可继续 SSE，不因聊天产品就全量换 WebSocket。增加持久序号、游标补发、去重、终态、断线恢复；历史快照与订阅之间不能漏事件。认证授权、断线清理、背压需测试。双向聊天/在线状态确有需求再选 WebSocket。
