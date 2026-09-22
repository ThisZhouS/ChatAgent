# 试点就绪清单（2026-09-18）

用途：回答「能不能拿去试点、试点前还差什么」。三类分开写，不混为一谈：
**A 已实现且有自动化证据** · **B 已实现但只有单机/开发环境验证** · **C 未验证或受阻（不得宣称完成）**。

基线：main = 7ce1b88（功能树 P0-1~P2-8 全部落地，17 个功能提交）。

## 验证口径（全部实跑）

| 检查 | 结果 |
| --- | --- |
| tsc --noEmit（根） | 0 错 |
| 根 vitest | 50 文件 / 408 用例 |
| apps/web vitest + vue-tsc | 73 用例、0 错 |
| Electron 七项（锁/回执/冒烟/工作台/退出/CSP/导航） | 18 / 21 / 6 / 13 / 10 / 5 / 13 全满分 |
| electron-builder --win nsis（离线） | 成功（安装包 + win-unpacked） |
| 打包后客户端 E2E（immediate 投喂 + 120s 召回窗口） | 38/38 |

## A 已实现且有自动化证据

| 能力 | 主要证据（用例数） |
| --- | --- |
| 投喂闸门：过召回窗口才交给助手，撤回即取消投喂 | agent-intake 9 + wiring 4 |
| 联系人权限分级（owner/confirm/chat/ignore，三处硬门） | contact-tier 8 + runtime-allowlist 4 + 编辑器 5 |
| 工具能力唯一名单 + 边界注入提示词 | policy 5 + host-security 24 + adapter 7 |
| 断线补差（事件 id/游标）+ 发送幂等 | event-replay 4 + cursor-expiry 3 |
| 好友关系与验证（拉黑阻断私聊） | friends 6 + ChatView 3 |
| 群治理（群主/管理员/公告/解散/组织维度身份） | group-governance 6 + ChatView 2 |
| 消息呈现（转发溯源/图片预览/@强提醒/免打扰） | presentation 3 + notifications 5 + ChatView 3 |
| 文件边界（签名校验 fail-closed）+ 拖入 | file-signature 5 + documents-upload 8 + ChatView 2 |
| 窗口置顶/隐藏（含自动验收入口） | electron-nav-check 13/13（含 5 项窗口断言） |
| 内容钩子（正则作为攻击面处理） | content-hooks 7 + wiring 3 |
| 澄清提问闭环 | clarification 3 |
| 会话外观（闭集）/ 私有别名 / 贴纸（闭集） | appearance 3 + aliases 3 + stickers 2 |
| 授权复核 fail-closed / 桌面生命周期 / 隔离行 / 保留策略 | authorization-refresh 10 + host-security 24 + store-integrity 9 等 |

## B 已实现，但只在单机/开发环境验证过

- 同机后台执行不干扰员工：靠 Electron 检查（关窗常驻、进程树回收、windowsHide）间接证明；真实办公负载下不抢焦点/不锁原件未实测。
- 组织多成员协作：协作测试都在一个进程内的多成员会话上跑；没有双机局域网实测。
- 上传与文档解析：以合成数据为主；真实 Word/Excel（大表、公式、宏）未用真实业务材料验证。
- 投喂窗口的体验：默认 120s 在测试里被缩短；员工对「发消息后要等 2 分钟助手才读」的接受度未验证（这是产品决策，不是缺陷）。
- 离线工作台：断网可用已自动化；但「没有组织服务器时员工能否自行走完一次完整交付」未走通（需要真实模型）。

## C 未验证或受阻（不得宣称完成）

1. Gate 7A.3：真实 Hermes 运行时 + 真实模型凭据的办公闭环。当前离线 MockProvider 只保证接口正确性；接入真实模型前，「助手能做事」的任何结论都不成立。
2. 安装包 GUI 人工验收：NSIS 安装、首次运行、卸载残留，需人工在干净 Windows 上执行。
3. 双机局域网验收：两台机器、真实网络、成员入职/停用、升级回滚、备份恢复。
4. Windows Job Object 子进程回收：现依赖 taskkill /T，进程被强杀时仍可能留下孙进程（需原生模块）。
5. Electron 版本切换：39.8.10 已于 2026-05-05 EOL；彩排已在 42.4.1 上全绿，换版本需要 registry 网络。
6. 完整 XSS 利用链复现：CSP/导航/分区加固有 5/5 + 13/13，但没有构造过端到端的实际注入利用链。
7. 九个产品语义问题（好友分级对象、拉黑归属、转发撤回是否级联、公告范围、队列栈粒度、文件安全是否含内容扫描、窗口背景指哪个窗口、个人 ID 含义、目录外授权形式）：已按最合理解释实现并标注假设，结论仍待确认。

## 试点建议（按风险从低到高）

1. 可立即试点：内部聊天 + 群聊 + 文件收发 + 撤回 + 好友关系 + 群治理 + 别名/外观/贴纸（A 类，自动化覆盖充分）。
2. 小范围试点（需观察）：本机后台执行与文档交付（需真实模型；先限定「生成文档」这类无外发副作用的闭环），同时观察 120s 投喂窗口的体验。
3. 暂不试点：外发/跨同事自动交付（依赖委托台账与真实审批链路）、无人值守定时任务、多机部署。

## Gate 7A.3：服务端真实模型闭环已跑通（2026-09-21）

- 配置：`CHATAGENT_MODEL_BASE_URL` / `CHATAGENT_MODEL_NAME=deepseek-v4.1-flash` / `CHATAGENT_MODEL_API_KEY`（**只在 gitignored 的 `Temp/model.env`，未入库**），OpenAI 兼容协议。
- 实测：以 `CHATAGENT_AGENT_INTAKE_MODE=immediate` 重启服务端后，在助手会话里发「请用一句话确认你已接入真实模型」，助手回复「**已接入真实模型：本次回复由真实推理模型生成，而非脚本或模板模拟。**」；任务状态 `completed`、`attempts=1`、无错误，该次请求服务端耗时约 404ms（真实网络调用）。
- 与 MockProvider 的差别可对照：同一会话里 Mock 的回复是「收到：「…」。需要产出文件时，请说明「生成 Word/Excel」。」——两条回复形态明显不同，因此这次是真实模型而非桩。
- **办公闭环也已跑通（同日追加）**：发「请生成一份本周工作周报的 Word 文档，包含三个要点。」→ 任务约 **8 秒**完成（`/api/tasks` 里状态为 `completed`、`attempts=1`、无错误），产物 `本周工作周报.docx`；把该产物下载回来核对：**HTTP 200、8819 字节、`application/vnd.openxmlformats-officedocument.wordprocessingml.document`、magic=`PK`**（合法 OOXML），不是空壳也不是文本改名。
- 也就是说：**「真实模型 + 真实办公产物」这条链路（消息 → 投喂闸门 → 任务引擎 → 真实模型 → 文档工具 → 产物 → 下载）已经在运行实例上端到端成立。**
- **仍未完成的**：`scripts/gate7a-verify.mjs` 的 Flow8 需要 `CHATAGENT_HERMES_EXE`（真实 Hermes 运行时进程）才能验证桌面宿主路径，目前仍是 BLOCKED；因此 Gate 7A.3 **只能说是服务端闭环已验证，不能宣称整条 Gate 通过**。
- 安全提示：该 API key 通过聊天传递，已按凭据处理（仅落 gitignored 文件、未写入任何提交）；若这段对话会被分享，请轮换该 key。

