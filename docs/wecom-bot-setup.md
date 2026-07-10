# 企业微信机器人配置

> 目前状态 · **Day 1-4 骨架已合入**：能收发文本 / 文件 / 图片 + template_card 卡片，内嵌 HTTP receiver + AES 加解密都能跑。**Day 5 尚未完成** —— 收到的消息还没接入 tab 派发流（收消息会打 log 但暂不注入 Terminal tab）。飞书链路不受影响。

## 前提

1. 你或团队管理员有权限在企业微信后台创建自建应用
2. Mac 需要**公网可达**的 HTTP endpoint —— 用 cloudflared tunnel（推荐）或 ngrok/frp

## Step 1 · 创建企业自建应用

1. 打开 [企业微信管理后台](https://work.weixin.qq.com/)
2. 「应用管理」→「应用」→「创建应用」→ 上传 logo、填名字（如 multiAgentChat）
3. 选可见范围（先给你自己，后期扩到部门）
4. 保存后拿到：
   - `CorpID`（顶部左侧「我的企业」→ 企业信息里找）
   - `AgentID`（应用详情页顶部）
   - `Secret`（应用详情 → 生成 Secret，只显示一次，抄好）

## Step 2 · 起 cloudflared tunnel

```bash
brew install cloudflare/cloudflare/cloudflared
# 临时 URL（每次重启会变）：
cloudflared tunnel --url http://localhost:3939
# → 输出 https://xxx-xxx-xxx.trycloudflare.com
```

**建议**：注册 CF 免费账号 + 创建 named tunnel，URL 稳定不变：
```
cloudflared tunnel login              # 打开浏览器登录
cloudflared tunnel create mchat       # 建一个叫 mchat 的 tunnel
cloudflared tunnel route dns mchat mchat.your-domain.com
cloudflared tunnel run mchat          # 起 tunnel（也可以做成 launchd 常驻）
```

## Step 3 · 企微后台配「接收消息」

在应用详情页找「接收消息」，点「设置 API 接收」：

| 字段 | 值 |
|---|---|
| URL | `https://xxx.trycloudflare.com/wecom/event` |
| Token | 生成一个随机字符串（如 `openssl rand -hex 16`），抄好 |
| EncodingAESKey | 点「随机生成」→ 43 位 base64 字符串，抄好 |

先**不要点保存** —— 等 daemon 起来后再校验 URL。

## Step 4 · 填 .env

```bash
# 编辑项目 .env，加：
WECOM_CORP_ID=wx_xxxxxxxxxxxxxxxx
WECOM_AGENT_ID=1000002
WECOM_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
WECOM_TOKEN=<Step 3 里的 Token>
WECOM_AES_KEY=<Step 3 里的 EncodingAESKey>
WECOM_CALLBACK_HTTP_PORT=3939
WECOM_DEFAULT_TO_USER=@all       # 或某个特定 userid
```

## Step 5 · 重启 daemon

```bash
pnpm dev
```

期望日志：
```
[INFO] wecom event server listening { port: 3939, path: '/wecom/event' }
[INFO] wecom access_token refreshed { ... }
[INFO] wecom transport attached { corpId, agentId, port }
```

## Step 6 · 回到企微后台，点「保存」

企微会 GET 你配的 URL 做 URL 校验（echostr）。daemon 侧 crypto.ts 会解密并回明文，成功 → 后台显示"已启用"。

## Step 7 · 测试收发

**发消息（从 Mac shell 试）**：
```bash
# 目前 CLI 侧还没加 wecom sub-command（Day 5），暂时用 curl 测底层：
# TODO: 待 agent wecom send-text 落地
```

**收消息**：
在企微里给你的应用发一条文本消息，daemon log 里应该看到：
```
[INFO] wecom message received (dispatch WIP) { chatId, senderId, textLen }
```

## 当前限制

- **Day 5 未完成**：收到的消息还没自动派发到 Terminal tab（只 log）。跟飞书对齐还需要接 handlers 里的 dispatch flow
- **CLI 缺 wecom 子命令**：`agent wecom send-text` 还未加，敬请期待 Day 5 收尾
- **群聊消息 target**：目前只支持 1v1 应用消息，群聊接口 `/appchat/send` 未实现
- **template_card 交互**：企微 vote_interaction 卡片能力受限，`ask multi` UX 不如飞书顺畅
- **patchCard 用重发实现**：企微不支持任意 body 更新，长任务进度会累积消息（比飞书多）

## 常见踩坑

| 坑 | 症状 | 解 |
|---|---|---|
| URL 校验失败 | 企微后台保存报错 | daemon 侧 log 找 `wecom URL verify failed`，多半是 Token / AESKey 抄错 |
| tunnel URL 每重启就变 | 后台要频繁改 | 用 named tunnel（Step 2 备选）|
| access_token 拉失败 | daemon log 报 gettoken errcode | 检查 CorpID + Secret；应用是否已启用（在「可见范围」加人）|
| 收不到消息 | 企微发消息 daemon 没反应 | 检查 tunnel 是否活着、URL 保存了吗、可见范围是不是包含你自己 |

## 下一步（Day 5）

- Wire `wecom.events.on('message')` 到 handlers dispatch → 消息真派发到 tab
- 加 `agent wecom send-text/-file/-image/-card` CLI
- 加 `agent wecom ask single/multi/input` 阻塞交互
- `agent doctor` 加 wecom section（token 有效性、endpoint 可达）
- 更新 features.md 加企微章节
