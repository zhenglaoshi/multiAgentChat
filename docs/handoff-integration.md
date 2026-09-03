# 同事任务甩单（Handoff）对接方案

> 要**部署 / 使用**（环境变量、上线步骤、排障）看 [`handoff-deployment.md`](./handoff-deployment.md)；本文是设计/协议/分期。


> 把「我 ⇄ 我自己的飞书」单人闭环，扩展成「我 ⇄ 同事」的跨人任务甩单。
> A 在某个 tab 里遇到问题、AI 给了建议 → 一句话让本地 AI 自动总结（问题 + 建议 + 相关文件）
> → 经中转 relay → B 的本地 daemon 收到 → B 的飞书机器人弹任务卡，状态双向同步。

## 为什么要中转 relay

关键洞察：**每个人只跟自己的飞书机器人说话**。A 永远不访问 B 的飞书，反之亦然。
两个飞书应用/租户完全解耦，relay 只做「按身份路由 + 文件暂存 + 离线排队」。

```
A(requester)                  Relay(云服务器)              B(assignee)
  │  handoff.create ─────────▶  按 to 入队  ─────────────▶  弹「👥 同事任务卡」
  │  (A 侧建卡:已发送)          (B 离线→落盘,重连补投)        │ B 点[接收]/[拒绝]
  │  ◀───────────── handoff.status ◀─────────────────────┘
  │  A 卡 patch:B 已接收                                    │ B 点[进行中]/[完成]
  │  ◀───────────── handoff.status ◀─────────────────────┘
  │  A 卡 patch:已完成 ✅
```

relay 是**独立项目**（与 multiAgentChat 平级的 `../multiagent-relay/`），部署到云服务器，
零运行时依赖（纯 Node `http`），生命周期/依赖/git 与本地 daemon 分开。

## 身份与鉴权（默认，可改）

- **身份 = 邮箱**（`@ihealthlabs-us.com` 天然唯一）。别名 `@bob` 在本地 `HANDOFF_ALIASES` 里映射到邮箱。
- **鉴权 = 预共享 token**（每人一个，写各自 `.env` 的 `RELAY_TOKEN`）。relay 侧 `relay.tokens.json` 存 `身份→token`。
- **防冒充**：envelope 的 `from` 由 relay 按已鉴权连接**强制盖章**，客户端传什么都不算数。
- **收件闸门**：接收方 `.env` 的 `HANDOFF_ALLOW` 非空 = 严格 opt-in（只收名单内）；**空 = 收所有已登记同事**（P3a 门户模型，靠 relay 登记身份 + 黑名单拦截）。

## 传输协议（HTTP，relay ↔ 客户端契约）

所有请求头带 `Authorization: Bearer <RELAY_TOKEN>`。relay 由 token 反查身份。

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/v1/send` | body = envelope（`from` 被 relay 覆盖为鉴权身份）→ 校验 → 入 `to` 的队列 |
| `GET`  | `/v1/poll?wait=25` | 长轮询：返回本身份队列里的 envelope（**不删**）；空则挂起最多 `wait` 秒 |
| `POST` | `/v1/ack` | body = `{ msgIds: [...] }` → 从队列删除已处理的 envelope（at-least-once + 客户端按 `msgId` 去重）|
| `POST` | `/v1/blob` | 原始 body = 文件字节，头 `x-blob-name`/`x-blob-size` → 存盘，返回 `{ blobId, expiresAt }` |
| `GET`  | `/v1/blob/:id` | 下载 blob（鉴权后）|
| `GET`  | `/v1/contacts` | 列已配置身份 + 在线状态（最近 poll 时间）|
| `GET`  | `/v1/health` | 健康检查（无需鉴权）|

### Envelope（wire format）

```jsonc
{
  "v": 1,
  "id": "任务 id（uuid）",       // create/status/reply 同一任务共用
  "msgId": "本条 envelope 唯一 id（uuid，用于去重/ack）",
  "kind": "create | status | reply",
  "from": "alice@ihealthlabs-us.com",   // relay 盖章，客户端说了不算
  "to":   "bob@ihealthlabs-us.com",
  "createdAt": 1690000000000,

  // kind=create
  "title": "shell 报错求助",
  "summaryMd": "## 问题\n...\n## AI 建议\n...",   // 发送前已过脱敏闸门
  "attachments": [{ "blobId": "...", "name": "trace.md", "size": 1234 }],
  "context": { "cwd": "...", "shell": "zsh", "agent": "claude", "host": "alice-mac" },

  // kind=status
  "status": "accepted",
  "note": "我接了，晚点看",

  // kind=reply
  "replyText": "你这个是 node 版本问题"
}
```

## 状态机

`sent → accepted → in_progress → done`；任意非终态可 `declined`（B 拒绝）/ `canceled`（A 撤回）。
两边各存一份 `HandoffTask`，`role` 区分 `requester`/`assignee`。状态推进 = 发一条 `kind=status` envelope，
对端 `applyIncoming` 幂等更新本地 task 并刷新飞书卡。非法跃迁被 `canTransition` 挡掉。

## 安全底线（硬要求）

- 发送前**强制过 redact-gate**（`redactText`）——跨人发**不给 `/raw` 后门**。
- `from` relay 盖章防冒充；`to`、blob 大小、body 大小均有上限；blob TTL 24h 自动清。
- 全程 wss/https（relay 挂反代 Caddy/nginx 上 TLS，或 Node TLS）。
- 收件白名单 `HANDOFF_ALLOW`。relay 只路由不解密，近乎零知识。

## 代码落位（守 monorepo 单向 DAG）

| 东西 | 放哪 |
|---|---|
| relay 服务（独立可部署） | **独立项目** `../multiagent-relay/`，不进本 monorepo |
| 任务模型 + 状态机 + envelope 类型（纯逻辑） | `orchestrator/handoff/` |
| relay HTTP 客户端 + 轮询器 + 配置 | `framework/relay/` |
| `agent handoff` / `agent contacts` CLI | `framework/control` 的 cli+server+protocol 三处 |
| daemon 启动挂轮询器 + 收到时投递飞书 | `apps/daemon/src/index.ts` |
| 「👥 同事任务卡」渲染 + 按钮回调（P2） | `im-lark/lark/cards.ts` + handlers |

## 分期

- **P1（本期）** ✅ relay（路由 + 暂存 + 离线排队 + 长轮询）+ envelope 协议 + `orchestrator/handoff` 模型
  + `framework/relay` 客户端/轮询器 + `agent handoff`/`agent contacts` CLI + daemon 接入。
  收到时先以**纯文本**推飞书（most-recent-chat），端到端可跑通、可上手机验证。
- **P2（已完成）** ✅ 富交互「👥 同事任务卡」（`im-lark/lark/cards.ts` `handoffTaskCard`）+ [🤝接收/🚧开始/✅完成/🙅拒绝]（assignee）、[↩️撤回]（requester）按钮 → 点击经桥接
  （`im-lark/lark/handoff-bridge.ts` setter，daemon 注入 `framework/relay/actions.ts` `sendHandoffStatus`）
  发状态信封 + 就地 patch 卡片，**两侧卡片状态双向同步**。A 侧发单即出 requester 卡、收到对端状态自动 patch。
  一句话总结 skill `skills/multiagent-handoff/`（本地 claude 自动写摘要 + 挑文件 + 调 `agent handoff send`）。达到「带任务状态跟踪」MVP。
- **P3a（已完成）** ✅ 自助接入门户（在独立 relay 项目里）：动态 token 库(`accounts.ts`) + 邀请码占位登录 + 一键装机(`/enroll/:code` 返回装机脚本,token 写进 `.env`) + 接入名单页 + **黑名单模型**。收件闸门语义随之改：`HANDOFF_ALLOW` **空 = 收所有已登记同事**（relay 侧凭登记身份 + 黑名单拦截），非空 = 严格 opt-in。token 前缀 `mrt_` 已注册进 `orchestrator/secrets` 脱敏引擎。详见 `../multiagent-relay/README.md`。
- **P3b（已完成）** ✅ OIDC 单点登录（`../multiagent-relay/src/oidc.ts`，零依赖 `node:crypto` 验 RS256+JWKS）：配齐 `OIDC_*` 即启用，门户「公司账号登录」→ 授权码流程 → 验签+iss/aud/exp/nonce+email_verified → email 过邮箱正则 → 签发 `mrt_` token → fragment 交前端。state 单次消费防 CSRF、nonce 防重放。邀请码占位登录保留作 bootstrap 兜底。假 IdP 端到端冒烟 8 项（`tests/oidc-smoke.ts`）。上线只需 IdP 管理员给 `OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET/REDIRECT_URI`。
- **P3c（已完成）** ✅ ① token 轮转/撤销：门户「凭证管理」卡（`/api/tokens` 计数 · `/api/rotate` 轮换本设备 · `/api/revoke-others` 撤其它设备）+ 已有 `/api/logout`。② 审计日志：relay `audit.ts` 追加式 JSONL 记登录/签发/撤销/邀请/路由/拉黑，`/admin/audit?limit=` 查（admin token）。③ 附件下载：`agent handoff pull <taskId> [--dir]` 收单方一键拉 blob 到本地。④ `kind=reply` 跨人对话：`agent handoff reply <taskId> <文本>`（`buildReplyEnvelope`+`sendHandoffReply`，发送前脱敏，两侧卡片 statusHistory 显示）。
- **P3+** 同租户 open_id 直投捷径、过期 login/enroll 记录后台清理（低危磁盘增长）。

> ⚠ 收件闸门语义变更（P3a）：P1/P2 时 `HANDOFF_ALLOW` 空 = fail-closed 谁都不收;**P3a 起空 = 收所有已登记同事**（门户模型,信任建立在 relay 的登记+黑名单）。要严格 opt-in 就显式列 `HANDOFF_ALLOW`。

> 卡片安全：`handoffTaskCard` 把对端可控字段（title/summaryMd/peer/note）全部放进 `plain_text` 元素，
> 不解析 lark_md → 从根上免 `[text](url)` 钓鱼链接注入（含下游 `redactMaybe` 二次插入 `[REDACTED-*]` 的绕过）。
> 交互卡带 `update_multi:true`（多次 patch 才视觉生效）。

## 一句话甩单的 UX（A 侧，P2 skill）

用户在 tab 里说「把这个报错甩给 bob」→ 当前 claude session（有完整上下文）自动：
1. 写 `summaryMd`（原始问题 + 它刚给的建议） 2. 挑相关文件 3. 调
`agent handoff --to @bob --title "..." --summary-file summary.md --attach trace.md`。
CLI/daemon 负责脱敏 + 上传 blob + 发 envelope。总结交给 claude，传输交给 CLI——沿用本项目分工习惯。

## 环境变量

本地 daemon（`.env`）：
```
RELAY_URL=https://relay.example.com       # 云服务器 relay 地址；不配则整个 handoff 功能不启用
RELAY_TOKEN=xxxxx                          # 本人的预共享 token
RELAY_IDENTITY=alice@ihealthlabs-us.com    # 本人身份（邮箱）
HANDOFF_ALLOW=bob@ihealthlabs-us.com,carol@ihealthlabs-us.com  # 空=收所有已登记同事（P3a）；非空=严格 opt-in 只收名单内
HANDOFF_ALIASES=bob=bob@ihealthlabs-us.com,carol=carol@ihealthlabs-us.com  # @别名→邮箱
```

relay 服务端见 `../multiagent-relay/README.md`。

## P1 已知取舍 / 后续加固（评审提出、暂按 P1 接受）

- **relay 无 per-identity 速率/并发限制**：一个泄露的 token 可高频刷 `/v1/send`·`/v1/blob` 或开大量长轮询连接。内部工具可接受；多人共用建议后续加粗粒度限流 + `http.Server.maxConnections`。
- **blob 仅凭 128-bit 随机 blobId 鉴权**，未绑定「该 blob 的预期收件人」（类预签名 URL 模式）。加固方向：relay 记 blob 归属，下载时校验 `identity ∈ {from,to}`。
- **token 校验用 Map 查找**（非 `crypto.timingSafeEqual` 常量时间）。现实可利用性极低，可选加固。
- **`processed.json` 去重窗口 2000 条**：理论上 2000+ 新消息后可重放很旧 msgId（幂等状态迁移，影响小）。
- **两仓库各维护一份 `HandoffEnvelope` 类型**（`orchestrator/handoff/types.ts` ↔ `multiagent-relay/src/types.ts`），靠注释约定同步，无编译期强制。加字段时两处都要改。
- **二进制附件无法文本脱敏**：只对文本类附件跑 `redactText`，二进制原样上传并打 warn 日志。
- **投递用富交互卡（P2）**，对端可控内容走卡片 `plain_text` 元素（不解析 lark_md）杜绝链接注入；见上「卡片安全」。
