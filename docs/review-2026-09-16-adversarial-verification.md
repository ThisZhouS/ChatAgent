# 2026-09-16 对抗性验证报告（Gate 7A.1 修复的独立复核）

来源：独立子代理（只读仓库，除 `Temp/verify-2026-09-16/` 外未改任何文件）。原始产物在 `Temp/verify-2026-09-16/`（34 项探针、日志、两个独立脚本），本文件为其存档副本，便于在仓库内长期留痕。

## 修复状态（修复后复跑同一套探针）

| 项 | 结论 |
| --- | --- |
| 攻击复现 | 修复前 11 项 `[attack]` 探针全部复现；修复后 **11/11 全部失败**（攻击不再成立） |
| 防线复核 | 23 项 `FIX-HOLDS` 探针仍然通过（原先就攻不破的部分没有被削弱） |
| 已修 | C1 关店后仍写库；C2 12 小时规则夺走存活持有者的锁；C3 释放非自己的锁；C4 截断锁被当作废弃；C5 并发首次访问自锁；C6 `document` 种类绕过委托与审批；C7/C13 写失败仍报成功与幽灵记录；C8 并发提交竞态；C9 旧记录缺少摘要即免检；C10 派发器未捕获拒绝；C11 缺少工具集白名单；C12 陈旧 `put` 复活终态；C15 审批可重复使用 |
| 保留并记录（未改语义） | C14 桌面链路中设备令牌是纵深防御而非主控制（真正的控制是发送方校验）；审批未绑定委托时仍可授权（动作摘要已锁定具体载荷）；真正同时的多进程写、`CHATAGENT_HOST_ROOT` 被两个安装共享、Windows 上 `taskkill` 的实际执行，均未在测试中覆盖 |
| 回归 | `packages/agent-host/src/host-security-verify.test.ts`（12 项）逐条封堵上述攻击；根套件 24 文件 / 238 用例、web 6 文件 / 40 用例、tsc/vue-tsc 0、真实 Electron 工作台 11/11 与关窗常驻 6/6 |

修复细节与文件位置见 `docs/iteration-2026-09-16-gate7a1-hardening.md`。

---

# Gate 7A.1 adversarial verification — independent findings

Verifier: independent subagent (no repo files outside `Temp/verify-2026-09-16/` were modified).
Probes: `Temp/verify-2026-09-16/probe-v{1,2,3,4}-*.test.ts` (34 tests) + `probe-crash.mts` + `probe-document-bypass.mts`.

Commands and results:
- `node node_modules/vitest/vitest.mjs run -c Temp/verify-2026-09-16/vitest.config.ts --reporter=dot` -> **4 files, 34 tests, all passed** (log `probes-final.log`). Convention: a test named `[attack] ...` passing means the attack was REPRODUCED; a test named `FIX-HOLDS: ...` passing means I could not break it.
- `node node_modules/.pnpm/tsx@4.23.13/node_modules/tsx/dist/cli.mjs Temp/verify-2026-09-16/probe-crash.mts` -> exit 7 (unhandled rejection escaped).
- `node node_modules/.pnpm/tsx@4.23.13/node_modules/tsx/dist/cli.mjs Temp/verify-2026-09-16/probe-document-bypass.mts` -> exit 9 (bypass confirmed).
- The repo suite (`packages/agent-host/src`) was NOT re-run (budget); only my own probes were executed.

## CONFIRMED findings

| # | Sev | Finding | Evidence |
|---|-----|---------|----------|
| C1 | P1 | **A closed host still writes tasks.json after `close()` released the single-writer lock, destroying the current lock holder's records.** `submit()` has no `closed` guard; `put`->`persist` writes the whole in-memory snapshot with no lock check. | v3.1: on disk while store2 held the lock `["first_task","second_writer_task"]`; after the closed host submitted, `["first_task","late_after_close"]`; `lock file still present after close() = false`. host.ts:186-193, store.ts:250-270 |
| C2 | P1 | **The 12h staleness rule evicts a LIVE holder** (age is checked before liveness), so a long-running window-resident host (>12h, the documented design) silently loses its lock to a second process; both then persist the whole file, last writer wins. | v3.2: lock `{pid: <live own pid>, startedAt: 13h ago}` -> `threw = NO — lock was stolen from a live holder`. store.ts:148-152 |
| C3 | P2 | **`releaseLock()` deletes a lock file it does not own** (unconditional `rm`), so a host whose lock was stolen removes the thief's lock and a third writer can enter. | v3.3: child pid lock (live) present before `A.close()`, absent after. store.ts:294-299 |
| C4 | P2 | **An unparseable lock of a LIVE writer is treated as abandoned** -> stolen. | v3.4: truncated JSON containing a live child pid -> `threw = NO — stolen, two writers now`. store.ts:170-175 |
| C5 | P2 | **Concurrent first access to a fresh store self-locks**: `load()` marks `loaded` only after `acquireLock()`, so N concurrent calls all pass the `lockHeld` test and all but one get EEXIST -> `AgentHostStoreLockedError`. | v3.5: `["ok", LockedError, LockedError, LockedError]` for `Promise.allSettled([get x4])`. store.ts:80-83, 262-283 |
| C6 | P2 | **`kind:'document'` bypasses delegation AND approval completely for an external-effect toolset.** `authorize()` returns ok for document before any check; toolsets are caller-declared and not allow-listed by the host; only `FORBIDDEN_TOOLSETS` is enforced (inside the adapter). | v2.2 + document-bypass probe: empty registry, `{kind:'document', toolsets:['web']}` -> state succeeded, adapter called with `["web"]`, blockedReason none, runs=1. authorization.ts:35, adapter.ts:22-70, ipc.ts:31-45 |
| C7 | P2 | **A failed terminal write reports success in memory while disk still says `running`** (CAS mutates the map before `persist`), so a restart re-queues and re-runs the task (duplicate execution) and `list()`/the UI shows `succeeded` for a non-durable result. | probe-crash A: persist calls=4, in-memory `succeeded`, on-disk `running`, lastError set, unhandled=0. store.ts:99-108, host.ts:456-500 |
| C8 | P2 | **Idempotency race: two concurrent submits of one taskId with different payloads are BOTH acknowledged** (check-then-write, no CAS), and the payload that runs can differ from the payload the surviving record describes. | v1.1: both settled ok (versions 1 and 4); run 1 executor ran goal A while the record said goal B, run 2 the opposite (`receipt/payload mismatch = true`). host.ts:186-215 |
| C9 | P2 | **A legacy record without `actionDigest` permanently defeats the different-payload check** (`existing.actionDigest !== undefined && ...`). Any tasks.json written by the pre-H-01 host is exempt. | v1.2: legacy record -> submit with a different goal AND `kind:'side_effect'` -> `threw = NO`, caller received the old document record. host.ts:194, store.ts:355-358 |
| C10 | P3 | **Unhandled rejection escapes the dispatcher** when `store.list()` rejects: `tick()` awaits `list()` outside any try/catch and every call site is `void this.tick()`. Under Node's default policy this terminates the process (Electron main). | probe-crash B: `unhandledRejection: synthetic transient list failure`, exit 7. host.ts:283-285, 275, 122-124 |
| C11 | P3 | **No host-level toolset allow-list**: `['*']` and `['terminal','code_execution']` are accepted for a document task and handed to the executor; with `FakeHermesAdapter` (the desktop fallback when the real runtime is missing) nothing enforces it. | v4.5: `toolsets handed to the executor = [["*"],["terminal","code_execution"]]`. host.ts / adapter.ts:61-83 |
| C12 | P3 | **A stale `put()` resurrects a terminal record and the host re-runs it** (`put` is an unconditional upsert; only CAS is guarded). | v3.7: runs 1->2, version 4->8 after replaying a queued copy. store.ts:88-96 |
| C13 | P3 | **A failed write leaves the record readable in memory ("phantom")**: `put` sets the map before `persist`, so `get()`/`list()` show a task that is not on disk (the H-03 claim holds only for submit's return value). | v3.8: `put() threw = EPERM ... rename`, `get(phantom) = queued`, `list() = ["phantom"]` |
| C14 | P3 | **The device-token gate is a no-op in the desktop wiring**: main.cjs passes `deviceToken` as both context and presented token, and the preload sends no token, so it can never fail; the real control is the sender-origin check. | v4.3: `{"ok":true,"result":{"tasks":[]}}` with no renderer token. main.cjs:260-265, preload.cjs:16 |
| C15 | P3 | **Approvals are not single-use and are unbound unless `delegationId` is set**: one approval for digest D authorized a different delegation with the same owner; two approvals for one digest both authorize. | v2.6 runs=1; v2.7 both ok. authorization.ts:66-72 |
| C16 | P3 | **Digest is order-insensitive and computed post-normalization**: toolset order swap is authorized; `toolsets: []` is widened to `['document']` before hashing. No escalation found, but the approval binds a normalized payload, not the declared one. | v2.2 (order-reversed runs=1); host.ts:186,216; authorization.ts:154-166 |
| C17 | P3 | **False doc comment**: `grantDelegation` claims to reject already-expired grants; it only checks parseability. | v2.8: past expiry -> no throw, stored. authorization.ts:57 |
| C18 | P3 | **UI offers 重试 for tasks the host always refuses** (failed/interrupted regardless of kind, while `retry` refuses side-effect tasks). | v4.4 `retry_refused` for a side-effect task; SettingsView.vue:465-473 |

## REFUTED (attacked, could not break)

- **H-02 approval replay**: goal variants (trailing space, zero-width space, newline, rewritten goal), toolset subset/duplicate, wrong digest, `approved:false`, past expiry, foreign owner, approval bound to another delegation, unregistered id -> all blocked with the exact expected reason, 0 runs (v2.1, v2.3).
- **Authorization re-checked immediately before execution**: delegation revoked while queued -> `delegation_unknown`; approval that expires between submit and run (injected clock) -> `approval_expired`; both 0 runs (v2.4a/b).
- **Delegation binding**: other device -> `delegation_unknown`; other agent -> `agent_mismatch`; missing capability -> `capability_not_granted`; expired -> `delegation_expired`; absent -> `delegation_missing` (v2.5).
- **Path traversal via taskId** (`..`, `../../escape`, `C:\\Windows\\Temp\\x`, `..\\..\\escape`, `a/../../b`, UNC): contained in the work root or refused with `workroot_refused`; nothing created outside (v2.9).
- **IPC strictness** (H-06): inline `delegation`/`approval`, extra `workDir`/`agentId`/`deviceId`/`token`, unknown `type`, 129-char taskId, empty goal, bad kind, 11 toolsets, `__proto__` key -> all `invalid_command`, no runs, no prototype pollution (v4.1). Wrong/missing/empty token -> `unauthorized` at unit level (v4.2).
- **IPC contract**: `list` returns `{tasks}` (not an array), blocked rows carry `blockedReason`/`error`, `retry` refused for succeeded/side-effect/unknown, `idempotency_conflict` surfaces as itself, authorized side-effect submit records the verified snapshots and a replay does not re-run (v4.4, v4.6, v4.7).
- **H-04 terminal CAS**: cancel beats a late success (state stays `cancelled`, `lateResultsDropped=1`); `recoverInterrupted` never yields `succeeded` for a killed run, side-effect survivors become `interrupted` and never re-run (v3.10, v3.11).
- **Lifecycle**: `stop()` twice is idempotent; a signal-ignoring executor is bounded by `stopTimeoutMs` (312 ms for 300 ms) and the task ends `cancelled` (v3.10).
- **`retry()`**: concurrent double retry requeues exactly once (1 of 2 accepted); refuses succeeded/side-effect/max-attempts/interrupted-side-effect (v1.4, v1.5).
- **H-05 happy paths**: a live second writer is refused in-process and against a real live child process (`AgentHostStoreLockedError`, code `agent_host_store_locked`); a killed holder is taken over; a lock with no `startedAt` but a live pid is refused (v3.6).
- **H-03 Nth-write failure**: a write failure during `claim` sets `lastError` without killing the dispatcher and the task runs once the store recovers (v3.9). My hypothesis that a finish-write failure escapes as an unhandled rejection was **wrong** — `execute()`'s catch absorbs it (probe-crash A: unhandled=0), though see C7 for the durability consequence.

## Residual risk not tested in the budget

1. Real Hermes executor: process-tree kill (`taskkill /pid <pid> /T /F`) on abort/timeout was only read, never exercised live; a `taskkill` that exits non-zero does not fall back to `child.kill('SIGKILL')` (the `error` handler fires only on spawn failure).
2. Electron main lifecycle (`shutdownHostOnce`, `before-quit`, `query-session-end`, `setPermissionCheckHandler`, `openExternalIfSafe`, `device.json`) — static reading only; no packaged-app run.
3. Truly simultaneous multi-process writes (my two-writer evidence is sequential, same last-writer-wins snapshot semantics).
4. `CHATAGENT_HOST_ROOT` pointing two installs at one store (defeats the single-instance lock behind C1/C2).
5. Real disk-level failure modes beyond the injected/simulated ones (ACL, EIO, AV locks).
6. `sandbox.ts` symlink/overwrite helpers and `collectArtifacts` (outside the reviewed fixes).
