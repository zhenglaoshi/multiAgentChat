# multiAgentChat

> 本地多 claude 终端 ⇄ 飞书 IM 的桥，从手机/远程异步调度自己 Mac 上多个 Claude Code tab 完成并发任务

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-beta-yellow.svg)](#当前状态)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](#平台)

## 这是什么

multiAgentChat 是一个**本地运行、单用户使用**的桥：

- 你在 Mac 上正常用 Terminal.app + Claude Code，每个 tab 一个 claude session
- 跑 `npm run dev` 起本地 daemon
- 在飞书机器人对话框里发命令：
  - `@ttys001 跑测试` → 命令送到 ttys001 这个 tab 的 claude
  - `/dashboard` → 看 Mac 上所有 tab 的实时状态
  - `/run --sop 实现 ping 命令` → 起一个多 stage SOP 任务（架构 → 编码 → 测试），关键节点给手机推审批卡
- Claude 的输出实时推送回飞书（含 alt-screen TUI 模式下不可见的内容）

### 跟其它工具的区别

| 维度 | multiAgentChat | cc-connect | Anthropic Remote Control |
|---|---|---|---|
| 工作模式 | **Terminal-first**：观察你已开的 claude tab | Messaging-first：spawn 子进程跑 claude | 1:1 直连本地 claude |
| 多 agent | ✅ 多 tab 真并行 + cwd 路由 | ✅ session 模型 | ❌ 单 session |
| 编排 / SOP | ✅ 多 stage / gate / artifact / failure loop | ❌ | ❌ |
| 平台 | 飞书（计划：企业微信） | 13 个 IM | Claude 官方 app |
| Host | macOS Terminal.app | spawn 进程 | 本地 claude |

定位：**远程异步多 agent 编排**——你不在 Mac 前时，看着、调度、审批、回滚。

---

## 当前状态

**Beta**。已能日常使用，但接口随时会变。

- ✅ 飞书入站（命令 + @target + chain + batch）
- ✅ AppleScript 控制 Terminal.app（含 claude TUI forceEnter 适配）
- ✅ 实时进度卡 patch + dashboard
- ✅ 审批流（含 SOP gate + design.md 预览）
- ✅ SOP 任务编排（task / stage / gate / 失败回环 / artifact handoff）
- ✅ Memory + recall（task 级 + stage 级）
- ✅ Unix socket CLI（任何 shell 可调）
- ✅ WS 长连接 watchdog（自杀重启）
- 🚧 monorepo 拆包（计划中）
- 🚧 第二平台（企业微信，计划中）

---

## 平台

- **运行平台**：macOS（依赖 AppleScript / Terminal.app）
- **IM 平台**：飞书 / Lark（计划接入企业微信）
- **Node**：≥ 20
- **Claude Code**：建议最新版

---

## 快速上手（5 分钟）

### 1. 安装

```bash
git clone <repo-url> multiAgentChat
cd multiAgentChat
npm install
```

### 2. 配 .env

```bash
cp .env.example .env
# 编辑 .env 填：
#   LARK_APP_ID=cli_xxx
#   LARK_APP_SECRET=xxx
```

申请飞书自建机器人：[飞书开放平台](https://open.feishu.cn/) → 创建应用 → 机器人 → 启用 → 配置 WebSocket 长连接。

### 3. 装 skill 让 claude 知道用 agent CLI

```bash
node -e "import('./bin/agent.js').then(() => {})" # bootstrap
./bin/agent install-skill
```

把 `multiagent-lark` skill 装到 `~/.claude/skills/`，所有 Mac 上的 Claude Code session 启动时会自动加载，知道用 `agent lark send-text` 推送结果回飞书。

### 4. 起服务

```bash
npm run dev
```

`tsx watch` 模式：代码改了自动 reload。生产用 `npm start`。

### 5. macOS 权限

打开 **System Settings → Privacy & Security → Accessibility**，把以下加进去：
- Terminal.app（或你常用的终端）
- iTerm.app（如果用）
- 跑 dev 服务的进程
- `osascript`

否则 AppleScript 控制不了 Terminal。

### 6. 第一条命令

在飞书机器人里：

```
/dashboard
```

应该看到 Mac 上所有 Terminal tab 的状态。

```
@ttys001 跑 npm test
```

会把 "跑 npm test" 派到 ttys001 这个 tab 的 claude，claude 跑完结果推回飞书。

---

## 命令速查

### 飞书命令

| 命令 | 作用 |
|---|---|
| `@<target> <text>` | 派发到指定 tab（target 支持 ttys001 / cwd basename / title） |
| `@a X >> @b Y` | 链式：先派 a，完成后派 b |
| `/dashboard` 或 `/d` | Mac tab + 任务全局状态卡 |
| `/shells` 或 `/s` | tab 列表卡，按钮可切 active |
| `/use <tty>` | 把这个 chat 的 active tab 设为指定 tty |
| `/new [path]` | 在 Mac 上开新 tab |
| `/watch on` 或 `/watch off` | 是否实时推送非飞书发起的 shell 活动 |
| `/template` | 列任务模板 |
| `/template save <name> [--stages a,b] [--gates after-a] <prompt>` | 保存模板 |
| `/run <name> [k=v]` | 跑模板 |
| `/run --sop [--stages a,b] [@target] <prompt>` | 临时 SOP（无模板） |
| `/run plan topic=...` | 跑内置 /plan 模板（轻量 explore + architect） |
| `/task` 或 `/task <id>` | 看 SOP 任务列表 / 详情 |
| `/approvals` | 待审批 + 历史 |
| `/recall <keyword>` | 查 task memory |
| `/history` | 看最近完成的任务 |
| `/help` | 完整列表 |

### Mac shell CLI（`agent` 命令）

任何 Mac shell 里都能用（包括 claude 自己调）：

```bash
agent tabs                      # 看所有 Mac Terminal tab
agent send -t /dev/ttys001 "..." # 发文本到指定 tab
agent show -t /dev/ttys001 -n 60 # 看 tab 历史 tail
agent open ~/code/foo            # 开新 tab cd 到 foo
agent lark send-text "..."       # 推文本到飞书（自动找当前 tab 对应 chat）
agent lark send-file <path>      # 推文件
agent lark send-image <path>     # 推图片
agent request-approval --title T --body B  # 等飞书审批（阻塞）
agent task list                   # 看 SOP 任务
agent task show <task-id>
agent task stage --task-id X --name <stage> --start/--end/--fail
agent stage-recall [--name X] [--cwd Y] [kw1 kw2 ...]
agent install-skill / uninstall-skill
agent help                        # 完整命令清单
```

---

## 架构

```
                  飞书云 (WS)
                       ↕
             ┌─────────────────────┐
             │  Node daemon (tsx)  │
             │                     │
             │  lark/  ←→  monitor/│
             │     ↓        ↑      │
             │  terminal/ (AppleScript)
             │     ↕               │
             │  Terminal.app (your tabs)
             │                     │
             │  control/ (Unix socket)
             │     ↑               │
             └─────│───────────────┘
                   │
            [agent CLI in any shell]
                   ↕
            [data/ JSON persistence]
```

详细架构（含 SOP 状态机、依赖方向、迁移路径）：[docs/architecture.md](docs/tasks/task-mr198nfa-4u7k/design.md)

数据流：
- 飞书消息 → `lark/handlers` → 路由到 tab via `terminal/tabs.send` + AppleScript
- claude 输出 → `monitor/watcher` (3s tick) → `notifier` → 飞书卡 patch
- SOP 任务 → `tasks/store` 状态机 → 飞书 stageProgressCard 实时更新

---

## 数据存放

```
~/.multiagent-chat/
  ├─ agent.sock         # Unix socket (server)
  ├─ cli-state.json     # CLI 默认 tab
  └─ presets/           # 任务模板

./data/                  # 项目内
  ├─ chats/<id>.json     # 飞书会话状态
  ├─ memories/<id>.json  # task-level memory
  ├─ stage-memories/<id>.json  # stage-level memory
  ├─ tasks/<id>.json     # SOP 任务状态机
  └─ approvals/<id>.json # 审批记录
```

---

## 开发

```bash
npm run dev        # tsx watch + 自动 reload
npm run typecheck  # tsc --noEmit
npm run build      # tsc → dist/
npm start          # 跑 build 后的版本
```

文件改了之后 `tsx watch` 自动重启，但 `.env` 改了要 kill + 重启。

---

## SOP（Standard Operating Procedure）— 重头戏

SOP 是 multiAgentChat 的核心差异化能力：把"丢个 prompt 让 claude 自由发挥"升级成"声明式多 stage 工作流 + 关键节点人工审批 + 失败自动回环"。

**最小例子**：

```
/run --sop 实现 ping 命令
```

默认走 6 stage（Explore → requirement-analyzer → architect → coder → tester → regression-checker），架构 stage 完成时停下来推审批卡给你（含 design.md 前 40 行预览），你批准后继续。

**自定义 stage**：

```
/run --sop --stages explore,architect --gates after-architect 帮我分析 X
```

或者保存模板：

```
/template save plan --stages explore,architect --gates after-architect 帮我分析 {topic}
/run plan topic="X 的可行性"
```

详见 [docs/sop.md](docs/) （TODO: 单独文档）

---

## Roadmap

- [ ] Phase 1: monorepo 拆包（pnpm workspaces）
- [ ] Phase 2: orchestrator 包独立（纯逻辑层）
- [ ] Phase 3: bridge / IM transport / host controller 接口抽象
- [ ] Phase 4: 企业微信 transport 验证抽象
- [ ] Phase 5: 调度 / DAG 编排 / token usage tracking

完整规划见 [docs/tasks/task-mr198nfa-4u7k/design.md](docs/tasks/task-mr198nfa-4u7k/design.md)

---

## License

MIT License — 见 [LICENSE](LICENSE)
