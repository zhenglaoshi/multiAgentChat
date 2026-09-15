# Architecture

## 一句话

multiAgentChat 是**本地运行的单用户桥**：飞书 IM 通过 WebSocket 长连接 ↔ 一个 Node daemon ↔ Mac Terminal.app 里的多个 Claude Code tab（通过 AppleScript 观测和控制）。核心增值是 **SOP 编排系统**——多 stage 工作流 + gate 审批 + failure loop + artifact handoff。

## Monorepo 布局

```
multiAgentChat/                       # workspace root
├── package.json                      # scripts: pnpm dev / typecheck
├── pnpm-workspace.yaml               # packages/*, apps/*
├── tsconfig.base.json                # 共享 compiler options
├── tsconfig.json                     # 顶层 project references
│
├── packages/
│   ├── orchestrator/                 # multiagent-orchestrator
│   │   └── src/
│   │       ├── logger.ts             # 全项目共享
│   │       ├── tasks/                # SOP 状态机 + 事件
│   │       ├── presets/              # 任务模板（/template save）
│   │       ├── memory/               # task + stage 双层 memory
│   │       ├── approval/             # 审批 manager + gateContext
│   │       ├── workspace/            # 工作目录（原在 host-mac，宿主无关）：paths /
│   │       │                         #   recent-cwds / bookmarks / dir-index / git /
│   │       │                         #   task-workspace / report-repos
│   │       └── subagents/            # ~/.claude/agents/ 读写
│   │
│   ├── host-api/                     # multiagent-host-api（宿主契约，纯类型 + 注册表）
│   │   └── src/
│   │       ├── types.ts              # TerminalTab / SendResult / 各操作出入参
│   │       ├── controller.ts         # HostController 接口 + HostCapabilities
│   │       ├── registry.ts           # setHost / getHost（进程级单例）
│   │       └── facade.ts             # 摊平成模块级函数，调用点零改动
│   │
│   ├── host-tmux/                    # multiagent-host-tmux（Linux / WSL2 宿主 → Windows 支持）
│   │   └── src/                      # tmux/pane/tabs/keys/lifecycle/procs/keep-awake/status/host
│   │                                 #   见 docs/windows-port.md
│   │
│   ├── host-mac/                     # multiagent-host-mac（HostController 的 macOS 实现）
│   │   └── src/
│   │       ├── terminal/             # AppleScript 控制 Terminal.app
│   │       │   ├── tabs.ts           # listTabs / send / forceEnter / newTab
│   │       │   ├── applescript.ts    # osascript runner
│   │       │   ├── status.ts         # tab 状态推断
│   │       │   └── types.ts
│   │       ├── screen-lock.ts        # ioreg 判锁屏
│   │       ├── lid-awake.ts          # pmset/launchctl 合盖不睡守护状态
│   │       └── host.ts               # macHost：把本包函数装配成 HostController
│   │
│   ├── im-lark/                      # multiagent-im-lark
│   │   └── src/
│   │       ├── lark/                 # 飞书 SDK 层
│   │       │   ├── client.ts         # WSClient 长连接启动
│   │       │   ├── api.ts            # withRetry(sendCard/patch/sendFile...)
│   │       │   ├── cards.ts          # 全部飞书卡片 schema
│   │       │   ├── commands.ts       # /run /template /task /subagent ...
│   │       │   ├── handlers.ts       # WS event handlers + dispatchSopExecute
│   │       │   ├── reply.ts / target.ts / task-render.ts
│   │       ├── monitor/              # 观测 + 通知（跟 lark 紧耦合）
│   │       │   ├── watcher.ts        # 3s tick 轮询
│   │       │   ├── notifier.ts       # taskEvents → 飞书卡 patch
│   │       │   ├── pending.ts        # 任务追踪
│   │       │   ├── chains.ts         # A2 链式
│   │       │   ├── health-check.ts   # 30s 检 lark endpoint
│   │       │   └── ws-watchdog.ts    # WS 假活自杀
│   │       ├── chats/                # 飞书 chat 状态（activeTty, watchAll）
│   │       └── config.ts             # LARK_APP_ID / SECRET
│   │
│   └── framework/                    # multiagent-framework
│       └── src/
│           └── control/              # Unix socket + agent CLI
│               ├── server.ts         # 所有 op dispatcher
│               ├── cli.ts            # `agent` 二进制入口
│               └── protocol.ts       # Op + Data 类型
│
└── apps/
    └── daemon/                       # multiagent-daemon（可执行）
        └── src/index.ts              # 装配层，wire 所有 package
```

## 依赖 DAG（严格单向）

```
daemon ──→ framework ──→ im-lark ──→ host-api ──→ orchestrator
                       ↘          ↘           ↗
                        ──────────→ orchestrator
                       ↘
                        ──→ host-mac / host-tmux（**只有** host-bootstrap.ts 的动态 import，按平台二选一）
```

- `orchestrator` 是叶子层：纯逻辑，无 IM / host 依赖
- `host-api` 只有**契约**（接口 + 类型 + 注册表），不含任何实现、不 spawn 任何进程；依赖 orchestrator 仅为取 `AgentKind`
- `host-mac` 依赖 host-api（implement）+ orchestrator（logger / AgentAdapter）
- `im-lark` 只依赖 host-api + orchestrator，**已完全不依赖 host-mac**；`daemon` 同样不再直接依赖它（宿主实现只经 framework 的 bootstrap 进来）
- `framework` 依赖 host-api；对 host-mac 的依赖**收口在 `host-bootstrap.ts` 一个文件**（按平台动态 import 具体实现）
- `im-wecom`（企微 transport，可选）依赖 framework + orchestrator
- `daemon` 是唯一装配层，wire 全部（含可选 im-wecom）；启动第一件事是 `ensureHostRegistered()`

TypeScript project references 强制这个方向；跨包 relative import 会编译错。

## 数据流：入站（飞书 → tab）

```
飞书云 WS
   ↓
lark/client.ts (SDK WSClient)
   ↓
lark/handlers.im.message.receive_v1
   ↓ parseMessage() → { targeted, fallback, chain }
   ↓
handleCommand (/run /template /task /subagent ...) or
sendToNamedTarget (@target) or
sendToActiveTab (fallback)
   ↓
dispatchSendToTab(tab, text) 或 dispatchSopExecute(sop-action)
   ↓
- 注入 SYSTEM_GUIDANCE（6h throttle）
- 注入 memory recall（cwd + keyword scored）
- 用 SOP 时：包 SOP wrapper prompt（含 stage 序 + gen-submit 指令）
   ↓
host-mac/terminal.send() → AppleScript "do script"
   ↓
claude TUI（alt-screen）接收字符 → 等 400ms → forceEnter()（默认 pty 直写：空 do script 单独写一个 \r）
```

**关键坑**：`do script X` 往 pty 写的是 `X + "\r"` 一整块，TUI 当粘贴处理、块内 `\r` 只算换行，所以文本送进去不提交；
再单独送一个 `\r`（空 `do script ""`）才是真回车。这条路不依赖键盘焦点，合盖锁屏也能提交。
`MCHAT_ENTER_MODE=keystroke` 可退回 System Events key code 36 键盘事件路径（需前台焦点 + Accessibility）。

## 数据流：出站（tab → 飞书）

```
Terminal.app tabs（每 3s AppleScript 轮询）
   ↓
monitor/watcher.tick()
   ↓
pendingTracker（tty → { beforeCharLen, taskDescription, progressMessageId, ... }）
   ↓
比对 lastSeenCharLen vs current → 检测增长
   ↓ (chars 而非 lines —— claude TUI 用 \r 重绘同一行)
events.emit('taskOutput' / 'localTaskDetected' / 'needsInput' / 'resolved')
   ↓
monitor/notifier 接：
- taskOutput → patchCard(progressMessageId, progressCard)
- localTaskDetected → sendCardMessage(watchAllTabs chats)（如 /watch on）
- isFinal → persistTaskMemory + delete from pending

也订阅：
- orchestrator.taskEvents (stage:start/end/retry/gate:wait/skip, task:done/failed/aborted)
  → patch stageProgressCard(task.progressMessageId)
- orchestrator.approvals.events (created/resolved)
  → sendCardMessage 或 patch approvalCard / stageGateCard（若有 gateContext）
```

## SOP 状态机

存储：`data/tasks/<id>.json`

```
task {
  taskId
  tty, cwd, chatId
  stages: string[]        // subagent_type 序
  gates: string[]         // ['after-architect', ...]
  loops: TaskLoopRule[]   // 失败回环规则
  currentStageIdx
  stageHistory: StageRecord[]
  stageRetries: { stageName: count }
  status: running | awaiting-gate | done | failed
  progressMessageId       // 飞书卡的 messageId，用于 patch
}
```

事件（TypedEmitter `taskEvents`）：
- `task:start / done / failed / aborted`
- `stage:start / end / retry / skipped`
- `gate:wait / resolve`

单向：只有 `tasks/store` 里的 `markXxx()` 系列函数 emit 事件；订阅方（notifier）只读不改。

## 智能分派（smart-dispatch）

`/run --sop` 无 `@target` 时的决策：

```
loadChat(chatId) → activeTty
listTabs() → tabsPre
getUserFocus() → { terminalFrontmost, tty of selected tab of front window }

如果同时满足：
  chat.activeTty 存在 &&
  activeTty 是 Terminal 的 frontmost tab &&
  activeTty 有 claude TUI (hasTUI)
→ attach 到 activeTty
否则：
→ newTab({ mode: 'new-tab-background', cwd: activeTty.cwd })
   → Terminal activate 后立刻切回 prevApp（~200ms 闪一下）
   → send 'claude' → 等 8s 冷启
   → dispatchSendToTab 派 SOP wrapper
```

## Subagent 集成

- **Registry**：orchestrator/subagents 读 `~/.claude/agents/*.md` (user) + `<projectRoot>/.claude/agents/*.md` (project)
- **YAML frontmatter parser**：极简，支持 `key: value` 单行 + `key: |` 块标量
- **生成**：`/subagent gen <desc>` → 派任务给 active tab → 主 claude 出 JSON → `agent subagent gen-submit` 交回 → framework 验证 + 写 .md + 推消息
- **迭代**：`/subagent tweak <name> <feedback>` → 派任务（含现有 JSON）→ overwrite 落盘
- **Claude Code 缓存**：session 启动时快照 agent 列表。加/改 subagent 后需**新 session** 才认。smart-dispatch 的 spawn 分支自动保证新 tab session 是 fresh 的

## Agent CLI（Unix socket protocol）

- `packages/framework/src/control/server.ts` 监听 `~/.multiagent-chat/agent.sock`
- 二进制 `bin/agent` → `packages/framework/src/control/cli.ts`
- 每条命令一次连接、一次 request、一次 response（除了 gate/approval 阻塞 op）
- 所有 op 类型化在 `protocol.ts`

## 持久化

```
~/.multiagent-chat/                   # 全局
├── agent.sock                        # Unix socket
├── cli-state.json                    # CLI 默认 tty
└── presets/*.json                    # 任务模板

<repo>/data/                          # 项目运行时（gitignored）
├── chats/<chatId>.json               # 飞书会话状态
├── memories/*.json                   # task memory
├── stage-memories/*.json             # stage memory
├── tasks/*.json                      # SOP 任务
├── approvals/*.json                  # 审批（含 gateContext）
└── recent-cwds.json
```

## 扩展点

- **新 IM**：新建 `packages/im-<name>/`，实现 SDK/client + api（sendCard/patch/sendFile）+ handlers（消息接入）+ cards。目前 im-lark 是"参考实现"，抽象接口尚未提炼（P2 会做）
- **新 host**：新建 `packages/host-<name>/`，implement `multiagent-host-api` 的 `HostController`（照 `host-mac/src/host.ts` 的装配写法），再在 `framework/src/host-bootstrap.ts` 加一条平台分支 —— **业务代码一行不用改**。宿主没有的能力在 `capabilities` 里如实标 false，对应探针会自动跳过（授权探针 / System Events 探针 / 合盖守护探针）。
  ✅ **已有第二个实现：`packages/host-tmux/`**（Linux / WSL2 → Windows 支持，见 [windows-setup.md](windows-setup.md)）。
  当初判断"Windows 的难点不在接口而在模型"（Terminal.app 那套「从外部附身用户已开的 tab」在 Windows 上没有等价能力）——
  结论是**绕开这个模型**：不用 ConPTY 让 daemon 自己托管 pty（daemon 会自杀重启，那样每次重启都会杀光所有 agent 会话），
  而是让 **tmux server** 持有 pane，daemon 只通过 tmux CLI 操作它 —— 等价于现在 Terminal.app 的性质，重启无感。
  `/watch` 的「本地手敲也能看到」那条数据流因此也不用重做（`capture-pane` 照样读得到）。
  ⚠ 该实现**尚未真机验证**，待验清单见 [windows-port.md](windows-port.md) §6。
- **新 subagent**：直接写 `.md` 到 `~/.claude/agents/`，或用 `/subagent gen`（推荐）
- **新命令**：飞书 → `im-lark/lark/commands.ts` 加 handler；CLI → `framework/control/cli.ts` 加 case + protocol op

## 已知设计缺陷（诚实）

0. **`dir-index` 的扫描仍是 POSIX 专有**：`orchestrator/workspace/dir-index.ts` 用 `find … -prune` 扫全机 git 仓库（这套参数是性能关键，见该文件注释：分钟级 → 秒级）。Windows 上没有等价命令，目前 `scanSupportedOnThisPlatform()` 直接返回空索引 —— 加 Windows 宿主时要么换 Node 侧递归扫（得重做那次性能调优），要么把「扫目录」提升成宿主能力挂进 `HostController`。
1. **im-lark 和 monitor 深度耦合**：monitor/notifier 直接调 lark/api + cards + task-render；理论上应该走 IMTransport 接口抽象。P2 拆
2. **AppleScript 权限依赖**：首次装用户要手动加 Accessibility 权限。目前只在 README 提醒
3. **单进程 daemon**：dev/prod 都是一个 Node 进程，挂了就都挂
4. **claude session cache**：Claude Code 在 session 启动时快照 agent list，加 subagent 后要新 session 才认。已通过 smart-dispatch spawn 缓解，但不是根治
5. **无 test suite**：目前全靠手动烟测（大量在开发中跑过）

## 参考

- SOP 详细用法：[docs/sop.md](sop.md)
- 贡献指南：[../CONTRIBUTING.md](../CONTRIBUTING.md)
- 命令速查：[../README.md](../README.md)
