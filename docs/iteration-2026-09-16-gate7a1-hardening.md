# 2026-09-16 Gate 7A.1 加固与桌面生命周期收敛

日期：2026-09-16（Asia/Shanghai）。基线：Git HEAD `b33c64d`（工作区含 2026-09-15 文档改动）。关联：`docs/review-2026-09-15-host-gaps-roadmap.md`、`docs/adr-0003-window-resident-agent.md`、`Prompt/2026-09-16-continuous-iteration.md`。

## 本轮范围

按 2026-09-15 复核的 H-01～H-06 修可信性与跨层契约，并把 ADR-0003（关窗常驻、明确退出即停止）落成可验证行为；同时处理联网调研发现的三个高价值缺口（退出时序、权限检查、幂等键语义）。不改聊天/任务主流程，不接真实模型与真实 Hermes。

## 变更

### H-01 提交幂等（重复提交不得重放已完成任务）

- `LocalAgentHost.submit()` 先查同 id 记录：存在即返回原记录，不重新入队、不重新执行。
- 同 id + 不同载荷（goal/kind/toolsets/agentId 任一变化）抛 `idempotency_conflict`，IPC 返回同名错误码 —— 幂等键只对“同一个请求”可复用。
- 重跑只走显式 `retry(taskId)`：仅允许 `failed`/`interrupted` 的本机文档任务且未超 `maxAttempts`；副作用任务需重新审批，禁止自动重试。

### H-02 可信授权（拒绝调用方自声明审批）

- 新增 `packages/agent-host/src/authorization.ts`：`TrustedAuthorizationRegistry` 持有已核验的委托/审批，`computeActionDigest()` 定义动作摘要的规范形式。
- 提交入参由“委托/审批对象”改为 `delegationId`/`approvalId` 引用；zod schema 改为 `.strict()`，仍带 `delegation`/`approval` 字段的调用返回 `invalid_command`。
- 校验项：委托已登记、设备匹配、Agent 身份匹配、未过期、能力覆盖所需 toolset；审批已登记、`approved` 为真、未过期、owner 与委托一致、可选绑定同一 delegation、`actionDigest` 与任务载荷完全一致。
- 授权在 `submit` 与“执行器启动前”各复核一次；撤权/过期后排队中的任务会以 `delegation_unknown` 等终态失败且执行次数为 0。
- 审批/委托仅存在于进程内存：重启必须重新授权。IPC 面没有任何“授予”命令。

### H-03 落盘错误不再被吞

- `JsonFileAgentHostStore.persist()` 改为 write → `FileHandle.sync()` → rename，并把失败抛给调用方（写队列本身保持可用）。
- `submit` 落盘失败时抛错、设置 `lastError=store_write_failed`，不再返回“已受理”的假记录；IPC 以 `host_error` 上报。

### H-04 终态不被迟到结果覆盖

- `LocalTaskRecord` 增加 `version`；`finish()` 先复读、遇终态直接丢弃（计入 `lateResultsDropped`），再以 `compareAndSet(taskId, expectedVersion, next)` 提交，竞态写入同样被拒。
- `cancel()` 对运行中任务先发 abort、立即写 `cancelled`；`stop()` 有界等待（默认 3s）后强制终态。

### H-05 单 writer

- `JsonFileAgentHostStore` 在 `load()` 前以 `wx` 独占创建 `tasks.json.lock`（记录 pid/时间），检测到存活进程即抛 `AgentHostStoreLockedError`；pid 已死、锁损坏或超过 12 小时视为可接管；`close()` 释放。
- 桌面端保持 Electron 单实例锁，启动失败时弹窗说明“任务库被占用”，而非静默双写。

### H-06 IPC 契约与可用性

- `handleHostCommand` 的 `list` 统一返回 `{ tasks }`，与 `SettingsView.vue` 读取的 `result.tasks` 一致；命令异常统一转为 `{ok:false}`（区分 `idempotency_conflict`）。
- 工作台本机卡片新增“说明”列（显示 `blockedReason`/`error`）与失败任务的“重试”按钮。

### 桌面生命周期（ADR-0003）

- 稳定 `deviceId`：`userData/device.json` 生成一次，替换原先所有机器相同的 `desktop-<platform>`。
- 唯一且幂等的关闭路径 `shutdownHostOnce()`：`before-quit`（preventDefault 一次 → 有界拆除 → 再 `app.quit()`）与 Windows 注销/关机事件 `query-session-end`/`session-end` 共用；托盘“退出”不再单独实现一套。
- 权限默认拒绝补齐 `setPermissionCheckHandler`（原先只有 request handler）。
- 外链改造为解析后的协议白名单（`http:`/`https:`/`mailto:`）。
- `HermesProcessAdapter` 中止/超时时用 `taskkill /PID <child> /T /F` 清理**自有**子进程树（只针对本应用 spawn 的 pid），避免遗留 python/浏览器子进程。

### Gate 7A.2 断网本机工作台（新增交付）

- 新增 `apps/desktop/workbench.html`：随包提供的本机受信工作台，`file://` 加载、严格 CSP（`default-src 'none'`，无网络、无远程资源），只经既有 preload 窄桥与 Host 通信；Host 返回的字符串一律用 `textContent` 渲染，不拼 HTML。
- 能力：本机状态（设备 / executor / fake 原因 / 排队与执行中计数 / 迟到结果丢弃计数）、任务列表（状态、说明、产物）、提交文档任务、取消与重试、暂停/继续、停止主机、退出（停止后台 Agent）、返回聊天服务。
- 退出路径实测（`scripts/electron-quit-check.mjs`，真实 Electron + 真实 `main.cjs` + 本机 Hermes 运行时）：应用在组织服务不可达时仍启动本机主机、设备号为稳定 `desktop-<uuid>`、任务库被锁文件保护、明确退出后进程在 15s 内有界结束、锁被释放、任务结局仍留在磁盘、无残留进程（10/10）。
- `error.html` 增加“打开本机工作台”入口；托盘菜单增加“打开本机工作台（不依赖服务器）”；主进程新增 `chatagent:workbench:open`，不接受页面传入的位置。
- 服务器不可达时不再只有错误页：文档任务可提交、查看、取消、重试；副作用任务因拿不到委托/审批而被拒绝并显示原因。

## 证据

```text
node node_modules/vitest/vitest.mjs run --reporter=dot        # 24 文件 / 243 用例通过
cd apps/web && node ../../node_modules/vitest/vitest.mjs run  # 6 文件 / 40 用例通过
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json      # exit 0
node apps/web/node_modules/vue-tsc/bin/vue-tsc.js --noEmit -p apps/web/tsconfig.json   # exit 0
node apps/desktop/build-agent-host.mjs                        # 重新生成 agent-host.bundle.cjs
node --check apps/desktop/main.cjs
apps/desktop/node_modules/.bin/electron scripts/electron-workbench-check.cjs   # 11/11，真实 Electron
apps/desktop/node_modules/.bin/electron scripts/electron-host-smoke.cjs        # 6/6，关窗常驻与重启恢复
node scripts/electron-quit-check.mjs                                          # 10/10，真实桌面应用：显式退出→进程结束→锁释放→任务库仍可读
node scripts/gate7a-verify.mjs                                                # 18 passed / 0 failed / 1 blocked（未设 CHATAGENT_HERMES_EXE）
CHATAGENT_HERMES_EXE=Temp/hermes-runtime/hermes-agent-cn-runtime-win32-x64.exe node scripts/gate7a-verify.mjs   # 19/19，含真实 Hermes 契约（无 provider → 明确失败）
node node_modules/vitest/vitest.mjs run -c Temp/verify-2026-09-16/vitest.config.ts   # 11/11 攻击失败，23 项 FIX-HOLDS 仍通过
```

新增回归：`packages/agent-host/src/host-security.test.ts`（18 项，覆盖 H-01～H-06 的安全行为）与 `host-security-verify.test.ts`（12 项，封堵对抗性复核复现的攻击），`packages/agent-host/src/host.test.ts` 的授权用例改为注册表语义，`apps/web/src/views/SettingsView.test.ts` 增加阻塞原因/重试契约用例。

## 对抗性验证与复查修复（同日第二轮）

独立子代理（只读仓库）用 34 项自建探针攻击上述修复，**11 项攻击复现**，全部已修并逐条加回归；修复后复跑同一套探针：11/11 攻击失败、23 项 `FIX-HOLDS` 仍通过。原始产物与完整表格见 `docs/review-2026-09-16-adversarial-verification.md`。

| 编号 | 问题 | 修复 |
| --- | --- | --- |
| C1 | `close()` 释放锁之后，已关闭的 host 仍能写 `tasks.json`，覆盖当前持锁者的记录 | `LocalAgentHost` 增加关闭判定（`submit/retry/cancel` 一律抛 `host_closed`）；store 关闭后拒绝任何写入（`agent_host_store_closed`） |
| C2 | 12 小时"过期"规则先于存活判定，常驻超过 12 小时的真持有者被夺锁 | 存活优先：pid 活着就不夺锁；年龄规则只在 pid 复用（>30 天）时兜底 |
| C3 | `releaseLock()` 无条件删除锁文件，可能删掉别人的锁 | 只有锁文件里的 pid 等于本进程才删除 |
| C4 | 截断/损坏的锁被当作废弃，实际持有者仍存活 | 解析失败时先用正则抢救 pid，仍存活的锁不夺 |
| C5 | 并发首次访问同一 store 时自锁（4 个并发读 → 3 个 `AgentHostStoreLockedError`） | `load()` 记忆化，只做一次取锁 |
| C6/C11 | `kind:'document'` + 外部工具集（`web`/`*`/`terminal`…）完全绕过委托与审批 | host 级工具集白名单：`document` 只允许 `document`/`document.read`，`*`、终端/代码执行等一律 `capability_not_granted` |
| C7/C13 | 落盘失败时内存已改成 `succeeded`、磁盘仍是 `running`，且失败记录在内存里可见（幽灵任务） | 所有写路径改为「先改内存→写盘→失败即回滚」，失败后内存状态与磁盘一致 |
| C8 | 同一 taskId 的并发提交（不同载荷）双双成功，且执行的载荷可能与落库记录不一致 | 新增 store 级 `createIfAbsent`，host 用它做原子创建；落败方按幂等规则重判 |
| C9 | 旧记录没有 `actionDigest` 时"同 id 异载荷"检查永久失效 | 对旧记录用其字段重算摘要后再比对 |
| C10 | `tick()` 的 `list()` 失败会变成 unhandledRejection（Node 默认终止进程） | `tick()` 整体 try/catch，失败写入 `lastError` |
| C12 | 陈旧的 `put()` 可把终态记录改回排队并再次执行 | `put()` 拒绝把终态记录改回非终态（`terminal_state_protected`） |
| C15 | 审批可重复使用 | 副作用任务真正开跑前 `consumeApproval()` 消耗审批，一次授权一次执行 |

保留并记录、未改语义：设备令牌在桌面链路属纵深防御（真正控制是发送方校验）；审批未显式绑定委托时仍可授权（动作摘要已锁定 taskId/agent/kind/goal/toolsets）；真正同时的多进程写、两个安装共享 `CHATAGENT_HOST_ROOT`、Windows 上 `taskkill` 的实际执行未纳入测试。

新增回归 `packages/agent-host/src/host-security-verify.test.ts`（12 项，逐条复现原攻击并断言其失败），工作台“重试”只对非副作用任务显示（host 对副作用任务恒不接受重试）。

## 第二轮对抗性验证与复查修复（同日晚）

第二位独立子代理（32 项探针，只读仓库）在修复后的代码上继续攻击，报告 `Temp/verify-round2/REPORT.md`，结果与状态：

| 编号 | 问题 | 状态 |
| --- | --- | --- |
| R2-01 | 能力下限只在 `submit()` 生效：旧版本写入的 `document` + `toolsets:["web"]` 行会被直接派发，`retry()`/重放也放行（升级旧任务库即可触发） | 已修：`execute()` 派发前与 `retry()` 再复核下限；重放该行直接记为 `failed/capability_not_granted` |
| R2-02 | `commit()` 回滚无条件：失败写入会把**已经成功**的后续写入一起回退（内存与磁盘分叉、下一次写覆盖成功结果） | 已修：仅当内存里仍是本次写入的对象时才回滚 |
| R2-03 | `void this.execute()` 的失败逃逸为 unhandledRejection（Node/Electron 主进程默认终止进程），且不写 `lastError` | 已修：派发处 `.catch()` 收敛到 `lastError`；调用链不再有未捕获拒绝 |
| R2-04 | 误拒：真实适配器接受的 `file` 文档工具集被新下限拒绝 | 已修：`file` 纳入文档工具集；`resolveHermesToolsets` 接受的文档能力不再被误拒 |
| R2-05 | 非数组 `toolsets` 触发原始 `TypeError`（IPC 有 schema 拦住，进程内调用没有） | 已修：下限对非数组 fail-closed 返回 `capability_not_granted` |
| R2-06 | `interrupted` 既非终态也不可认领：三个计数都不含它，且迟到结果仍能覆盖它 | 已修：`status().finished` 计入 `interrupted`；`finish()` 同样把 `interrupted` 视为已定论 |
| R2-07 | `put()` 仍可用一个终态覆盖另一个终态（陈旧写者把 `succeeded` 改成 `failed`） | 已修：终态只能保持不变，变更一律走 `compareAndSet` |
| R2-08 | 没有 `createIfAbsent` 的自定义 store 会让并发同 id 提交双双成功（内置两个 store 都已实现） | 部分修复：`submit()` 在回退路径写入后复核版本，发现被他人覆盖即转入幂等规则（同 id 异载荷 → `idempotency_conflict`）；新增回归 V-08。缺少首次写入必胜原语的 store 仍无法彻底封死竞态窗口，标注为嵌入边界 |

复跑同一套探针：修复前 3 项不变量断言失败（R2-01/02/03），修复后这 3 项通过，7 项攻击型探针失败（即攻击不再成立），其余 25 项仍通过。新增回归 5 项（`host-security-verify.test.ts`：V-07 旧行拒绝执行与重放、写失败不回退后续写入、`interrupted` 计数、后台链无未捕获拒绝；V-08 回退路径写入后复核版本并转入幂等冲突）。

桌面侧同轮加固（静态复核发现，已修）：`CHATAGENT_SERVER_URL` 只接受 http/https（否则 `file:` 会成为"应用源"并把窄桥交给本地文件）；`assets/tray.png` 缺失时关闭最后一个窗口改为退出（避免无托盘、无入口的隐形进程）；任务库被占用时的提示补上锁文件路径与自愈办法。保留记录：`close()` 超过 8s 的极端情况下以"停不干净"换取"退得掉"；pid 被无关进程复用的陈旧锁最长阻塞 30 天（需人工删锁）。

### 收口验收快照（2026-09-16 18:40，本机 Node v24.11.0）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 单元/集成 | `node node_modules/vitest/vitest.mjs run --reporter=dot` | 24 文件 / 243 用例通过 |
| Web | `cd apps/web && node ../../node_modules/vitest/vitest.mjs run` | 6 文件 / 40 用例通过 |
| 类型 | `tsc --noEmit` + `vue-tsc --noEmit` | 退出码 0 / 0 |
| 主机级流程（8 流程 + 第二轮回归） | `CHATAGENT_HERMES_EXE=Temp/hermes-runtime/hermes-agent-cn-runtime-win32-x64.exe node scripts/gate7a-verify.mjs` | 22 通过 / 0 失败 / 0 阻塞 |
| 断网本机工作台 | `apps/desktop/node_modules/.bin/electron scripts/electron-workbench-check.cjs` | 11/11 |
| 显式退出路径 | `node scripts/electron-quit-check.mjs` | 10/10 |
| 关窗常驻 | `apps/desktop/node_modules/.bin/electron scripts/electron-host-smoke.cjs` | 6/6 |
| 第二轮对抗性探针 | `node node_modules/vitest/vitest.mjs run -c Temp/verify-round2/vitest.config.ts` | 7 项攻击不再成立、25 项健康探针通过 |

未跑：打包 exe 重建（无网络，electron-builder 无法下载依赖）、打包后客户端 E2E、真实模型推理（无凭据）、Gate 7A.3 的固定版本 Hermes 端到端。

## 第三轮（2026-09-16 晚）：任务库载入校验与隔离

问题：`tasks.json` 跨版本存活，而载入时只补了 `version`——未知 `kind`/`state`、缺失 `workDir` 的行会被当成可运行任务，损坏的 JSON 则让主机启动失败（弹窗后没有主机）。

改动（新增 `packages/agent-host/src/record-integrity.ts`，接线到 `store.ts` / `types.ts` / `host.ts`）：

| 规则 | 行为 |
| --- | --- |
| 决定"能否运行"的字段（`taskId`/`kind`/`state`/`workDir`）不可信 | 该行**保留但隔离**为 `failed` + `blockedReason=invalid_persisted_row`，派发器与 `retry()` 都不碰 |
| 其余字段值非法（version/attempts/artifacts/时间戳/lease…） | 用安全默认值修复，并逐条记录修复字段名 |
| 可选字段缺失 | 静默补默认值（缺失本身在记录里可见，如空 `deviceId`），不计入修复计数 |
| 同一 taskId 多行 | 保留版本号较大的一行，另一行计入 `duplicates` |
| 未知多余字段 | 丢弃，不进入内存 |
| 文件不是合法 JSON / 不是数组 | 另存为 `tasks.json.corrupt-<时间戳>`（**不删除**），空库启动，报告 `corruptFile` |

对外可见性：`status().storeIntegrity = { repaired, quarantined, duplicates, corruptFile? }`；服务端工作台"本机 Agent"卡片与离线工作台各显示一行警示；桌面主进程启动时写日志并按需弹一次非致命提示。

证据：新增 `packages/agent-host/src/store-integrity.test.ts`（9 项：修复与计数、隔离且不派发、重复 id 取舍、未知字段丢弃、损坏文件另存不删除、非数组视为损坏、空库干净载入、载入不回写原文件）；根套件 25 文件 / 252 用例、web 6 文件 / 40 用例、tsc/vue-tsc 0；真实 Electron 工作台 11/11、显式退出 10/10、主机级 22/22。

刻意保留：载入时**不**回写规范化结果（避免销毁原始证据），首次成功写入才把规范形态落盘。

## 第四轮（2026-09-16 晚）：回执持续同步与归属绑定

问题（Gate 7A.2 剩余项）：本机任务只有打开"设置"页时才由页面 best-effort 上传——关窗常驻或没人看那个页面时，本机真实发生的工作在服务端账本里是缺失的；而且回执不携带归属，共享电脑上可以把别人的本机工作镜像进自己的列表。

改动：

| 面 | 内容 |
| --- | --- |
| 主进程同步（新 `apps/desktop/receipt-sync.cjs`） | 周期（默认 30s）把"有变化"的本地任务上传到 `POST /api/local-tasks`；离线排队落盘 `receipts-sync.json`；按任务 `updatedAt` 去重（同版本不重发）；失败指数退避 30s→10min；队列上限 200 条（超出丢最旧）；cookie **只在请求时**从 Electron 会话读取，不落盘 |
| 生命周期 | 随主机启动（关窗后托盘常驻时照常同步）；退出前做一次有界（1.5s）收尾尝试，失败留给下次启动；`status().receiptSync` 暴露 pending/synced/lastSuccessAt/lastError，服务端工作台显示"未上传 N 条（原因）" |
| 归属绑定 | 回执新增可选 `ownerId`（取自主机**已验证**的委托快照）；服务端校验 owner 必须等于登录成员，否则 403 `receipt_owner_mismatch` 且写 `local_tasks.sync` denied 审计；纯本地任务无 owner，不受影响 |
| 契约与页面 | `packages/contracts` 的 `localTaskReceiptSchema` / `LocalTaskReceipt` 增加可选 `ownerId`；页面同步路径改为上报设备验证过的 owner，而不是"当前登录者" |

证据：

- 新增 `scripts/electron-receipt-sync-check.mjs`（真实 Electron + 进程内 stub 组织服务，16/16）：无需打开设置页即自动上传、重试一次 500 后带 cookie 成功、`ownerId` 来自已验证委托、同版本不重发、运行时新增任务被同步、服务端持续故障时退出仍保留队列、下次启动补交成功。
- 服务端新增 2 项测试：异主回执 403 + 不存储 + denied 审计；同主回执与无 owner 回执均接受。
- 根套件 25 文件 / 254 用例、web 6 文件 / 40 用例、tsc/vue-tsc 0；一键验收新增该项 Electron 检查。

刻意保留：无 cookie 时的首次尝试仍会发出（开发档位允许无凭据回环调用），失败按退避重试；同步只是**镜像**，设备始终是权威，服务端没有反向下发命令的通道。

## 未完成 / 不在本轮

- Gate 7A.2 剩余：Host 侧**持续**回执同步（当前仍由页面触发 best-effort 上传）、断网时的账号归属与设备绑定核对；关窗常驻、托盘重开、断网本机工作台、退出清理、稳定 deviceId 已完成。
- Gate 7A.3：真实 Hermes 上游（固定 tag/commit、uv 管理的 Python 运行时）与真实模型的安全办公闭环仍未验收；本机无 runtime/凭据，保持 BLOCKED，未用 fake 冒充。
- 安装包未重打包：`workbench.html` 已加入 electron-builder `files`，但本轮未重跑 `electron-builder` 与打包后 exe 的 E2E。
- 调研发现、尚未处理：Electron 39.8.x 已不在官方支持窗口（现行为 42/43/44），升级需重新打包与 E2E；远端工作台未使用独立 session 分区；未对远端页面注入 CSP；任务库仍是 JSON（`node:sqlite` + WAL + 行级 CAS 是后续更稳的方向）；Windows 上“主进程被强杀”仍无法保证子进程全部回收（Job Object 需原生插件）。

## 交付判断

H-01～H-06 已按“安全行为”回归并可复现验证；断网本机工作台在真实 Electron 下 11/11 通过。Gate 7A 仍**未整体完成**：真实 Hermes 安全办公闭环（7A.3）与 Host 侧持续回执同步未做，不得据此宣称本机 Agent 已可用于真实员工文件。
