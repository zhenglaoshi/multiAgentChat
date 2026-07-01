# Explore: multiAgentChat 项目状态

## 总体规模
9277 行 TypeScript，单 Node.js daemon（tsx watch），单进程多职责。

## 模块清单（src/）

| 模块 | 行数 | 职责 |
|---|---|---|
| `lark/` | ~4200 | 飞书侧：cards/commands/handlers/api/target/reply |
| `monitor/` | ~1550 | 3s tick watcher、pending、notifier、health、ws-watchdog、chains |
| `terminal/` | ~560 | AppleScript 控制 Terminal.app |
| `control/` | ~1900 | Unix socket server + `agent` CLI + protocol |
| `tasks/` | ~500 | SOP task state machine + sop-prompt + render |
| `memory/` | ~370 | task + stage memory + recall + tokenize |
| `approval/` | ~160 | 审批 manager + gateContext |
| `presets/` | (单文件 ~270) | 模板（含 stages/gates/loops 字段） |

## 数据持久化（data/）

```
data/
├─ chats/<chatId>.json       # 飞书会话状态（activeTty / watchAllTabs）
├─ memories/<id>.json        # task 级 memory
├─ stage-memories/<id>.json  # stage 级 memory  ← 本周加
├─ tasks/<id>.json           # SOP 任务状态机  ← 本周加
└─ approvals/<id>.json       # 审批记录（含 gateContext） ← 本周加
```

## 关键链路

### 入站（飞书 → tab）
- WS event → handlers → parseMessage → handleCommand / sendToNamedTarget / sendToActiveTab → dispatchSendToTab
- 注入 SYSTEM_GUIDANCE + memory recall + AppleScript do script + forceEnter

### SOP 入站（本周加）
- `/run --sop ...` 或 `/run <sop-preset>` → resolveSopConfig → SopActionData → dispatchSopExecute → createTask → sendCardReturnId(stageProgressCard) + buildSopWrapperPrompt 注入

### 出站（事件 → 飞书）
- watcher 3s tick → emit taskOutput/localTaskDetected/needsInput → notifier patch/send
- taskEvents (stage:start/end/retry, gate:wait/resolve, task:done/failed) → notifier patch stageProgressCard
- approvals.events → approvalCard 或 stageGateCard

### Agent CLI
- Mac 任何 shell `agent <subcmd>` → Unix socket → control/server dispatch
- 支持：tabs / chats / approvals / tasks / stage.recall / lark outbound

## 已有差异化（vs cc-connect / Anthropic Remote Control）

- **Terminal-first 工作流**：每个 tab 是用户自己开的 claude，framework 用 AppleScript 观测，不 spawn
- **多 tab 并行 + cwd 维度路由**：@cwd-basename / @tty 都能寻址
- **SOP 编排**：task / stage / gate / artifact / failure loop 完整状态机
- **Gate 卡含 artifact 预览**：远程异步时核心价值
- **双层 memory**：task + stage

## 已知短板

- **macOS-only**：AppleScript 锁死
- **飞书-only**：lark SDK 直接耦合在 handlers / cards / notifier
- **单进程**：dev 挂了全挂
- **SOP 0 真实任务跑过**（这是第一个）
- **6-stage 默认对规划/小任务太重**
- **stage memory 没自动注入**到下一 stage prompt
- **没有调度（cron）/ DAG 编排**

## 跟外部工具对照

| 维度 | multiAgentChat | cc-connect | Anthropic Remote |
|---|---|---|---|
| 平台数 | 1（飞书） | 13 | 1 |
| Host 控制 | 看现有 Mac claude tab | spawn 子进程 | 本地 claude |
| 多 session | ✅ tab | ✅ session | ❌ 1:1 |
| 编排/SOP | ✅ 独有 | ❌ | ❌ |
| Gate | ✅ + 预览 | claude 自带 | ❌ |
| 调度 | ❌ | ✅ cron | ❌ |
| 开源 | 否 | ✅ | 否 |
