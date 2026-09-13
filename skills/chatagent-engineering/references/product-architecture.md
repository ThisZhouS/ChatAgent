# 产品与框架方向

## 三个产品层与一个开发工具

| 层 | 职责 | 不负责 |
| --- | --- | --- |
| 内网聊天 | 员工身份、组织/联系人、私聊/群聊、消息同步、文件、AI 成员 | 执行模型返回的任意 shell 或服务器路径 |
| 助手控制层 | 委托、权限、任务、审批、产物、交付、审计 | 用回答文本替代授权和终态 |
| Hermes 执行层 | 在受限上下文和能力内规划、调用工具、使用记忆/技能 | 持有全组织管理员凭据或绕过审批 |

DeepSeek Harness 是开发这些层的工具，不是产品运行时，也不能作为企业授权来源。

## 推荐 MVP（设计建议，不是已实施功能）

单组织内网，人类和 AI 共用账号/会话基础，但类型明确。AI 有 owner、有效期、权限范围和暂停/撤权能力；个人助手和团队助手区分可见记忆。生命周期：创建 → 配置 → 启用 → 暂停/撤权 → 归档。

先交付：员工发任务与附件 → 持久任务 → 文档产物 → 预览审批 → 发给授权同事 → 收件人可下载。先支持一个聊天交付后端，不同时承诺四个平台，不先做音视频、朋友圈、全量 OA。

原生内网聊天与外部 IM 分里程碑；外部平台按真实企业授权与接口能力适配，不能把 bot/app API 写成个人账号登录。现有简报和用户目标冲突先记录 ADR，未确认前不做不可逆平台重写。

## 真正复用 Hermes

保留当前 packages/hermes，先抽 AgentExecutor 端口，分别提供显式 Mock、现有实验实现和 HermesExecutor。生产选择 Hermes 时连接失败不能静默切 Mock。

建议固定上游版本，在受控进程/容器中运行 Hermes，通过项目自有适配器协议接 TS。这是待实施方案，不声称上游已有特定 HTTP API：先核实选定 commit 的 Python 导入/CLI/gateway 扩展入口，再确定包装形态。

PoC 记录上游 commit/tag、许可证、启动入口、工具注册、会话/记忆隔离、取消、进程故障、真实产物。包名和 mock 输出不算集成证据。不拷贝全部仓库再维护一套同名循环。

Hermes 的默认工具不自动获得企业授权。工具走 capability-scoped broker，网络/目录/进程隔离由环境执行；提示词不是沙箱。跨用户记忆隔离，自动生成技能需审查和负责人批准后发布。

## 渐进架构

```text
Vue / Electron
  → Fastify: authentication → resource policy → services
      → conversations/messages → durable tasks
      → approvals/artifacts/outbox/audit
      → AgentExecutor → isolated Hermes adapter
                            → scoped tool broker → documents / delivery
```

- contracts：TS 类型和运行时 schema，不反向依赖 apps。
- task-engine：状态、调度、恢复与存储端口，不耦合 Fastify/模型 SDK。
- hermes：保留现状直到适配 ADR，跨进程协议有契约测试。
- document：可测试解析/生成核心，不全局搜文件或执行宏。
- im-gateway：入站验证/规范化、能力声明、出站回执；模拟显式。
- server：组合根、身份/资源授权和事务边界；先分内聚 service，不急于微服务。
- web：流程/状态展示，不自行制造可信授权上下文。

优先评估 SQLite 单机事务方案；按并发与部署运维决定 PostgreSQL，不把选库当已迁移。不为了“应用级”默认引入 Redis/Kafka/Kubernetes/向量库。

## 待实施的数据实体

| 实体 | 必需语义 |
| --- | --- |
| Principal/Membership | organizationId、人类/AI、status、会话成员；身份不来自请求体 |
| AgentAccount/Delegation | owner、授权动作/资源、expiry、policyVersion、撤权时间 |
| Message/Inbox | conversation、sender、外部消息键、序号；按网关+账号去重 |
| Task/Run/Step | requester、agent、conversation、state、version、lease、attempt、deadline |
| Approval | approver、actionDigest、收件人/内容/附件版本、policyVersion、expiry、一次性状态 |
| Artifact | task/run/owner/organization、存储键、hash/version、mime/size、sourceRefs |
| Outbox/Delivery | 稳定步骤/幂等键、不可变载荷、receipt、state、attempt |
| AuditEvent | actor/delegator、task、action、授权/审批结果、摘要、时间、traceId |

单组织不等于不需要对象归属或群成员授权；第一版不需要多租户管理 UI。

内网应用不等于数据不出网。开发模型与产品模型独立配置，企业文档发公网模型先确认组织政策。严格离线部署使用批准的内网网关，按实测能力降级，不默默切公网。部署验收覆盖 TLS/代理、密钥、出站白名单、备份恢复、迁移回滚、日志保留和双用户测试。
