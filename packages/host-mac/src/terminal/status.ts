import type { TerminalTab } from './types.js';
import { detectAgentFromProcs } from 'multiagent-orchestrator';

export type TabStatusKind =
  | 'shell-idle'       // shell prompt 闲（没 claude）
  | 'shell-busy'       // shell 跑别的命令（npm/git/...）
  | 'claude-active'    // claude 在跑（thinking / 执行 tool）
  | 'claude-waiting'   // claude 等用户输入（与 watcher needsInput 信号叠加）
  | 'claude-login'     // claude 需要登录
  | 'tui'              // vim/htop 等独占
  | 'unknown';

export interface TabStatusInfo {
  kind: TabStatusKind;
  label: string;
  icon: string;
  /** 在卡片渲染时优先显示的副标题（cwd / 进程名等） */
  detail?: string;
}

const TUI_PROCS = new Set([
  'vim', 'vi', 'nvim', 'emacs', 'nano', 'pico', 'micro',
  'less', 'more', 'man', 'top', 'htop', 'btop', 'atop',
  'fzf', 'tmux', 'screen', 'mc', 'ranger', 'nnn', 'lf',
]);

// 登录态识别文案已移入 AgentAdapter（claude/codex 各自的 loginPatterns），见 orchestrator/agents

const WAITING_PATTERNS: RegExp[] = [
  /^\s*[☐☒○●⊙◯◉]/m,
  /^[❯>►▶]\s+\S/m,
  /\(\s*[Yy]\s*\/\s*[Nn]\s*\)/,
  /\([Nn]\/[Yy]\)/,
  /[Pp]ress\s+(Enter|Return|[Yy]|[Nn]|any\s+key|space)/,
  /[\[\(]\s*Y\/n\s*[\]\)]/,
  /[\[\(]\s*y\/N\s*[\]\)]/,
];

export function inferTabStatus(
  tab: TerminalTab,
  historyTail?: string,
): TabStatusInfo {
  const procs = tab.processes.map((p) => p.toLowerCase());
  // agent 识别走 AgentAdapter registry：claude 逻辑逐字不变，顺带认 codex（多 agent 解耦）
  const agent = detectAgentFromProcs(tab.processes);
  const hasClaude = agent !== null;

  // TUI 优先（vim/htop 等独占）
  const tuiProc = tab.processes.find((p) => TUI_PROCS.has(p.toLowerCase()));
  if (tuiProc && !hasClaude) {
    return { kind: 'tui', label: `TUI: ${tuiProc}`, icon: '⚠️' };
  }

  if (agent) {
    if (historyTail) {
      if (agent.loginPatterns.some((re) => re.test(historyTail))) {
        return {
          kind: 'claude-login',
          label: `🔐 ${agent.kind} 需要登录`,
          icon: '🔐',
          detail: agent.kind === 'codex' ? '运行 `codex login` 或重启 codex' : '运行 `claude /login` 或重启 claude',
        };
      }
      if (WAITING_PATTERNS.some((re) => re.test(historyTail))) {
        return {
          kind: 'claude-waiting',
          label: `⏳ ${agent.kind} 等输入`,
          icon: '⏳',
        };
      }
    }
    return { kind: 'claude-active', label: `🤖 ${agent.kind} 跑着`, icon: '🤖' };
  }

  if (!tab.busy) {
    return { kind: 'shell-idle', label: '💤 shell 闲', icon: '💤' };
  }

  // shell busy 但没 claude — 跑着别的命令
  const lastProc = tab.processes[tab.processes.length - 1] ?? 'shell';
  return {
    kind: 'shell-busy',
    label: `⚙️ 跑着 ${lastProc}`,
    icon: '⚙️',
    detail: lastProc,
  };
}
