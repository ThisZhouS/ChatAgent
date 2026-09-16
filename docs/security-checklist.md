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
- [ ] 单 writer 锁的**歧义**情形不静默处理：持有者 pid 仍存活（可能被复用）或锁损坏时，桌面弹窗询问，默认"不接管"；只有本地用户明确选择才 `takeOverStoreLock`。旧锁改名保留（`*.replaced-<ts>`）而非删除，接管写入 `<store>.lock-audit.jsonl`（actor=`local-user-consent`、原因、原持有者）。无人值守（`CHATAGENT_NO_PROMPT=1`）时锁获胜且不挂起；明确残留（pid 已消失）仍自动自愈且不产生"同意"审计。
- [ ] 远程工作台独立会话分区：`persist:chatagent-workbench`（cookie/存储与默认会话隔离，登录跨重启）；该分区默认拒绝一切权限请求与权限检查。
- [ ] 响应头加固：服务端未提供 CSP 时由主进程注入保守策略（`default-src 'self'`…），服务端已有 CSP 时不削弱；补 `X-Content-Type-Options`/`Referrer-Policy`。`status().shell` 可核对 `cspInjected`/`cspFromServer`。
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
- 本机 Agent 未验证的边界：真正同时的多进程写、两个安装共享同一 `CHATAGENT_HOST_ROOT`、Windows 上 `taskkill /T /F` 的实际执行效果、主进程被强杀后的子进程回收（需要 Job Object/原生插件）。
- 单 writer 锁是"防两个调度器写同一份任务记录"的互斥，**不是信任边界**：本机任何进程改写 `tasks.json` 都能绕过所有主机不变量（派发时的能力下限会拦下被改写的行，但文件本身没有签名/校验）。
- 持久化行在 `load()` 时不做迁移/校验（旧版本的 `toolsets` 会被信任）；补偿手段是派发前复核能力下限，并在重放时把不合格的行标记为 `failed`。
- `interrupted` 语义特殊：它不是终态（可重试），但已计入 `finished` 且不再接受迟到结果覆盖；对副作用任务它不可重试（需要重新授权）。
- 授权登记表驻留内存：桌面重启后本机无法自我授权，副作用任务会以 `delegation_missing` fail-closed，必须由组织服务重新下发委托或本地明确同意。
- 缺少 `createIfAbsent` 原语的自定义 store 仍有同 id 竞态窗口（内置两个 store 都已实现，回退路径新增写后复核以缩小窗口）。
- 陈旧锁若其 pid 被无关进程复用，最长可阻塞启动 30 天（提示里给出锁文件路径，需人工删除）。
- `close()` 超过 8s 的有界停机到期后仍然退出：极端情况下会留下未清理的执行器与锁文件，下次启动按陈旧锁接管。
- 桌面设备令牌在现有接线中是纵深防御（主进程同时充当校验方与出示方），真正的控制是 IPC 发送方校验（frame URL + 主进程单实例）；嵌入到其他宿主时需要重新评估。
- 真实浏览器 E2E 已由 `scripts/ui-e2e.mjs`（Electron/CDP，34/34）覆盖；但 CSP 的**拦截效果**仍是静态断言，未构造真实 XSS 载荷验证。
- 组织管理员可读本组织全部会话（设计如此）；不接受该模型时需改为显式授权。
- AI 回复逐条写审计（`ai.message_sent`：`assistant_reply` / `artifact_message`，**不含正文**）。
- 管理员 break-glass：管理员可读本组织**全部会话与文件**（既有设计），读取「未分享给自己」的文件会写 `file.admin_access` 审计，便于事后追溯。
- 撤回的边界：撤回解除消息引用与所有读取面（历史/搜索/预览/模型上下文/任务快照），但**不删除**底层上传文件（本人与管理员仍可下载）与 AI 已发出的引用回复；如需彻底删除，应另做保留策略/文件擦除。
- 没有管理员「踢人」接口：成员移除目前只有自助退出；如需踢人，应实现显式、写审计的移除操作。
