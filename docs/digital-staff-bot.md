# 第二个飞书机器人：数字员工 bot

> 目标：数字员工（`~/ihealth-work/digital-staff`）在飞书里是**另一个机器人**，与本机 multiAgentChat bot
> 的派 tab / 运维通知消息分开。同一个 daemon 同时接两个飞书自建应用。

## 1. 原理（一分钟版）

- `.env` 里 `LARK_APP_ID/SECRET` 是默认 bot（id `local`）；`LARK_BOT_<ID>_APP_ID/APP_SECRET` 是附属 bot。
  `<ID>` 大写随便取，解析后小写成 bot id，比如 `LARK_BOT_STAFF_*` → `staff`。
- 每个 bot 一条独立 WS 长连接。附属 bot 收到的会话 chatId 写成 `staff:oc_xxx`，chat 状态 / pending 都按它存。
- **chatId 决定走哪个 bot 发**：发送层按前缀挑 client、剥掉前缀再调飞书 API。所以：
  - 数字员工 bot 的会话里发的任何消息、卡片、`agent lark send-text --chat staff:oc_xxx`，都由数字员工 bot 发出；
  - 本机运维通知（权限、System Events、TAPD、公函、fleet 摘要）只出现在 `local` bot 的会话里。
- `LARK_BOT_STAFF_ROLE=digital-staff` 时这个 bot **不派 tab**，而是把消息翻译成 digital-staff 的 HTTP 调用（见 §4）。
  不设 role（默认 `tabs`）则与本机 bot 同一套逻辑，只是换了个机器人身份。

## 2. 飞书后台

按 [installation.md 第 2A 步](installation.md#第-2a-步申请飞书自建应用) **再建一个应用**，权限与事件订阅完全一样：

- 权限：`im:message` `im:message:send_as_bot` `im:resource`（加完后按后台提示补 `im:message.p2p_msg:readonly`）
- 事件与回调：订阅方式「长连接」；事件 `im.message.receive_v1` + `card.action.trigger`
- 启用机器人 → 发布版本 → 抄 App ID / App Secret

## 3. multiAgentChat 侧 `.env`

```bash
LARK_BOT_STAFF_APP_ID=cli_yyyy
LARK_BOT_STAFF_APP_SECRET=yyyy
LARK_BOT_STAFF_ROLE=digital-staff
LARK_BOT_STAFF_LABEL=数字员工

DIGITAL_STAFF_URL=http://127.0.0.1:3900   # digital-staff 默认地址
DIGITAL_STAFF_TOKEN=                       # digital-staff 开了 AUTH_REQUIRED 才填（= 它的 AUTH_API_TOKEN）
DIGITAL_STAFF_OWNER_OPEN_IDS=              # 先留空，下一步拿
```

重启 daemon（`/reload` 或 `launchctl kickstart`），日志应出现 `多飞书 bot 已就绪 { bots: ['local(tabs)', 'staff(digital-staff)'] }`。

**拿自己的 open_id**：在飞书里给数字员工 bot 发任意一句话，它会回「还没配老板白名单…你的 open_id 是 ou_xxx」。
把它填进 `DIGITAL_STAFF_OWNER_OPEN_IDS`，再 `/reload`。
⚠ open_id **按应用隔离**：你在本机 bot 下的 open_id 和在数字员工 bot 下的不一样，必须用数字员工 bot 回的那个。

## 4. 数字员工 bot 会话里能说什么

| 你发 | 发生什么 |
|---|---|
| `@苏芮 这周进度如何` | `POST /api/messages?wait=120`，员工回复渲染成紫色「👤 苏芮」卡；超时则先回「还在想」，之后 15s 轮询、到了补推（最长 10 分钟） |
| `继续说`（裸文本） | 30 分钟内沿用上一位聊过的员工；没有则提示 @谁，并附员工列表 |
| `派任务 @苏芮 整理周报⏎要含 TIR` | `POST /api/tasks`，首行标题、其余描述；不写 @ 按职责自动匹配；`@整组 测试组` 派给整个团队 |
| `让苏芮做一版竞品分析` | 同上的口语写法 |
| `/staff` | 员工列表（岗位 / 团队 / 忙闲） |
| `/asks` · `/answer <id> 内容` | 待回答的请示 / 答复（请示卡过期后的兜底，正常直接在卡片上答） |
| `/whoami` · `/help` | 看自己的 open_id 与身份 / 用法 |

**分支键是发送者**，不是消息内容：

- 白名单内 = 老板：以上全部可用。digital-staff 把老板聊天当**可信域**（员工能当场问同事、派活、操作 MCP）。
- 不在白名单：只能提交任务，且 `untrusted:true`（外部文本：不进 Codex、不带工作区、不能装工具 / 推飞书）；
  不能聊天、不能答请示、不能审核。即使你只是自己用，这条也留着，防止哪天群里多了人。
- 白名单没配：什么都不做，只回 open_id 与配置方法（fail-closed）。

## 5. 反向：数字员工推请示 / 审核 / 播报

digital-staff 出站走的是 `agent lark send-text / ask … --chat $LARK_CHAT_ID`（它自己的 `server/notify/lark.js`），
**一行不用改**，只要在 digital-staff 的 `.env` 里：

```bash
LARK_CHAT_ID=staff:oc_xxxxxxxx     # 带 bot 前缀！
```

`oc_xxx` 怎么拿：daemon 日志 `message received { chat_id: 'staff:oc_…' }`，或在数字员工 bot 会话里发 `//agent lark which-chat`
（`//` 转发到 active tab，所以这招只在 role=tabs 的 bot 里有效；digital-staff role 直接看日志）。

于是请示卡 / 审核卡由数字员工 bot 发出，你在卡上点选或打字，答案走 multiAgentChat 既有的 ask 流程回给 digital-staff。
这些回答**不会**再被当成聊天转发给员工：ask 消费发生在进入数字员工适配器之前，天然没有回环。

## 6. 常见问题

- **两个 bot 会不会拉进同一个群？** 不会也没关系：chatId 带前缀，状态文件 `data/chats/staff:oc_xxx.json` 与 `oc_xxx.json` 互不干扰。
- **数字员工 bot 凭证填错 / 应用没发布会怎样？** 它的 WS 会反复 reconnect，但**不触发 daemon 自杀**（只有默认 bot 才会），
  日志里每 10 次 warn 一次 `WS[staff] reconnect（附属 bot，不触发重启）`；health-check 同理只 warn。本机 bot 不受影响。
- **digital-staff 没在跑？** 回「数字员工服务不可达（http://127.0.0.1:3900）」，`cd ~/ihealth-work/digital-staff && npm start`。
- **digital-staff 开了鉴权却 403「缺少 X-Requested-With」？** 适配器总是带 `X-Requested-With: fetch`；403 多半是 `DIGITAL_STAFF_TOKEN`
  没填或填错（Bearer 不对时会落到会话模式再被 CSRF 头检查拦）。
- **图片？** digital-staff 聊天只收文本。纯图消息直接回「暂不收图片」（不会像本机 bot 那样暂存后派给 tab）；带文字的图文消息文字照发、图略去并在正文里注明。

## 7. 代码位置

- `packages/im-lark/src/lark/bots.ts` —— profile / 注册表 / 命名空间（单一事实源）
- `packages/im-lark/src/lark/client.ts` —— 逐 profile 起 Client + WSClient
- `packages/im-lark/src/lark/api.ts` `reply.ts` `monitor/notifier.ts` —— 发送层按 chatId 前缀选 client
- `packages/im-lark/src/lark/handlers.ts` —— `buildEventDispatcher(client, bot)`：入站 chatId 加前缀；role=digital-staff 分流
- `packages/im-lark/src/lark/digital-staff.ts` —— 适配器（意图解析 / 员工匹配 / HTTP / 回复渲染）
- `packages/im-lark/src/monitor/ws-watchdog.ts` `health-check.ts` —— 附属 bot 只告警不自杀
- 测试：`tests/lark-bots.test.ts` `tests/digital-staff.test.ts`
