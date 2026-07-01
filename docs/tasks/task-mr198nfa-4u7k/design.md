# multiAgentChat — 项目分析 + 演进设计

## 0. 这个项目是啥（给新人看的两段）

multiAgentChat 是单用户的「飞书 IM ⇄ Mac Terminal 多 claude tab」桥。你在飞书发命令 → framework 通过 AppleScript 控制 Mac 上的 Terminal.app，把消息送进对应 claude tab；claude 的输出经 watcher 轮询采集，再实时推回飞书卡片。

它**不是** spawn 子进程跑 claude（区别于 cc-connect），而是**观测用户已有的 claude tab**——你日常怎么用 Terminal，framework 怎么贴上去。这意味着远程异步使用时，你能看到所有 Mac 上正在干的 claude 进度，并通过飞书介入；坐在 Mac 前时它完全不打扰你。

最近一周加了 SOP 系统：声明式多 stage 工作流（Explore→需求→架构 ⏸gate→编码→测试→回归）、artifact 文件 handoff、失败回环、stage 级 memory。这是 cc-connect / Anthropic 官方 Remote Control 都没有的差异化。

---

## 1. 项目状态摘要（2026-07）

**规模**：9277 行 TS / 单 Node daemon (tsx watch) / 8 主模块 / ~5 MB data 持久化。

**模块**：
| 名 | 行 | 干啥 |
|---|---|---|
| `lark/` | 4200 | 飞书 SDK 客户端 / cards / commands / handlers / api / target / reply |
| `monitor/` | 1550 | 3s tick watcher / pending / notifier / health / ws-watchdog / chains |
| `terminal/` | 560 | AppleScript 控制 Terminal.app |
| `control/` | 1900 | Unix socket server + `agent` CLI |
| `tasks/` | 500 | SOP 状态机 + sop-prompt + render |
| `memory/` | 370 | task/stage memory + recall + tokenize |
| `approval/` | 160 | 审批 + gateContext |
| `presets/` | 270 | 任务模板（stages/gates/loops） |

**正确工作的能力**：
- 飞书发命令 → tab，含 @target/@cwd 路由、chain `>>`、batch 多 target
- claude TUI 适配（forceEnter / char-len 检测 / SYSTEM_GUIDANCE 自动注入）
- pending tracker + 实时进度卡 patch
- 审批流（卡 + 5min 默认超时）
- task-level memory + cwd/keyword recall
- WS watchdog（SDK 假活检测） + health check（自杀重启）
- SOP 完整状态机（task/stage/gate/loop + 实时 stageProgressCard + stageGateCard 带 artifact 预览）
- 本地 shell watch（最近修复，不限 claude tab）
- ad-hoc `/run --sop <prompt>` 不依赖模板

**还没正常用过的能力**：
- 真实 SOP 跑通 e2e（这是第 1 次）
- Stage memory recall 跨任务复用

**短板**：
- macOS-only（AppleScript 锁死）
- 飞书-only（lark SDK 耦合在 handlers/cards/notifier）
- 单进程（dev 挂全挂）
- 6-stage 默认对小/规划任务太重（这次任务暴露的）
- 无调度（cron）/ DAG 编排
- 无远程 Linux host 支持

---

## 2. 架构现状图

### 当前（紧耦合的单进程 daemon）

```
        [飞书云端 WS]
            ↕
   ┌────────────────────────────────────────────┐
   │  Node daemon (tsx watch src/index.ts)      │
   │                                            │
   │   ws-watchdog ← lark/client.ts             │
   │       ↓                                    │
   │   lark/handlers ──→ commands ──→ cards     │
   │       │                                    │
   │       ├→ target.ts (解析 @target)          │
   │       ├→ memory/recall + tasks/sop-prompt  │
   │       └→ tasks/store (createTask)          │
   │       ↓                                    │
   │   terminal/tabs ──→ AppleScript ──→ Terminal.app
   │                                            │
   │   monitor/watcher (3s tick) ──┐            │
   │       ├→ pending/tracker      │            │
   │       └→ taskEvents emitter   │            │
   │                               ↓            │
   │   monitor/notifier ──→ lark/api → patch 飞书卡
   │       │                                    │
   │       └← approval/manager events           │
   │                                            │
   │   control/server (Unix socket) ←──── agent CLI（子 shell 用）
   │       └→ tabs/chats/approvals/tasks/stage.recall/lark.out
   └────────────────────────────────────────────┘
            ↕
        [data/*  ./data/{chats,memories,stage-memories,tasks,approvals}]
```

**问题**：
- `lark/` 直接 import `terminal/`、`tasks/`、`memory/`，调换 IM/host 时改动面巨大
- `notifier` 既订阅 watcher 也订阅 taskEvents 也订阅 approvals.events，逻辑过载
- `index.ts` 50 行就把所有模块 wire 完，没分层

### 抽离后（三层，可换 transport / 可换 host / orchestrator 独立）

```
   ┌──────────────────────────────────────────────────────┐
   │  packages/orchestrator    (pure logic, no IO)        │
   │                                                       │
   │  - tasks/* (state machine, events emitter)            │
   │  - presets/* (template + SOP config)                  │
   │  - memory/* (task + stage memory, recall)             │
   │  - approval/* (typed gate with artifact context)      │
   │                                                       │
   │  暴露：TaskOps / EventBus / StorageAdapter 三个接口   │
   └──────────────────────────────────────────────────────┘
                          ↑ depends on
   ┌──────────────────────┴───────────────────────────────┐
   │  packages/bridge   (IM-agnostic, host-agnostic)      │
   │                                                       │
   │  - dispatch routing（解 @target、SOP 包装、recall 注入）│
   │  - cards schema (typed builders, IM-neutral)         │
   │  - control protocol (Unix socket op set)              │
   │  - watcher loop（轮询接口化，不直接 AppleScript）       │
   │                                                       │
   │  接口：IMTransport / HostController                  │
   └──────────────────────────────────────────────────────┘
        ↑                                ↑
        │ impl                           │ impl
   ┌────┴──────────┐         ┌───────────┴──────────────┐
   │ IM Transports │         │ Host Controllers         │
   ├───────────────┤         ├──────────────────────────┤
   │ packages/     │         │ packages/                │
   │  - lark-im    │         │  - macos-terminal-host   │ (AppleScript)
   │  - slack-im   │         │  - tmux-ssh-host         │ (远程 Linux)
   │  - telegram   │         │  - stdio-spawn-host      │ (cc-connect 风格)
   └───────────────┘         └──────────────────────────┘
```

### 接口定义草案

```ts
// orchestrator 暴露
interface TaskOps {
  createTask(input): Promise<TaskState>
  markStageStart/End/Retry(...)
  markGateWait/Resolve(...)
  // ...
}
type TaskEvent = 'task:start'|'stage:start'|'stage:end'|'gate:wait'|...
interface EventBus { on<E>(e: E, fn): void; emit<E>(e: E, payload): void }
interface StorageAdapter { read/write/list<T>(...) }  // 默认 file，可换 SQLite/远程

// bridge 期待的 transport
interface IMTransport {
  sendCard(chatId, card): Promise<{ messageId }>
  patchCard(messageId, card): Promise<void>
  sendText(chatId, text): Promise<void>
  sendFile(chatId, path, name?): Promise<void>
  resolveChatId(opts): Promise<string|null>
  // events
  onMessage(handler: (msg: NormalizedMessage) => void): void
  onCardAction(handler: (action: NormalizedAction) => void): void
}

// bridge 期待的 host
interface HostController {
  listSessions(): Promise<Session[]>
  getSession(id): Promise<Session|null>
  send(sessionId, text, opts?): Promise<SendResult>
  forceEnter(sessionId): Promise<void>            // TUI 适配，可选 impl
  newSession(opts): Promise<Session>
  observe(): EventEmitter  // 'output'/'busy-change'/'closed' events
  getHistory(sessionId): Promise<string>
}
```

每个 transport / host 实现独立 npm package，bridge 通过依赖注入选用。

---

## 3. 前后抽离方案（核心）

### 包结构（monorepo, pnpm workspaces）

```
multiagent-chat/                      # repo root
├─ package.json                       # workspaces 配置
├─ packages/
│   ├─ orchestrator/                  # 纯逻辑
│   │   ├─ src/{tasks,presets,memory,approval}/
│   │   └─ package.json (no IM/host deps)
│   ├─ bridge/                        # 抽象层 + 协议
│   │   ├─ src/{dispatch,cards,watcher,control}/
│   │   └─ deps: orchestrator
│   ├─ lark-im/                       # 飞书 transport
│   │   └─ deps: @larksuiteoapi/node-sdk, bridge interfaces
│   ├─ macos-terminal-host/           # Mac AppleScript host
│   │   └─ deps: bridge interfaces
│   └─ cli/                           # `agent` CLI 二进制
│       └─ deps: bridge (via socket protocol)
└─ apps/
    └─ daemon/                        # 你日常跑的 dev 服务
        ├─ src/index.ts (wire all)
        └─ deps: orchestrator + bridge + lark-im + macos-terminal-host
```

### 依赖方向（严格单向）

```
cli ──→ bridge (Unix socket)
                ↓
apps/daemon ──→ lark-im ──→ bridge ──→ orchestrator
            ──→ macos-terminal-host ──→ bridge ──→ orchestrator
```

orchestrator **不依赖任何 IM/host**。
bridge 只依赖 orchestrator + 自身定义的接口。
lark-im / macos-terminal-host 只依赖 bridge 接口（dependency inversion）。
apps/daemon 是唯一组装层。

### 迁移路径（不能一次重写）

**Phase 1**（Week 1-2）：仓库内 monorepo 化，包名引用，**代码原地不动**。
- 加 pnpm workspaces 配置
- src/ → packages/<name>/src/ 移动（用 git mv 保留 blame）
- 暂时所有 package 互相 import，typecheck 通过即可
- 验收：`pnpm dev` 跑起来等同现有 `npm run dev`

**Phase 2**（Week 3）：抽 orchestrator 的纯函数边界。
- tasks/、memory/、presets/、approval/ 进 orchestrator
- 把 logger import 改成依赖注入
- file IO 抽成 StorageAdapter
- 验收：orchestrator 单测覆盖（tasks state machine、memory recall）

**Phase 3**（Week 4）：抽 bridge 接口。
- 把 lark/handlers 里"调 terminal/" 的调用改走 `HostController` 接口
- 把 lark/api 里调用提到 IMTransport 接口
- lark-im / macos-terminal-host package 实现接口
- 验收：apps/daemon 通过依赖注入装配，跑起来等同 Phase 1

**Phase 4**（Week 5-6）：新增第二个实现验证抽象。
- 试做 slack-im 或 telegram-im（任选一个）→ 验证 IMTransport 抽象够用
- 试做 tmux-ssh-host → 验证 HostController 抽象够用
- 验收：拿掉飞书也能用 Slack 跑完 SOP；拿掉 Mac AppleScript 用 tmux 跑也行

---

## 4. 手机端可操作性增强（按 ROI 排序）

> 假设：你 80% 的远程使用场景在地铁/会议/出差，飞书移动端 == 主 surface。

### P0（必做，预计 1-2 周）

#### 4.1 Stage 卡按钮升级（估 2 天）
现在 stageProgressCard 只展示，没操作。加：
- "Ctrl-C 当前 stage"（往 task tab 发 ^C）
- "跳过 stage"（标 skipped 进入下一 stage）
- "看 artifact"（推该 stage artifact 文件回飞书）
- "改 prompt 重跑"（当前 stage --fail + 触发 loopback）

#### 4.2 Gate 卡 inline 改 prompt（估 1 天）
当前 gate 只能 approve/reject。加"reject 但写理由 + 触发 loopback 到上一 stage"按钮——这样**你不批，让架构师重做**。

#### 4.3 任务级"全局 dashboard"卡升级（估 2 天）
当前 dashboard 杂糅 tab 状态 + 任务。手机一屏要做到：
- 顶部 N 个进行中 task（按状态着色）
- 中间 attention（gate 等待 / 错误 / 输入需求）
- 底部 idle tab 折叠
- 每张卡有"详情"按钮跳 stageProgressCard

#### 4.4 Push notification（估 1 天）
飞书机器人可以触发 push（机器人主动消息）。当用户离线时，gate trigger / task failed 主动 push。

### P1（高价值，2-3 周）

#### 4.5 任务 timeline 视图（估 3 天）
单 task 完整时间线，stage / approval / artifact 都在一张卡里折叠，可以滚动。

#### 4.6 语音输入 → /run（估 3 天）
飞书移动端语音消息 → ASR → 作为 /run --sop 的 prompt。地铁里说话比打字快。

#### 4.7 一键重跑 / 派生（估 2 天）
任务完成卡上加 "重跑同样的"、"用相同 stages 跑新需求"按钮。

#### 4.8 artifact 直接预览（估 2 天）
gate 卡已经预览 design.md head 40 行。扩展到所有 stage 卡：点 artifact 路径直接看 markdown 内容 carousel。

### P2（值得做但可推迟）

#### 4.9 多 chat 隔离的 SOP 队列（估 1 周）
团队场景：多人共享一个 Mac，每人飞书 chat 独立任务队列。

#### 4.10 浏览器 PWA dashboard（估 2 周）
浏览器看全 dashboard、跨 task 比对、artifact 全文阅读。

---

## 5. 其它功能增强（不限手机端）

| 名 | 价值 | 估时 | 备注 |
|---|---|---|---|
| 调度 `/schedule` (cron) | 中 | 3 天 | cc-connect 有，常见需求 |
| DAG 任务编排 (A2 chain → DAG) | 中 | 1 周 | 多 tab 并行+依赖 |
| Plan template 库 | 低 | 2 天 | 内置 5-10 个常用 SOP 模板 |
| Token usage tracking | 低 | 2 天 | 每 task 累计 API token 用量 |
| 自动 chat 选择 | 低 | 2 天 | 基于 task cwd 推断 chat |
| Session crash 恢复 | 中 | 3 天 | claude 挂了从 artifact 续跑 |
| LLM-driven dispatch 路由 | 中 | 1 周 | "改个 bug" 自动选合适 tab |
| 跨 task artifact 引用 (refs) | 中 | 3 天 | task A 引用 task B 的 design.md |
| `/plan` 命令（短 SOP） | 高 | 1 天 | 本次任务暴露的需求 |
| Stage memory 自动注入 | 中 | 2 天 | 下一 stage prompt 头部带上次相关 stage 摘要 |

---

## 6. 4-6 周 Roadmap

### 周 1：monorepo + 文档基础
- [ ] pnpm workspaces 切换
- [ ] src 切到 packages/
- [ ] 写完整 README（项目自描述 / 架构图 / 安装步骤）
- [ ] 加 CONTRIBUTING.md（如果未来开源）
- [ ] 验收：`pnpm dev` 等同现状

### 周 2：手机端 P0 (4.1, 4.2, 4.4)
- [ ] stage 卡按钮增强（Ctrl-C / 跳过 / 看 artifact / 改 prompt 重跑）
- [ ] gate 卡"reject + 重做"路径
- [ ] push notification（飞书离线主动消息）
- [ ] `/plan` 命令（轻量 SOP：explore + architect 2 stage）
- [ ] 验收：手机端可以全程不打字管理一个 SOP 任务

### 周 3：orchestrator 抽离
- [ ] packages/orchestrator 独立 + 接口
- [ ] StorageAdapter file 实现
- [ ] 单测覆盖 tasks state machine
- [ ] 验收：orchestrator 单测全过，daemon 行为不变

### 周 4：bridge 抽离 + lark-im / macos-host 拆包
- [ ] IMTransport / HostController 接口定义
- [ ] lark-im / macos-terminal-host package 实现
- [ ] apps/daemon DI 装配
- [ ] 验收：daemon 行为不变，单元测试覆盖接口契约

### 周 5：第二平台验证（slack OR telegram，选一）
- [ ] 选一个新 IM（建议 telegram 因简单）
- [ ] 实现 IMTransport
- [ ] 跨平台跑 SOP 验证抽象
- [ ] 验收：同一个 daemon 装 lark + telegram，两边都能跑

### 周 6：调度 + DAG + 第一阶段收尾
- [ ] `/schedule` cron 任务
- [ ] DAG 编排（A2 chain 升级）
- [ ] 灰度运行 1 周，记录踩坑
- [ ] 验收：第一个真实任务用调度+DAG 跑通

---

## 7. 开放问题（请你拍板）

1. **是否最终公开开源**？
   - 影响接口设计严谨度、文档完整度、CI 投入
   - 推荐：先按"可开源"的标准做，但暂不公开发布。Phase 4 完成后视质量决定

2. **第二平台优先做哪个**？
   - Slack（团队场景，企业用）
   - Telegram（个人易接入）
   - 钉钉（国内同生态）
   - 推荐：**Telegram**（最小成本验证抽象 + 个人可用）

3. **是否要 Linux host (tmux-ssh)**？
   - 用例：远程 Linux 服务器上跑 claude，从飞书调度
   - 不要：节省 1 周工作
   - 推荐：**不要**（你主要工作在 Mac 上，远程开发也是 SSH 进 Mac）。需要时再加

4. **6-stage SDLC vs `/plan` 轻量 SOP**？
   - 本次任务说明 6-stage 对规划任务过度
   - 推荐：保留 6-stage 做"完整开发任务"模板，**新增 `/plan` 命令** = explore + architect 2 stage（+ gate），专门给规划场景

5. **monorepo 工具选什么**？
   - pnpm workspaces（轻量，无额外配置）
   - turborepo（缓存 / 任务编排）
   - nx（最完整但最重）
   - 推荐：**pnpm workspaces**（够用，未来需要再升）

---

## 8. 这次 SOP 任务的元反馈（dogfood data point）

跑这一次得到的数据：
- 6-stage 默认对**规划任务过度**：coder/tester/regression 没东西可做
- artifact 文件 handoff 在规划任务里有点尬：explore.md/requirements.md/design.md 都是"自描述"，subagent 之间没真"接力"
- gate 卡含 design.md 预览 → 这场景下**真的好用**（你审 design 时不用切 IDE）
- ad-hoc `/run --sop` 用起来比预想流畅
- stageProgressCard 实时 patch → 你应该已经在飞书看到 stage 一个一个亮起

**建议**：完成本任务后**立刻加 `/plan` 轻量 SOP**（2 stage + gate），作为这次 dogfood 直接产出。
