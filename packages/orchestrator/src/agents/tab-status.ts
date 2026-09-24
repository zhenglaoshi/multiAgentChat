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
  | 'claude-idle'      // agent 空着、等人发下一条（一轮答完晾着）—— 目前只 claude 能识别，见 agentIdleByTitle
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

/** 推断只需要这几样 —— 宿主把自己的 tab 模型摊平成这个形状即可。 */
export interface TabStatusInput {
  processes: string[];
  busy: boolean;
  /** tab 标题（识别 agent 空闲用；拿不到就不传，退回原判定） */
  title?: string;
}

/**
 * 靠 tab 标题判断 agent 是否**空闲、等人发下一条**。
 *
 * 为什么需要：屏幕文本分不出「空闲」和「在干活只是这会儿没输出」——两者都是静止的。
 * 没有这一档时空闲的 claude 一律归 `claude-active`：`/shells` 显示「跑着」，fleet 卡住哨兵
 * 晾 8 分钟就报「可能卡住」（用户真机报障：用完 ttys000 晾着就反复收到）。
 *
 * 信号：Claude Code 空闲时把终端标题设成 `✳ <话题>`，干活时（含 tool 执行、等 API）是转动的
 * `◐◓◑◒`。真卡住（命令挂死 / API 不回）时标题仍在转 → 仍是 active，卡住告警不受影响。
 * 只认 claude：codex 的标题约定没验证过，保持原行为（宁可误报卡住，不可漏报）。
 * 标题可被 tab 内程序用 OSC 转义改写 —— 所以它只用于显示 / 提醒，**不得**用于任何注入决策。
 */
export function agentIdleByTitle(agentKind: string | undefined, title: string | undefined): boolean {
  return agentKind === 'claude' && (title ?? '').trimStart().startsWith('✳');
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
 * 「在等输入」的判据只看**屏幕最末尾这几条非空行**。
 *
 * ⚠ 为什么不是"尾部 40 行"（第一版就是这么写的，评审指出仍然不够）：
 * 判据是按文本匹配的，而**菜单答完之后那几行文案还留在原地**。用户给的反例：
 *     Press enter to confirm or esc to cancel
 *     yes
 *     command finished
 * 菜单早就关了，但这三行都在 40 行窗口内 → 仍判「codex 等输入」→ `/shells` 状态是错的、
 * fleet-monitor 也不再按 `claude-active` 处理它，从而漏掉卡住检测。
 *
 * 真正可靠的信号是**位置而不是存在**：菜单还活着时，它的提示行就是屏幕的**最后一行**；
 * 一旦被答掉，后续输出会把它顶上去。所以只在「最末尾这几条非空行」里匹配。
 *
 * 取 **2** 行是实测定的：用户给的反例里菜单答完只追加了 `yes` + `command finished` 两行，
 * 窗口放到 3 行就仍会命中 `Press enter to confirm`（它是菜单的最后一行）。2 行才能把它顶出去。
 *
 * **承认的代价**（宁可漏判，不可错判）：选项很多、且末尾没有提示行的菜单，
 * 「等输入」可能识别不出来 → 只影响**显示**（`/shells` 显示成"跑着"而不是"等输入"），
 * 不影响任何注入决策 —— 原生菜单镜像走的是自己那套独立且更严的闸门（见 native-menu.ts）。
 * **残留局限**：答完后若**一行输出都没有**（命令无输出且瞬间结束），这一拍仍会判成等输入，
 * 下一拍有输出就自愈 —— 静态快照下这个歧义无法根除，只能缩小窗口。
 */
const STATUS_TAIL_NONEMPTY_LINES = 2;

/** 取最末尾若干条**非空**行 —— 状态判据一律基于它，不看整段历史、也不看整个 40 行窗口。 */
function tailForWaiting(text: string): string {
  const nonEmpty = text.split('\n').filter((l) => l.trim() !== '');
  return nonEmpty.slice(-STATUS_TAIL_NONEMPTY_LINES).join('\n');
}

/**
 * 登录态判据的窗口 —— 比「等输入」宽松：登录提示出现后不会被后续输出顶掉语义
 * （没登录就是没登录），只要别在整段无界历史里匹配即可。
 */
const STATUS_TAIL_LINES = 40;

function boundTail(text: string): string {
  const lines = text.split('\n');
  return lines.length <= STATUS_TAIL_LINES ? text : lines.slice(-STATUS_TAIL_LINES).join('\n');
}

export function inferTabStatusFrom(
  tab: TabStatusInput,
  historyTailRaw?: string,
): TabStatusInfo {
  const historyTail = historyTailRaw === undefined ? undefined : boundTail(historyTailRaw);
  // 「等输入」用更窄的窗口（见 tailForWaiting 的说明）
  const waitingTail = historyTailRaw === undefined ? undefined : tailForWaiting(historyTailRaw);
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
      if (waitingTail && [...WAITING_PATTERNS, ...agent.waitingPatterns].some((re) => re.test(waitingTail))) {
        return {
          kind: 'claude-waiting',
          label: `⏳ ${agent.kind} 等输入`,
          icon: '⏳',
        };
      }
    }
    // 放在登录 / 等输入之后：弹着菜单时标题也可能是 ✳，那时该显示「等输入」
    if (agentIdleByTitle(agent.kind, tab.title)) {
      return { kind: 'claude-idle', label: `💬 ${agent.kind} 空闲`, icon: '💬' };
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
