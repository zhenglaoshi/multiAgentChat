/**
 * tab 状态推断 —— **宿主无关**的纯逻辑（原在 `host-mac/src/terminal/status.ts`）。
 *
 * 为什么在 orchestrator 而不在某个 host 包：判据只有「进程名列表 + busy + 屏幕尾巴文本」，
 * 跟 AppleScript / tmux / ConPTY 怎么拿到这三样毫无关系。留在 host-mac 里的话，第二个宿主
 * （host-tmux）只能原样抄一份 —— 两份分类逻辑必然漂移（改了 claude 的等待态识别却忘了改另一份，
 * 表现是「同一个 tab 在 Mac 上显示等输入、在 tmux 上显示跑着」这种极难排查的不一致）。
 *
 * 各宿主只负责把自己那套「怎么拿到进程列表」适配成 `TabStatusInput`。
 */

import { detectAgentFromProcs } from './registry.js';

export type TabStatusKind =
  | 'shell-idle'       // shell prompt 闲（没 agent）
  | 'shell-busy'       // shell 跑别的命令（npm/git/...）
  | 'claude-active'    // agent 在跑（thinking / 执行 tool）
  | 'claude-waiting'   // agent 等用户输入（与 watcher needsInput 信号叠加）
  | 'claude-login'     // agent 需要登录
  | 'tui'              // vim/htop 等独占
  | 'unknown';

export interface TabStatusInfo {
  kind: TabStatusKind;
  label: string;
  icon: string;
  /** 在卡片渲染时优先显示的副标题（cwd / 进程名等） */
  detail?: string;
}

/** 推断只需要这三样 —— 宿主把自己的 tab 模型摊平成这个形状即可。 */
export interface TabStatusInput {
  processes: string[];
  busy: boolean;
}

/**
 * 会被 `do script` / `send-keys` 写坏的独占式 TUI 程序。
 * ⚠ 含 `tmux` / `screen`：在 **Mac 宿主**下，tab 里跑着 tmux 说明用户自己开了个复用器，
 * 往里送字符同样会错位。tmux 宿主下 pane 的进程列表里不会出现 tmux server 本身（它不在 pane 的 tty 上），
 * 所以这条不会自己误伤自己。
 */
/*
 * ⚠ 已知误判（评审记录，2026-09-14）：判定用 basename 归一后，**basename 撞名的正经 CLI 会被误当 TUI**，
 * 后果是 `send()` 拒绝往那个 tab 发文本（飞书会收到"在跑 xx（TUI），已拒绝"）。
 * 最可能踩到的是 `mc` —— 这里的原意是 Midnight Commander，但 **MinIO 的命令行客户端也叫 `mc`**
 * （`mc cp` / `mc ls`，S3 运维很常见）。`top` / `man` / `more` / `lf` 同理都是短到容易被复用的名字。
 * 选择保留现状：误判是 **fail-safe**（拒绝发送，不会弄坏终端），而漏判 vim/htop 会让 `do script`/`send-keys`
 * 把人家的编辑器写乱。真踩到了就从这个集合里摘掉对应条目。
 */
export const TUI_PROCS: ReadonlySet<string> = new Set([
  'vim', 'vi', 'nvim', 'emacs', 'nano', 'pico', 'micro',
  'less', 'more', 'man', 'top', 'htop', 'btop', 'atop',
  'fzf', 'tmux', 'screen', 'mc', 'ranger', 'nnn', 'lf',
]);

/**
 * 进程名归一化：去掉路径与 login shell 的前导 `-`，转小写。
 * 各宿主给的进程名形式不一（Mac 的 AppleScript 可能给全路径、`-zsh` 这种 login shell 形式；
 * tmux 侧读 `ps -o args=` 拿到的是 argv[0]，带路径是常态），判定前统一收敛。
 */
export function procBasename(proc: string): string {
  return (proc.replace(/^-/, '').split('/').pop() ?? proc).toLowerCase();
}

/** 进程名列表里有没有独占式 TUI（返回第一个命中的**原始**进程名，没有则 undefined）。 */
export function findTuiProc(processes: string[]): string | undefined {
  return processes.find((p) => TUI_PROCS.has(procBasename(p)));
}

/** 列表里是否有独占式 TUI —— `hasTUI` 标记与 `send` 的拒绝判据共用这一条。 */
export function hasTuiProc(processes: string[]): boolean {
  return findTuiProc(processes) !== undefined;
}

/** 「屏幕在等人回答」的文本特征（agent 的选项菜单 / y-n 询问 / 按任意键）。 */
const WAITING_PATTERNS: RegExp[] = [
  /^\s*[☐☒○●⊙◯◉]/m,
  // `›`(U+203A) 是 codex 选项菜单的当前项前缀，原来不在集合里
  /^[❯>►▶›]\s+\S/m,
  /\(\s*[Yy]\s*\/\s*[Nn]\s*\)/,
  /\([Nn]\/[Yy]\)/,
  // ⚠ 必须 /i：codex 的 "Press enter to confirm" 是**小写 enter**，
  // 原来只认大写 Enter，整屏审批菜单因此一条都不命中（2026-09-14 实测）
  /[Pp]ress\s+(enter|return|[Yy]|[Nn]|any\s+key|space)/i,
  /[\[\(]\s*Y\/n\s*[\]\)]/,
  /[\[\(]\s*y\/N\s*[\]\)]/,
];

/**
 * 由进程列表 + 屏幕尾巴推断 tab 状态。
 * 逻辑与原 `host-mac/terminal/status.ts` **逐字一致**（含 label/icon 文案与判定顺序），
 * 只是把入参从 `TerminalTab` 放宽成 `TabStatusInput`，让第二个宿主也能用。
 */
/**
 * 文本判据只看**屏幕尾部这么多行**。
 *
 * ⚠ 调用方传进来的 `historyTail` 未必真是"tail"：fleet-monitor 传的是 watcher 缓存的**完整历史**，
 * 而 tmux 的 `capture-pane` 还可能带很长的 scrollback。不收敛的话，一次**早已答完**的 codex 审批
 * （"Would you like to run the following command?" / "Press enter to confirm"）会永远留在历史里 →
 * 该 tab **长期显示"codex 等输入"**，`/shells` 状态是错的，fleet-monitor 也不再按 `claude-active`
 * 处理它、从而漏掉卡住检测（评审 2026-09-15 指出）。
 * 这与原生菜单镜像那条 critical 是同一类错误：**闸门的取景框必须有界**。
 */
const STATUS_TAIL_LINES = 40;

/** 取尾部若干行 —— 状态判据一律基于它，不看整段历史。 */
function boundTail(text: string): string {
  const lines = text.split('\n');
  return lines.length <= STATUS_TAIL_LINES ? text : lines.slice(-STATUS_TAIL_LINES).join('\n');
}

export function inferTabStatusFrom(
  tab: TabStatusInput,
  historyTailRaw?: string,
): TabStatusInfo {
  const historyTail = historyTailRaw === undefined ? undefined : boundTail(historyTailRaw);
  // agent 识别走 AgentAdapter registry：认 claude 与 codex
  const agent = detectAgentFromProcs(tab.processes);

  // TUI 优先（vim/htop 等独占）
  const tuiProc = findTuiProc(tab.processes);
  if (tuiProc && !agent) {
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
      // 通用判据 + 该 agent 自己声明的原生菜单特征（各 agent 菜单长得不一样，见 AgentAdapter.waitingPatterns）
      if ([...WAITING_PATTERNS, ...agent.waitingPatterns].some((re) => re.test(historyTail))) {
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

  // shell busy 但没 agent — 跑着别的命令
  const lastProc = tab.processes[tab.processes.length - 1] ?? 'shell';
  return {
    kind: 'shell-busy',
    label: `⚙️ 跑着 ${lastProc}`,
    icon: '⚙️',
    detail: lastProc,
  };
}
