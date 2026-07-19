# SOP（Standard Operating Procedure）—— 完整说明

## 是什么

SOP 是 multiAgentChat 的核心差异化能力：**把"丢个 prompt 让 claude 自由发挥"升级成"声明式多 stage 工作流 + 关键节点人工审批 + 失败自动回环"**。

日常场景：
- 你在飞书发一个 SOP 任务（比如"实现新功能"）
- Framework 把它拆成多个 stage，一个个跑，每个 stage 用不同的 subagent（架构 / 编码 / 测试 / ...）
- 关键节点（比如架构做完）会推审批卡到你手机，你批准了才继续
- 某个 stage 失败会按预设自动回环重跑
- 全部 stage 的产出（design.md / diff / 测试结果）都持久化，可随时查

跟 cc-connect / Anthropic 官方 Remote Control 的差别：**它们只做消息桥，SOP 是 multiAgentChat 独有**。

## 最小用例

```
/run --sop 实现 ping 命令
```

Framework 会：
1. 检查你 chat 有没有 active tab
2. 智能判断 attach 到当前 tab 还是 spawn 新 tab
3. 建 task 记录（`data/tasks/task-mqXXX-YYYY.json`）
4. 发一张 stageProgressCard 到飞书（预览所有 stage）
5. 把 SOP wrapper prompt 派到 tab 的主 claude

主 claude 按 wrapper 提示：
1. 先分析任务，用 `--skip` 跳过不必要的 stage
2. 对每个 stage：`--start` → `Task(subagent_type='stage-name', ...)` → `--end`
   - `--start` **框架已自动打点**：Task 工具的 PreToolUse hook（`bin/mchat-task-hook`）会在 `Task(subagent_type=X)` 时自动 `markStageStart`（X 是 pending stage 时）；主 agent 手动 `--start` 变幂等兜底。
   - 忘了 `--end`：下一 stage `--start` 时 server 自动收尾上一个**非 gate** 的 running stage（gate 的只告警不动，暴露漏审）。
   - `--end --artifact` 会按 stage 骨架**轻校验**（`artifact-schema.ts`：如架构必含 受影响文件/接口/风险）；缺 section 在 stderr 提醒（不 block）。stage 列表里每个 stage 标了 `[artifact 骨架]`。
3. 收到 gate stage 的 --end 时会阻塞等飞书审批
4. 收到 [SOP 中止] banner 就停手
5. 全部完成后调 `agent lark send-text` 报告

## 核心概念

### Stage（阶段）
一个 SOP 任务由多个有序 stage 组成。每个 stage 对应一个 subagent（Claude Code 自定义 agent）。默认 SDLC 6 stage：

```
Explore → requirement-analyzer → architect ⏸gate → coder → tester → regression-checker
```

用 `/run --sop --stages a,b,c` 或 preset 里 `stages: ['a', 'b', 'c']` 覆盖。

### Gate（关卡）
Stage 结束时的人工审批点。声明为 `gates: ['after-architect']`。默认 30 分钟超时。

Gate 触发时：
- Framework 创建 approval + 发 stageGateCard（**含刚完成 stage 的 artifact 文件预览**）到飞书
- 主 claude 的 `--end architect` 阻塞
- 你在飞书点批准 → CLI 返回 `approved` → 主 claude 继续
- 拒绝 → task → failed

### Loop（失败回环）
Stage 失败自动重试到早期 stage。声明 `loops: [{ on: 'tester', retryFrom: 'coder', maxRetries: 2 }]`。

主 claude 调 `--fail`：
- 命中 loop 且未耗尽 → framework reset `retryFrom` 到 `on` 之间所有 stage → stdout 返回 `loopback:coder` → 主 claude 从 coder 重跑
- 未命中 loop 或已耗尽 → task → failed

### Skip
主 claude 判断某 stage 不需要，`--skip` 跳过。状态变 `skipped`，不算失败、不触发 loop、下一 stage 的 artifact 输入来自更早的 stage。

### Artifact handoff
每个 stage 写文件到 `artifactDir/<stage>.md`。下一 stage 读上一个的 artifact。跨 stage 通过**文件**传递，不靠主 claude 转述全文。artifactDir 默认 `./docs/tasks/<task-id>/`，可 preset 覆盖（支持 `{task-id}` 占位符）。

### Abort（中止）
用户主动 abort：
- `agent task abort <id>` 或 `/task abort <id>`
- `soft`（默认）：task → failed，主 claude 收到 🛑 banner，可写收尾 summary
- `hard`：不写收尾，直接停手
- 所有后续 `agent task stage --start/--end` 被 server 拒绝（避免协议漂移）

## 触发方式

### `/run <preset>`（预设模板）
先 `/template save <name> --stages ... --gates ... [--loops ...] <prompt>`，然后 `/run <name>`。适合反复用的 SOP。

### `/run --sop [--stages ...] [@target] <prompt>`（ad-hoc）
临时启动。`--stages` 未指定时走默认 SDLC 6 stage。适合探索性 SOP。

### `/run <preset> --sop`
preset 有 stages 时自动 SOP，不需要 `--sop` flag。

## Preset 字段

```json
{
  "name": "video-edit",
  "prompt": "视频剪辑：{clip}",
  "target": "studio",              // 可选
  "stages": ["ffmpeg", "qa"],
  "gates": ["after-ffmpeg"],
  "loops": [{ "on": "qa", "retryFrom": "ffmpeg", "maxRetries": 1 }],
  "artifactDir": "./docs/{task-id}"
}
```

在飞书里：
```
/template save video-edit --stages ffmpeg,qa --gates after-ffmpeg --loops qa→ffmpeg*1 视频剪辑：{clip}
```

## Subagent 集成

**每个 stage 对应一个 subagent**。要么用 Claude Code 内置的（`Explore` / `Plan` / `general-purpose`），要么用 `~/.claude/agents/*.md` 里的自定义。

### 快速创建自定义 subagent

用 `/subagent gen <描述>`。framework 派任务给主 claude 分析域 + 产出 3-5 个 subagent + 组合 template。落盘后立即可 `/run <template>`。

### 迭代已有 subagent

`/subagent tweak <name> <改动指令>` — 主 claude 拿现有定义 + 你的改动指令 → 输出改后版本 → overwrite。

### 手动加

```bash
agent subagent add ffmpeg-operator \
  --title "视频处理" \
  --artifact "Bash,Read,Glob" \
  --summary sonnet \
  --note purple \
  --body "You are a ffmpeg operator. Handle mp4 clip/subtitle/thumbnail tasks..."
```

（CLI flag 复用了通用参数：`--title`=description、`--artifact`=tools CSV、`--summary`=model、`--note`=color）

## Stage memory + recall

Stage 完成时框架写一条 stage memory（`data/stage-memories/<id>.json`）。含：stageName / cwd / userPrompt / summary / artifactPath / 时间。

召回：
```bash
agent stage-recall --name architect --cwd $(pwd) 数据分析
```

用于跨任务复用："上次 architect 在这个 cwd 遇到 xxx 问题时怎么设计的"。

## 智能分派（Smart-dispatch）

`/run --sop <prompt>` 无 `@target` 时：

- **你正在 Mac 上盯着 activeTty 的 claude**（Terminal frontmost + selected tab = activeTty + hasTUI）→ **attach** 到当前 session，跳过 spawn（省 ~9s）
- **你在别处**（手机、别的 app、别的 tab）→ **spawn 新 tab**，Terminal 闪 200ms 就切回，claude 冷启 8s 后派 SOP

新 subagent 加/改后，spawn 分支保证 fresh session 认得（Claude Code session 启动时快照 agent list）；attach 分支跑老 subagent OK，跑新 subagent 会报 `unknown` —— 提示用户在新 tab 重开。

## 状态查询

飞书：
- `/dashboard` — 全局：tab 状态 + 进行中 SOP + 最近完成
- `/task` — 所有进行中 SOP
- `/task <id>` — 单个 SOP 时间线卡（stage / gate / artifact）
- `/task here` — 本 chat 进行中的 SOP
- `/approvals` — 审批列表

CLI：
- `agent task list [--status running|awaiting-gate|done|failed]`
- `agent task show <id>`
- `agent task here` — 当前 tty 上进行中的 SOP
- `agent stage-recall [--name X] [kw1 kw2]`

## 数据落盘

```
data/
├── tasks/<task-id>.json          # 状态机（stageHistory / currentStageIdx / status）
├── stage-memories/<id>.json      # per-stage 独立索引
├── memories/<id>.json            # task 级（在 memory 里的老概念）
├── approvals/<id>.json           # 审批 + gateContext
└── docs/tasks/<task-id>/         # artifact 目录（每 stage 一个 .md）
```

daemon 死了不影响状态：全部落盘，重启读回。

## 命令速查（SOP 相关）

### 飞书
```
/run --sop [--stages a,b] [--gates after-a] [--loops b→a*N] [@target] <prompt>
/run <preset> [key=value ...]
/template save <name> --stages ... --gates ... --loops ... <prompt>
/task [<id>]                       列表 / 详情
/task abort [<id>] [hard]
/task here                         本 chat 进行中的 SOP
/subagent gen <描述>                LLM 生成 subagent 集
/subagent tweak <name> <feedback>   LLM 改现有 subagent
```

### CLI（主 claude 在 tab 里调）
```bash
agent task stage --task-id X --name <stage> --start
agent task stage --task-id X --name <stage> --end --summary "..." --artifact <path>
agent task stage --task-id X --name <stage> --fail --note "..."
agent task stage --task-id X --name <stage> --skip --reason "..."
agent task abort <task-id> [--hard]
agent task here
agent stage-recall --name <stage> [kw...]
agent subagent gen-submit --task-id X --chat Y --body '<json>' [--hard]
```

## 常见问答

**Q: 全部 stage 都要跑吗？**  
A: 不。主 claude 会看任务，用 `--skip` 跳过不必要的 stage。默认 SDLC 6 stage 对简单任务过度，会被大量 skip。

**Q: SOP 卡住不动？**  
A: 大概率主 claude 卡在某个 stage 或等 gate。查：
- `/task <id>` 看当前 stage
- `/approvals` 看有没有卡壳的 gate
- `agent task abort <id>` 中止

**Q: 加了新 subagent 但 `Task(subagent_type='...')` 报 unknown？**  
A: 这个 claude session 启动时快照了 agent list，不认新加的。用 `/run --sop` 让 framework 自动 spawn 新 tab（走 smart-dispatch spawn 分支）。或手动新开 tab + `claude`。

**Q: SOP wrapper prompt 太长打扰主 claude？**  
A: SOP wrapper 只在 `/run --sop` 或有 stages 的 preset 走。普通消息（`@ttys001 干活`）不带 wrapper。
