# multiAgentChat

> 本地跑的桥：**飞书 / 企业微信 ⇄ Mac Terminal.app** —— 从手机远程异步调度自己 Mac 上多个 Claude Code tab 完成并发任务。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-beta-yellow.svg)](#当前状态)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey.svg)](#平台)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](#平台)
[![IM](https://img.shields.io/badge/im-Lark%20%2B%20WeCom-blue.svg)](#im-平台支持)

---

## 一句话

出门在外 / 在会议室 / 躺床上，手机飞书或企微给你的 Mac 发命令，Mac 上 N 个 Claude Code tab 并行干活，结果实时推回你手机。

## 优势 · 为什么用这个

| 你想要的 | multiAgentChat 提供 |
|---|---|
| **不换端** | 复用你已在用的 IM（飞书 / 企微）+ Terminal.app + Claude Code —— 零学习曲线 |
| **完全本地** | 单 daemon 本地跑，你的数据不出你 Mac；无云服务、无中转、无订阅费 |
| **多 tab 并行** | 一个 Mac 上开 N 个 Claude tab（各自 cwd/context/session），飞书里 `@target` 精准路由；`>>` 链式；多行 batch |
| **异步不阻塞** | 派完任务合上 MacBook 走人（合盖防睡设好），任务完成推回飞书 |
| **手机友好交互** | `agent lark ask` 弹交互卡片（radio/checkbox/input），用户手指点选/回复，AI 从 stdout 拿答案 —— 不用手打 |
| **可编排** | 声明式 SOP：多 stage / gate（人工审批）/ 失败回环 / artifact 传递 —— 复杂任务不失控 |
| **双 IM 并行** | 飞书 + 企微同时挂着，各自独立 chat state 互不干扰；接第 3 个 IM 靠 IMTransport 抽象接口 |

**跟其它远控方案的差异**：
| 维度 | multiAgentChat | cc-connect | Anthropic Remote Control | VNC / SSH |
|---|---|---|---|---|
| 工作模式 | Terminal-first：观察你已开的 Claude tab | Messaging-first：spawn 子进程 | 1:1 直连本地 claude | 全桌面远控 |
| 多 agent | ✅ 多 tab 真并行 + cwd 路由 | ✅ session 模型 | ❌ 单 session | 靠人手切 |
| SOP 编排 | ✅ 多 stage / gate / artifact / loop | ❌ | ❌ | ❌ |
| 手机 UX | 自然语言 + 卡片点选，AI 帮你干 | 手打命令 | 手打 | 戳小按钮累 |
| 本地部署 | ✅ 数据不出 Mac | ✅ | ✅ | ✅ |
| IM 平台 | 飞书 P0 · 企微 P0 beta（99% 对齐） | 13 个 IM | 官方 app | — |

---

## IM 平台支持

| IM | 状态 | 说明 |
|---|---|---|
| **飞书 / Lark** | ✅ P0 stable | 参考实现；所有能力最先在这里落地 |
| **企业微信 (WeCom)** | ✅ P0 beta（99% 对齐） | 基本能力全在（`@target` 派发 / sticky 对话 / ask / approval / /screen /keys / Stop hook / doctor / 群聊 target）；差在：SOP stageProgressCard 企微版 render / 进度卡实时 patch（企微 template_card body update 不支持） |
| 钉钉 / Slack / Telegram | 🚧 roadmap | IMTransport 抽象层已就位，接第 3 个 IM 现在只是"照葫芦画瓢"|

**双 IM 可以同时挂**，各自独立 chat state，互不干扰。

## 当前状态

**Beta** — 已能日常使用，但接口可能会变。

- ✅ 飞书入站（命令 + `@target` + `>>` chain + 多行 batch）
- ✅ 企业微信入站（同上 · 走 cloudflared tunnel 打通 webhook）
- ✅ AppleScript 控制 Terminal.app（Claude Code TUI 回车走 pty 直写：锁屏 / 弹框 / 别的 app 在前台都能提交）
- ✅ 笔记本「插电合盖也能远程」守护（`sudo scripts/lid-awake.sh install`，拔电自动恢复睡眠；首次安装顺带装 + 没装时飞书提醒）
- ✅ 实时进度卡 patch + 长任务自适应节流 3.5s→60s + `/quiet` 静默模式 + 单卡 🔇 按钮
- ✅ `agent lark ask` / `agent wecom ask`（single/multi/input 三种交互卡）
- ✅ SOP 任务编排（stage / gate 审批 / 失败回环 / artifact handoff / memory 召回）
- ✅ 高风险审批工作流（`agent request-approval`）
- ✅ `/screen` 抓 alt-screen 截图 · `/keys` 按键遥控 · `//foo` 显式转发
- ✅ Stop hook 双 IM 通吃（Claude turn 完成自动推给源 chat）
- ✅ 首次启动自动化 5 项（Node ≥22 assert · .env 自动 cp · skill/hooks upsert · agent CLI symlink · macOS 权限提示）
- ✅ 高危命令审批 gate：5 档权限等级（`/perm-level` L0~L4，默认 L1 仅致命）+ 学习放行（连续批准同一命令 N 次后自动放行）
- ✅ 明文凭证脱敏（回显 + 落盘）+ `/raw on/off` 临时明文模式
- ✅ TAPD 缺陷/需求自动监听 → 认领/轻量提示卡分级（不再每次改动都打扰）
- ✅ 任务工作目录隔离（`fix_/feature_<id6>` git worktree，`/worktasks` 可搜可打开）
- ✅ 多 agent · Codex CLI 对接（`AgentAdapter` 抽象，`@target` 派发同样能打到 codex tab）
- ✅ Dogfood 自审（`/selfaudit`：`claude -p` 定期审自己 CHANGELOG↔docs↔日志有没有出入）
- ✅ Fleet 主动监控（卡住哨兵 · 闲置提议 · 每早摘要，主动推飞书不用你问）
- ✅ 出站飞书消息统一加「🕐 时间 + 📁 路径」页脚

---

## 平台

- **运行平台**：macOS 13+（依赖 AppleScript / Terminal.app）
- **Node**：≥ 22（daemon 启动会 assert）
- **Claude Code**：最新版
- **IM**：飞书 P0 / 企微 P0 beta（选一或都装）

---

## 快速上手（3 步）

### Step 1 · 装依赖
```bash
brew install node pnpm anthropic/tap/claude-code

git clone <this-repo> multiAgentChat && cd multiAgentChat
pnpm install
```

### Step 2 · 拿 IM 凭证 + 填 .env
```bash
pnpm dev   # 首次跑 .env 缺失会自动 cp .env.example 并 die + 提示
```

编辑生成的 `.env`，填**至少一组** IM 凭证（**飞书 + 企微二选一或都填**）：

<details>
<summary>飞书凭证（推荐入门）</summary>

到 [飞书开放平台](https://open.feishu.cn/) 创建自建应用 → 拿 App ID + App Secret → 「事件与回调」订阅方式改「长连接」，权限加 `im:message` 等。详见 [docs/installation.md](docs/installation.md) 第 2 步。

```env
LARK_APP_ID=cli_xxxxxxxxxxxxxxxx
LARK_APP_SECRET=xxxxxxxxxxxxxxxx
```
</details>

<details>
<summary>企业微信凭证（需要内网穿透）</summary>

企微是 webhook 模式，需要 `cloudflared tunnel` 或类似把内网 :3939 暴露公网。详见 [docs/wecom-bot-setup.md](docs/wecom-bot-setup.md) 完整 11 步指南。

```env
WECOM_CORP_ID=wwxxxxxxxxxxxxxxxx
WECOM_AGENT_ID=1000002
WECOM_SECRET=xxxxxxxxxxxxxxxx
WECOM_TOKEN=xxxxxxxxxxxxxxxx
WECOM_AES_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
WECOM_CALLBACK_HTTP_PORT=3939
WECOM_DEFAULT_TO_USER=@all
```
</details>

### Step 3 · 跑 dev
```bash
pnpm dev
```

daemon 启动时**自动**：
- ✅ Node 版本 assert
- ✅ 装 `multiagent-lark` skill 到 `~/.claude/skills/`
- ✅ 装 Claude Code Stop / PreToolUse hooks
- ✅ Symlink `bin/agent` 到 `~/.local/bin/agent`（记得 `~/.local/bin` 加 PATH）
- ✅ 起 caffeinate 阻止 idle sleep
- ✅ 打印 macOS 三项权限提示（Accessibility / Screen Recording / Automation）

期望看到：
```
[INFO] node version ok { version: '22.x' }
[INFO] lark bot started (WS long-connection)     ← 飞书就绪
[INFO] wecom transport attached { corpId, ... }   ← 企微就绪（若配了）
[INFO] control server listening
[INFO] tab watcher started
```

### Step 4 · 验证 + 发第一条消息

```bash
agent doctor   # 12 项健康检查
```

在飞书或企微里给机器人发：
```
/dashboard         # 概览 Mac 所有 tab
@ttys001 ls -la    # 派命令到 ttys001 那个 tab（先 agent tabs 看你有哪些）
```

---

## 核心功能 20 秒概览

### 💬 双向桥
- 飞书 / 企微 消息 → Mac Terminal tab（AppleScript 控制）
- Claude 的响应实时推回 IM（含 alt-screen TUI 模式下不可见的内容）
- 双渠道并行：pc shell 里 claude 完整答，同时 `agent lark send-text` 推同样一份到 IM

### 🎯 多 tab 并行
- 一个 Mac N 个 Terminal tab，各自独立 claude session + cwd + context
- IM 里 `@target text` 精准派发（target = tty / cwd 目录名 / 标题）
- `@a X >> @b Y` 链式；多行 `@a X\n@b Y` 批量并发
- **Sticky 对话**：首次 `@ttys003` 后 5min 内裸文本自动路由到该 tab

### 🧭 智能交互（不用手打命令）
```bash
# claude session 里
answer=$(agent lark ask single --title "选一个方案" --options "A. 快,B. 稳,C. 稳稳")
# → 手机弹交互卡，你手指点 → stdout 拿到 {"status":"answered","index":1,"value":"B. 稳"}
```
- `single`（radio）· `multi`（checkbox）· `input`（用户回文本）
- 企微上 multi 走"回复数字勾选"模式（如 "1,3,5"）
- **完全替代 AskUserQuestion**，避免用户手机端看不见 TUI 选项框

### 🎬 长任务降噪三层
1. **默认**：Adaptive backoff（前 30s 3.5s，之后 15s → 30s → 60s 随时长）
2. **/quiet on/off**：全局静默模式，只发首次 + 完成，中间不刷卡
3. **单卡 🔇 按钮**：只静默某一个吵的 pending

### 📸 兜底通道（非 claude TUI）
- `/screen` → 抓 tab 所在窗口截图（含 alt-screen TUI）推图到 IM
- `/keys '2d . ⏎'` → 通用按键遥控（osascript System Events）
- `//foo` → 强制转发到 activeTty（对付 skill / 插件命令）

### 🧬 SOP 编排（差异化能力）
声明式多 stage 工作流 + gate 审批 + 失败回环 + artifact 传递：
```
/run --sop 实现登录功能
# 默认 6 stage：Explore → requirement-analyzer → architect → coder → tester → regression-checker
# architect stage 结束时推审批卡（含 design.md 前 40 行预览），批准后继续
```

### 🛑 高风险审批
```bash
agent request-approval --title "DROP TABLE prod.users" --body "..."
# 阻塞，飞书弹卡片；批准 → exit 0，拒绝 → exit 1，5min 超时 → exit 2
```
- 除了显式调用，**任何 tab 里跑高危 Bash 命令都会被自动拦下**（PreToolUse gate）弹飞书审批卡
- 5 档权限等级（`/perm-level`，默认 **L1 仅致命**）自选拦截松紧：L0 全自动 → L4 每条都问；同一命令连续批准 N 次后**自动放行**（`/perm-reset` 清空放行记录）

### 🤖 Subagent 系统
- Claude Code 内置 subagent 直接可用（Explore / Plan / 等）
- 自定义：`~/.claude/agents/*.md` 或项目本地
- LLM 自动生成：`/subagent gen 视频剪辑：ffmpeg + 字幕 + 缩略图`

### 💾 双层 Memory + 自动 recall
- Task 级：任务完成时落盘 prompt / output / files
- Stage 级：SOP 每 stage 完成时落盘
- 派新任务时自动检索并注入到 prompt（cwd 精确匹配 + 关键词 + 时间衰减）

### 📱 Web Dashboard（手机浏览器直控 Mac）
- daemon 内嵌 HTTP :3940，Bearer token 鉴权
- 手机浏览器一屏见所有 tab + 抓屏（自动降采样 17.5MB→300KB）+ 命令 + Live 3s 自动刷新
- 飞书发 `/wd` 一键拿多路径 URL（公网 cloudflared / LAN / mDNS / localhost）
- 详见 [docs/web-dashboard.md](docs/web-dashboard.md)

### 🧠 Knowledge Extraction · 自动个人知识库（Phase 1）
每次 tab 任务完成 → 脱敏 + 启发式过滤 + spawn `claude -p` 提炼成结构化知识条目（5 类：problem-solved / howto / decision / gotcha / reference）。跨项目复用经验，避免重复踩坑。
```bash
KNOWLEDGE_EXTRACT_ENABLED=1              # .env
agent knowledge stats/list/show/extract-last
```
详见 [docs/knowledge.md](docs/knowledge.md)。

---

## 命令速查

**IM 侧**（飞书 / 企微通吃）：

| 分类 | 命令 |
|---|---|
| 概览 | `/d /dashboard` `/s /shells` `/w /where` |
| Tab | `/n /new [path\|@alias\|kw]` `/u /use <tty>` `/h /history` `/pin` `/dirindex refresh` |
| 编排 | `/t /template` `/run [--sop] ...` `/task` `/tk` `/c /chain` `/sa /subagent` `/plan` |
| 交互 | `/screen` `/keys '<seq>'` `//foo`（强制转发） |
| 观测 | `/a /approvals` `/audit` `/r /recall` `/watch on/off` `/quiet on/off` `/raw on/off` |
| 权限/审批 | `/perm-level [0-4]` `/perm-reset` |
| 对接 | `/connect` `/tapd` `/worktasks /wt` `/webdash /wd` |
| 运维/报告 | `/reload`（重启 daemon） `/selfaudit /dogfood`（自审） `/report day\|week\|month\|year` |
| 派发 | `@target text` · `@a X >> @b Y` · 多行批量 |

**shell 侧**（`agent` CLI，Claude tab / 你自己都能用）：
```bash
agent tabs / show / send / open / close    # tab 管理
agent lark  send-text/-file/-image/-card/which-chat/ask   # 飞书外发
agent wecom send-text/-file/-image/ask/which-chat         # 企微外发
agent request-approval --title T --body B                 # 阻塞式审批
agent task list/here/show/stage/abort                      # SOP 任务
agent subagent list/show/add/delete/gen-submit             # subagent 管理
agent stage-recall [--name X] [kw ...]                     # 历史召回
agent doctor                                                # 健康检查
```

完整清单：[docs/commands.md](docs/commands.md) · 飞书 slash 菜单配置：[docs/feishu-bot-setup.md](docs/feishu-bot-setup.md)

---

## 📖 文档索引

| 你的角色 | 文档 |
|---|---|
| 首次访问 | 本 README |
| 完整安装 | [docs/installation.md](docs/installation.md) |
| 飞书应用配置 | [docs/feishu-bot-setup.md](docs/feishu-bot-setup.md) |
| **企微应用配置**（含 cloudflared tunnel）| [docs/wecom-bot-setup.md](docs/wecom-bot-setup.md) |
| 完整功能清单 | [docs/features.md](docs/features.md) |
| 命令速查 | [docs/commands.md](docs/commands.md) |
| SOP 编排 | [docs/sop.md](docs/sop.md) |
| **Web dashboard 手机直控** | [docs/web-dashboard.md](docs/web-dashboard.md) |
| **Knowledge 自动知识库** | [docs/knowledge.md](docs/knowledge.md) |
| 排错 | [docs/troubleshooting.md](docs/troubleshooting.md) |
| 改代码 | [docs/architecture.md](docs/architecture.md) + [CONTRIBUTING.md](CONTRIBUTING.md) |
| 全部文档 | [docs/README.md](docs/README.md) |

---

## 架构

```
                      飞书云 (WS)        企微云 (webhook)
                          ↕                  ↕
                   ┌────────────┐   ┌────────────────────┐
                   │ Lark       │   │  cloudflared       │
                   │ transport  │   │  → 内嵌 HTTP :3939 │
                   └─────┬──────┘   └──────┬─────────────┘
                         │                 │
                         │  IMTransport 抽象接口
                         │                 │
                     ┌───▼─────────────────▼───┐
                     │   Node daemon (tsx)      │
                     │   handlers · watcher · notifier
                     │   AskManager · ApprovalManager · TaskStore
                     └───────┬──────────────────┘
                             │
                        AppleScript
                             ↕
                     Terminal.app tabs（你的 claude sessions）
                             │
                     ┌───────▼──────────┐
                     │ agent CLI ↔      │
                     │ ~/.multiagent-chat/agent.sock
                     └──────────────────┘
                             │
                     ./data/ JSON 持久化
```

细节：[docs/architecture.md](docs/architecture.md)

---

## 数据存放

```
~/.multiagent-chat/
  ├─ agent.sock         # Unix socket（server）
  ├─ cli-state.json     # CLI 默认 tab
  └─ presets/           # 任务模板

./data/                  # 项目内
  ├─ chats/<id>.json     # 飞书/企微 会话状态（activeTty/quietMode/watchAllTabs 等）
  ├─ memories/<id>.json  # task-level memory
  ├─ stage-memories/<id>.json  # stage-level memory
  ├─ tasks/<id>.json     # SOP 任务状态机
  └─ approvals/<id>.json # 审批记录
```

---

## 开发

```bash
pnpm dev          # tsx watch + 自动 reload
pnpm typecheck    # tsc -b --pretty
```

文件改了 `tsx watch` 自动重启；`.env` 改了要 kill + 重启。

---

## Roadmap

- ✅ Phase 1: monorepo 拆包（pnpm workspaces）
- ✅ Phase 2: orchestrator 包独立
- ✅ Phase 3: IMTransport 抽象接口
- ✅ Phase 4: 企业微信 transport（99% 对齐飞书）
- ✅ Phase 5: 多 agent · Codex CLI 对接（`AgentAdapter` 抽象；C1+C2+C3 已完成）
- 🚧 Phase 6: 钉钉 / Slack / Telegram transport（IMTransport 已就位）
- 🚧 Phase 7: DAG 编排 / token usage tracking / cost dashboard

**近期已交付**（原 roadmap 之外，按用户反馈迭代出来的）：TAPD 缺陷/需求自动监听 + 通知分级、performance-platform P1 只读监听 + P2 认领并建需求、Knowledge Extraction 个人知识库、权限审批分级(`/perm-level`) + 学习放行、Dogfood 自审(`/selfaudit`)、明文凭证脱敏(`/raw`)、任务工作目录隔离(worktree + `/worktasks`)、Fleet 主动监控。

---

## License

MIT License — 见 [LICENSE](LICENSE)
