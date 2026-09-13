# 代码审查基线

时间：2026-09-13，Asia/Shanghai，本机测量。仓库：E:\ChatAI。以下为静态代码证据，不声称已执行漏洞复现；后续按符号复核，不机械依赖行号。P0 为企业试用前安全/结果可信门槛，P1 为核心能力与可靠性，P2 为体验。

## 产品偏差

- `docs/project-brief.md` 的主要入口是第三方 IM 联系人，Web 是管理台。此次用户强调内网聊天社交工具，建议先明确原生员工聊天是否为主产品，不能默认继续只加 Webhook。
- `docs/research.md` 明确“不整体 fork”、本地包独立实现；`packages/hermes/src/runtime.ts` 是自研 TS 循环，不是接通的 NousResearch Hermes Agent。保留为适配/测试基础，不用包名冒充上游复用。
- 简报中“TypeScript 全栈（用户选定）”在此次原始要求中没有依据。沿用 TS 是维护成本决策，不能把模型选型追认为用户要求。
- “其他聊天软件未实现独立 AI 账号”是用户产品观察，不作为全面验证的市场事实；本项目仍需用可交付能力证明价值。

## 问题清单

| ID | 级别 | 证据入口 | 问题与修复验收 |
| --- | --- | --- | --- |
| AUTH-01 | P0 | `apps/server/src/app.ts:124` 及其他 API | 未见应用级身份认证和对象授权钩子；账号、任务、文件、消息和 SSE 均需覆盖匿名拒绝、跨用户拒绝、合法成员通过的集成测试。反向代理登录不能替代对象权限。 |
| AUTH-02 | P0 | `apps/server/src/app.ts:187`；`packages/im-gateway/src/webhook-gateway.ts` 的 verify | 路由未调用 verify；未配置 token 时 verify 放行。生产 fail closed，按目标平台验证原始签名/时间窗/去重；未通过不得创建任务。 |
| AUTH-03 | P0 | `apps/server/src/service.ts:88` 与 isAllowed | sender 由输入提供，空 allowlist 放行，姓名也参与匹配；拒绝前已经写入会话历史。伪造姓名不能认证，拒绝内容不能污染后续上下文；直接提交任务也要一致授权。 |
| TASK-01 | P0 | `packages/hermes/src/runtime.ts:74`、`:114`；service.runTask；`packages/task-engine/src/engine.ts:128` | runtime 异常返回空结果，service 用“任务已执行”兜底，engine 正常返回即 completed。跨层抛错 provider 测试须断言 failed 且无成功通知。 |
| TASK-02 | P0 | `packages/task-engine/src/engine.ts:66`、`:128` | 取消后正常返回的 handler 仍能写 completed。用可控 Promise 制造竞态；终态不能被覆盖，已开始副作用的未知结果需对账。 |
| TOOL-01 | P0 | `apps/server/src/agent.ts:52`、`:85`、`:138` | 发送/转发无审批和目的地授权；未知网关回退第一个。未知收件人/网关必须拒绝，不默认 self；未授权时网关调用数为零。 |
| FILE-01 | P0 | service.runTask 的 beforeArtifacts/newArtifacts；`apps/server/src/agent.ts:31` | 全局产物前后差集会在并发时混入其他任务文件。创建时绑定 task/run/owner，两任务交错生成只能获得各自产物。 |
| DELIVER-01 | P1 | WebhookImGateway.sendMessage/sendFile；app 网关装配 | 无 sendUrl 仍返回 ok:true；当前装配无 sendUrl。只能算模拟记录；明确 simulated/accepted/delivered/failed/unknown，HTTP 200 还需检查业务响应。 |
| TASK-03 | P1 | `packages/task-engine/src/engine.ts:46`、`:50`、`:149` | start 只改布尔值，无持久任务恢复；stop 不等待/终止工作，重试队列和事件在内存。补恢复、执行互斥/租约、幂等和优雅停机。 |
| MODEL-01 | P1 | `packages/hermes/src/providers/openai-compatible.ts`、types.ts | 未保留 reasoning_content；无明确 thinking 模式；空 choices 默认 stop；length 未作截断；无独立请求超时。真实 DeepSeek 工具循环兼容性未证实。 |
| TOOL-02 | P1 | `packages/hermes/src/runtime.ts:134`；tools.ts | 无效 JSON 变空对象，执行前未校验工具 schema。格式/类型错误须零副作用，不以 String 转换和默认值修复。 |
| DOC-01 | P1 | `packages/document/src/tools.ts:166` | Excel rows 被 map(String)，丢数值/布尔类型；空 sheets 造“状态/完成”表。拒绝错误输入或澄清，测试数值 round-trip。 |
| STORE-01 | P1 | stores.ts 的 readJson/persist；json-file-store.ts | JSON 读取失败兜底及全量并发写风险待复现；迁移需备份、事务、版本、唯一约束、回滚，不能宣称可无成本替换数据库。 |
| TEST-01 | P1 | `vitest.config.ts` 的 include | 只收集 packages 下测试；新增 server 测试须调整 include 并确认实际收集数。 |
| IM-01 | P1 | service.injectMessage/buildHistory | 每条入站创建任务，未见消息去重、群触发、自回复抑制、同会话顺序和上下文预算。覆盖重复 Webhook、双任务交错、历史越权。 |
| UI-01 | P2 | apps/web/src/views；apps/desktop/main.cjs | 页面与 Electron 壳不代表登录、成员聊天、审批、真实交付完成。Electron 已关闭 nodeIntegration、开启 contextIsolation；补导航和外链边界测试，勿说已有安全项缺失。 |

现有 runtime 测试主要是 Mock 成功/未知工具，engine 测试主要是成功/重试失败，不能证明以上链路。本次升级技能，没有修复业务代码。

原有五项技能已有流程、目录、UI、测试基础；缺少领域授权/任务契约、Harness 接入、运行时真实性和阶段任务卡。用专项技能承载细节，通用技能只加路由，避免污染其他项目。
