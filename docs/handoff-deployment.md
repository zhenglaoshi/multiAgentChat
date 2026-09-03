# 同事任务甩单（Handoff）· 部署与使用指南

> 面向：要把 handoff 功能真正跑起来的人。
> 结构：先懂拓扑 → 管理员部署中转 relay → 每个同事本地接入 → 日常使用 → 环境变量总表 → 安全须知 → 运维排障。
> 设计/协议细节见 `docs/handoff-integration.md`；relay 服务自身说明见 `../multiagent-relay/README.md`。

---

## 0. 这是什么 / 拓扑

把「我 ⇄ 我自己的飞书」的单人闭环，扩展成「我 ⇄ 同事」的跨人任务甩单。**每个人只跟自己的飞书机器人说话**，中间靠一台公共 **relay** 按身份路由，两边飞书应用/租户完全解耦。

```
张三的 Mac                         公共 relay（云服务器）              李四的 Mac
─────────                          ──────────────────                ─────────
multiAgentChat daemon              multiagent-relay(独立项目)         multiAgentChat daemon
  └ 张三自己的飞书应用      ──HTTPS──▶  按身份路由 + 文件暂存    ──HTTPS──▶   └ 李四自己的飞书应用
                                       + 离线排队 + 门户/OIDC
```

- **relay 是独立项目**：`../multiagent-relay/`（与 multiAgentChat 平级），零运行时依赖（纯 Node http）。
- relay 只路由不解密，近乎零知识；`from` 由 relay 按已鉴权连接**强制盖章**，无法冒充。
- 收件人离线时消息在 relay **落盘排队**，重连自动补投。

---

## 1. 前置条件

- 一台**所有同事都能访问**的服务器（内网或公网皆可），装了 **Node ≥ 20**。
- 一个域名 + TLS 证书（强烈建议；relay 只跑明文 HTTP，TLS 由前置反代做）。客户端强制要求 `RELAY_URL` 为 `https://`（仅 `http://localhost` 例外）。
- 每个同事本地已经在跑 multiAgentChat（各自的 daemon + 各自的飞书应用），即 `npm run dev` 正常。

---

## 2. Part A · 部署 relay（管理员，一次性）

### 2.1 拿代码、构建、启动

```bash
# 把 multiagent-relay 传到服务器（scp / git 均可），进目录
cd multiagent-relay
npm install
npm run build            # tsc → dist/
# 前台试跑（见下方环境变量）：
RELAY_PUBLIC_URL=https://relay.你域名.com RELAY_ADMIN_TOKEN=$(openssl rand -hex 24) npm start
# 正常会打印：INFO relay 就绪 {addr, adminEnabled, oidc, portal}
```

`npm start` = `node dist/index.js`。开发调试可 `npm run dev`（tsx watch）。

### 2.2 挂 TLS 反代（务必）

relay 自身只监听明文 HTTP（默认 `:8787`）。生产**必须**在前面挂反代做 TLS。Caddy 示例（自动签证书）：

```
relay.你域名.com {
    reverse_proxy 127.0.0.1:8787
}
```

nginx 同理 `proxy_pass http://127.0.0.1:8787;`。**不要把明文端口直接暴露公网。** 反代记得透传 `X-Forwarded-Proto`。

### 2.3 进程守护（systemd 示例）

```ini
# /etc/systemd/system/multiagent-relay.service
[Service]
WorkingDirectory=/opt/multiagent-relay
ExecStart=/usr/bin/node dist/index.js
Restart=always
EnvironmentFile=/opt/multiagent-relay/relay.env    # 把下面的环境变量放这里
[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now multiagent-relay
sudo journalctl -u multiagent-relay -f    # 看日志
```

### 2.4 选登录方式（二选一，也可并存）

同事怎么拿到接入 token，两条路：

**方式甲 · OIDC 单点登录（推荐，接公司统一认证）**
配齐这 4 个（问 IdP/IT 管理员要），门户就变成「🔐 公司账号登录」：

```
OIDC_ISSUER=https://sso.你公司.com
OIDC_CLIENT_ID=relay-client
OIDC_CLIENT_SECRET=xxxxx                                 # 只在服务端，绝不下发
OIDC_REDIRECT_URI=https://relay.你域名.com/auth/callback   # 需在 IdP 侧登记为允许回调
# 可选：OIDC_SCOPES（默认 openid email）/ OIDC_EMAIL_CLAIM（默认 email）
# 建议：OIDC_ALLOWED_DOMAINS=你公司.com   # 只放行公司邮箱域，纵深防御
```
登录后 relay 用授权码换 id_token → 验签(RS256/JWKS) → 取 email 当身份 → 自助签发 token。

**方式乙 · 邀请码（没接 SSO 时的兜底 / bootstrap）**
只配 `RELAY_ADMIN_TOKEN`（≥16 字符）。管理员给每人建一个邀请码：

```bash
curl -X POST https://relay.你域名.com/admin/invite \
  -H "Authorization: Bearer $RELAY_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"identity":"lisi@你公司.com"}'
# → {"code":"xxxx", ...}  把 code 私发给本人，他在门户输入即接入
```

> 两者可并存：配了 OIDC 就显示 SSO 登录，同时邀请码仍可用（管理员 bootstrap）。

### 2.5 静态 token 表（可选，几乎不用了）

`relay.tokens.json`（`{"email":"token"}`）是最原始的手动分发方式，P3a 后基本被门户取代，可完全不配。若配，务必 gitignore（示例见 `relay.tokens.json.example`）。

### 2.6 数据与备份

- `RELAY_DATA_DIR`（默认 `./data`）下：`accounts.json`（token/邀请/黑名单）、`queue/`（离线消息）、`blobs/`（附件暂存，24h TTL）、`audit.log`（审计，5MB 轮转）。
- 备份 `accounts.json` 即可保住已签发身份/黑名单；queue/blobs 是暂存中转数据，丢了只丢未投递的甩单。

---

## 3. Part B · 每个同事本地接入

### 方式一（推荐）· 自助门户，一条命令装好

1. 浏览器打开 `https://relay.你域名.com`
2. 「🔐 公司账号登录」（OIDC）或输入管理员发的邀请码
3. 点「① 生成一次性安装命令」→ 复制那条 `curl ... | bash` 到自己 Mac 的终端执行
   - 它会把 `RELAY_URL / RELAY_TOKEN / RELAY_IDENTITY` **写进本机 multiAgentChat 的 `.env`**（token 只进 `.env`，不进 skill 文本）
   - 默认写到 `~/ihealth-project/multiAgentChat/.env`；仓库在别处就先 `export MULTIAGENT_DIR=/你的/路径` 再跑
4. **重启 daemon 生效**：在跑 `npm run dev` 的终端 Ctrl-C 重启一次
5. 回门户「② 已接入的同事」能看到名单、在线状态、拉黑

### 方式二 · 手动填 `.env`

拿到自己的 `RELAY_TOKEN` 后，在 multiAgentChat 的 `.env` 加：

```bash
RELAY_URL=https://relay.你域名.com
RELAY_TOKEN=mrt_xxxxx
RELAY_IDENTITY=你@你公司.com
# 可选：
HANDOFF_ALLOW=lisi@你公司.com,wangwu@你公司.com   # 收件闸门，见下
HANDOFF_ALIASES=lisi=lisi@你公司.com,wangwu=wangwu@你公司.com   # @别名→邮箱
```
然后重启 daemon。缺 `RELAY_URL/TOKEN/IDENTITY` 任一 → handoff 功能不启用（daemon 启动日志会打印「handoff relay 未启用」）。

> **收件闸门语义**：`HANDOFF_ALLOW` **留空 = 收所有已登记同事**（门户模型：relay 已凭 SSO/邀请码登记发件人 + 黑名单拦截）；**非空 = 严格 opt-in**，只收列出的人。想更严就显式列。

`multiagent-handoff` skill 由 daemon 启动时自动装到 `~/.claude/skills/`，无需手动。

---

## 4. Part C · 怎么用

### 4.1 一句话甩单（在 tab 里对 claude 说）

> 「把这个报错甩给 @李四」 / 「这个问题总结发给 lisi 看看」

本地 claude 会自动：写 md 摘要（问题 + 它刚给的建议）→ 挑相关文件 → 调 `agent handoff send`。对方飞书弹出「👥 同事任务卡」。

### 4.2 CLI（也可手动）

```bash
agent contacts                                   # 谁已接入 + 在线状态
agent handoff send --to @lisi --title "CGM 接口 500" \
    --summary-file summary.md --attach trace.log  # 发送前强制脱敏；--attach 可多次
agent handoff list                               # 我发出/收到的甩单任务 + 状态
agent handoff status <taskId> <状态> [--note ..] # 状态见下（一般点卡片按钮，不用敲）
agent handoff reply <taskId> "补充：日志在 /tmp/x.log"   # 跨人留言（两侧卡片可见）
agent handoff pull <taskId> [--dir <目录>]        # 收单方一键下载该任务附件到本地
```

### 4.3 收单方视角（飞书卡片）

收到「👥 同事任务卡」，按角色出按钮，点一下即改状态、两侧卡片同步刷新：

- 收单方：`🤝接收` → `🚧开始` → `✅完成`，或 `🙅拒绝`
- 发单方：`↩️撤回`
- 状态机：`sent → accepted → in_progress → done`；任意非终态可 `declined`（收单方拒）/ `canceled`（发单方撤）。必须先接收才能开始。

---

## 5. 环境变量总表

### 5.1 relay 服务端（`../multiagent-relay/`）

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `RELAY_PORT` | 否 | `8787` | 监听端口 |
| `RELAY_BIND` | 否 | `0.0.0.0` | 监听地址 |
| `RELAY_DATA_DIR` | 否 | `./data` | 持久化目录（accounts/queue/blobs/audit）|
| `RELAY_PUBLIC_URL` | **强烈建议** | 按 Host 头推断 | 对外地址，拼装机命令用；不配会按请求 Host 推断（可被伪造 Host 污染，启动会告警）|
| `RELAY_ADMIN_TOKEN` | 用邀请码/看审计则需 | 无（管理端点关闭）| 管理员 token（≥16 字符），`/admin/*` 用 |
| `RELAY_ENROLL_TTL_MS` | 否 | `900000`（15min）| 一次性装机码有效期 |
| `RELAY_MAX_BODY_BYTES` | 否 | `1000000`（1MB）| 单条 envelope 上限 |
| `RELAY_MAX_BLOB_BYTES` | 否 | `25000000`（25MB）| 单个附件上限 |
| `RELAY_BLOB_TTL_MS` | 否 | `86400000`（24h）| 附件暂存有效期 |
| `RELAY_MAX_POLL_WAIT_MS` | 否 | `25000` | 长轮询最长挂起 |
| `RELAY_TOKENS_FILE` / `RELAY_TOKENS_JSON` | 否 | `./relay.tokens.json` | 静态 bootstrap token 表（可选，几乎不用）|
| `OIDC_ISSUER` | OIDC 必填 | 无 | OIDC 发行方（自动拉 discovery）|
| `OIDC_CLIENT_ID` | OIDC 必填 | 无 | |
| `OIDC_CLIENT_SECRET` | OIDC 必填 | 无 | 只在服务端 |
| `OIDC_REDIRECT_URI` | OIDC 必填 | 无 | `https://relay.../auth/callback`，需 IdP 登记 |
| `OIDC_SCOPES` | 否 | `openid email` | 要能拿到邮箱 |
| `OIDC_EMAIL_CLAIM` | 否 | `email` | id_token 里取哪个 claim 当身份 |
| `OIDC_ALLOWED_DOMAINS` | 否 | 无（不限）| 逗号分隔的允许邮箱域，纵深防御 |

> OIDC 四项（ISSUER/CLIENT_ID/CLIENT_SECRET/REDIRECT_URI）**要么都配、要么都不配**；缺任一即不启用 OIDC，回退邀请码。

### 5.2 客户端（每个同事的 multiAgentChat `.env`）

| 变量 | 必填 | 说明 |
|---|---|---|
| `RELAY_URL` | 是 | relay 地址，必须 `https://`（`http://localhost` 例外）|
| `RELAY_TOKEN` | 是 | 本人 token（`mrt_...`），门户装机自动写入 |
| `RELAY_IDENTITY` | 是 | 本人身份（邮箱）|
| `HANDOFF_ALLOW` | 否 | 收件闸门：空=收所有已登记同事；非空=严格 opt-in |
| `HANDOFF_ALIASES` | 否 | `别名=邮箱` 逗号分隔，`agent handoff --to @别名` 用 |

三个必填缺任一 → handoff 不启用（其余功能不受影响）。改 `.env` 后**必须重启 daemon**。

---

## 6. 安全须知 & 已知取舍

**已内建的保护**：
- `from` 由 relay 按鉴权连接**强制盖章**，客户端伪造无效。
- 发送前**强制脱敏**（title/summary/note/reply/文本附件都过 redact，跨人发不给 `/raw` 后门）。
- OIDC：验签强制 RS256（无 alg:none/HMAC 路径）+ 校 iss/aud/exp/nonce/email_verified；`state` 单次消费防 CSRF；token 经**一次性登录码**交付、不进 URL。
- 门户对端可控内容全走 `plain_text`，杜绝 lark_md 钓鱼链接注入；身份走严格邮箱正则，堵命令注入/XSS。
- 收件黑名单在 relay 侧拦截；`agent handoff pull` 附件名做路径穿越清洗。

**已知取舍 / 上线前注意**：
- **默认放行**：`HANDOFF_ALLOW` 留空 = 收所有已登记同事。信任建立在「relay 只让 SSO/邀请码登记过的人有身份」+ 黑名单。要更严就每人显式配 `HANDOFF_ALLOW`。
- **OIDC key 撤销窗口 ≤ 1h**：JWKS 缓存 1h，别把它当 0 延迟撤销依赖。
- **无速率限制**：一个泄露的 token 可高频刷；内部工具可接受，多人共用建议反代层加限流。
- **blob 凭不可猜的 128-bit id 下载**（类预签名链接），practically 安全，别把 blobId 记进日志/外发。
- **单实例假设**：一次性码防重放靠单进程内存锁；横向扩多实例需另加共享锁。
- token 明文存 `accounts.json`（暂存中转数据，服务器本身要管好访问权限）。

---

## 7. 运维 / 管理员速查 / 排障

```bash
# 健康检查（无需鉴权）
curl https://relay.你域名.com/v1/health            # → {"ok":true}

# 建邀请码
curl -X POST https://relay.../admin/invite -H "Authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' -d '{"identity":"someone@你公司.com"}'

# 看审计日志（最近 100 条）
curl "https://relay.../admin/audit?limit=100" -H "Authorization: Bearer $ADMIN"

# 同事自助：门户里可「🔄 轮换本设备凭证」「🧹 撤销其它设备」「退出（撤当前 token）」
```

**排障对照**：
- 飞书没收到甩单卡 → 收件方 daemon 在跑吗？发件人在收件方 `HANDOFF_ALLOW` 里吗（若配了）？收件方拉黑了没？relay `journalctl` 看有没有 `handoff_routed` / `blocked`。
- `agent handoff` 报「relay 未配置」→ 该机 `.env` 少了 `RELAY_URL/TOKEN/IDENTITY`，或改完没重启 daemon。
- 门户点登录裸报错 → OIDC 四项配全了吗？`OIDC_REDIRECT_URI` 在 IdP 侧登记为允许回调了吗？relay 日志看 `oidc callback failed` 原因。
- `RELAY_URL 必须是 https` 启动报错 → 客户端强制 TLS，本地调试用 `http://localhost`。
- 装机命令跑了没反应 → 找不到 multiAgentChat 目录，`export MULTIAGENT_DIR=/正确/路径` 再跑。

---

## 8. 端到端自检（无需真机，验证整条链路）

仓库自带两个端到端冒烟（真起 relay + 假 IdP）：

```bash
cd multiAgentChat
npx tsx tests/handoff-smoke.ts     # P1~P3c：路由/防冒充/白名单/黑名单/reply/附件/token 管理/审计（35 项）
npx tsx tests/oidc-smoke.ts        # OIDC 授权码全流程 + 验签负例（21 项）
npm test                           # 单元测试（状态机/store/卡片/脱敏/config 等）
```

全绿即代码侧就绪，剩下就是上面的部署三步。
