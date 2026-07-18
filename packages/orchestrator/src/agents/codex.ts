import type { AgentAdapter } from './types.js';

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
  unverified: true, // 仅 notify payload 格式待真机 turn 验证
};
