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
| **C-future** | `host-codex-app`（Electron GUI 驱动，输入注入） | 有刚需才启 | 记档不做 |

**Codex CLI 对接闭环达成（C1+C2+C3）**，claude 行为始终 byte-identical。所有 agent 专属逻辑从 `orchestrator/agents/` 一处流出。C0（HostBackend）只对**桌面 App** 有意义（CLI 走"桥接到 CLI"），降级暂缓。**唯一剩**：codex `login` 后跑一轮验 notify payload（`/tmp/mchat-codex-notify.log` 会记原始 payload）→ 摘 `codexAdapter.unverified`。

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
