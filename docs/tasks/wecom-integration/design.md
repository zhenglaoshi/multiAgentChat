# WeCom Integration · Design

**Date**: 2026-07-11
**Depends on**: [requirements.md](./requirements.md)

---

## 架构总览

```
                ┌─────────────────────────────────────────┐
                │            apps/daemon (index.ts)        │
                │  main() 里 attach 多个 IMTransport 实例   │
                └───────────────┬────────────┬────────────┘
                                │            │
                    ┌───────────▼──┐    ┌────▼──────────┐
                    │  LarkTransport │    │ WeComTransport │
                    │  (WS 长连接)   │    │  (HTTP webhook)│
                    └───────┬──────┘    └───────┬────────┘
                            │                   │
                     lark SDK                Cloudflared
                     open.feishu.cn         → https://xxx.trycloudflare.com
                                            → 本地 :3939/wecom/event


┌───────────────────────  IMTransport（新抽象接口）  ────────────────────────┐
│                                                                              │
│  interface IMTransport {                                                     │
│    readonly kind: 'lark' | 'wecom' | ...                                     │
│    readonly events: EventEmitter    // 'message', 'cardAction', 'error'      │
│    async start(): Promise<void>                                              │
│    async stop(): Promise<void>                                               │
│                                                                              │
│    // 发消息（统一签名）                                                     │
│    async sendText(chatId, text, opts?): Promise<{messageId}>                 │
│    async sendCard(chatId, card: CardSpec): Promise<{messageId}>              │
│    async patchCard(messageId, card: CardSpec): Promise<void>                 │
│    async sendFile(chatId, path, opts?): Promise<{messageId}>                 │
│    async sendImage(chatId, path): Promise<{messageId}>                       │
│                                                                              │
│    // 反查（chat state 定位）                                                │
│    resolveChatIdFromEvent(event): string                                     │
│  }                                                                           │
│                                                                              │
│  interface CardSpec {                                                        │
│    kind: 'progress' | 'approval' | 'ask' | 'ack' | ...                       │
│    title: string                                                             │
│    template: 'blue' | 'green' | 'red' | 'yellow' | 'grey'                    │
│    body?: string       // markdown                                           │
│    metaLines?: string[]                                                      │
│    actions?: Array<{                                                         │
│      label: string                                                           │
│      type?: 'primary' | 'danger' | 'default'                                 │
│      value: Record<string, unknown>                                          │
│    }>                                                                        │
│    // 高阶 kind-specific 字段（progress 的 code block、ask 的 options 等）  │
│  }                                                                           │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 目录结构

```
packages/
├── framework/           不变（IMTransport interface 放在这里）
│   └── src/im/
│       ├── transport.ts         ← 新 · IMTransport interface + CardSpec
│       └── index.ts             ← 新 · export IMTransport, CardSpec
├── im-lark/             改造 · 让它 export LarkTransport implements IMTransport
│   └── src/
│       ├── transport.ts         ← 新 · LarkTransport class
│       └── lark/cards.ts        改 · 加 renderLarkCard(spec: CardSpec) -> any
├── im-wecom/            全新 package
│   └── src/
│       ├── transport.ts         WeComTransport class implements IMTransport
│       ├── auth.ts              access_token 缓存 + 刷新
│       ├── api.ts               REST API 封装（send / upload）
│       ├── crypto.ts            AES 加解密 + 签名验证
│       ├── event-server.ts      内嵌 HTTP server（fastify or hono）
│       ├── cards.ts             renderWeComCard(spec: CardSpec) → template_card
│       └── index.ts
apps/daemon/src/
    └── index.ts         改 · attach 两个 transport 到 main()
```

**依赖 DAG**：
```
im-lark   ─┐
im-wecom  ─┼→ framework (IMTransport, CardSpec) → orchestrator → host-mac
           ┘
daemon → 全部
```

im-lark 和 im-wecom 都依赖 framework 里的抽象，互不知道对方存在。

---

## IMTransport 抽象设计要点

### 1. events emitter 标准化
两个 transport 都发一样的 event 名 + payload shape：

```ts
type MessageEvent = {
  chatId: string           // 统一格式 'lark:oc_xxx' or 'wecom:corp_xxx_chat_xxx'
  senderId: string
  text: string
  messageId: string
  raw: unknown             // 原始 event，需要时可读
}

type CardActionEvent = {
  chatId: string
  operatorId: string
  action: string           // value.action
  value: Record<string, unknown>
  originalMessageId: string
}
```

daemon 侧监听 `transport.events.on('message', ...)` 走同一个 dispatch flow。

### 2. chatId 前缀 namespace
避免 lark 的 `oc_xxx` 跟 wecom 的 chat id 混淆：
- Lark chat: `lark:oc_xxx`
- WeCom 1v1: `wecom:user:xxx`
- WeCom chat: `wecom:chat:xxx`

chats/store.ts 里就存 namespaced chatId。API 需要真实 chat id 时 transport 内部 strip 前缀。

### 3. CardSpec 高阶抽象
不搞"所有 feishu card v2 特性都能 map"的完美映射，只 map 我们**实际用的**卡片类型：
- progressCard
- approvalCard
- askCard (single / multi / input)
- ackCard
- receiptCard

每个 kind 有专门的 render 函数。lark 侧渲染成 v2 schema，wecom 侧渲染成 template_card。

### 4. cardMessageId 双向兼容
patchCard 需要之前 sendCard 返回的 messageId。两个 transport 都要能 update 消息 —— 飞书 SDK 有 patchCard API，企微支持 `update_template_card`。

### 5. 优雅降级
CardSpec 里有 lark 独有的字段（如 form container）时，wecom render 自动 skip 或降级为等价 button。同样 wecom 独有的 button 样式 lark 忽略。

---

## 企微 API 关键实现

### access_token 管理（auth.ts）
```
GET https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=X&corpsecret=Y
→ {access_token, expires_in: 7200}

- 首次调 API 时 lazy fetch
- 后台每 60min 后台刷新（early refresh，避 corner case）
- 内存缓存
- errcode !== 0 → 重新 fetch
```

### 发消息（api.ts）
```
POST https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=X
Body: {
  touser: "@all" | "userid1|userid2",
  toparty / totag: 部门 / 标签,
  msgtype: "text" | "textcard" | "template_card" | "file" | "image",
  agentid: N,
  <msgtype>: {...},
  enable_id_trans: 0,
  enable_duplicate_check: 0,
}
```

**msgtype 到 CardSpec 映射**：
- CardSpec.kind='ack' → msgtype='text' 或 'textcard'
- CardSpec.kind='progress' → msgtype='template_card' with button_interaction
- CardSpec.kind='approval' → msgtype='template_card' with two buttons
- CardSpec.kind='ask' single/multi → msgtype='template_card' with buttons
- CardSpec.kind='ask' input → msgtype='textcard'（提示回复文本，daemon 拦截下条）

### 文件 / 图片上传
```
POST https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=X&type=file|image
multipart/form-data
→ {media_id, ...}

之后发消息 body 里带 media_id
```

### Event 加解密（crypto.ts）
参考企业微信官方 `WXBizMsgCrypt` 逻辑：
1. verify_signature(token, timestamp, nonce, encrypted_msg) → boolean
2. decrypt(aes_key_b64, encrypted_msg) → {corpid, plain_xml}
3. parse_xml(plain_xml) → event JSON

Node 用 `crypto.createDecipheriv('aes-256-cbc', ...)` 手写。

### 内嵌 HTTP server（event-server.ts）
用 hono（轻，无依赖）或 native http：
```
POST /wecom/event
    Query: ?msg_signature=X&timestamp=X&nonce=X
    Body: <xml><Encrypt>...</Encrypt></xml>

GET /wecom/event
    企微首次校验 URL 时发 GET，验签成功后 response echostr 明文
```

daemon 启动时监听可配置端口（默认 3939）。

---

## Cloudflared tunnel 集成

用户第 4 步（安装向导）：
```bash
brew install cloudflare/cloudflare/cloudflared
cloudflared tunnel --url http://localhost:3939
# → 输出 https://xxx.trycloudflare.com
```

用户把这个 URL 填到企微「应用管理 → 应用能力 → 接收消息」的**回调 URL**。

之后 daemon 里配 `WECOM_CALLBACK_HTTP_PORT=3939` + `WECOM_CALLBACK_URL=https://xxx.trycloudflare.com`（可选，doctor 用它验证）。

**改进**（下期做）：daemon spawn cloudflared subprocess，从 stdout 拿 URL，通过 CLI 帮用户打开企微后台填 URL 页。

---

## CLI 扩展

**新 sub-command**：
```
agent wecom send-text [--chat X] "..."
agent wecom send-file [--chat X] <path>
agent wecom send-image [--chat X] <path>
agent wecom send-card [--chat X] '<CardSpec JSON>'
agent wecom ask <single|multi|input> --title ... --options ...
agent wecom which-chat        # 反查 sticky chat
```

跟 `agent lark xxx` 完全对称。**推荐更好**：加一个 dispatch 层：
```
agent send-text ...
```
自动挑当前 chat 的 transport（chatId 前缀决定）。飞书 CLI 保持向后兼容。

---

## Daemon 启动集成

`apps/daemon/src/index.ts`：
```typescript
// 新增 imports
import { LarkTransport } from 'multiagent-im-lark';
import { WeComTransport } from 'multiagent-im-wecom';

// main() 里
const transports: IMTransport[] = [];

if (process.env.LARK_APP_ID && process.env.LARK_APP_SECRET) {
  const lark = new LarkTransport(...);
  await lark.start();
  transports.push(lark);
  logger.info('lark transport attached');
}

if (process.env.WECOM_CORP_ID && process.env.WECOM_AGENT_ID && process.env.WECOM_SECRET) {
  const wecom = new WeComTransport(...);
  await wecom.start();       // 起内嵌 HTTP server
  transports.push(wecom);
  logger.info('wecom transport attached');
}

if (transports.length === 0) {
  logger.error('至少配置一个 IM transport (LARK_* 或 WECOM_*)');
  process.exit(1);
}

// dispatch flow 里根据 chatId 前缀路由到对应 transport
```

---

## 环境变量

`.env` 加：
```
# 企微（可选，缺就不 attach 企微 transport）
WECOM_CORP_ID=wx_xxxxx
WECOM_AGENT_ID=1000002
WECOM_SECRET=xxxxx
WECOM_TOKEN=xxxxx                    # 企微后台配的 token（验签用）
WECOM_AES_KEY=xxxxx                  # 43 位 base64 encoding aes key
WECOM_CALLBACK_HTTP_PORT=3939        # 内嵌 HTTP server 端口
WECOM_CALLBACK_URL=https://xxx.trycloudflare.com  # 可选，doctor 用
```

`.env.example` 同步更新。

---

## Doctor 扩展

```
agent doctor
  ...
  ✅ [important]  WeCom transport 已 attach（若配了 WECOM_*）
  ✅ [important]  WeCom access_token 有效
  ✅ [important]  WeCom endpoint http://localhost:3939 可达
  ⚠️ [optional]   Cloudflared tunnel URL 可 reach（若配了 WECOM_CALLBACK_URL）
```

---

## 迁移 checklist（既有 lark 代码抽象化）

需要动 lark 代码的地方：
1. `packages/im-lark/src/lark/handlers.ts` —— dispatch 逻辑抽出到 framework 里共享的 dispatch
2. `packages/im-lark/src/lark/api.ts` —— sendCardReturnId / patchCard / sendImage / sendFile 抽 IMTransport method
3. `packages/framework/src/control/server.ts` —— `handleLarkSendText` 等改成 dispatch to right transport (by chatId prefix)
4. `packages/framework/src/control/cli.ts` —— `cmdLark` 分裂成 cmdWeCom 或统一 dispatch
5. `packages/im-lark/src/lark/cards.ts` —— export CardSpec-based render function

**注意**：这一层抽象**可以先粗略做**（Day 1），细化在 Day 3-4；先让 wecom 骨架跑起来再回头精修。

---

## 风险 + 缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 企微 template_card 交互能力不足 | ask multi 需多次交互 | UX 提示"回复数字 y/n"降级；documented limitation |
| Cloudflared URL 每次重启变 | 每次重启后要重配企微后台 | 建议用户用 named tunnel；提供 fallback 让 daemon 帮 open 后台页 |
| 企微 access_token 频繁失效 | 消息发不出 | 60min early refresh + errcode retry |
| 加解密错误 | Event 收不到 | crypto.ts 完整 unit test；先 verify 后 decrypt |
| 现有 lark 代码耦合太深 | 抽象难度大 | 先 minimum 抽象 + iterate；不追求一次完美 |

---

## 分 5 天实施计划（每天可 commit）

### Day 1 · 抽象层
- 定 `IMTransport` + `CardSpec` interface（framework/src/im/）
- LarkTransport implements IMTransport（wrap 现有 lark code）
- 现有 im-lark public API 不 break（backward compat）
- ✅ 目标：飞书链路继续工作，daemon.attach 走新接口

### Day 2 · WeCom 骨架
- `packages/im-wecom` 创建
- auth.ts access_token 缓存
- api.ts sendText / sendFile / sendImage REST
- 未 attach 到 daemon，只 unit test

### Day 3 · Event receiver
- crypto.ts AES 加解密 + 签名验证
- event-server.ts 内嵌 HTTP server（hono）
- URL verify + event decrypt + emit 'message' event
- WeComTransport.start() 挂上 receiver

### Day 4 · Card render + interactive
- cards.ts CardSpec → template_card 渲染
- ask single/multi/input 三种降级 UX
- 手动测通一次 progressCard patch loop

### Day 5 · 联调 + doctor + docs
- daemon 双 transport attach 通
- doctor 加检测
- docs/wecom-bot-setup.md 编写
- Cloudflared tunnel 集成指南

每天 commit 一次；每个 stage 完成飞书推进度。

---

## 验收（跟 requirements US-x 对齐）

- [ ] US-1：从企微发命令 → tab 收到 → 有响应
- [ ] US-2：`agent wecom send-*` 三种消息类型都能发
- [ ] US-3：progressCard 在企微能显示 + patch
- [ ] US-4：ask single/multi/input 三种类型都能玩通
- [ ] US-5：request-approval 在企微弹卡 + 5min 超时
- [ ] US-6：doctor 加了企微 section + skill/hooks 自动化未 break
- [ ] US-7：企微 + 飞书同时挂着，两 chat 独立不干扰
