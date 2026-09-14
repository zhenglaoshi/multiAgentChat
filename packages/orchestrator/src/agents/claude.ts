import type { AgentAdapter } from './types.js';
import { buildSystemGuidance, buildTuiReminder } from './guidance.js';

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
  // ⚠ 顺序 = 写进 ~/.claude/settings.json 的顺序，与历史安装逻辑逐条一致（tests/agents.test.ts 钉住）。
  hookInstall: {
    configPathFromHome: '.claude/settings.json',
    format: 'claude-settings-json',
    specs: [
      { event: 'Stop', matcher: '*', script: 'mchat-stop-hook', purpose: 'turn 结束把 last_assistant_message 推飞书' },
      { event: 'PreToolUse', matcher: 'AskUserQuestion', script: 'mchat-pretooluse-hook', purpose: '原生选项菜单弹出前先把问题+选项镜像到飞书' },
      { event: 'PostToolUse', matcher: 'AskUserQuestion', script: 'mchat-posttooluse-hook', purpose: '本地作答后关卡（清 chat.askArm）' },
      { event: 'PreToolUse', matcher: 'Bash', script: 'mchat-permission-hook', purpose: '高危命令抢在原生提示前推飞书审批卡' },
      { event: 'PreToolUse', matcher: 'Task', script: 'mchat-task-hook', purpose: 'SOP 阶段自动 --start 打点' },
    ],
  },
  systemGuidance: buildSystemGuidance('claude'),
  tuiReminder: buildTuiReminder('claude'),
};
