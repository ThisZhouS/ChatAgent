# 归档：第二轮对抗性验证报告（Gate 7A，2026-09-16）

> **状态（2026-09-16 18:35，收口后）**：本报告 12 项发现中 **7 项已修**（R2-01…R2-07，见
> `docs/iteration-2026-09-16-gate7a1-hardening.md` 第二节），1 项（R2-08 自定义 store 缺
> `createIfAbsent`）保留为嵌入边界，4 项静态推测（R2-09…R2-12）中：R2-09（`file:` 作为应用源）
> 与 R2-10 的"无托盘 ⇒ 关窗即退出"已修，R2-11（pid 复用陈旧锁最长 30 天）与 R2-12
> （CSP 依赖 textContent 渲染）保留并写入 `docs/security-checklist.md` §4.1/§7。
> 探针复跑：修复前 3 项不变量断言失败；修复后这 3 项转绿、7 项攻击型探针失败（攻击不再成立）、
> 其余 25 项仍通过。原始探针仍在 `Temp/verify-round2/`（未入库）。
>
> 以下为验证子代理原始报告全文。

---

# Round-2 adversarial verification (fixes ce1dcfc / 00c8813)

Repo: E:/ChatAI @ d03cd83, Node v24.11.0, Windows. Nothing outside Temp/verify-round2/ was modified.

Artifacts: `Temp/verify-round2/adversarial.test.ts` (32 tests), `Temp/verify-round2/vitest.config.ts`, `Temp/verify-round2/run.log`.

Commands run
```
cd /e/ChatAI && node node_modules/vitest/vitest.mjs run --config Temp/verify-round2/vitest.config.ts --reporter=dot
  -> Test Files 1 failed (1) | Tests 3 failed | 29 passed (32)   # the 3 failures are R2-01/02/03
cd /e/ChatAI && node node_modules/vitest/vitest.mjs run packages/agent-host --reporter=dot
  -> Test Files 4 passed (4) | Tests 49 passed (49) | Errors 1 error  # the error is R2-03
```

## CONFIRMED (reproduced)

| # | Sev | Finding | file:line | Repro + observed output |
|---|---|---|---|---|
| R2-01 | P1 | The document capability floor is enforced only in `submit()`. A store row that already exists with `kind=document` and an external toolset (`toolsets:["web"]`) is dispatched with no delegation/approval, and `submit()` replay / `retry()` / `recoverInterrupted()` all keep it alive. Pre-fix rows of exactly this shape are what the previous version wrote, so an upgrade over an existing tasks.json re-runs them. | host.ts:202-203 (early return before the floor), host.ts:250 (only call site of refuseCapabilities), host.ts:394-415 (dispatch), host.ts:417-441 (execute re-checks `authorize` but not the floor), host.ts:336-357 (retry re-queues stored toolsets), store.ts:215-238, store.ts:99-122 (load does not validate toolsets) | D3: seed `rec({taskId:"legacy",kind:"document",toolsets:["web"],state:"queued"})`, `host.start()`, sleep 500ms -> `[R2] D3 adapter saw: [{"taskId":"legacy","toolsets":["web"],"goal":"browse the internet"}] | state: succeeded`. D4: `submit({taskId:"legacy2",kind:"document",goal:"browse",toolsets:["web"]})` on a legacy row -> `[R2] D4 replay -> queued ["web"]` (no refusal). D5: `retry("legacy3")` -> `[R2] D5 retry -> queued ["web"]` |
| R2-02 | P2 | `commit()` rollback is unconditional, so a failed write rewinds the in-memory map over a LATER write that already succeeded (and already returned to its caller). Memory and disk then disagree; the next write persists the stale state, so the successful write is silently lost. Two shapes: plain `put()` (A1) and get()+CAS, which is the exact pattern of `finish()` (A5). | store.ts:255-268, store.ts:137-157 (put), host.ts:525-556 (finish = get then CAS) | A1: put(A) ok; arm one-shot rename failure; `put(B)` then `put(C)` concurrently -> `[R2] A1 settled: [rejected, fulfilled] | memory: A v1 | disk: C v3`; `assert mem.goal === disk.goal` FAILS (`expected A to be C`). A5: `[R2] A5 settled: [rejected, fulfilled] | optimistic B v2 | mem A v1 | disk C v3`, same assertion fails. A3 control (claim/release rollback) is correct: `[R2] A3 claim error: EPERM... | lease after failed claim: undefined v1` / `[R2] A3 release error: EPERM... | mem lease: h1 | disk lease: h1` |
| R2-03 | P2 | A store failure inside the fire-and-forget execution chain escapes as an UNHANDLED promise rejection: `tick()` catch does not cover `void this.execute()` (host.ts:413) nor the `finish()` inside execute catch (host.ts:508). The host does not even record it in `lastError`. On plain Node (and Electron main with default policy) an unhandled rejection terminates the process. The fixes own suite already trips it. | host.ts:384-392 (tick try/catch), host.ts:413, host.ts:459-465 (CAS outside the try), host.ts:505-515 | I1: wrapper store whose `compareAndSet` throws once for state running -> `[R2] I1 unhandledRejections: ["Error: EPERM: transient store write failure"] | task state: cancelled | lease left: undefined | host.lastError: undefined`. Repo suite: `run packages/agent-host --reporter=dot` -> `Errors 1 error` with stack `guard host-security-verify.test.ts:83 -> Object.compareAndSet :98 -> LocalAgentHost.finish host.ts:554 -> LocalAgentHost.execute host.ts:508`. Control I2 (claim throws) is contained: `[R2] I2 unhandledRejections: [] | lastError: EIO: claim failed` |
| R2-04 | P3 | False refusal: a toolset the real adapter accepts for a document task is rejected by the new floor, so a legitimate document submission becomes a failed record. `DOCUMENT_TOOLSETS` only holds the two ChatAgent-level names while `resolveHermesToolsets` also accepts every raw HERMES_TOOLSETS name. | host.ts:574, host.ts:590-599, adapter.ts:74-91 | D2: `resolveHermesToolsets(["file"]) = {"toolsets":["file"],"invalid":[]}` (adapter would run) vs `host says failed capability_not_granted`. Desktop workbench always sends ["document"] (workbench.html:290), so this needs a direct/other caller |
| R2-05 | P3 | `submit()` throws a raw `TypeError` when `toolsets` is not an array (the floor calls `.find` before any kind check). No state change (nothing is written), but a direct in-process caller gets an untyped crash instead of a blocked record. The IPC schema does block it. | host.ts:594, host.ts:206 | D6: `[R2] D6 direct: TypeError: toolsets.find is not a function | ipc string: {"ok":false,"error":"invalid_command","detail":"Expected array, received string"}` |
| R2-06 | P3 | `interrupted` is neither terminal nor claimable, so `status()` reports a task in none of the three counters and the desktop workbench shows 0/0/0 while the row exists; being non-terminal it can also still be overwritten by a late `finish()`. | types.ts:41, host.ts:173-175, store.ts:184 | H3: `[R2] H3 {"queued":0,"running":0,"finished":0}` with one interrupted task stored; `isTerminal("interrupted") = false` (C1) |
| R2-07 | P3 | `put()` still overwrites one terminal state with another, so a stale writer can replace `succeeded` with `failed` (the new guard only blocks terminal -> non-terminal). Pre-existing, unchanged. | store.ts:142-150, store.ts:386-394 | C2: `[R2] C2 after put: failed stale writer v2` after storing `succeeded` |
| R2-08 | P3 | Documented fallback path: when a store has no `createIfAbsent`, two racing submits of one taskId both succeed and the second silently replaces the first (no `idempotency_conflict`). Only affects custom stores; both bundled stores implement `createIfAbsent`. | host.ts:280-296 | B2: `[R2] B2 ["ok:first@v2","ok:second@v1"] | stored: ["first@v2"]` (both callers told OK, one row, winner = second) |

## SUSPECTED (static review only, no Electron run)

| # | Sev | Finding | file:line | Reasoning |
|---|---|---|---|---|
| R2-09 | P3 | Desktop IPC trusts ANY `file://` sender frame, and `isAppOrigin` compares raw origins (both are the string "null" for file: URLs). If `serverUrl` is ever a `file:` URL (`--server=`, CHATAGENT_SERVER_URL, config.default.json), `will-navigate` permits navigation to arbitrary local files and those pages inherit the preload host bridge plus trusted-sender status - any downloaded HTML could then drive the agent host. Needs local argv/env/config control; not reachable from remote content alone. | main.cjs:254, main.cjs:42-50, main.cjs:96-100, main.cjs:23-39, preload.cjs:7-24 | Static read; no run() performed |
| R2-10 | P3 | Quit path has no deadlock: the race always settles, the `before-quit` latch lets the second quit pass, double close/stop are safe (E1). But if `host.close()` exceeds 8000 ms the app quits with the host possibly mid-run and the store lock file left behind (next start steals it via the dead-pid rule) - the in-flight side effect is killed without a terminal state. Also `window-all-closed` never quits and `createTray` returns early when assets/tray.png is missing, which would leave an invisible app with no quit affordance (the asset exists in this checkout). | main.cjs:164-189, main.cjs:409-413, main.cjs:400-402, main.cjs:300 | Static read; the tray asset exists so the invisible-app branch is not reproducible here |
| R2-11 | P3 | A stale lock whose pid was reused by a live unrelated process blocks startup for up to 30 days; the desktop only shows a dialog and cannot self-heal. Deliberate trade-off, but the failure mode is hard for a user to clear (manual delete of tasks.json.lock). | store.ts:317-348, store.ts:71-72, main.cjs:377-388 | G1: `pid 4 + recent -> agent_host_store_locked`, `pid 4 + 40d old -> acquired` |
| R2-12 | P3 | Workbench CSP is real but weak by construction: inline script and inline style are allowed; safety rests on the textContent-only rendering (verified: no innerHTML/outerHTML/insertAdjacentHTML/document.write anywhere under apps/desktop) and on no remote sources (`default-src none`, `connect-src none`). No HTML injection sink found today; a single future `innerHTML` would be executable. | workbench.html:8-11, workbench.html:147-221 | Static read + grep |

## REFUTED (attacked hard, fix held)

- A4 close() racing a queued write: the write is refused with `agent_host_store_closed`, nothing lands on disk, the lock is released (`disk goals: [] | lock left: false`). No window where a write survives the lock release.
- A3 claim()/release() rollback: memory matches disk exactly; no phantom lease after a failed claim, lease preserved after a failed release.
- A2 two plain concurrent CAS calls for one record: the second sees the first optimistic version and returns undefined - the CAS path alone does not diverge (A5 needs an explicit get() between them).
- B1 two hosts on one Memory store, same id different goal: exactly one ok, one error, one row.
- B3 createIfAbsent throwing: submit rejects with `task store write failed: disk on fire`, zero records - no phantom task.
- B4 versioning: create -> v1, put -> v2, CAS(2) -> applied, stale CAS(1) -> undefined, createIfAbsent on an existing id is a no-op (`second: undefined`).
- C1/C3 terminal_state_protected does not block retry (CAS bypass) or recoverInterrupted (running -> queued for document, -> interrupted for side_effect); put(queued) over interrupted allowed; equal terminal state allowed (`ok@v2`); put(queued) over failed throws as intended.
- D1 18 attack spellings refused for kind=document: web, *, terminal, code_execution, node, python, shell, custom, browser, computer_use, messages, messages.send, DOCUMENT, Document, " document", "document ", "document\u0000", ["document","web"]; ["document"], ["document","document.read"], [] and duplicates allowed ([] -> stored ["document"]).
- D6 [null] toolset entries and string toolsets are rejected by the IPC schema before reaching the host.
- E1/E2 closed guard: after close() list/get/status still work; start/pause/resume/tick/stop/close-again all resolve; submit/retry/cancel throw `host_closed`; load() after close() does not re-acquire the lock and put/claim/CAS are refused with `agent_host_store_closed`. The desktop shutdown path (close only) is not broken by the guard.
- F1/F2/F3 approvals: the digest binds taskId (digestA != digestB, second task -> `failed/approval_digest_mismatch`); the approval survives cancel-before-dispatch (`true`), is consumed by the real run (`consumed: true`) and the same taskId never re-runs (`adapter runs: 1`, re-submit -> succeeded record); a side_effect re-queued after its approval was consumed is not dispatched at all (`adapter runs: 0`, state interrupted) - fail closed.
- G1 lock payloads: pid 0 / -7 / 999999 / 0.5 / "abc" / missing -> acquired; live pid + recent/future/unparseable date -> locked; live pid + 40 days -> acquired; pid 4 + recent -> locked; truncated lock with live pid -> locked (regex salvage works), with dead pid -> acquired; empty file -> acquired.
- G2/G3 a second store instance for the same file in the same process is refused (`agent_host_store_locked`); two stores on different files both start.
- I2 a claim() failure is contained by tick() and recorded in `lastError` (only the execute chain leaks - R2-03).
- H2 stop() during an in-flight run leaves a terminal state (succeeded/cancelled); H4 a caller-supplied workDir (C:/Windows/System32) is replaced by the host workRoot.

## Residual risk

1. Windows AV/Defender makes tmp-write + rename transiently fail (EPERM/EBUSY); that is exactly the trigger for R2-02 and R2-03, and it is a routine event on this platform, not an exotic fault.
2. Single-writer enforcement is only the lock file: a local process that rewrites tasks.json bypasses every host invariant, including the capability floor (R2-01 needs no more than a legacy row).
3. There is no migration/validation of persisted rows on load (store.ts:99-122); toolset and kind are trusted forever once written.
4. `interrupted` remains an odd state (non-terminal, non-claimable, invisible in counters, non-retryable for side effects).
5. Grants (delegation/approval) are memory-only, so after a restart the desktop cannot re-authorize without the org server - fail closed, but the workbench cannot recover on its own.
6. Not covered by this round: a real Electron quit/session-end run (R2-09/10 are static), and the real Hermes binary path with a toolsets:["web"] document row.