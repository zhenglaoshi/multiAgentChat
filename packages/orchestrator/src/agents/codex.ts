import type { AgentAdapter } from './types.js';
import { buildSystemGuidance, buildTuiReminder } from './guidance.js';

/**
 * Codex CLI adapter。
 *
 * 已本机验证（codex-cli 0.144.5，`codex --help`）：二进制/进程名 `codex`、
 * `resume --last` 续接、`login`/`exec` 子命令、config = `~/.codex/config.toml`。
 *
 * ⚠ `unverified: true` 仅剩一处：**`notify` 的 payload 确切格式**（据 OpenAI Codex 文档为
 * argv 末位 JSON 串含 `type=agent-turn-complete` + `last-assistant-message`），需 C2 里跑一次
 * 真机 turn（配 notify 脚本）落实字段名与触发时机后再摘掉此标记。
 *
 * 宿主形态：本 adapter 面向 **Codex CLI（跑在 Terminal.app tab）**；桌面 App 走"桥接到 CLI"
 * （见 docs/codex-integration.md §4.2），不由本 adapter 驱动。
 */
export const codexAdapter: AgentAdapter = {
  kind: 'codex',
  displayName: 'Codex CLI',
  binaryName: 'codex',
  detect: (p) => p === 'codex' || p === 'codex-cli' || p.endsWith('/codex'),
  loginPatterns: [
    /Sign\s+in\s+with\s+ChatGPT/i,
    /run\s+`?codex\s+login/i,
    /not\s+logged\s+in/i,
    /Authentication\s+required/i,
    /Not\s+(yet\s+)?authenticated/i,
  ],
  /**
   * codex 的**原生命令审批菜单**（`approval_policy` 触发，不经 hook，我们的审批闸看不到它）。
   * 真机样本（2026-09-14 用户截图）：
   *   Would you like to run the following command?
   *   › 1. Yes, proceed (y)
   *     2. No, and tell Codex what to do differently (esc)
   *   Press enter to confirm or esc to cancel
   * 这三条各自都足够特征化，不会被普通 scrollback 误触发（「等输入」假阳性在本项目有前科）。
   */
  /**
   * 原生**命令审批**菜单的高置信特征 —— **两条必须同时命中**（AND）。
   * 真机样本（用户截图）里这两句成对出现，而 assistant 在正常回答里同时逐字写出这两句
   * 基本不可能；只靠其中任何一条都不够（`1. Yes, proceed` 这种写法模型自己也会用）。
   *
   * ⚠ 覆盖面有意窄：codex 若还有别的原生菜单（文件编辑审批等）措辞不同，**不会**被镜像 ——
   * 宁可漏认（退回现状）也不能错认（往干活的 tab 注入数字）。要扩就往这里加成对特征。
   */
  nativeMenuPatterns: [
    /Would\s+you\s+like\s+to\s+run\s+the\s+following\s+command/i,
    /[Pp]ress\s+enter\s+to\s+confirm/i,
  ],
  waitingPatterns: [
    /Would\s+you\s+like\s+to\s+run\s+the\s+following\s+command/i,
    /\d+\.\s+Yes,\s*proceed/i,
    /[Pp]ress\s+enter\s+to\s+confirm/i,
  ],
  // 已验证：交互式 `codex`；续接 `codex resume --last`（picker 默认，--last 直接续上一个）
  launchCommand: (o) => (o?.continueSession ? 'codex resume --last' : 'codex'),
  // codex 内建 slash（待补/验证；先留常见项，C2 wiring 时核对）
  builtinSlashCommands: ['model', 'approvals', 'new', 'init', 'compact', 'diff', 'mention', 'status', 'mcp', 'logout', 'quit'],
  skillDirsFromHome: ['.agents/skills'],
  returnChannel: {
    kind: 'codex-notify',
    configPathFromHome: '.codex/config.toml',
    payloadSource: 'argv-json',
    messageField: 'last-assistant-message',
  },
  /**
   * codex 0.154+ 的 lifecycle hooks —— 与 Claude Code 的 hook 协议**同构**，所以直接复用同一批脚本。
   *
   * 依据（从 codex 二进制内嵌的 JSON Schema 抽出，见 docs/codex-integration.md §8）：
   *  - 事件名同名：PreToolUse / PostToolUse / Stop / UserPromptSubmit / SessionStart / ...
   *  - 入参字段逐字相同：`hook_event_name` / `session_id` / `cwd` / `transcript_path` /
   *    `last_assistant_message`（Stop）/ `tool_name` / `tool_input`（PreToolUse）
   *  - 出参字段逐字相同：`hookSpecificOutput.{hookEventName,permissionDecision,permissionDecisionReason}`
   *
   * 两处与 claude 的**关键差异**：
   *  1. `matcher` 是**正则**（codex 内部包成 `\A(?:…)\z` 全值匹配），claude 是字面量工具名。
   *     所以"匹配全部"在 codex 要写 `.*`，写 `*` 会被当无效正则。
   *  2. codex 的 shell 工具在 `tool_name` 里叫什么**尚未真机确认**（候选：shell / exec_command /
   *     unified_exec）。所以这里**不赌工具名**，一律 `.*` 全匹配，由 mchat-permission-hook 自己按
   *     payload 形状判断是不是 shell 调用 —— 赌错工具名的后果是审批闸**静默失效**，比多跑几次脚本危险得多。
   *
   * 不装的：AskUserQuestion 的 Pre/PostToolUse（codex 没这个工具）、Task hook（codex 没 Task 工具）。
   */
  hookInstall: {
    configPathFromHome: '.codex/config.toml',
    format: 'codex-config-toml',
    specs: [
      // fire-and-forget（spawn 完就 exit），30s 绰绰有余
      { event: 'Stop', matcher: '.*', script: 'mchat-stop-hook', purpose: 'turn 结束把 last_assistant_message 推飞书', timeoutSec: 30 },
      // **阻塞型**：要等人在飞书上点批准/拒绝。审批 auto-timeout 是 5min，这里给 6min 兜底，
      // 给短了会在人还没点的时候被 codex 掐断 → 闸门退化成"没拦住"。
      { event: 'PreToolUse', matcher: '.*', script: 'mchat-permission-hook', purpose: '高危 shell 命令抢在原生审批前推飞书审批卡', timeoutSec: 360 },
    ],
  },
  systemGuidance: buildSystemGuidance('codex'),
  tuiReminder: buildTuiReminder('codex'),
  unverified: true, // 仍待真机：notify payload 格式、codex shell 工具的 tool_name 取值
};
