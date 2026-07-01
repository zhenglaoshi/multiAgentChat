# 功能完整清单

按能力分类，含"什么时候用"和"实际例子"。

---

## 1. 飞书 ⇄ Mac Terminal 双向桥

### 能力
- 飞书消息 → Mac Terminal tab（AppleScript 控制）
- Mac Terminal 输出 → 飞书卡片（3s 轮询采集 + 主动推送）
- 支持 alt-screen TUI 程序（Claude Code 用 `\r` 重绘 → 用**字符长度**变化而非行数检测）

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
- **MacBook 合盖** 时 macOS 主动断电+挂起 CPU，任何用户态程序（包括 caffeinate）**都无能为力**
- 唯一软件绕过：SIP 关闭 + 装第三方 kext（如已停维护的 InsomniaX，有风险）
- **推荐硬件方案**：
  - **Clamshell mode**：MacBook + AC 电源 + 外接显示器 + 外接键盘/鼠标 → 合盖也不睡（macOS 自动进 clamshell mode）
  - 或用**桌面 Mac**（iMac / Mac mini）
- 就 idle 睡眠：`caffeinate` 完全够用（默认已开）

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
