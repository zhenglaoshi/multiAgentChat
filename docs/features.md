# 功能完整清单

按能力分类，含"什么时候用"和"实际例子"。

---

## 1. 飞书 ⇄ Mac Terminal 双向桥

### 能力
- 飞书消息 → Mac Terminal tab（AppleScript 控制）
- Mac Terminal 输出 → 飞书卡片（1-2s 轮询采集 + 主动推送 + adaptive 节流）
- 支持 alt-screen TUI 程序（Claude Code 用 `\r` 重绘 → 用**字符长度**变化而非行数检测）
- **双渠道并行输出**：任务响应同时在 pc shell TUI 和飞书露出（SYSTEM_GUIDANCE 强制引导 claude 不能只推不答）

### 什么时候用
- 你在电脑前不方便切 Terminal → 手机发命令
- 出门/开会时想让 Mac 后台跑活 → 飞书调度 + 手机看状态
- 多个项目并行时 → 每个 tab 一个项目，飞书 dashboard 统一看

### 例子
```
# 飞书里
@pivotal-parrot 跑 npm test
@monitor tail -f /var/log/foo.log

# Mac claude 里
agent lark send-file ./output.xlsx
```

---

## 2. 多 tab 并行

### 能力
- 一个 Mac 支持 N 个 Terminal tab，每个独立 claude 进程
- 每个 tab 独立 cwd + 独立 context + 独立 claude session
- 飞书通过 `@target` 定向派发；`>>` 链式；多行并发 batch

### 什么时候用
- 一个项目一个 tab
- 长任务丢给某 tab，接着开新 tab 干别的
- 复杂任务分派多 tab 协作（各自跑一部分）

### 例子
```
@studio 拉 mixpanel 数据 >> @analyst 分析这批数据
（studio tab 完成后自动派给 analyst tab）
```

---

## 3. SOP 编排 —— 声明式多 stage 工作流

**这是 multiAgentChat 的核心差异化**。cc-connect / Anthropic 官方 Remote Control 都没有。

### 能力
- 声明 `stages: ['explore', 'architect', 'coder', 'tester']`
- 每个 stage 对应一个 subagent（Claude Code 内置或自定义 `~/.claude/agents/*.md`）
- 关键节点 `gates: ['after-architect']` 会推审批卡到飞书，人工批准才继续
- 失败自动回环 `loops: [{on: 'tester', retryFrom: 'coder', maxRetries: 2}]`
- 主 claude 可 `--skip` 判定跳过不必要 stage
- 每 stage 通过 artifact 文件传递结果（`./docs/tasks/<task-id>/<stage>.md`）

### 什么时候用
- 大改动（要走 SDLC 流程）
- 需要人工审批的敏感任务（改数据库、发 prod）
- 想要过程可追溯 + artifact 可查

### 例子
```
/run --sop 实现登录功能
# framework 建 task-mqXXX
# 主 claude 依次调 Task(explore) → Task(architect) 
# → gate 触发飞书审批卡（含 design.md 预览）
# → 你批准 → Task(coder) → Task(tester)
# → 全部完成，推报告到飞书
```

详见 **[sop.md](sop.md)**。

---

## 4. Subagent 系统

### 能力
- **Claude Code 内置 subagent**（Explore / Plan / general-purpose / statusline-setup / ...）直接可用
- **用户自定义**：`~/.claude/agents/*.md` 或 `<repo>/.claude/agents/*.md`
- **YAML frontmatter**（name / description / tools / model / color）+ system prompt body
- **CRUD**：list / show / add / delete
- **AI 自动生成**：`/subagent gen <域描述>` 让主 claude 设计一套
- **迭代**：`/subagent tweak <name> <改动指令>` LLM 改现有 subagent

### 什么时候用
- **默认 SDLC 不够用** → 换域（视频 / 数据分析 / 财务 / 教学 / 硬件）
- **需要专用能力** → 加 `ffmpeg-operator` 之类专项 subagent
- **反复用同一种任务** → 存 template + 关联 subagent 一键触发

### 例子
```
/subagent gen 视频剪辑：ffmpeg 剪 mp4 + 加中文字幕 + 生成 3 张缩略图

# framework 派任务到主 claude
# 主 claude 输出 JSON：
#   { subagents: [ffmpeg-clipper, subtitle-adder, thumbnail-gen], template: {stages: [...]}}
# 落盘 3 个 .md + 1 个 preset
# 立即可 /run video-edit clip="X.mp4"
```

---

## 5. 智能派发（Smart-dispatch）

### 能力
- `/run --sop` 无 `@target` 时，framework 智能决定：
  - **你在 Mac 前正盯着 activeTty claude** → **attach**（复用当前 session，省 8s）
  - **你在别处**（手机 / 别的 app / 别的 tab）→ **spawn 新 tab**（Terminal 闪 200ms 归位）
- 新 tab spawn 保证 claude 是 fresh session，能识别刚 gen 的新 subagent
- 显式 `@target` 时永远尊重用户选择（attach 到指定 tab）

### 什么时候用
- 自动，你不用管
- 想强制新 tab 就别设 activeTty
- 想 attach 就在 Mac 前盯着那个 tab 再触发

---

## 6. 双层 Memory 系统

### 能力
- **Task memory**：每个 task 完成时落盘（`data/memories/*.json`），含 prompt / outputPreview / filesProduced / tags / cwd / duration
- **Stage memory**：SOP 里每个 stage 完成时落盘（`data/stage-memories/*.json`），按 stageName + cwd + 关键词召回
- **自动 recall 注入**：派任务时框架检索相关历史，注入到 prompt 顶部（cwd 精确匹配优先 + 关键词 token 匹配 + 时间衰减）

### 什么时候用
- 反复做类似任务 → framework 记得你上次怎么做，主 claude 看历史不用摸索
- 想查"上次 architect 在这个 repo 咋设计的" → `agent stage-recall --name architect`
- 想追溯"上次跑照护师查询用了啥脚本" → `/recall 照护师`

### 例子
```
# 第一次
飞书：@studio 查一下手机号 18510248896 的用户信息
# framework 落 memory：cwd=x, tags=[查, 手机, 号, 用户], files=[obs/lookup.js]

# 第二次
飞书：@studio 查手机号 13800000000
# framework 检索相关，注入 [上次相关历史 - 1 天前：查过 18510... 用了 obs/lookup.js]
# 主 claude 直接复用脚本
```

---

## 7. 审批工作流

### 能力
- 主 claude 用 `agent request-approval --title X --body Y` 阻塞式请求
- Framework 生成飞书卡片 + 5min 默认超时
- 用户点批准 / 拒绝 → CLI 返回 exit 0/1，主 claude 继续或中止
- SOP gate 用同一底子（timeout 30min，卡片含 stage summary + artifact 预览）

### 什么时候用
- 主 claude 要跑高风险命令（DB 写 / git push --force / rm -rf 大量文件）
- SOP 关键节点（architect 完成后审设计）
- 涉及钱（支付 / 退款）

### 例子
```bash
# 主 claude 在 tab 里
agent request-approval \
  --title "执行 DROP TABLE prod.users" \
  --body "$(cat <<EOF
影响：删除 5M 行
备份：已 mysqldump 到 s3://backup/xxx
回滚：需要 15min，SQL 已备好
EOF
)"
# 阻塞，等飞书 tap
# exit 0 → 继续；exit 1 → 中止
```

---

## 8. 本地 Shell 监听（Watch mode）

### 能力
- 飞书 chat 里 `/watch on` 后，Mac 上**任何 shell 活动**（不只是飞书派发的）都会推卡到飞书
- 触发条件：tab busy + history 增长 ≥ 8 行 + 30s cooldown
- 场景：你在 Mac 上直接跑长命令，人不在但想手机上看进度

### 什么时候用
- 你 Mac 前跑 `npm run build` / `pytest` 之类长任务
- 你想边跑边处理别的事，进度靠飞书推
- **远程调试**：让 Mac 跑，你手机看

---

## 9. Agent CLI + Unix socket

### 能力
- 一个统一的 `agent` 命令，Mac 任何 shell 都能用
- 通过 `~/.multiagent-chat/agent.sock` 跟 daemon 通信
- 支持所有内部 op：tab / chat / task / approval / subagent / lark / stage-recall / doctor

### 什么时候用
- 主 claude 在 tab 里的所有对外通信（推飞书 / 提审批 / SOP stage 上报）
- 用户手工调（`agent tabs` / `agent send` / `agent doctor`）

---

## 10. 防休眠（Sleep prevention）

### 能力
- daemon 启动时**自动** spawn `caffeinate -i -m -w <daemon-pid>`
- 阻止 macOS idle sleep + disk sleep，daemon 死 caffeinate 自动退
- Env var `AGENT_NO_CAFFEINATE=1` 关闭
- Env var `AGENT_CAFFEINATE_SYSTEM_SLEEP=1` 加 `-s`（AC 电源下真阻 system sleep）

### 什么时候用
- 你希望 remote 时 Mac idle 不睡（默认开）
- Mac 在跑长 SOP，出门后你不希望它睡了断 WS

### ⚠️ 硬性限制：合盖 macOS 强制睡

**软件层无解**：
- `caffeinate` / `IOPMAssertionCreateWithName` / **Amphetamine 的 "Closed-Display Mode"** 全都**不能**真的阻止合盖睡眠
- Amphetamine 的机制跟 caffeinate 一样，只影响 idle sleep 断言；合盖是 kernel + 固件层的独立行为
- InsomniaX 类 kext 在现代 macOS SIP 下装不上
- `pmset` 里各种参数（`lidwake` / `standby`）只调整**从睡眠恢复**行为，不阻止睡眠本身

**真能合盖不睡的 3 条路**：

1. **HDMI ghost plug 假显示器**（推荐给远程场景，5-15 元）
   - 小 dongle 插 HDMI / USB-C 口，macOS 认为外接了显示器
   - 加 AC 电源 + BT 键鼠（或额外 HID）→ 满足 macOS clamshell mode 条件
   - 合盖后 Mac 依然认为"有外接屏"，不睡
   - 缺点：占一个口 + 需带 BT 键鼠

2. **真 clamshell mode**（桌面场景）
   - AC 电源 + 外接真显示器 + 外接键鼠
   - macOS 自动开 clamshell mode
   - 缺点：不便携

3. **桌面 Mac**（Mac mini / iMac / Studio）
   - 没有"合盖"问题
   - 缺点：需买硬件

**就 idle sleep（不合盖但闲置）**：`caffeinate` 默认已跑，完全够。

### 验证
```
agent doctor
```
`caffeinate (防休眠)` 那行应显示 `pass` + PID。

---

## 11. WS 长连接健壮性

### 能力
- **WS watchdog**：monkey-patch console.log 截 lark SDK 的 `[ws] reconnect` / `[ws] ws client ready`；判断 WS "假活"（reconnect ≥3 且 90s 无 ready）触发自杀 + tsx watch reload
- **Health check**：每 30s 调 lark endpoint；失败 3 次自杀重启
- **Task 状态机磁盘持久化**：daemon 挂了不丢 task 状态

### 什么时候用
- 后台跑几天不用管
- 网络抖动、飞书 SDK 断连自动恢复

---

## 12. 诊断（Doctor）

### 能力
- 一句 `agent doctor` 跑 12 项健康检查
- 分级：critical / important / optional
- 每个 fail 附具体 fix hint

### 什么时候用
- 首次装完验证
- 遇到问题排查
- 升级后确认没坏

见 **[installation.md](installation.md)** 第 7 步。

---

## 13. Modular / 可扩展

### 能力
- Monorepo：orchestrator / host-mac / im-lark / framework / daemon 5 层单向依赖
- 计划抽象：`IMTransport`（第 2+ IM）+ `HostController`（Linux tmux 等）
- 目前扩展点：
  - 加飞书斜杠命令：改 `im-lark/lark/commands.ts`
  - 加 socket op：改 `framework/control/protocol.ts` + `server.ts` + `cli.ts`
  - 加 subagent：`~/.claude/agents/*.md` 或 `/subagent gen`
  - 加 SOP 模板：`/template save` 或 `~/.multiagent-chat/presets/*.json`

见 **[architecture.md](architecture.md)** + **[../CONTRIBUTING.md](../CONTRIBUTING.md)**。

---

## 14. 交互式选择 · `agent lark ask`

### 能力
用户在飞书**手指点选**回答问题，claude 从 stdout 拿 JSON 答案。三种类型：
- **single** —— radio 单选，按钮阵列
- **multi** —— checkbox 多选，toggle 后点提交
- **input** —— 用户在 chat 里直接回复文本（也支持 `/cancel`）

### 用法
```bash
# claude session 里
answer=$(agent lark ask single \
  --title "选一个方案" \
  --options "A. 快速,B. 稳妥,C. 稳妥再稳妥")
# → {"status":"answered","type":"single","index":1,"value":"B. 稳妥"}
echo "$answer" | jq -r '.index'

# 多选
answer=$(agent lark ask multi \
  --title "跑哪些 stage？" \
  --options "requirement,architect,coder,tester")
# → {"status":"answered","type":"multi","indices":[0,2],"values":["requirement","coder"]}

# 输入
answer=$(agent lark ask input --title "输入 commit message")
# → {"status":"answered","type":"input","text":"fix: xxx"}
```

### 退出码
- 0 = `answered`
- 1 = `cancelled`
- 2 = `timeout`（默认 5min，可 `--timeout <ms>`）

### 什么时候用
- 主 claude 想让用户"从 N 个选项里挑"或"填一段文本"
- 替代 `AskUserQuestion`（AskUserQuestion 在 TUI 里弹选项框，手机端飞书完全看不见）
- SKILL / SYSTEM_GUIDANCE 强制引导 claude 在选择场景优先用它

### 底层
`AskManager`（`packages/orchestrator/src/ask/`）+ 飞书交互卡片（`askCard`）+ card_action.trigger 路由 + input 类型时监听下条文本消息 = 完整闭环。

---

## 15. 抓屏 & 按键遥控（TUI 场景兜底）

### `/screen` · agent screen
抓 Terminal.app 指定 tab 所在窗口的截图（**含 alt-screen TUI 内容**，是 alt-screen 下飞书唯一能"看到"屏幕的通道），推图到飞书。

```bash
# CLI
agent screen [-t ttys003]     # -t 可省，自动反查

# 飞书斜杠
/screen                        # 抓当前 sticky tab
```

底层：AppleScript 拿 window bounds + `screencapture -R x,y,w,h` + `sendImage`。首次要授 Screen Recording 权限。

### `/keys` · agent keys
往目标 tab 发按键序列（osascript System Events），做为非 claude TUI 的**兜底**遥控。

键位：`d`=↓ `u`=↑ `l`=← `r`=→ `.`=空格 `⏎`=回车 `t`=tab `x`=esc  
中文别名：上/下/左/右/空/回

修饰：`ctrl+c` `cmd+k` `alt+f` `shift+tab`  
连发：`3d` 或 `d*3`  
打字（原样发字符）：`'hello world'`

```bash
# CLI
agent keys '2d . ⏎'                    # ↓↓ 空 回
agent keys ctrl+c
agent keys "'hello' ⏎"

# 飞书斜杠
/keys 2d . ⏎
/keys ctrl+c
```

飞书 `/keys` 每次执行后 300ms 自动补一张 `/screen` 截图回推确认。

### 什么时候用
- Claude 内置多选 UI（比如 `/agents` 界面）飞书看不见 → /screen 看现状 + /keys 遥控
- 非 claude TUI（`npm init` / `gum choose`）用户不方便切 tab → 手机 /keys 兜底
- 兜底原则：能用 `agent lark ask` 就优先用它（用户点选比手打按键序列友好）；用不了才走 /screen + /keys

---

## 16. 长任务进度卡降噪（三层组合）

30 分钟 build 类长任务本来会累积 500+ 次卡片 patch，视觉上一直变。三层治法：

### 层 1 · Adaptive Backoff（默认自动生效，无需操作）
patch 间隔随任务时长自动拉长：
- 前 30s → 3.5s（短任务体验不变）
- 30s-2min → 15s
- 2-5min → 30s
- 5min+ → 60s

`isFinal` 完成时永远 patch。

### 层 2 · `/quiet on/off/status`（每 chat 全局静默）
```
/quiet on         # 该 chat 所有 pending 只发首次 + 最终，中间全不 patch
/quiet off        # 恢复实时（走层 1 的自适应节流）
/quiet status     # 看当前状态
```

场景：你专心其他事情、后台跑 build 长任务，不想被中间进度打扰。

### 层 3 · 单张卡「🔇 静默此任务」按钮
每张 running 状态的进度卡底部一个按钮：
- 未静默：`[🔇 静默此任务]`，点后该 pending 中间不 patch，只在完成时更新
- 已静默：按钮变 `[🔊 恢复实时]`，卡片副标题多一行「🔇 已静默 · 完成时才更新」

`pending.quietUntilDone` 独立于 chat.quietMode，两者是 OR 关系。

### 使用建议
- 一般：默认层 1 自动降噪就够
- 专注模式：层 2 一次开关全局静默
- 只有一个任务吵：层 3 单卡按钮

---

## 17. 首次启动自动化（新 PC 上手最短路径）

daemon 启动时**自动**做的事，让新 PC 首次跑通只需要 3 步（装依赖 → 填 `.env` → 跑 dev）：

| # | 动作 | 目标 |
|---|---|---|
| 1 | `assertNodeVersion` | Node < 22 die + 引导升级 |
| 2 | `ensureEnvFile` | `.env` 缺失自动 `cp .env.example .env` + die 提示补密钥 |
| 3 | `emitMacPermissionHints` | 一次性打印 Accessibility / Screen Recording / Automation 权限提示 |
| 4 | `caffeinate` | 阻止 idle sleep |
| 5 | `ensureSkillInstalled` | upsert `skills/multiagent-lark/SKILL.md` 到 `~/.claude/skills/`（源码更新自动同步）|
| 6 | `installClaudeCodeHooks` | 往 `~/.claude/settings.json` 加 Stop + PreToolUse hooks（幂等）|
| 7 | `ensureAgentOnPath` | `bin/agent` 无 sudo symlink 到 `~/.local/bin/agent` |

用户唯一手动做：加 `~/.local/bin` 到 PATH（一次性 `echo 'export PATH=...' >> ~/.zshrc`）。

---

## 已知的能力边界

**能做**：
- 单用户 macOS
- 飞书为 IM 层
- Claude Code 为 agent 层
- 多 tab 并行
- SOP 编排
- 自定义 subagent 域

**不能做**（当前）：
- 多平台 IM（企微 / Slack / Telegram / 钉钉等，P2 计划）
- Linux / Windows host（AppleScript 锁死，P3 计划）
- 团队多用户共享（单 chat 一个 user，无 auth）
- 分布式部署（daemon 单机）

**不打算做**（哲学决定）：
- 云端 SaaS（本项目是本地工具，你数据不出你 Mac）
- claude 之外的 agent 后端（除非 P3 抽象 invoker）
- 完全无 Terminal 依赖（Terminal-first 是核心工作流哲学）
