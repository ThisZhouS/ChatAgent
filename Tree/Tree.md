# Tree

最后更新: 2026-09-06

排除: `node_modules`, `.git`, `dist`, `data`, `Temp`, `*.log`, 生成产物。

```text
ChatAgent/
├── apps/
│   ├── server/          Fastify 组合根：REST、SSE、Webhook、文件、静态托管
│   │   ├── src/
│   │   │   ├── agent.ts         模型/文档/消息工具构建（含审批闸门与 outbox）
│   │   │   ├── app.ts           buildApp + 路由 + SSE + 认证/错误处理
│   │   │   ├── approvals.ts     审批摘要、ApprovalStore、OutboxStore、发送时复核
│   │   │   ├── audit.ts         审计日志（JSONL，字段截断）
│   │   │   ├── auth.ts          成员目录、会话/Cookie 认证、对象授权矩阵
│   │   │   ├── events.ts        原生事件 hub（有界订阅、消息/任务/审批广播）
│   │   │   ├── native-gateway.ts 内置原生投递通道（AI 主动消息 → 成员收件箱）
│   │   │   ├── rate-limit.ts    进程内滑动窗口限流（登录/写/上传/webhook）
│   │   │   ├── config.ts        环境配置（含 auth/webhook/approval profile）
│   │   │   ├── index.ts         启动入口
│   │   │   ├── service.ts       编排：消息→会话→任务→Agent→产物归属→审批/回执
│   │   │   ├── stores.ts        JSON 持久化存储（含迁移）+ webhook 去重
│   │   │   ├── test-helpers.ts  测试用 buildApp/principal 夹具
│   │   │   ├── auth.test.ts             principal 与授权矩阵单测
│   │   │   ├── app.security.test.ts     认证/越权/Webhook 集成测试
│   │   │   ├── artifacts.test.ts        并发产物归属与下载授权
│   │   │   ├── approval-outbox.test.ts  审批闸门/幂等/回执语义/端到端
│   │   │   ├── native-chat.test.ts      原生登录/联系人/会话/成员投递/SSE/独立默认
│   │   │   ├── native-delivery.test.ts  原生投递与通道选择
│   │   │   ├── security-hardening.test.ts  Cookie 只读/安全头/限流/上传/审计/吊销
│   │   │   ├── security-regression.test.ts 跨组织文档/审批原子性/历史注入/出站隔离/SSE 上限
│   │   │   └── members.test.ts          成员管理（令牌一次性签发/重置）
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── tsup.config.ts
│   └── web/             Vue 3 + Element Plus 工作台
│       ├── src/
│       │   ├── views/           登录/聊天/工作台/任务/审批/文件/账号/成员/设置 (.vue + ChatView.test.ts)
│       │   ├── api.ts           前端 API 客户端
│       │   ├── App.vue          导航与布局
│       │   ├── main.ts
│       │   └── style.css
│       ├── index.html
│       ├── package.json
│       ├── tsconfig.json
│       └── vite.config.ts
│   └── desktop/          Electron Windows 客户端（打包为 exe）
│       ├── main.cjs             主进程：加载服务端 URL + 失败回退
│       ├── preload.cjs          contextBridge
│       ├── error.html           无法连接时的本地错误页
│       ├── config.default.json  默认 serverUrl
│       └── package.json         electron-builder 配置
├── packages/
│   ├── contracts/       共享类型 + Zod 契约（唯一稳定契约层）
│   ├── hermes/          Agent 运行时（工具循环/提供商/记忆/事件）
│   ├── document/        Word/Excel 解析与生成 + 工具封装
│   ├── im-gateway/      IM 网关抽象 + 钉钉/飞书/企微/QQ 规范化
│   ├── agent-host/      本机 Agent Host（任务库/租约/停止/Hermes 适配/IPC/载入校验/保留策略/进程树/锁心跳与持有者身份/持续授权刷新）
│   └── task-engine/     任务状态机、队列、重试、取消、持久化
├── docs/                项目简报、调研、需求、任务、架构、环境、验收、Gate 记录、升级调研（upgrade-2026-09-17-electron.md）
│   ├── gate1-2-identity-task-integrity.md  认证/状态机/迁移策略
│   ├── gate4-approval-outbox.md            审批摘要/outbox/回执语义
│   ├── adr-0001-standalone-native-chat.md  独立产品与原生聊天方向决策
│   ├── gate5-standalone-hardening.md       原生投递/安全加固/成员与审批自助
│   ├── security-checklist.md               部署安全清单
│   ├── gate6-access-control-fixes.md       第三轮对抗性复核的访问控制修复
│   ├── adr-0002-dual-mode-client-agent-host.md  双用途客户端与本机 Hermes 工作节点（生命周期部分被 ADR-0003 取代）
│   ├── gate7a-local-agent-host.md          本机 Agent Host 与桌面集成验收
│   ├── adr-0003-window-resident-agent.md   后台绑定关窗常驻、明确退出即停止（当前生命周期决策）
│   ├── review-2026-09-15-host-gaps-roadmap.md   当前复核基线：Host 六项缺口与 Gate 7A 路线
│   ├── review-2026-09-16-adversarial-verification.md 独立对抗性复核：11 项攻击复现→修复→复跑失效
│   ├── review-2026-09-16-adversarial-verification-round2.md 第二轮复核：12 项发现，7 项已修
│   ├── iteration-2026-09-16-gate7a1-hardening.md  H-01～H-06 加固、桌面生命周期收敛与第四～九轮（回执同步/分区/进程树/锁接管/CSP/保留策略）
│   ├── verification-2026-09-16-round3-findings.md  第三轮对抗性验证的 7 项发现（F1–F7）与修复复验证据
│   ├── electron-upgrade.md                  Electron 支持窗口与升级预研（39 已 EOL，含 node:sqlite 实测结论）
│   └── acceptance-guide.md                 10 分钟人工验收指南
├── Prompt/              原始 Prompt 留痕
├── Tree/                目录树索引
├── package.json         workspace 根脚本
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json        全仓类型检查（paths）
├── vitest.config.ts     测试（alias + include：packages 与 apps/server）
├── scripts/
│   ├── add-member.mjs        生产成员/token 签发（只写 sha256）
│   ├── acceptance.mjs        一条命令跑完整验收链（含桌面壳检查，失败即非零退出）
│   ├── restart-server.mjs    按端口重启服务端并等待 /health（记录真实 pid）
│   ├── smoke.mjs             端到端冒烟（健康→登录→会话→任务→审批→投递→搜索→群聊）
│   ├── ui-e2e.mjs            真实客户端 E2E（Electron/CDP 驱动打包 exe，含截图与对比度检查）
│   ├── gate7a-verify.mjs     本机 Agent 主机级流程（22/22；含真实 Hermes 进程契约）
│   ├── ensure-e2e-member.mjs  为 E2E 签发本机专用成员（token 只落 Temp/e2e-member.json）
│   ├── electron-host-smoke.cjs       关窗常驻与任务继续（6/6）
│   ├── electron-quit-check.cjs       显式退出路径（10/10）
│   ├── electron-receipt-sync-check.mjs 回执持续同步（21/21，含分区、CSP 注入与授权刷新断言）
│   ├── electron-lock-check.mjs       单 writer 锁（18/18：持有者身份/心跳、冻结心跳需人工确认）
│   ├── electron-workbench-check.cjs  断网本机工作台（13/13，含保留策略/授权/回执可见性）
│   ├── electron-csp-check.mjs        远程页面 CSP 强制执行（5/5，内联载荷）
│   └── electron-nav-check.mjs        导航/窗口/桥面收敛（7/7）
├── apps/desktop/receipt-sync.test.mjs 回执同步模块单测（7 例，经 createRequire 测 Electron 侧 CJS）
├── Dockerfile           容器构建（pnpm install + build + start）
├── docker-compose.yml   单容器开箱部署（端口 8787 + 数据卷）
├── start-server.cmd     Windows 一键启动服务端
└── .env.example

## 重要入口

- 服务端启动: `apps/server/src/index.ts`
- 服务端装配: `apps/server/src/app.ts`
- 身份与对象授权: `apps/server/src/auth.ts`
- 业务编排: `apps/server/src/service.ts`
- Agent 循环: `packages/hermes/src/runtime.ts`
- 任务状态机: `packages/task-engine/src/engine.ts`
- 前端入口: `apps/web/src/main.ts`

## 命令

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm dev
pnpm start
```
