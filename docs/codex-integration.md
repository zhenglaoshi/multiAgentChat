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

### 4.1 为什么不做一等公民
- 不在 Terminal tab 里 → `do script` / `history of tab` **全部失效**，整个 host 层不适用。
- 驱动 Electron 只有两条脏路：**CDP**（`--remote-debugging-port` 重启 app 后戳私有 DOM，每次 app 更新可能崩）或 **macOS Accessibility**（AXUIElement 读/点，脆且慢）。
- 往 contenteditable 注入 + 从流式 DOM 稳定读回响应 = 研究课题，非 feature。等于新写 `host-codex-app` 后端 + 长期维护税。
- 且**价值低**：GUI 本来就是给坐 Mac 前的人用的；用手机模拟点 GUI 窗口既脆又违背 multiAgentChat 的终端范式。

### 4.2 推荐：桥接到 CLI（+ 可选只读回传桥）
- **桥接**：`agent connect codex` 检测到桌面版 → 引导同事装 Codex CLI（同账号 `~/.codex/auth.json`，几分钟）。桌面留着手动用，多agent 调度走 CLI。
- **可选·只读桥（80/20）**：`notify` 是引擎级钩子。若桌面版也执行 `config.toml` 的 `notify`（§2.3 待验证），则**无需驱动 GUI 即可把桌面会话结果推飞书**（只出不进：能看结果、不能远程发指令）。这是极便宜的增值。
- **完整 GUI 驱动**（`host-codex-app`）→ 仅当同事坚决拒绝 CLI 且业务刚需时才做；先记档，不投机开发。

## 5. 分阶段计划

| 阶段 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| **C0** | 抽 `HostBackend` 接口（纯重构，行为不变，单测护航） | — | 待做 |
| **C1** | 抽 `AgentAdapter` + claude adapter（把现有硬编码搬进去，行为不变） | C0 | 待做 |
| **C2** | Codex CLI adapter：`mchat-codex-notify` + upsert config.toml + detect/login/launch | C1 + §6 待查 | 待做 |
| **C3** | `/connect` 加 codex 项 + `agent connect codex` 引导（含桌面→CLI 桥接） | C2 | 待做 |
| **C4**（可选） | 桌面版只读回传桥（验证 notify 对桌面触发后再定） | §6 验证 | 待定 |
| **C-future** | `host-codex-app`（Electron GUI 驱动） | 有刚需才启 | 记档 |

先做 C0→C1 拿到解耦收益（顺带让未来任何 agent/宿主都好接），再 C2→C3 把 Codex CLI 接通。

## 6. 待拍板 / 需提供 / 需验证

1. **同事的 Codex 是 CLI 还是桌面?**（gating——但即使桌面，答案已是「桥接到 CLI」，不再是死路）
2. **Codex CLI 的 `notify` payload schema**（字段名、是否含最后消息全文、cwd、session id）——查 codex 官方文档。
3. **Codex CLI 的启动 / 续接命令**（`codex` 之外，resume/continue 怎么写）。
4. **桌面版是否执行 `config.toml` 的 `notify`**（决定 C4 只读桥是否成立）——在一台真跑桌面版的机器上测。
5. **Codex CLI 的分发方式**（npm `@openai/codex` / brew / 其它）——写进 `agent connect codex` 的引导。
6. Codex 是否有 headless（对标 `claude -p`）——若有，planner/knowledge 也能按用户偏好切；否则统一用本机 claude 跑后台，不阻塞。

## 7. 与现有约定的衔接

- 回传钩子脚本沿用 `bin/mchat-stop-hook` 的铁律：**ESM**（root `package.json` 是 `"type":"module"`，`require()` 会静默 crash）、fire-and-forget `detached` + `unref` + 立即 `exit 0`、跳过内部 headless（`MCHAT_INTERNAL_SESSION=1` / 父进程含 `-p`）。见 CLAUDE.md「Stop hook 脚本必须 ESM」。
- 新增对接项按第 8 条约定：改 registry + `/connect` + `agent connect`，并在 `CHANGELOG.md` 顶部追加。
- adapter/backend 放 `orchestrator`（宿主无关、传输无关）；host 相关实现留 `host-mac`；飞书专属的引导卡才留 `im-lark`。
