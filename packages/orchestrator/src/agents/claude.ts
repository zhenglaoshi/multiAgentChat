import type { AgentAdapter } from './types.js';

/**
 * Claude Code adapter —— 忠实还原当前散落在 host-mac/status.ts、restart.ts、
 * commands.ts、daemon 里的 claude 专属值。抽出来后行为不变，只是集中。
 */
export const claudeAdapter: AgentAdapter = {
  kind: 'claude',
  displayName: 'Claude Code',
  binaryName: 'claude',
  // 对齐 host-mac/status.ts:54
  detect: (p) => p === 'claude' || p === 'claude-code' || p.endsWith('/claude'),
  // 对齐 host-mac/status.ts 的完整 LOGIN_PATTERNS（通用几条 + claude 专属），保证接线后 byte-identical
  loginPatterns: [
    /Please\s+(log|sign)\s*in/i,
    /You\s+(need\s+to\s+)?log\s*in/i,
    /Sign\s+in\s+to\s+Claude/i,
    /console\.anthropic\.com\/login/i,
    /Authentication\s+required/i,
    /Not\s+(yet\s+)?authenticated/i,
    /OAuth\s+token/i,
    /run\s+`?claude\s+\/login/i,
    /run\s+`?claude\s+(auth|login)/i,
  ],
  // 对齐 host-mac/terminal/restart.ts:104
  launchCommand: (o) => (o?.continueSession ? 'claude --continue' : 'claude'),
  // 对齐 im-lark/lark/commands.ts 的 CLAUDE_CODE_NATIVE_SLASH
  builtinSlashCommands: [
    'config', 'model', 'clear', 'agents', 'skills', 'permissions',
    'cost', 'doctor', 'compact', 'export', 'memory', 'resume',
    'review', 'vim', 'ide', 'mcp', 'add-dir', 'allowed-tools',
    'init', 'todo', 'status', 'logout', 'login', 'bug', 'release-notes',
    'security-review', 'pr-comments',
    'loop', 'schedule', 'goal', 'ultrathink',
  ],
  skillDirsFromHome: ['.claude/skills'],
  returnChannel: {
    kind: 'claude-stop-hook',
    configPathFromHome: '.claude/settings.json',
    payloadSource: 'stdin-json',
    messageField: 'last_assistant_message',
  },
};
