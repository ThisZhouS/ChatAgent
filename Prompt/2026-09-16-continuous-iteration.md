# 持续迭代：Gate 7A.1 加固与可改进方向调研

日期：2026-09-16；项目：E:\ChatAI；基线：`b33c64d`（工作区含 2026-09-15 文档改动）。关联：`docs/review-2026-09-15-host-gaps-roadmap.md`、`docs/adr-0003-window-resident-agent.md`。

## 原始指令

> 在现在到2026年9月16日19时之间，不断完善迭代该项目。包括但不限于完整性，耦合性，实用性，简约性，安全性。可调用子代理，记得关闭。联网搜索，以了解项目的可改进方向。

## 语义与范围

时间盒内（当日 16:22→19:00）按“先修可信性、再补体验”的顺序推进，不新开产品方向：

1. 完整性/安全性：Gate 7A.1 的 H-01～H-06（提交幂等、可信授权、落盘错误、终态 CAS、单 writer、IPC 契约）。
2. 实用性/简约性：本机卡片显示未执行原因与重试；退出路径收敛为一条幂等拆除；稳定 deviceId。
3. 耦合性：授权判定集中在 agent-host，IPC 只传引用；桌面端只做生命周期与授予，不重复业务判断。
4. 调研：Electron 生命周期/单实例/单 writer、Electron 2026 安全清单、幂等与终态 CAS、Hermes 子进程集成的公开实践。

约束：不改聊天/任务主流程与安全语义；不接真实模型/真实 Hermes；不提交未验证的“已完成”；子代理用完即关；留痕仍用 Markdown，不新增向量存储。

## 结果

- 新增 `docs/iteration-2026-09-16-gate7a1-hardening.md`（本轮范围、变更、证据、未完成）。
- 代码：`packages/agent-host/src/{authorization.ts,host.ts,store.ts,ipc.ts,types.ts,adapter.ts,index.ts}`、`apps/desktop/{main.cjs,preload.cjs,error.html,workbench.html,package.json}`、`apps/web/src/views/SettingsView.vue`；回归 `host-security.test.ts`、`host.test.ts`、`SettingsView.test.ts`，真实 Electron 校验 `scripts/electron-workbench-check.cjs`（断网工作台 11/11）与 `scripts/electron-host-smoke.cjs`（关窗常驻 6/6）。
- 只改文档与上述源码；未改服务端业务、未加依赖、未调用真实模型；安装包重打包与 Electron 版本升级未做（记入技术债）。
- 对抗性复核（独立子代理，34 项探针）：复现 11 项攻击，全部修复并逐条加回归；复跑后 11/11 攻击失败、23 项 FIX-HOLDS 仍通过，报告存档 `docs/review-2026-09-16-adversarial-verification.md`；子代理已结束，无后台任务残留。
- 未决：Gate 7A.2 的 Host 侧持续回执同步与断网账号归属、Gate 7A.3 真实 Hermes 验收；Electron 支持窗口、CSP/session 分区、JSON→SQLite、Job Object 清理列入后续评估。

## 元数据

| 项 | 值 |
| --- | --- |
| 受影响 package/符号 | `@chatagent/agent-host`：`LocalAgentHost.{submit,retry,cancel,stop,close,finish}`、`TrustedAuthorizationRegistry`、`computeActionDigest`、`JsonFileAgentHostStore.{compareAndSet,close,AgentHostStoreLockedError}`、`handleHostCommand`、`validatePersistedRow`/`StoreLoadReport`、`terminateProcessTree`、`inspectStoreLock`/`takeOverStoreLock`、`selectExpiredRecords`；`apps/desktop`：生命周期、`workbench.html`、`receipt-sync.cjs`（回执持续同步）、会话分区与 CSP 注入；`apps/server`：`LocalTaskReceiptStore.upsert`（单调写入）与 `POST /api/local-tasks`（归属校验）；`SettingsView.vue` 本机卡片与保留策略提示 |
| 前置权限 | 本机任务默认许可；副作用任务需已登记委托＋已批准审批，且摘要与载荷一致；IPC 无授予命令 |
| 数据分类 | 任务记录仅存目标/状态/产物哈希与授权引用快照，不含凭据、模型推理或员工文件原文 |
| 是否外发 | 否；本轮不调用模型、不投递消息、不启动真实 Hermes |
| 幂等/取消语义 | 同 id 同载荷幂等返回；同 id 异载荷 `idempotency_conflict`；取消立即写终态，迟到结果按 version CAS 丢弃 |
| 测试 profile | 根 vitest 286（30 文件，含桌面 CJS 单测）、web vitest 40、tsc/vue-tsc 0、Electron 校验：工作台 11/11、关窗常驻 6/6、显式退出 10/10、回执同步 19/19、单 writer 锁 9/9、远程页面 CSP 5/5、导航与桥面 7/7（真实应用）；打包 exe 与打包后 E2E 未重跑 |
| 未验证边界 | 真实 Hermes+模型（Gate 7A.3，BLOCKED）、干净安装、多设备并发、Electron 升级后的回归、完整 XSS 利用链 |

## 第二时间窗续记：2026-09-16 19:00 → 22:00（第四～九轮）

第二时间窗的原始指令与目标不变（窗口顺延至 22:00），按 `docs/tasks.md`「下一轮建议」逐项推进。每轮都遵循同一节奏：**先复现/证明、再改、再回归、最后写进文档**；没有真实凭据的部分保持 BLOCKED，不写成已完成。

| 轮次 | 主题 | 关键证据 |
| --- | --- | --- |
| ④ | 任务库**载入即校验**与隔离（不可信行隔离为失败、可修的行修复、未知字段丢弃、重复 id 按版本取舍、损坏文件另存不留删） | `store-integrity.test.ts` 9 例 + `host-security-verify.test.ts` V-07/V-08；被隔离的行永不进执行器 |
| ⑤ | **回执持续同步**（主进程周期同步、离线队列、按版本去重、失败退避、cookie 不落盘）与**回执归属绑定**（`ownerId` 必须等于登录成员，否则 403 + denied 审计） | `scripts/electron-receipt-sync-check.mjs` 16/19 项（真实 Electron + 进程内 stub 组织服务）；服务端 2 例归属测试 |
| ⑥ | 远程工作台**独立持久分区 + 响应头加固**（缺省 CSP 注入、服务端 CSP 不削弱、分区内权限全拒）；Electron 升级预研（39 已 EOL，实测 Node 22.22.1 且 `node:sqlite` 仍 experimental） | 回执同步检查扩到 19/19（含分区与注入断言）；工作台 11/11、冒烟 6/6、退出 10/10 全部重跑 |
| ⑦ | **执行器子进程树回收**实测（`terminateProcessTree` 提取为可测单元） | `process-tree.test.ts` 5 例真实两级进程树 + `adapter-kill.test.ts` 调用点回归 |
| ⑧ | **单 writer 锁的歧义情形交给人**：弹窗询问（默认不接管）、旧锁改名保留、`lock-audit.jsonl` 审计、无人值守时锁获胜 | `lock-takeover.test.ts` 11 例 + `scripts/electron-lock-check.mjs` 9/9 |
| ⑨ | **CSP 强制执行**用真实载荷证明（内联脚本被拦、同源外链不被误伤、服务端策略不被覆盖）；并修掉检查脚本自身的假通过 | `scripts/electron-csp-check.mjs` 5/5 |
| ⑩ | **任务库保留策略**（只淘汰终态、进行中永不淘汰、载入只报告、写入时才落盘、写失败回滚不丢历史） | `retention.test.ts` 7 例；顺带修掉 zip 炸弹用例的随机失败 |
| ⑪ | **服务端回执单调性**（旧副本不覆盖新状态、同版本幂等、返回 `{accepted, stale}` 并在审计写明） | `apps/server/src/local-tasks.test.ts` 10/10 |
| ⑫ | **远程页面导航/窗口/桥面实测**（窄桥无通用直通、未知命令被拒、window.open 不产生窗口、跨源跳转被阻止、同源跳转仍允许） | `scripts/electron-nav-check.mjs` 7/7；新增 `CHATAGENT_OPEN_EXTERNAL` 部署开关 |
| ⑬ | **回执队列耐久性与增长收敛**（write→fsync→rename、损坏队列另存并上报、去重表随主机淘汰收缩） | `apps/desktop/receipt-sync.test.mjs` 7 例；真实 Electron 回执同步仍 19/19 |

轮次编号在 `docs/iteration-2026-09-16-gate7a1-hardening.md` 中为第四～九轮（"任务库保留策略"并入第九轮之后的收尾）；以该文档为准。

第二时间窗新增/修改的可执行证据：`scripts/electron-receipt-sync-check.mjs`、`scripts/electron-lock-check.mjs`、`scripts/electron-csp-check.mjs`（均接入 `scripts/acceptance.mjs`），以及 `packages/agent-host/src/{record-integrity.ts,process-tree.ts,lock-takeover.ts,retention.ts}` 与其测试。

仍未完成（不得声称已完成）：Gate 7A.3（真实 Hermes + 真实模型的安全办公闭环）、Windows Job Object 回收、Electron 39→42/43/44 升级（本机无外网，二进制无法下载）、打包 exe 重跑与打包后 E2E、完整 XSS 利用链。

### 补充轮次（第十时间窗收尾：⑭⑮）

| 轮次 | 主题 | 关键证据 |
| --- | --- | --- |
| ⑭ | **列表 IPC 有界化与倒序**（`limit` 1..500 默认 200、最新优先、返回 `total`，UI 说明“本机共 N 条、此处显示最近 M 条”） | `host-security.test.ts` H-06 新增断言、`SettingsView.test.ts` 40 通过 |
| ⑮ | **第三轮对抗性验证的 7 项发现（F1–F7）全部修复**：隔离行不可重试/不可执行、回执按版本指纹去重、回执分块 ≤100、保留策略不淘汰 `interrupted` 并上报淘汰数、锁不再按年龄偷存活进程的锁、回执产物符合契约、能力下限 fail-closed | 复验证据见 `docs/verification-2026-09-16-round3-findings.md`；根套件 30 文件 / 296 用例、web 40、Electron 回执 19/19 与冒烟 6/6 |

## ⑯ 2026-09-17 上午：锁心跳与持有者身份（F5 根因）

- 现象：`F5` 说“存活 pid 的锁会被偷”；根因是锁里没有“持有者仍在运行”的证据，只能靠时间猜。
- 做法：锁负载加 `heartbeatAt` + `token`；持有者每 15 s 原子刷新（写临时文件再改名）；新增纯函数 `classifyLock()` 输出 6 种状态与 `stale`/`ambiguous` 两个结论；只有无歧义的情况才自动清理，存活 pid 一律交给人；桌面端心跳新鲜时**不给**接管按钮。
- 同时让心跳自己做归属校验（发现锁易主就停心跳、拒绝写入），释放锁校验 pid+token 并清掉 `.beat`。
- 结果：锁检查 18/18（新增“心跳停止不抢锁”“心跳在推进”“退出后无残留”），根套件 31 文件 / 307 用例，`tsc`/`vue-tsc` 0 错。
- 教训：这一轮自己引入过一个缺陷（`resolveDeviceId` 被误改成 `async` → `status()` 返回 Promise → IPC“无法克隆”），是端到端 Electron 检查抓到的；单元测试全绿并不能替代真机检查。

## ⑰ 2026-09-17 中午：Host 侧持续授权刷新（Gate 7A.2 剩余）

- 问题：委托/审批只在宿主内存里，关窗常驻的宿主从不向组织服务复核撤销/过期；一次网络抖动也不该逼员工重新授权。
- 做法：服务端新增 `POST /api/agent-authorizations/verify`（只回 id+状态+到期时间，`supportedKinds` 声明只管 `approval`，他人/未知/无台账一律 `unknown`，不回传审批内容）；宿主新增 `authorizationRefresh`（默认 60 s，仅在有授权时提问，超时按失败处理），`active` 刷新到期时间、`revoked|expired` 本地撤销、`unknown` 只标记不销毁、失败/超时 → `unverified`。
- fail-closed 的边界：`unverified` 时新的外部副作用任务**暂缓**（不失败、不占租约、留队列，恢复后自动继续），在跑任务不回滚，本地文档任务不受影响；`status().authorization` 与设置页「授权复核」可见。
- 结果：新增 `authorization-refresh.test.ts` 10 例与 `agent-authorizations.test.ts` 4 例；真实 Electron 回执检查新增两项授权断言后 21/21；根套件 33 文件 / 321 用例（连续两次）、web 41、`tsc`/`vue-tsc` 0 错。
- 顺带修掉两个负载下的不稳定用例（改用带截止时间的 `waitFor`，并把崩溃模拟的执行时长从 0.8 s 放到 5 s）。
