# 2026-09-15 项目复核：Host 已成形，Gate 7A 尚未整体完成

本轮审查后的用户决策：后台绑定客户端关窗常驻，见 `adr-0003-window-resident-agent.md`。因此下文 A 项“仍在 Electron 主进程”不再算缺陷，独立守护进程不再排期；六项实测问题的观察不变，H-05 按单实例/单 writer 边界处理。

日期：2026-09-15，Asia/Shanghai。代码基线：`b33c64d`。

## 审查范围与产品目标

沿用用户要求：ChatAgent 不依赖 QQ、微信、飞书、钉钉；既是员工聊天工具，也是单机 Agent 工具。同一电脑员工工作时 Hermes 可在后台并行，关闭界面/无人操作时按授权继续。

此次检查源码、最近提交、Gate 7A 与迭代报告，运行现有测试/类型检查并编写六项隔离诊断。没有修改业务代码、读取真实凭据、启动真实 Hermes、调用模型、杀现有进程或重建 exe。开始时已有未提交的产品/任务文档及上一轮 Prompt，均予保留。

## 已有进展

- 新增 `packages/agent-host`：Host 生命周期、执行器接口、fake/进程适配器、JSON 任务记录、IPC schema、工作目录及产物哈希辅助函数。
- Electron 已创建 Host、单实例锁、托盘和关闭窗口继续运行逻辑，preload 只暴露命令桥；比上一轮单纯加载网页有实质进展。
- 新增服务端本地任务回执路由、成员级隔离、任务页展示；但真正的端到端同步存在契约问题，不能仅据 API 测试判通过。
- 原生聊天、审批、文件上传安全继续增强；本轮增加后的测试均能运行。上传认证/CSV 编码/预览、搜索定位、审计过滤等不是下阶段需要重做的功能。
- `Temp/hermes-runtime` 存在运行时 exe。历史报告记录了版本与缺 provider 的进程失败契约，但没有真实模型成功执行文档的证据。本轮不运行该 exe；其上游来源/构建来源/版本固定仍需正式集成核查。

## 实测结果

| 检查 | 本轮结果 |
| --- | --- |
| 根目录 `node node_modules/vitest/vitest.mjs run --reporter=dot` | 22 文件，208 用例通过 |
| apps/web 下 `node ../../node_modules/vitest/vitest.mjs run --reporter=dot` | 6 文件，39 用例通过 |
| 根目录 TS 检查 | 退出码 0 |
| Vue 类型检查 | 退出码 0 |
| 六项隔离缺陷探针 | 6/6 复现预期的错误行为，不是安全修复通过 |

现有测试合计 **28 文件 / 247 用例通过**。Node v24.11.0，Vitest v4.1.11。本轮通过批准在沙箱外运行本地测试，仅使用测试代码的隔离数据。没有重新执行构建、安装包 E2E、依赖联网扫描或真实模型；历史报告的 227/229 用例与 7/7 验收不代表当前 HEAD 的本轮全链路结果。

日志与可执行探针位于 `Temp/review-2026-09-15/`，被现有 gitignore 排除；下文保留耐久的复现说明。下一轮修复应把探针转成正式测试，并改为断言安全行为，不把“复现错误行为”的绿色结果并入安全验收。

## 六项已复现问题

### H-01：重复提交已完成任务会重新执行（P0）

证据：`packages/agent-host/src/host.ts:144`、`store.ts:66`。submit 构造 attempts=0 的新 queued 记录并覆盖原 ID。

复现：fake 执行器记录调用数；提交 taskId=repeat，等待 succeeded，再提交同 ID/同载荷。调用数从 1 变为 2。现有同时/短窗口重复测试不足以覆盖完成后重放。

修复目标：原子 create-if-absent；同键同载荷返回既有任务，同键异载荷报冲突；显式新任务或有权限的重试操作才允许新执行。所有终态不能经 submit 覆盖，attempts 不能清零掩盖历史。

### H-02：调用方自行声明的审批可以授权副作用任务（P0）

证据：`packages/agent-host/src/ipc.ts:25`、`:34`、`host.ts:303`。delegation/approval 来自命令体，Host 检查布尔值与时间，但没有可信记录解析、动作 digest 核验、agentId 匹配、capabilities 约束；Date.parse 非法字符串产生 NaN，当前过期比较未拒绝。

复现：经过正常 IPC handler 调用，传未注册 owner、错误 agent、空 capabilities、伪造 approved=true、无关 actionDigest 和 not-a-date。side_effect 任务进入 fake executor 并 succeeded；没有真实发送。

修复目标：命令只传授权/审批引用，Host 向可信本地授权库或组织服务解析；绑定 owner/agent/device/action/资源版本，校验有效日期与自审规则；执行前及副作用前再次复核撤权/过期。个人单机授权不强迫依赖组织服务器，但也不能仅相信网页 JSON。

范围说明：证明的是本地可信 frame 能伪造业务授权，不是匿名网络攻击已成功。Electron 主进程持有随机 token，但 handler 同时填入期望值与提交值（main.cjs:184），该检查不等于认证当前员工/委托。来源验证与业务授权是两层。

### H-03：持久化失败被吞掉，调用方仍看到成功（P0）

证据：`packages/agent-host/src/store.ts:128` 的 persist 最后 `.catch(() => undefined)`。

复现：在隔离目录中先 load 一个未存在的任务文件，再把同名路径创建为目录，put 仍 resolve，内存可读记录；新 store 无法 load。这证明写入失败没有向上传递，不代表本轮对生产磁盘故障进行过测试。

修复目标：传播持久化错误，保留可观察健康状态，持久提交完成前不确认成功/派发副作用；测试写失败、rename 失败、损坏 JSON 和恢复。tmp+rename 本身不提供跨文件事务，也不能弥补吞异常。

### H-04：停止后迟到的执行成功会覆盖 cancelled（P0）

证据：`host.ts:87` 的 stop 与 `host.ts:277` 的 finish。finish 无终态版本校验。

复现：fake adapter 用可控 Promise 暂不返回；stop 后记录为 cancelled；再返回成功，最终变为 succeeded。

修复目标：集中合法状态转换、版本/CAS、runId/租约校验；取消已提交则迟到结果不能改终态。停止还需有界等待活动执行器结束、清理自己的进程树，不能只发 signal 后清空 active 就声称完全停止。

### H-05：JSON 租约不是跨实例互斥（P1；按单实例/单 writer 边界处理）

2026-09-15 更新：ADR-0003 取消“独立 Host 进程/多实例共享任务库”方向，本项按单 Electron 实例 + 单 writer 防护处理，不新增多进程租约系统；若未来扩展共享存储须重新设计互斥。

证据：`store.ts:72` 在每个实例自己的 Map 检查/更新，未见跨进程锁、事务或心跳。

复现：两个 store 实例读取同一个 queued 任务文件，先后以不同 holder claim，两者都获得任务。

当前 Electron 有单实例锁，不能因此宣称日常桌面必然已经重复调度；但它也不证明独立 Host、多入口/多进程可以共享任务库。修复可先强制一个真实 writer/OS 级锁和明确第二实例拒绝，不必为了 PoC 上多节点分布式数据库。需要抢占/恢复时补 fencing/version，不能单靠可过期时间字段。

### H-06：任务列表 IPC 契约不一致，阻断 UI/回执同步（P1）

证据：`ipc.ts:74` 返回 `{ok:true,result:LocalTaskRecord[]}`；`apps/web/src/views/SettingsView.vue:78` 按 `result.tasks` 读取，不存在则空数组。

复现：真实 handler 返回含一条记录的数组，同前端表达式得到 []。因此任务表可能为空，syncHostReceipts 获得空数组直接返回；任务页定时 GET 回执不能弥补根本没有 POST 同步。

修复目标：共享 TS+运行时 schema，消除 UI 的手写不一致类型；用真实 handler 的结果做组件集成测试，验证任务显示、产物显示、POST 回执以及另一页面可读。不能只测试服务端收到手工伪造回执。

## 还未满足的产品边界（静态核查，不冒充动态复现）

### A. 仍是 Electron 主进程内 Host，不是独立后台节点（2026-09-15 由 ADR-0003 移出缺陷范围）

> 复查更新：用户随后决定后台与关窗常驻绑定（`docs/adr-0003-window-resident-agent.md`），主进程内 Host 即为目标形态，本小节不再是缺陷或待办；保留原文仅为记录当时的判断依据。仍有效的是 A 项之外的验证要求——明确区分“终止 renderer”与“退出应用”，退出后停止并清理自有执行器。

`apps/desktop/main.cjs:145` 直接 new LocalAgentHost。关窗和 renderer 崩溃时继续是有效进展；但 Electron 主进程结束后 Host 不再运行，不能据此证明“UI 进程退出仍运行”。

下一步应以独立入口/进程管理 Host，明确 start/status/stop、单实例、守护/恢复及升级；验收需明确终止的是 renderer 还是 Electron 主进程。无需本阶段安装 Windows Service，但应避免仅用无监管 detached 进程伪装完成。
（上述“独立入口/进程管理 Host”不再执行；改为验证关窗常驻、托盘重开与明确退出后的停止清理。）

### B. 无组织服务器时还没有实际可用的单机界面

main.cjs:92 仍加载 serverUrl；`apps/desktop/error.html:55` 仅有“无法连接服务”与重试按钮。SettingsView 的本机入口随远端页面提供，断开服务不能完成正常的独立任务管理体验。

下一步增加随包提供的本地受信 Agent 工作台/路由，与远端聊天页分别授权。聊天服务器不可达时仍能提交、查看、取消授权本地任务；不是只证明 host 类可由测试脚本调用。

### C. 真实 Hermes 的执行范围没有被当前 helper 证明

adapter.ts:168 将子进程 cwd 设为 task 目录并继承 process.env，工具集 document 映射为 file。sandbox.ts 的路径检查、写入哈希 helper 和产物扫描不是所有 Hermes 文件工具的必经入口；不应由 helper 单测推断进程不能读写目录外路径。

本轮不运行真实模型越界测试，不宣称已经成功越界。真实接入前需要核实工具策略/受控代理或 OS 级隔离，合成兄弟目录访问必须拒绝；环境变量采用最小清单，文件写入走版本/审批边界；审计不可只是对任意 stdout/stderr 截断就称为脱敏。进程超时回收、产物大小预算和异常出口也要覆盖。

### D. 真实进程可启动不等于真实文档任务成功

Gate7A 报告说明 provider 缺失、真实推理 BLOCKED。本轮见桌面 createHost 未提供模型配置 UI/显式配置传递；只有找到 exe 即选择 Hermes，找不到会自动使用明确标注的 fake。

先修上述授权/持久化风险，再核查运行时来源、commit/tag、许可证、安装来源/校验、模型配置与工具路径。在安全合成文件上验收“真实推理 → 工具执行 → 可读办公产物”，不能把退出 0、stdout 文字或 fake 产物当作真实工作完成证据。缺 provider 应明确待配置；fake 仅显式演示模式，不能成为生产自动降级策略。

打包配置列出了 Host bundle，未见把 Hermes 作为 extraResources 包含；开发目录的 exe 存在不保证干净安装后可运行。按获准方式选择打包、离线安装包或指向已有运行时，并实际验收。

### E. 回执同步仍依赖页面、缺持久设备/委托语义

SettingsView loadHost 触发 best-effort 上传，关闭页面/窗口后没有该页面驱动的同步。另有设备 ID 使用 `desktop-${process.platform}`，不满足多设备唯一性。Host task/list 也没有绑定当前员工的可信身份。

先修 H-06；后台持续同步放在 Host，用稳定设备 ID、任务归属、独立授权、持久待同步队列与重试去重。不同员工切换登录时不能把前一人的本地任务同步到后一人账号。当前 API 成员隔离有用，但客户端回报的 hash/状态只是回报，不是独立验真的可信完成凭证。

## 验收结论修正

建议把历史 Gate 7A 的总 PASS 改为 **部分完成**：

- 已完成：本地 Host 核心、进程适配端口、fake 流程、关窗保持主进程运行、基本 IPC/产物辅助逻辑。
- 需修复：H-01～H-06。
- 未完成：不依赖服务端的实际单机工作台、可信设备/委托同步和明确退出后的执行器清理验收；脱离 Electron 主进程运行已由 ADR-0003 移出范围。
- 未验收：安全隔离后的真实 Hermes+模型办公闭环、干净安装部署、无人操作计划任务。
- 不适用/非目标：第三方 IM 凭据、ACP 强制接入、开机未登录/系统服务，不能将它们列为此次核心功能 BLOCKED 的理由。

历史报告不删除或冒改，本报告给出当前 HEAD 的更正基线。

## 2026-09-16 修复状态（H-01～H-06）

| 项 | 状态 | 归宿 |
| --- | --- | --- |
| H-01 提交重放 | 已修 | `submit` 按 taskId 幂等、异载荷 `idempotency_conflict`；重跑只经显式 `retry` |
| H-02 审批伪造 | 已修 | `TrustedAuthorizationRegistry` + IPC 只传引用 + 派发前复核 + 动作摘要绑定 |
| H-03 吞落盘错误 | 已修 | write→fsync→rename，错误抛给调用方，`lastError=store_write_failed` |
| H-04 迟到结果覆盖取消 | 已修 | 记录 `version` + 终态丢弃 + `compareAndSet`；取消立即写终态 |
| H-05 双 writer | 已修（单实例边界） | 独占锁文件 + 存活 pid 拒绝 + Electron 单实例锁；不做多进程租约系统 |
| H-06 IPC 契约 | 已修 | `list` 返回 `{ tasks }`，工作台显示原因并可重试，新增契约回归 |

回归与证据见 `docs/iteration-2026-09-16-gate7a1-hardening.md`（根 243 用例、web 40 用例、tsc/vue-tsc 0、真实 Electron 校验 11/11、6/6 与退出路径 10/10）。独立子代理同日晚做对抗性复核，又复现 11 项攻击（关店后写库、夺存活锁、`document` 种类绕过授权、并发提交竞态、写失败报假成功、陈旧 `put` 复活终态等），已全部修复并加固回归：`docs/review-2026-09-16-adversarial-verification.md`。断网本机工作台（B 项）已完成；仍未完成：真实 Hermes 安全办公闭环（C/D 项）、Host 侧持续回执同步（E 项）与断网账号归属。

## 下一阶段：Gate 7A.1（只修可信性与真实跨层契约）

1. 固定 Host IPC schema，修任务显示/回执，补真实 handler→preload→页面→回执 API 集成测试。
2. 收紧授权来源和执行时复核；拒绝无效日期、错误 device/agent、空能力、伪造审批、动作变更、自审和撤权后执行。
3. 修 submit 幂等、终态 CAS、取消/停止、持久失败传播与单 writer；将本报告六项探针改成期望安全行为的正式回归。
4. 更新 docs/tasks/Gate7A 报告的状态口径；保留聊天功能与现有 247 用例。

验收目标：不能重复执行、伪造批准、吞持久错误、取消后改成功、双 writer 抢任务、丢失本机任务显示。现有测试通过不代替新回归；类型检查、现有测试、新集成均通过才能推进。

## 后续顺序

**Gate 7A.2：单机工作台与关窗常驻体验。** 保留 Electron 主进程内 Host，补本地受信工作台、稳定 device identity、托盘重开与明确退出清理；组织服务停止时本地任务可管理，应用明确退出后后台应停止，而不是继续运行。不新增后台守护服务。

**Gate 7A.3：真实 Hermes 安全办公验收。** 固定运行时与安装路径，配置获准模型，只使用合成数据，验证文件边界、工具授权、取消、产物格式/内容，不能拿任意员工文件试跑。缺外部条件只标具体受阻项。

**之后：原生持久消息/SSE 补发、步骤检查点和审批续跑、Host 后台同步，最后增加计划任务与无人值守。** 目前不要优先加更多聊天 UI、第三方平台、MCP/ACP 或整套数据库重构。

## 复现命令与环境

```text
node node_modules/vitest/vitest.mjs run --config Temp/review-2026-09-15/vitest.config.ts --reporter=verbose
node node_modules/vitest/vitest.mjs run --reporter=dot
cd apps/web
node ../../node_modules/vitest/vitest.mjs run --reporter=dot
```

在仓库根执行类型检查：

```text
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node apps/web/node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p apps/web/tsconfig.json
```

六项探针全部只使用 fake executor 与 Temp 下合成数据。本轮浏览检索未返回可引用的有效资料，因此结论只基于本地源码/执行证据，不对 Hermes 上游具体版本能力或依赖漏洞最新状态作外部核验结论。
