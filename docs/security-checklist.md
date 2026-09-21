# ChatAgent 部署安全清单 / Deployment Security Checklist

适用于内网单组织部署。逐项确认后再对外提供服务。

## 1. 认证与身份

- [ ] `CHATAGENT_AUTH_MODE=production`（默认在 `NODE_ENV=production` 时已是 production；`start-server.cmd` 会打印开发档位警告）。
- [ ] `CHATAGENT_ALLOW_DEV_AUTH=false`（**绝不要**在共享网络启用；开启后任意主机都能拿到 owner 身份）。
- [ ] 为每个使用者签发独立成员令牌：`node scripts/add-member.mjs <id> <名称> <强令牌> [组织] [角色]`，或登录后由管理员在「成员」页创建（令牌只显示一次）。
- [ ] 只给必要的人 `owner`/`admin`：owner 可管理 owner 与账号，admin 可管理普通成员与审批。
- [ ] 反向代理必须透传真实来源地址（例如 Nginx `proxy_set_header X-Forwarded-For`）并在应用前设置 `trustProxy`；否则同机代理会让所有远程调用看起来像回环，触发开发档位回落。**当前版本未启用 trustProxy**，因此同机反向代理部署等同把 owner 暴露给匿名用户 —— 必须使用 production 档位。
- [ ] 成员离职/设备丢失：在「成员」页重置令牌（会同时吊销该成员全部会话）。

## 2. 传输与浏览器侧

- [ ] 前置 HTTPS（TLS 终止在 Nginx/网关）；HTTPS 下会话 Cookie 自动带 `Secure`。
- [ ] 已内置：`Content-Security-Policy`（`default-src 'self'`、`frame-ancestors 'none'`）、`X-Content-Type-Options`、`X-Frame-Options: DENY`、`Referrer-Policy`、`Permissions-Policy`、COOP。
- [ ] Cookie 为 `HttpOnly + SameSite=Strict`，且**只读**：非 GET/HEAD 请求必须带 Bearer 令牌（无 CSRF 面）。
- [ ] 不要在浏览器里用同一账号共享令牌；每个使用者一个成员身份，审计才有意义。

## 3. 数据与备份

- [ ] `CHATAGENT_DATA_DIR` 指向受控目录（默认 `./data`），仅服务账号可读写。
- [ ] 备份内容：`data/*.json`（成员、会话、消息、任务、审批、outbox、上传/产物索引）、`data/artifacts/`、`data/uploads/`、`data/audit.jsonl`。
- [ ] 审计日志 `data/audit.jsonl` 只写不删；字段已截断且不含令牌与消息正文。当前覆盖：登录/登出、按对象拒绝（`auth.denied`/`access.not_found`）、限流、成员 CRUD 与令牌重置（`member.created`/`auth.token_rotated`）、建群（含**被拒**的 `conversation.group_created`）、加人/退群（`conversation.member_added`/`conversation.left`）、发送（`message.sent`，工作台与原生路径）、上传拒绝（`upload.rejected`）。**AI 回复不逐条审计**（见已知缺口）。
- [ ] JSON 存储为单进程写入（消息/会话为防抖合并写）。**不要**让两个服务实例指向同一数据目录。

## 3.1 会话与群成员

- [ ] 会话只对**参与者**开放：`GET/POST /api/conversations/:id/messages` 对非参与者一律 404；`POST /api/messages` 若解析出的会话不含调用者则 403（防止用他人 `chatId` 劫持会话）。
- [ ] 建群语义：**只增不减**（同名同成员的键会复用同一会话，重复提交不会踢人）；键已存在且调用者不是参与者时返回 `409`，必须由现有成员邀请才能加入。
- [ ] 退群即失去该会话的消息、任务读取/取消/恢复与产物下载权限；重新加入只能通过成员邀请。
- [ ] 群管理与审计：改名（`PATCH /api/conversations/:id`）与移出成员（`DELETE /api/conversations/:id/members/:memberId`）都要求调用者是参与者，且分别写 `conversation.renamed` / `conversation.member_removed`；自助退出走 `/leave`。
- [ ] 组织管理员按设计可读本组织全部会话（`canReadConversation`）；如需更严格模型，请改造该分支为显式授权。

## 4. 外发与审批

- [ ] `CHATAGENT_ENABLE_EXTERNAL_CHANNELS=false`（默认）。若启用第三方通道，必须为每个通道配置 `CHATAGENT_<CHANNEL>_SIGNING_SECRET` 或 `..._TOKEN`，未配置时生产档位一律 401。
- [ ] `CHATAGENT_APPROVAL_TTL_SECONDS` 按合规要求设置（默认 1800s）；审批单次使用、绑定发起任务与载荷摘要。
- [ ] 复核 `data/outbox.json` 中 `unknown` 记录（超时/5xx）：这类记录**不会自动重发**，需要人工对账。
- [ ] `simulated` 表示没有真实投递通道（不计为送达）；接入真实网关后才会出现 `accepted/delivered`。

## 4.1 本机 Agent 主机（Gate 7A，2026-09-16）

- [ ] 授权只走受信路径：委托/审批由主进程根据组织服务响应或本地明确同意登记（`TrustedAuthorizationRegistry`），IPC 只接受 `delegationId`/`approvalId` 引用；页面/渲染进程传入的任何"审批对象"都会被 `.strict()` schema 拒绝（`invalid_command`）。
- [ ] 本机不自我审批：注册表默认为空 ⇒ 一切副作用任务 fail-closed（`delegation_missing`），且授权在执行前复核一次（撤权/过期即拒）。
- [ ] 审批单次使用：副作用任务真正开跑前消耗审批（`consumeApproval`）；摘要绑定 taskId/agentId/kind/goal/toolsets，同 id 异载荷报 `idempotency_conflict`。
- [ ] 工具集白名单：`document` 任务只允许 `document`/`document.read`，`*`/`terminal`/`code_execution` 等一律 `capability_not_granted`（host 级，不依赖适配器）。
- [ ] 单 writer：任务库 `tasks.json.lock` 由存活 pid 独占，第二写者被拒（`agent_host_store_locked`）；`close()` 后进程拒绝再写（`agent_host_store_closed`），且只释放自己写的锁。
- [ ] 桌面端：`app.enableSandbox()`、`contextIsolation` 且无 `nodeIntegration`、外链协议白名单（http/https/mailto）、权限检查默认拒绝、拒绝 webview 附着、断网本机工作台 `workbench.html` 用严格 CSP + `textContent` 渲染且不接受页面传入的加载位置。
- [ ] 远程页面的**导航与桥面已实测**：`scripts/electron-nav-check.mjs`（7/7）证明页面桥只有 `host/platform/versions` + `command/openWorkbench/quitApp`（无通用 IPC 直通）、未知命令被拒、`window.open` 不产生窗口、跨源顶层跳转被阻止、同源跳转仍允许；外链在 `CHATAGENT_OPEN_EXTERNAL=off` 时只记日志不拉起浏览器。
- [ ] CSP **强制执行已验证**：`scripts/electron-csp-check.mjs`（真实 Electron，5/5）用 stub 页面证明——服务端不发 CSP 时注入策略真的阻止内联脚本执行、且不误伤同源外链脚本；服务端自带 CSP 时桌面不覆盖（`cspInjected=0`/`cspFromServer=1`）。完整 XSS 利用链（含被信任第三方脚本）仍未构造，不夸大结论。
- [ ] 单 writer 锁的**歧义**情形不静默处理：持有者 pid 仍存活（可能被复用）或锁损坏时，桌面弹窗询问，默认"不接管"；只有本地用户明确选择才 `takeOverStoreLock`。旧锁改名保留（`*.replaced-<ts>`）而非删除，接管写入 `<store>.lock-audit.jsonl`（actor=`local-user-consent`、原因、原持有者）。无人值守（`CHATAGENT_NO_PROMPT=1`）时锁获胜且不挂起；明确残留（pid 已消失）仍自动自愈且不产生"同意"审计。
- [ ] 远程工作台独立会话分区：`persist:chatagent-workbench`（cookie/存储与默认会话隔离，登录跨重启）；该分区默认拒绝一切权限请求与权限检查。
- [ ] 响应头加固：服务端未提供 CSP 时由主进程注入保守策略（`default-src 'self'`…），服务端已有 CSP 时不削弱；补 `X-Content-Type-Options`/`Referrer-Policy`。`status().shell` 可核对 `cspInjected`/`cspFromServer`。
- [ ] 回执单调性：服务端镜像只接受**不比已存版本更旧**的收据（`updatedAt` 比较），乱序或重发的旧副本不会把已完成的任务打回进行中；接口返回 `{accepted, stale}` 并在审计里写明忽略条数。
- [ ] 回执归属绑定：设备把**已验证委托**里的 owner 随回执上报（`ownerId`），服务端拒绝 owner 与登录成员不一致的回执（403 `receipt_owner_mismatch` + `local_tasks.sync` denied 审计）。共享电脑无法把别人的本机工作镜像进自己的账本；纯本地任务不带 owner（无可绑定对象）。
- [ ] 回执持续同步在**主进程**（关窗后托盘常驻时照常工作）：离线排队到 `receipts-sync.json`，按任务版本去重，失败指数退避（30s→10min，队列上限 200 条）；cookie 只在请求时从会话读取、不落盘；`status().receiptSync` 暴露 pending/lastSuccessAt/lastError。
- [ ] 任务库载入即校验：字段缺失按安全默认值修复（并计入 status().storeIntegrity），无法信任的行（未知 kind/state、缺 taskId/workDir）保留为 failed + blockedReason=invalid_persisted_row，永不执行；重复 id 按版本取舍，未知字段丢弃。损坏文件另存为 tasks.json.corrupt-<时间戳>（不删除）并空库启动；载入阶段不回写文件，首次成功写入才落盘规范形态。
- [ ] 退出路径唯一且幂等：托盘/菜单/IPC/系统注销都汇入 `before-quit` 的 `shutdownHostOnce()`（有界 8s），按 pid 清理自有子进程树（`taskkill /T /F`），不误杀其他 Python/Hermes 进程。

## 5. 运行与依赖

- [ ] Node ≥ 20.19；使用 `pnpm install --frozen-lockfile` 部署。
- [ ] 依赖漏洞扫描：`node scripts/audit-deps.mjs`（走 `https://registry.npmjs.org`，默认 high/critical 非零退出）。当前状态：critical 0；桌面端 dev 工具链（electron 33 / electron-builder 25）仍有 high/moderate 告警，属**已接受风险**（本地镜像不稳定，无法在线升级），需要定期复扫。
- [ ] 上传限制：单文件 20 MiB、扩展名白名单（docx/xlsx/csv/txt/md/pdf/图片/zip）、上传与写入限流。超限必须由 `file.file.truncated` 判定并返回 413（G6-4：仅依赖框架异常时会出现「静默截断 + 200」）。
- [ ] 限流桶：登录按身份 10/min + 按地址 60/min；写操作 240/min；上传 30/min；webhook 300/min。
- [ ] 单主体 SSE 并发上限 8 条（原生流另有 5 条上限），超出返回 503。
- [ ] 流式响应同样带安全头（`STREAM_SECURITY_HEADERS`，G6-6）：核对 `curl -i /api/events/stream` 有 `nosniff`/`DENY`/CSP。
- [ ] `POST /api/auth/token/rotate` 必须拒绝「未出示凭据」的调用者，包括 `development` 档位的回环 dev 身份（G6-8）。
- [x] **仓库不含任何可用登录令牌**（2026-09-17）：`scripts/ui-e2e.mjs` 曾把 `alice-dev-token` 作为默认值写进仓库（与 G6-5 的处理口径不一致），现改为按 `--member/--token` → `SMOKE_MEMBER/SMOKE_TOKEN` → `Temp/e2e-member.json` 解析，缺失时由 `scripts/ensure-e2e-member.mjs` 用本机 owner 身份签发**专用成员 `e2e_local`**（只写 sha256 到 `data/members.json`，令牌留在被 gitignore 的 `Temp/`），不触碰 `u_alice` 等既有账号。**注意**：旧令牌仍在 git 历史中，若仓库对外公开，请用 `node scripts/add-member.mjs u_alice u_alice <新令牌>` + 重启服务端轮换。
- [ ] 确认工作目录内没有长期凭据：smoke 审批人令牌缓存于 `os.tmpdir()`（按服务端地址分文件、使用前先登录校验，G6-5），可用 `SMOKE_APPROVER_TOKEN` 注入；该缓存仍是 owner 凭据，用完请删除。
- [ ] 成员 id 只允许 `[A-Za-z0-9._-]`（防止逗号等分隔符构造群键碰撞，G6-N6）。
- [ ] 优雅停机：`SIGINT/SIGTERM` 会停止任务引擎、断开网关并 flush 合并写入与审计。

## 6. 上线前自检

```bash
pnpm typecheck && pnpm test && pnpm build
node scripts/smoke.mjs                       # 开发档位（本机回环）
SMOKE_MEMBER=<id> SMOKE_TOKEN=<token> node scripts/smoke.mjs   # 生产档位
curl -s localhost:8787/health                # authMode 必须是 production
curl -s -o /dev/null -w '%{http_code}\n' localhost:8787/api/accounts   # 期望 401
```

## 7. 已知未完成风险

- 依赖 CVE 未扫描（见 5）。
- 解析资源上限已具备：上传 20 MiB + 扩展名白名单；**实测** zip 条目真实解压大小与压缩比（条目 2000 / 单条目 64 MiB / 总量 200 MiB / 压缩比 200:1，见 `packages/document/src/zip-guard.ts`；中央目录声明值不作为依据，超限 413）；解析输出限长（文本 20 万字符、段落 2000、表 50、单表 2 万行，见 `packages/document/src/limits.ts`）。
- 仍未覆盖：嵌套压缩包（zip 内 zip）与 PDF 等非 zip 格式的解析资源上限；任务执行没有 CPU 时间片/内存配额。
- 任务恢复只有「running → pending 重取」，没有租约与多实例互斥（服务端任务引擎；本机 Agent 主机已有租约 + 单 writer 锁）。
- 本机 Agent 未验证的边界：真正同时的多进程写、两个安装共享同一 `CHATAGENT_HOST_ROOT`、主进程被强杀后的子进程回收（需要 Job Object/原生插件）。
- 子进程回收已实测（不再列为未验证）：`packages/agent-host/src/process-tree.test.ts` 5 例真实进程——两级子进程全部结束、无关进程存活、无 pid 时回退 `SIGKILL`、`taskkill` 无法启动时回退、win32 分支收到正确 pid。
- 单 writer 锁是"防两个调度器写同一份任务记录"的互斥，**不是信任边界**：本机任何进程改写 `tasks.json` 都能绕过所有主机不变量（派发时的能力下限会拦下被改写的行，但文件本身没有签名/校验）。
- 持久化行在 `load()` 时会校验/隔离（第三轮验证后）：缺 `taskId`/未知 kind/未知 state/空 `workDir`/**非数组 `toolsets`** 的行被隔离为 `failed` + `invalid_persisted_row`，**不可执行也不可 `retry()`**（F1/F7 已修并回归）。
- `interrupted` 语义特殊：它不是终态（可重试），但已计入 `finished` 且不再接受迟到结果覆盖；对副作用任务它不可重试（需要重新授权）。保留策略**不再**把它当终态淘汰（F4 已修），写入期淘汰数通过 `status().storeIntegrity.pruned` 上报。
- 授权登记表驻留内存：桌面重启后本机无法自我授权，副作用任务会以 `delegation_missing` fail-closed，必须由组织服务重新下发委托或本地明确同意。
- 缺少 `createIfAbsent` 原语的自定义 store 仍有同 id 竞态窗口（内置两个 store 都已实现，回退路径新增写后复核以缩小窗口）。
- 锁只看存活、不再看年龄：存活 pid 的锁永不自动接管（F5 已修），因此 pid 被无关进程复用时**无人值守会一直拒绝启动**，需要人工删除锁文件或使用桌面上的显式接管确认（`lock-takeover.ts`，写 `lock-audit.jsonl`）。
- `close()` 超过 8s 的有界停机到期后仍然退出：极端情况下会留下未清理的执行器与锁文件，下次启动按陈旧锁接管。
- 桌面设备令牌在现有接线中是纵深防御（主进程同时充当校验方与出示方），真正的控制是 IPC 发送方校验（frame URL + 主进程单实例）；嵌入到其他宿主时需要重新评估。
- 真实浏览器 E2E 已由 `scripts/ui-e2e.mjs`（Electron/CDP，34/34）覆盖；CSP 的**拦截效果**已用内联脚本载荷验证（`scripts/electron-csp-check.mjs` 5/5），完整 XSS 利用链未构造。
- 组织管理员可读本组织全部会话（设计如此）；不接受该模型时需改为显式授权。
- AI 回复逐条写审计（`ai.message_sent`：`assistant_reply` / `artifact_message`，**不含正文**）。
- 管理员 break-glass：管理员可读本组织**全部会话与文件**（既有设计），读取「未分享给自己」的文件会写 `file.admin_access` 审计，便于事后追溯。
- 撤回的边界：撤回解除消息引用与所有读取面（历史/搜索/预览/模型上下文/任务快照），但**不删除**底层上传文件（本人与管理员仍可下载）与 AI 已发出的引用回复；如需彻底删除，应另做保留策略/文件擦除。
- 没有管理员「踢人」接口：成员移除目前只有自助退出；如需踢人，应实现显式、写审计的移除操作。

### 第三轮对抗性验证（2026-09-16 晚）后的新增结论

- 能力下限 fail-closed：`document` 任务的 `toolsets` 为空列表、含空白项或非数组时**一律拒绝**（`capability_not_granted`），不再“缺省即默认 capability”；可信提交面（IPC）省略 `toolsets` 时仍按契约默认 `['document']`。被种在磁盘上的空能力行按 `capability_not_granted` 拒绝且不可重试。
- 隔离的坏行是“只读的墓碑”：既不交给执行器，也不能通过 `retry()`/IPC `retry` 复活（否则等于绕过 `invalid_persisted_row`）。
- 回执同步的三条硬约束：去重键必须是“版本+内容”指纹（`updatedAt` 同毫秒会让最终结果永不镜像）；单次请求必须 ≤ 契约上限（100 条，超出即永久 400）；产物必须符合共享契约（无 `sha256` 的产物丢弃、字段截断、非法 state 跳过），否则一条坏记录会毒死整批。
- 保留策略只淘汰 `succeeded`/`failed`/`cancelled`；`interrupted`（可重试）与进行中的行永不淘汰，且淘汰数量必须可观测（`storeIntegrity.prunable` = 待清理，`storeIntegrity.pruned` = 本次运行已清理，设置页分别提示）。
- 锁的接管只看“持有者是否存活”，年龄不是接管理由；歧义情形必须由人确认并留审计。

## 授权刷新（2026-09-17 第十五轮）

- **判定权归组织服务、执行权归宿主**：宿主从不自行延长授权，只应用服务端答案。`active` 才刷新过期时间；`revoked|expired` 立即本地撤销，让执行前复核拦下未跑的任务。
- **`unknown` ≠ `revoked`**：服务端说“无法确认”时既不销毁本地授权也不放行——只把相关新任务**暂缓**（留队列、不失败、不占租约），一次成功复核即可恢复；这样既 fail-closed，又不会因为一次抖动逼员工重新授权。
- **核对失败与超时一律 fail-closed**：`verify` 抛错或超时 → `unverified`，新外部副作用不启动。
- **断网可用边界明确**：`unverified` 只约束外部副作用；本地文档任务照常运行，在跑任务不回滚、不打断。这是刻意选择，写在实现注释里。
- **请求/响应都不带内容**：设备只发 `id + kind`（≤200 条），服务端只回 `id + kind + status + expiresAt`；不是本人的审批、未知 id、无台账的种类统一 `unknown`，不泄露 id 是否存在；`supportedKinds` 明说服务端只管 `approval`。
- **可见性**：`status().authorization`（状态/最近复核/失败原因/撤销数/无法确认数/暂缓条数）与设置页「授权复核」提示，避免“任务没动却没有任何解释”。


## 消息投喂闸门（2026-09-17）

- **默认延迟投喂是硬编码行为**：`AgentIntakeGate` 在撤回窗口结束前不把消息交给任何 agent；唯一例外是部署配置 `CHATAGENT_AGENT_INTAKE_MODE=immediate`（启动时告警）。没有任何 API 参数、工具或提示词可以提前投喂。
- **撤回即取消**：`recallMessage` 在同一事务路径上取消未投喂的入队项并写审计 `agent_intake.cancelled`；已投喂的任务不回滚（避免静默作废用户已看到的执行）。
- **入队与投喂都持久化**：队列落 `data/agent-intake.json`，重启不重放已投喂项、不丢失已到期项；投喂失败按指数退避重试而不是丢弃。
- **上下文窗口有上限**：交给模型的会话历史默认最近 20 条（`CHATAGENT_AGENT_CONTEXT_MESSAGES`，1-200），撤回内容不在其中。
- **提示词只是辅助**：`packages/hermes/src/system-prompt.ts` 的 `OPERATING_RULES` 声明「撤回内容不可索要/重建、目录外访问被拒即终局、关闭的工具不存在、授权由代码判定」，真正的边界仍在代码（闸门、能力下限、审批摘要、工作目录校验）。

## 联系人权限分级（2026-09-17）

- **等级由负责人设定，能力由代码裁剪**：`owner`（派生）> `confirm` > `chat` > `ignore`。未知值一律回退 `confirm`，绝不回退到更宽松的一档。
- **三处硬门**：入站闸门（`ignore` 不投喂、写审计、不告知发送者）、运行时 `allowedTools`（被关的工具不广播、执行处拒绝）、`POST /api/tasks` 403。提示词只声明等级，不承担边界。
- **`chat` 级是白名单而不是黑名单**：只保留显式列出的只读工具（`parse_document`），新工具默认对该等级不可用——新增能力不会自动对低等级开放。
- **负责人与组织管理员不可被降级**：`owner` 等级由账号 `ownerId` 与目录角色派生，`contactTiers` 里无法表示。

## 工具能力边界（2026-09-17，P0-3）

- **唯一名单**：`packages/agent-host/src/policy.ts` 是禁止工具集的唯一来源（host 提交期与 adapter 执行期都引用它）。历史上两份名单漂移过，导致 `browser`/`computer_use`/`cronjob`/`delegation`/`homeassistant`/`spotify` 能过提交门、只在执行期失败。新增能力必须改这一处，并同时被两个检查点覆盖。
- **门口拒绝**：禁止项在 `submit()` 即返回 `capability_not_granted`（attempts=0，不建工作目录、不调用执行器）；空名单与空字符串同样拒绝，省略名单才会落到显式 `['document']`。
- **提示词只是声明**：`capabilityBrief()` 与检查用同一份名单生成，注入本机 Hermes 调用的目标文本，明确「关闭即不存在、不得模拟或手写其输出、缺少能力要报告而不是绕路」。

## 事件流的重连语义（2026-09-17，P1-1）

- **回放也要鉴权**：SSE 回放（`Last-Event-ID` / `?since=`）逐条走与实时投递相同的授权判定，游标不是访问凭据；非参与者用任意游标都拿不到内容。
- **缓冲有界**：重放缓冲默认 500 条，只为断线补差；过老的游标只会拿到仍持有的部分，客户端另有一次按 id 合并的重拉兜底，不会把缺失当成“没有新消息”。
- **发送幂等键**：`clientMsgId` 的作用域是（发送者, 会话, key），台账有上限与 10 分钟 TTL；跨用户/跨会话不可碰撞，key 不构成全局去重。

## 好友关系与拉黑（2026-09-17，P1-2）

- **友谊是双向的**：只有被申请人能同意，同意后两侧同时建立关系；单方无法自称好友，也无法替对方接受。
- **备注与拉黑是私有数据**：备注只对设置者可见、不用于称呼；拉黑不告知被拉黑者（其得到的回答与陌生人一致，不泄露谁拉黑了他）。
- **拉黑是投递规则**：被拉黑者的私聊在服务端被拒（403，不落库、不投递），并且不能发起好友申请；**范围仅限私聊**——群聊不因某个成员被拉黑而对该成员禁言，否则拉黑会变成“让所有人沉默他”的工具。
- **越权面**：申请/决定/备注/拉黑都只能作用于同组织成员，且决定只能由被申请人做出（403 `addressee_only`）。

## 群治理（2026-09-17，P1-3）

- **权限在服务端**：改名/公告/踢人/解散都要群主或管理员（组织管理员等同管理员）；普通成员 403 `group_manager_required`。界面隐藏按钮只是体验，不是控制。
- **层级不可被绕过**：管理员不能移除群主或其他管理员（403 `cannot_remove_admin`），群主身份不是可切换的标志（`owner_immutable`）；建群不能夺取已有群（重建保留原群主）。
- **群主退群需交接**：群主在有其他成员时退群会被拒（409 `owner_must_transfer`），避免留下无法管理的群。
- **解散是软删除**：`dissolvedAt` 后群内不能再发消息、不能再治理，但历史对原参与者仍可读——审计与「说过什么」的记录不因解散而消失。
- **群身份按组织隔离**：`findByChatId` 现在按组织过滤，跨组织即使键相同也不会拿到对方的会话。

## 转发溯源与免打扰（2026-09-17，P1-4）

- **转发可溯源**：转发副本记录原消息 id、来源会话、原作者**与原发送时间**，界面显示「转发自 … · 原 …」。没有原时间，转发件就能冒充新消息。
- **免打扰是私人偏好**：`muted` 存在调用者自己的已读行上，只影响**本人**的提醒；未读数照常统计（免打扰不隐藏工作）。
- **@ 突破免打扰**：被点名的消息仍然提醒并在标题标注 `[@我]`，因为「被点名」与「背景噪音」不是一回事。
- **提醒不泄露内容**：通知正文与标题只含会话名、发送者与摘要（120 字截断），不包含附件内容或未读的其它消息。

## 上传的字节边界（2026-09-17，P2）

- **扩展名不是类型**：所有上传都按文件签名校验（`apps/server/src/file-signature.ts`），不匹配即 415 并写审计；空文件、未知扩展名、无法识别的容器一律拒绝（fail-closed）。
- **容器不可互换**：docx/xlsx 是 ZIP、doc/xls 是 OLE，改名不会通过；文本类必须是可读 UTF-8 且不含 NUL（避免二进制伪装成 csv/txt 进入解析器）。
- **前端检查不算防线**：客户端只做类型/大小预检与拖入体验，服务端独立校验字节与大小；限流（每成员）、20MiB 上限、zip 炸弹防护都仍在服务端执行。

## 窗口控制面（2026-09-17，P2）

- **动作是固定动词**：`chatagent:window` 只接受 `pin/unpin/toggle-pin/hide/show`，不接受坐标、路径、窗口 id；未知动作返回 `unknown_action`，IPC 发送者仍按白名单校验（非本应用帧拒绝）。
- **状态以窗口为准**：`status().window.pinned` 读 `isAlwaysOnTop()`，不缓存；页面按钮文案跟随主进程回报，不自行猜测。
- **浏览器里没有这个面**：控件仅在桌面壳内渲染，普通浏览器打开同一页面时 `window.chatagent?.window` 不存在，不会出现点了没反应的按钮。

## 内容钩子的正则边界（2026-09-17，P2）

- **规则是管理者财产**：只有群主/管理员能设置（403 `group_manager_required`），普通成员无法安装一条会跑在所有人消息上的正则。
- **设置时拒绝危险形态**：长度上限 200、每群 ≤20 条、必须能编译，并拒绝嵌套量词/重复选择/超大重复（`(a+)+$`、`(a|aa)+$`、`a{10000}`）——这是灾难性回溯的经典形态；本环境没有 RE2，只能在入口拒绝而不是「先跑跑看」。
- **匹配时有预算**：只扫描 ≤4000 字的文本，每条消息 25ms 预算，超出即跳过剩余规则（不命中是安全方向）；编译结果有界缓存；无法编译的规则写审计而不是抛错。
- **与权限体系一致**：钩子不绕过投喂闸门、撤回窗口与联系人等级；忽略级联系人不会被规则召唤。
