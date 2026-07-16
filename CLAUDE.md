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

> **pnpm monorepo**（不再是单 `src/`）。一个 `apps/daemon` 组装入口 + 5 个 `packages/*`。
> 依赖方向：`daemon` → `im-lark`/`im-wecom` → `framework`/`host-mac`/`orchestrator`。
> `framework`/`host-mac`/`orchestrator` 之间互不依赖（传输无关、宿主无关、编排无关三层解耦）。
> 包名：`multiagent-framework` / `multiagent-host-mac` / `multiagent-im-lark` / `multiagent-im-wecom` / `multiagent-orchestrator`。

```
apps/
└─ daemon/src/
    ├─ index.ts             启动总入口（main()：assertNodeVersion → ensureEnvFile → startCaffeinate
    │                       → installWsWatchdog → startLarkBot →[可选]WeComTransport
    │                       → startControlServer → attachWatcherToLark → startHealthCheck
    │                       → startSystemEventsProbe →[可选]WebDashboardServer → refreshDirIndex）
    │                       同时幂等 upsert Claude Code hooks + agent CLI symlink + multiagent-lark skill
    │                       企微侧的 final/ask/cardAction/approval 监听器也都挂在这（attachWeCom*）
    └─ web-dashboard/       内置 Web 面板（config / html / server；缺 WEB_DASHBOARD_TOKEN 则不启用）

packages/
├─ framework/               传输无关 + 宿主无关的公共内核
│   └─ src/
│       ├─ control/         本地 IPC（Unix domain socket）
│       │   ├─ server.ts    startControlServer：起 ~/.multiagent-chat/agent.sock，路由所有 op
│       │   ├─ cli.ts       `agent` CLI 实现（tabs/use/which/send/open/show/lark/approvals/doctor ...）
│       │   ├─ doctor.ts    环境自检（权限 / 依赖 / socket）
│       │   └─ protocol.ts  Request/Response 类型 + SOCKET_PATH
│       └─ im/              IMTransport 抽象接口（lark/wecom 都 implement；chatId 带 'lark:'/'wecom:' 前缀）
│
├─ host-mac/                Mac 宿主能力（AppleScript 控制 Terminal.app）
│   └─ src/
│       ├─ terminal/
│       │   ├─ tabs.ts      listTabs / getHistory / send / forceEnter / newTab
│       │   ├─ applescript.ts runScript / runOsascript 包装 + escape
│       │   ├─ keys.ts      sendKeys / forceEnter（System Events key code 36 发真 Enter）
│       │   ├─ probe.ts     probeSystemEvents（术语故障自检；恒 false 分支里放 key code 36）
│       │   ├─ screen.ts    captureScreen（截 tab 可视区域）
│       │   ├─ status.ts    inferTabStatus（idle/busy/claude/login/waiting/TUI）
│       │   └─ types.ts     TerminalTab 类型
│       ├─ workspace.ts     ./data 目录管理
│       ├─ recent-cwds.ts   最近用过的 cwd（new-tab dropdown）
│       ├─ dir-index.ts     后台 refreshDirIndex 建目录索引（open/new 时补全）
│       └─ bookmarks.ts     常用目录书签
│
├─ im-lark/                 飞书 transport + tab 观测通知（monitor 与 lark cards/api 强耦合，暂同包）
│   └─ src/
│       ├─ lark/
│       │   ├─ client.ts    startLarkBot：建 SDK Client + WSClient 长连接
│       │   ├─ handlers.ts  事件入口（im.message.receive_v1 / card.action.trigger）→ dispatch/command/cardAction
│       │   ├─ commands.ts  斜杠命令路由（/dashboard /shells /history /new /use /preset /recall /approvals /watch ...）
│       │   ├─ cards.ts     所有交互卡片 schema（progress / batch / dashboard / approval / chooseDir / ack ...）
│       │   ├─ api.ts       withRetry 包裹的 lark API（sendCardReturnId / patchCard / sendFile / sendImage）
│       │   ├─ target.ts    @target 解析（tty 全/短匹配 → title → cwd basename → fuzzy）
│       │   ├─ task-render.ts 任务进度/结果卡的渲染
│       │   ├─ reply.ts     replyText / sendText 工具
│       │   └─ resource.ts  飞书图文入站：下载 image/post 图片到 data/inbound + post 解析 + 24h 清理 + imgPrefix 拼接
│       ├─ monitor/
│       │   ├─ watcher.ts   tab poll（2s tick）+ pending 字符长度稳定性检测 + cache
│       │   ├─ pending.ts   PendingOutput 跟踪器（add/forTty/remove/done 列表）
│       │   ├─ notifier.ts  attachWatcherToLark：watcher event → patchCard / sendCardMessage
│       │   ├─ detector.ts  paragraph stable / local task detector 辅助
│       │   ├─ chains.ts    任务链（A2：@a X >> @b Y）执行编排
│       │   ├─ sanitize.ts  推送前清洗终端 noise（ANSI / 控制字符）
│       │   ├─ health-check.ts  30s 调 lark token endpoint，失败 3 次自杀
│       │   ├─ ws-watchdog.ts   monkey-patch console.log 截获 SDK [ws] 状态，判定 WS 死
│       │   └─ system-events-probe.ts  每 2min 跑 probeSystemEvents，状态翻转时推飞书告警
│       └─ chats/           per-chat 状态（activeTty / watchAllTabs）store + types
│
├─ im-wecom/                企业微信 transport（可选；配了 WECOM_* 才 attach）
│   └─ src/                 config / transport / api / auth / crypto（签名+AES）/ event-server / cards
│
└─ orchestrator/            传输无关的编排 + 持久化（./data 落盘）
    └─ src/
        ├─ logger.ts        统一 logger（INFO/WARN/ERROR 带时间戳）
        ├─ tasks/           任务模型 + SOP prompt（store / sop-prompt / types）
        ├─ presets/         任务模板（A1）
        ├─ memory/          跨任务长期记忆 + stage 记忆（store / stage-store / recall / types）
        ├─ approval/        审批工作流（manager.create/resolve/list，5min auto-timeout）
        ├─ ask/             AskUserQuestion 交互问答（manager / types；含多问题表单 form）
        ├─ planner/         A3 Planner：generatePlan(claude -p 分解目标) + 内存计划库（/plan 用）
        ├─ perf/            performance-platform 对接（P1 只读）：config/client(Basic auth)/query/store；perf-watcher 消费
        ├─ subagents/       subagent 注册表（registry / types）
        └─ knowledge/       shell 交互流自动提炼知识条目（extractor / heuristics / store / sanitize；缺 KNOWLEDGE_EXTRACT_ENABLED 不启用）

skills/multiagent-lark/SKILL.md    →  会 symlink/copy 到 ~/.claude/skills/
bin/agent                          →  CLI 入口（npx tsx packages/framework/src/control/cli.ts）
data/                              →  运行时持久化（memories / chats / approvals / templates / knowledge）
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
watcher tick (2s) → for each pending
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

### 4. 本地 claude 响应 → Stop hook → 飞书

`watcher` 拿不到 claude TUI 里的 assistant 响应文本（alt-screen 屏蔽）。补一条 Claude Code **Stop hook** 通道：

```
claude assistant 响应完成
   ↓ ~/.claude/settings.json hooks.Stop
bin/mchat-stop-hook   （Node ESM 脚本）
   ↓ stdin JSON 里 last_assistant_message
spawn detached: agent lark send-text --auto <text>
   ↓ IPC → daemon handleLarkSendText
若 chat.watchAllTabs === true  → sendTextMessage 推到飞书
否则                            → 静默 gated（返回 details.gated=true）
```

- hook 由 `apps/daemon/src/index.ts` 的 `installClaudeCodeStopHook()` 在 dev 启动时幂等 upsert 到 `~/.claude/settings.json`
- `--auto` flag 只由 hook 用；手工 `agent lark send-text` 不带 flag，任何时候都放行
- 飞书 `/watch on|off` 只改 `chat.watchAllTabs`，daemon 侧 gate；不需要给 tab 里的 claude 重发指令

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
→ **绝不能 `return { toast }`**：飞书收到回调的 toast 响应后，会把这张卡当作"已处理、无卡片更新"，**盖掉你另发的 `patchCard`** → 按钮标记不刷新（点了像没反应）。要 toast 就牺牲卡片刷新，二选一；本项目一律选卡片刷新（标记变化本身就是反馈）。

### 交互卡多次更新要 `update_multi: true`

会被用户**点击多次、每次 patch** 的交互卡（多选 toggle、多问题表单 form 向导），`config` 必须带 `update_multi: true`，否则第二次起 `patchCard` 在飞书端**视觉不生效**（API 返回 code 0 但卡不变）。服务端单向驱动的进度卡不受影响。另：回调 `value` 里的数字字段（index/q/i/to）用 `Number()` 强转再用——飞书可能回传字符串，直接当 number 会让 `Set.has(0)` 对 `["0"]` 失配。

### 多问题交互用 `agent lark ask form`（AskUserQuestion 的飞书替代）

要用户一次回答多个问题（每题单/多选、可带自由输入）→ 用 `agent lark ask form --spec-json '{"questions":[...]}'`，弹飞书表单卡。**不要用 `AskUserQuestion`**（shell 弹窗手机端看不见，且阻塞会话）。全固定选项渲染成一张卡铺完(A)，任一题 `allowText` 则渲染成向导式一次一题(B，带「💬 打字回答」回流）。single/multi 待答时用户直接打字（裸数字/逗号/选项原文）也能答，是卡片抽风时的解冻兜底。详见 `docs/features.md §14`。

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

### System Events 术语故障（forceEnter 静默失败）

`forceEnter` 靠 System Events 专有术语 `key code 36` 发真 Enter。当 System Events helper 被拖挂
（进程 T 态 / LaunchServices 注册损坏 / 术语字典加载失败，实测诱因：Mac 严重过载 + 长时间未重启），
`key code` 会在 **编译期** 就报语法错 → forceEnter 静默失败 → 飞书注入的命令停在命令行不回车。
→ `host-mac/terminal/probe.ts` 的 `probeSystemEvents()` 把 `key code 36` 塞进恒 false 分支：编译期
  照样解析术语（坏则捕获），运行时永不真按键。`im-lark/monitor/system-events-probe.ts` 每 2min 自检，
  仅在状态翻转时推飞书（正常→故障发 🚨 含修法；故障→正常发 ✅），持续故障每 30min 再提醒。
→ **修法就是重启 Mac**（解开 wedged helper）。重启后跑一次探针脚本确认 exit 0 即恢复。

### .env 不可提交

`LARK_APP_SECRET` 在 .env，gitignored。`.env.example` 模板可提交。任何 audit / agent / commit 行为都不要把 .env 内容写进任何地方。

### WS 长连接的"假活"

`@larksuiteoapi/node-sdk` 的 WSClient 偶尔会 silent 断开，HTTP 还通但 WS 死。
→ `im-lark/monitor/ws-watchdog.ts` monkey-patch `console.log` 截获 SDK 的 `[ws] reconnect` / `[ws] ws client ready`，跟踪 reconnect 计数。
→ `im-lark/monitor/health-check.ts` 先看 WS 状态（reconnect ≥3 且 90s 没 ready）触发自杀；再看 HTTP（失败 3 次自杀）。
→ 自杀 = `utimesSync` touch `apps/daemon/src/index.ts` 让 tsx watch reload + `process.exit(1)`。

### pending 的 char-length 而非 line-count

不要再回到 `arr.length` 判断变化——claude TUI 用 `\r` 重绘同行，行数不变但内容在变。一律用 `fullHist.length` (字符总数)。`beforeCharLen` 在 dispatch 时记录，`lastSeenCharLen` 在 watcher tick 更新，`taskOnlyTail = fullHist.slice(beforeCharLen)` 给 memory/notifier。

### sendFile / sendImage 返回 schema

SDK 返回 `{file_key}` 在 **TOP level**，不在 `.data` 下。`api.ts` 已修，新增任何 lark API 调用前先看现有代码。

### memory 写入用 taskOnlyTail

`persistTaskMemory` 用 `pending.cwd ?? tab.cwd ?? ''`（dispatch 时记录的优先）；`outputPreview = taskOnlyTail.slice(-500)`；`filesProduced = extractFilesFromOutput(taskOnlyTail)`。不要用 `outputTail` 否则会捞到 scrollback 里的 noise。

### Stop hook 脚本必须 ESM

`bin/mchat-stop-hook` 是无扩展名的 Node 脚本。monorepo root `package.json` 声明了 `"type": "module"`，Node 22+ 会把所有无扩展名 shebang 脚本按 ESM 加载 → **`require()` 会 ReferenceError 让 hook 静默 crash**（Claude Code 不会往 UI 报，只是 hook 不生效，非常难排查）。

→ 用 `import { ... }` from 'node:xxx'。要 debug 时设 `MCHAT_HOOK_DEBUG=1`，日志落 `/tmp/mchat-stop-hook.log`。

hook 内部必须 fire-and-forget spawn agent CLI（`detached: true` + `proc.unref()` + 立即 `process.exit(0)`），别 await —— 阻塞 Claude Code 的 Stop 流程会拖慢用户 UI。

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

1. 新增 lark API 调用 → 用 `im-lark/lark/api.ts` 的 `withRetry`，不要直接 `client.xxx.xxx`
2. 新增卡片 → `im-lark/lark/cards.ts` 集中放，按已有 template 配色：黄/红 = 需用户响应；蓝/绿 = 信息
3. 新增 watcher event → 在 `watcher.events.emit('xxx')` 之外，必须在 `im-lark/monitor/notifier.ts` 接听
4. 新增 CLI 命令 → 同时改 `framework/control/cli.ts`（client 侧）+ `framework/control/server.ts`（server 侧）+ `framework/control/protocol.ts`（共享 type）
5. 改了 `apps/daemon/src/index.ts` 或 watcher 启动逻辑 → 注意 tsx watch reload 是否能干净重启（旧的 setInterval 是否清理）
6. 新增跨传输的编排/持久化能力（不绑飞书）→ 放 `orchestrator/`，通过 `multiagent-orchestrator` 导出；飞书专属的才留 `im-lark/`
7. 加平台（如企微已在 `im-wecom/`）→ implement `framework/im` 的 `IMTransport`，daemon 里 attach，chatId 带平台前缀
8. **每次功能/修复/文档改动 → 在 `CHANGELOG.md` 顶部「未发布」区对应日期追加一条**（新增/修复/文档/改动）。这是硬约定，commit 前顺手补。

## 当前阶段（2026-07）

已完成：
- v3.x 基础链路 + TUI 适配 + memory + approval + WS watchdog
- monorepo 拆分（framework / host-mac / im-lark / im-wecom / orchestrator）—— 三层解耦，为多平台铺路
- 企微 transport（im-wecom，`IMTransport` 抽象，配 WECOM_* 才启用）
- Web Dashboard（apps/daemon/web-dashboard，配 WEB_DASHBOARD_TOKEN 启用）
- Knowledge Extraction（orchestrator/knowledge，shell 交互流自动提炼；KNOWLEDGE_EXTRACT_ENABLED=1 启用）
- System Events 术语故障自检告警（见上「关键约定」）

进行中 / 待办：
- A 路线 · 编排：A1 任务模板（/template + /run ✅）、A2 任务链（chains.ts ✅）、A3 Planner（v1·方案丙 ✅ `/plan`；甲多tab自动串/乙单tab SOP 待叠加）
- 图文入站（飞书✅ + 企微✅）；待补：先文后图配对、富文本(A) 真机验证
- performance-platform 对接：P1 只读监听 ✅（`orchestrator/perf` + perf-watcher，配 PERF_* 启用）；P2 认领开 tab 修（已含 lite 版）；P3 回写+校验闭环待 perf 侧加 CAS。设计见 docs/perf-integration.md
- v52 `restart-all-claude-tabs --except`（✅ 已做）

下一会话从 `agent tabs` 开始看现状，然后 `cat MEMORY.md` 看 memory 上下文。
