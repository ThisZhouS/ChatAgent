# 第三轮对抗性验证（2026-09-16 晚）：7 项发现与修复证据

独立的对抗性子代理（`Temp/verify-round3/`，hash 固定的修订版）对本机 Agent Host、桌面回执同步、服务端归属绑定做了第三轮验证：8 个探针文件 / 36 个用例，最终 **12 个用例失败 = 7 项发现（F1–F7）**。原始报告：`Temp/verify-round3/REPORT.md`。

本文记录“发现 → 修复 → 复验证据”。探针保留不改（它们断言的正是“漏洞存在”），因此修复后**仍然失败**是预期的：失败即证明原缺陷不再成立。下面每行给出复验时该探针打印的原始证据。

## 修复与复验

| # | 严重度 | 发现（探针断言的行为） | 修复 | 复验证据（同一探针） |
| --- | --- | --- | --- | --- |
| F1 | P1 | 被隔离的坏行（`invalid_persisted_row`）可被 `retry()`（含桌面 IPC `retry`）重新排队并**真的交给执行器**运行，`workDir:''` 也照跑 | `LocalAgentHost.retry()` 在能力下限检查之前显式拒绝隔离行（`blockedReason === INVALID_ROW_REASON`）；`refuseCapabilities` 对空能力列表 fail-closed | `[C1] retry() -> null`、`[C1] ipc retry -> {"ok":false,"error":"retry_refused"}`、`[C1] adapter saw: []`、`[C1] final state: failed` |
| F2 | P2 | 回执去重键是 `updatedAt`，同一毫秒内的新版本被判为“已同步”，**最终结果永不镜像**，而 `status()` 显示 `pending:0` | 去重改为“版本 + 内容”指纹（`receiptFingerprint(receipt, version)`，FNV-1a，只保存在内存里，不上线） | `[C5] same-timestamp change -> calls: 2`（原为 1），第二次上传的 `state` 为 `succeeded` |
| F3 | P2 | 队列上限 200、请求一次全发，而契约 `receipts` 上限 100 ⇒ 101–200 条**永久 400**，队列永不排空 | 按 `MAX_RECEIPTS_PER_REQUEST = 100` 分块，逐块确认逐块落盘；分块大小与契约的上限在单测里对齐（100 通过 / 101 被拒） | `[C5] server statuses: [200,200]`、`after retries: {"pending":0,"synced":150}`、`server rows: 150`（原为 `[400,400,400]`、`pending:150`、`rows: 0`） |
| F4 | P2 | 保留策略把 `interrupted` 当终态淘汰，而主机自己的 `isTerminal('interrupted') === false`（可通过 `retry()` 重跑）⇒ 可重试的工作被静默删除，且**淘汰不可见** | `retention.ts` 的可淘汰集合改为 `succeeded/failed/cancelled`（`interrupted` 永不淘汰）；新增写入期淘汰计数 `store.retentionStats().pruned`，随 `status().storeIntegrity.pruned` 上报 | `[C2] retention over two interrupted rows, cap=1 -> []`、`[C2] memory: ["I-interrupted","Q-queued"] disk: ["I-interrupted","Q-queued"]`、`[C2] age rule over [interrupted, queued] -> []` |
| F5 | P3 | 存活 pid 的锁只要“超过 30 天”就被偷走并删除 ⇒ 常驻主机可能被第二个 writer 顶掉 | `isLockStale()` 只看**存活**：pid 活着就保留锁；歧义情形交给桌面显式同意（`lock-takeover.ts`，审计留痕），无人值守时宁可拒绝启动 | `[C3] 40-day-old lock with a LIVE pid -> AgentHostStoreLockedError`（原为 started + 旧锁被删） |
| F6 | P2 | `toReceipt()` 会产出服务端 schema 拒收的回执（`sha256:''`、超长 `name`/时间戳、未知 `state`）⇒ 服务端整批 400，**一条坏记录毒死整个队列** | 产物缺 sha256（<8 字符）即丢弃、`name`≤255、时间戳≤40 否则用当前时间、非法 `state` 跳过并记 `invalid_receipt:<taskId>`；单测直接用共享契约（`@chatagent/contracts`）校验产物 | `[C5] store-loaded legacy row -> {"sentArtifacts":[],"ok":true,"issues":[]}`、`[C5] poisoned batch statuses: [200]`、`server rows: 2`（原为 `[400,400]`、`rows: 0`） |
| F7 | P3 | 能力下限不 fail-closed：空列表 `[]`、空白项 `['']`、非数组 `toolsets`（提交时被强制成 `['document']`）都能得到“允许”；被种下的空能力 document 行会被执行 | `refuseCapabilities()` 对空列表与空白/非字符串项一律拒绝（用 `some` 而非 `find`，避免空字符串为假值而漏过）；`record-integrity` 把**非数组** `toolsets` 的行隔离为 `invalid_persisted_row`（不再替换成 `['document']`）；`submit()` 对非数组值直接拒绝、省略/空数组仍取文档化默认 `['document']` | `[C7] empty/blank planted rows -> {"planted-empty":"failed/capability_not_granted","planted-blank":"failed/capability_not_granted"} | adapter calls: []`、`[C7] direct non-array submit -> {"string":"failed/…","number":"failed/…","blank":"failed/…"}` |

## 探针中“预期的失败”（不要误读）

修复后仍有 4 个探针用例失败，原因是**探针本身断言的就是旧行为或另一种对齐方式**，不是回归：

| 探针用例 | 探针期望 | 现状 | 说明 |
| --- | --- | --- | --- |
| claim2 `interrupted is NOT terminal …` | `isTerminal('interrupted') === true` 且保留 | `isTerminal` 仍为 `false`，但淘汰结果 `[]`、行被保留 | F4 选择了“保留侧对齐”：`interrupted` 可重试，所以既不淘汰也不改终态定义 |
| claim5 `bounds the on-disk queue …` | 一次请求发出 200 条 | 首次发 100 条（分块） | F3 的分块使单次请求恰好等于契约上限；上限 `MAX_PENDING = 200` 与“保留最新”由 `apps/desktop/receipt-sync.test.mjs` 断言 |
| claim5 `… a >100 queue can never drain` | `[400,…]` 排不空 | `[200,200]` 全部送达 | 该探针断言的正是 F3 的缺陷 |
| claim7 `refuses a planted row …` / `a direct submit with a non-array …` | `planted-string: succeeded`、`undefined: threw TypeError` | `planted-string: invalid_persisted_row`、`undefined: queued`（取默认能力） | 前者是被修掉的缺陷；后者是文档化语义：可信提交面省略 `toolsets` 时取默认 `['document']`（IPC 契约同样默认） |

## 回归证据

- 根套件：**30 文件 / 296 用例通过**（连续两次满跑），`tsc --noEmit` 0 错；web 套件 40 通过、`vue-tsc` 0 错。
- 真实 Electron：回执同步 19/19、显式退出 10/10、生命周期冒烟 6/6。
- 新增回归用例：`packages/agent-host/src/host-security.test.ts` 的 H-07（隔离行永不执行、隔离行不可重试、空/空白/非数组能力全部拒绝、被种下的空能力行按 `capability_not_granted` 拒绝）、`retention.test.ts`（`interrupted` 不淘汰）、`apps/desktop/receipt-sync.test.mjs`（版本指纹、分块排空、分块失败保留剩余、修正后的 schema 一致性）。
- 顺带修掉的**不稳定用例**：`host.test.ts` 的“重启后恢复 running 任务”在负载下会先被调度器取走，改为先 `pause()` 再断言恢复证据，然后 `resume()` 等成功。

## 仍未处理（明确不声称）

F5 的根治（锁心跳/持有者身份而非年龄）与 Gate 7A.2 剩余（Host 侧持续**授权**刷新）仍在 `docs/tasks.md`「下一轮建议」；Gate 7A.3（真实 Hermes + 真实模型凭据）依旧 BLOCKED。
