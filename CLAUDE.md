# multiAgentChat — Claude Code 项目指南

> 飞书 IM ⇄ Mac Terminal.app 的本地多 agent 协作桥
> 目标：单用户在手机/飞书上调度自己 Mac 上多个 Claude Code 终端 tab，完成并发任务

## 启动 / 日常运维

```bash
# 一次性
cp .env.example .env       # 填 LARK_APP_ID / LARK_APP_SECRET
agent install-skill        # 把 multiagent-lark skill 装到 ~/.claude/skills/

# 跑 dev（tsx watch 自动 reload）
npm run dev

# CLI（任何 tab 里都能用）
agent tabs                                    # 看 Mac 上所有 Terminal tab
agent lark send-text -m "结果摘要..."         # 主动推消息到飞书（auto-resolve chat）
agent lark send-file <path>                   # 推文件
agent request-approval --title "git push --force" --body "..."  # 审批
```

`.env` 必须 gitignored。健康检查、WS watchdog 会自动重启 dev，但 `.env` 改了要手动 kill 重启。

## 整体结构

```
src/
├─ index.ts                 启动总入口（installWsWatchdog → startLarkBot → ControlServer → Watcher → HealthCheck）
├─ config.ts                .env 加载 + 全局配置
├─ logger.ts                统一 logger（INFO/WARN/ERROR 带时间戳）
├─ workspace.ts             ./data 目录管理
├─ recent-cwds.ts           最近用过的 cwd（用于 new-tab dropdown）
│
├─ lark/                    飞书侧（入站事件 + 出站 API）
│   ├─ client.ts            startLarkBot：建 SDK Client + WSClient 长连接
│   ├─ handlers.ts          事件入口（im.message.receive_v1 / card.action.trigger）→ dispatchSendToTab / handleCommand / handleCardAction
│   ├─ commands.ts          斜杠命令路由（/dashboard /shells /history /new /use /preset /recall /approvals /watch ...）
│   ├─ cards.ts             所有交互卡片 schema（progress / batch / dashboard / waitingInput / approval / chooseDir / ack ...）
│   ├─ api.ts               withRetry 包裹的 lark API 调用（sendCardReturnId / patchCard / sendFile / sendImage）
│   ├─ target.ts            @target 解析（tty 全/短匹配 → title → cwd basename → fuzzy）
│   └─ reply.ts             replyText / sendText 工具
│
├─ terminal/                AppleScript 控制 Terminal.app
│   ├─ tabs.ts              listTabsRaw / listTabs / getHistory / send / forceEnter / newTab
│   ├─ applescript.ts       runOsascript 包装 + escape
│   ├─ status.ts            inferTabStatus（idle/busy/claude/login/waiting/TUI）
│   └─ types.ts             TerminalTab 类型
│
├─ monitor/                 后台观测 + 通知
│   ├─ watcher.ts           tab poll（3s tick）+ pending 字符长度稳定性检测 + cache
│   ├─ pending.ts           PendingOutput 跟踪器（add/forTty/remove/done 列表）
│   ├─ notifier.ts          attachWatcherToLark：watcher event → patchCard / sendCardMessage
│   ├─ detector.ts          paragraph stable / local task detector 辅助
│   ├─ health-check.ts      30s 调 lark token endpoint，失败 3 次自杀
│   ├─ ws-watchdog.ts       monkey-patch console.log 截获 SDK [ws] 状态，判定 WS 死
│   └─ ...
│
├─ control/                 本地 IPC（Unix domain socket）
│   ├─ server.ts            启动 ~/.multiagent-chat/agent.sock，路由所有 op
│   ├─ cli.ts               `agent` CLI 实现（tabs/use/which/send/open/show/lark/approvals/install-skill ...）
│   └─ protocol.ts          Request/Response 类型 + SOCKET_PATH
│
├─ approval/                审批工作流
│   ├─ manager.ts           ApprovalManager.create / resolve / list，5min auto-timeout
│   └─ types.ts
│
├─ memory/                  跨任务长期记忆
│   ├─ store.ts             ./data/memories/<id>.json
│   ├─ recall.ts            tokenize + scoreMemory（cwd + keyword + age） + formatRecallPrefix
│   └─ types.ts             TaskMemory
│
├─ chats/                   per-chat 状态（activeTty / watchAllTabs）
│   ├─ store.ts             ./data/chats/<chatId>.json
│   └─ types.ts
│
└─ presets/                 任务模板雏形（A1 会在此扩展）
    └─ store.ts

skills/multiagent-lark/SKILL.md    →  会 symlink/copy 到 ~/.claude/skills/
bin/agent                          →  CLI 入口
data/                              →  运行时持久化（memories / chats / approvals / templates）
```

## 核心数据流

### 1. 飞书发命令 → tab 执行

```
[手机] @ttys003 跑 npm test
   ↓ WS 长连接
SDK → handlers.im.message.receive_v1
   ↓ parseMessage 拆 @target
sendToNamedTarget → resolveTarget(target) → dispatchSendToTab
   ↓
注入 SYSTEM_GUIDANCE（6h throttle）+ recall（cwd+keyword Top3）
   ↓
tabs.send(tty, text) → osascript "do script"
   ↓ 若是 claude TUI → 等 400ms → forceEnter（System Events key code 36）
   ↓
pendingTracker.add({ tty, beforeCharLen, originalPrompt, source, batchId... })
   ↓ 进度卡（sendCardReturnId）回飞书
```

### 2. 任务执行中 → 进度回传

```
watcher tick (3s) → for each pending
   ↓ getHistory(tty) 拿 fullHist
currentCharLen = fullHist.length
   ↓ 与 lastSeenCharLen 比较
若变化 → emit 'taskOutput' { pending, tab, outputTail, taskOnlyTail, isFinal }
   ↓
notifier 监听：若 batchId → maybePatchBatchCard（2.5s 节流）
            否则 → patchCard(progressMessageId)
   ↓ isFinal → persistTaskMemory（写 ./data/memories/）+ remove from pending
```

### 3. 本地 tab 输入（非飞书）→ 飞书也能看到

```
启用 /watch on 后
   ↓
watcher 检测到非 pending tab 的 history 增长 ≥8 行
   ↓ emit 'localTaskDetected'
notifier 给所有 watchAllTabs=true 的 chat 发"🏠 本地"卡 + 创建 ghost pending（source='local'）
```

## 关键约定（!!! 必读 !!!）

### 飞书 ack 窗口

飞书 WS event handler **必须 3-5 秒内 return**，否则飞书会重试投递（同 message_id 收到 2 次）。
→ **handler 内只做轻量 ack，重活用 fire-and-forget 异步**：

```ts
'im.message.receive_v1': async (data) => {
  recordInbound();
  // 立即 return；重活异步
  (async () => { await heavyWork(); })();
}
```

`card.action.trigger` 同理：callback 立刻返回 `{}`，side effect 用 fire-and-forget 走 sendCard / sendText 推回。

### claude TUI / alt-screen 模式

进入 claude TUI 后：
- `do script` 加 `\n` 被 claude 理解为多行换行，**不是 Enter** → 必须 `forceEnter()` 用 System Events key code 36 发真 Enter
- `contents of tab` 返回 missing value（alt-screen 屏蔽）→ 屏幕状态我们读不到
- `history of tab` 返回的还是退出 alt-screen 前的 scrollback → 用 char-length 而非 line-count 检测变化（claude 用 `\r` 重绘，行数不变）

→ **SYSTEM_GUIDANCE 强制 claude session 主动调 `agent lark send-text`** 推结果回飞书。这是 alt-screen 看不见时唯一的输出渠道。

### Accessibility 权限

`osascript` 用 `System Events keystroke` / `key code` 都需要 macOS Accessibility 授权。
→ Terminal.app / iTerm / 任何运行 dev 的进程 + osascript 自己都要加到：
  System Settings → Privacy & Security → Accessibility

### .env 不可提交

`LARK_APP_SECRET` 在 .env，gitignored。`.env.example` 模板可提交。任何 audit / agent / commit 行为都不要把 .env 内容写进任何地方。

### WS 长连接的"假活"

`@larksuiteoapi/node-sdk` 的 WSClient 偶尔会 silent 断开，HTTP 还通但 WS 死。
→ `monitor/ws-watchdog.ts` monkey-patch `console.log` 截获 SDK 的 `[ws] reconnect` / `[ws] ws client ready`，跟踪 reconnect 计数。
→ `monitor/health-check.ts` 先看 WS 状态（reconnect ≥3 且 90s 没 ready）触发自杀；再看 HTTP（失败 3 次自杀）。
→ 自杀 = `utimesSync` touch index.ts 让 tsx watch reload + `process.exit(1)`。

### pending 的 char-length 而非 line-count

不要再回到 `arr.length` 判断变化——claude TUI 用 `\r` 重绘同行，行数不变但内容在变。一律用 `fullHist.length` (字符总数)。`beforeCharLen` 在 dispatch 时记录，`lastSeenCharLen` 在 watcher tick 更新，`taskOnlyTail = fullHist.slice(beforeCharLen)` 给 memory/notifier。

### sendFile / sendImage 返回 schema

SDK 返回 `{file_key}` 在 **TOP level**，不在 `.data` 下。`api.ts` 已修，新增任何 lark API 调用前先看现有代码。

### memory 写入用 taskOnlyTail

`persistTaskMemory` 用 `pending.cwd ?? tab.cwd ?? ''`（dispatch 时记录的优先）；`outputPreview = taskOnlyTail.slice(-500)`；`filesProduced = extractFilesFromOutput(taskOnlyTail)`。不要用 `outputTail` 否则会捞到 scrollback 里的 noise。

## 常见维护操作

```bash
# 看 dev 实时日志（dev 跑在 tab/tsx watch）
# 通常 dev tab 是 ttys003 (会变化，看 agent tabs)

# 看最近 pending / done
agent recent-cwds       # 最近用的工作目录
# 飞书 /dashboard 看实时活跃

# 强制重启所有 claude tab（除自己）
agent tabs              # 看 tty 列表，自己排除
# 用 CLI 循环 close + new（待做：v52 — restart-all-claude-tabs --except）

# typecheck
npm run typecheck
```

## 扩展时的小坑

1. 新增 lark API 调用 → 用 `api.ts` 的 `withRetry`，不要直接 `client.xxx.xxx`
2. 新增卡片 → `cards.ts` 集中放，按已有 template 配色：黄/红 = 需用户响应；蓝/绿 = 信息
3. 新增 watcher event → 在 `watcher.events.emit('xxx')` 之外，必须在 `notifier.ts` 接听
4. 新增 CLI 命令 → 同时改 `control/cli.ts`（client 侧）+ `control/server.ts`（server 侧）+ `control/protocol.ts`（共享 type）
5. 改了 `index.ts` 或 watcher 启动逻辑 → 注意 tsx watch reload 是否能干净重启（旧的 setInterval 是否清理）

## 当前阶段（2026-06）

v3.x 完成（基础链路 + TUI 适配 + memory + approval + WS watchdog）
v4.0 进行中：A 路线 · 编排
  - A1 任务模板（/template + /run）
  - A2 任务链（@a X >> @b Y）
  - A3 Planner（待评估）
旁支：代码 audit / integration test 主路径

下一会话从 `agent tabs` 开始看现状，然后 `cat MEMORY.md` 看 memory 上下文。
