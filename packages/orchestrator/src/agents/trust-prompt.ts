/**
 * agent 首次进未信任目录时的「信任此目录吗？」提示 —— 读屏判定 + 按光标位置作答（纯逻辑，IO 由宿主注入）。
 *
 * 为什么不再「按时序盲按回车」：Claude Code 2.1.280 起该提示的选项是
 *   ❯ No, exit
 *     Yes, I trust this folder
 * **默认高亮 No**。老逻辑默认「第一项=信任」盲按回车 → 选中 No → claude 立刻退出，
 * 飞书 `/new` 开在没信任过的目录（如 `~`）里起 claude 必失败（2026-11-05 实测，两次都退回裸 shell）。
 * 选项也不带编号，pty 写数字选不中（实测数字被忽略、块尾 \r 照样确认了 No）。
 *
 * 作答方式（宿主实现）：光标在 Yes → 回车；光标在 No → 「下 + 回车」。macOS 上 `do script "\x1b[B"`
 * 往 pty 写的是 `ESC[B\r` 一整块，claude 解析成「下箭头 + 回车」直接选中 Yes 并确认 —— 不经 System Events，
 * 锁屏可用（实测 2026-11-05）。tmux 上是 send-keys Down Enter。
 *
 * ⚠ 判定偏保守：拿不准 → 不按任何键。误判的代价是往 agent 输入框里按「下+回车」（翻历史并提交）。
 * 关键守卫：提示必须是屏幕上**最后一个**光标行（`❯`/`›`）。`contents` 会带着已被关掉的旧提示残影，
 * 之后 agent 主界面的输入框 `❯` 会出现在它下面 → 不再算提示。
 */

export type TrustCursor = 'yes' | 'no';

/**
 * 提示正文特征 —— 只认**具体已知文案**，不认单个 `trust` 词（安全评审 2026-11-05：单词级匹配可能把
 * 上方 15 行里恰好出现 trust 的「Allow this command?」高危命令审批菜单误认成信任提示，替人点了批准）。
 */
const TRUST_TEXT_RE = /trust this folder|trust the (files|contents)|one you trust|allow \S+ to work in this folder/i;
/** 光标行：claude `❯` / codex `›`，后面的文字是高亮的选项（空 = 输入框） */
const CURSOR_LINE_RE = /^\s*[❯›]\s?(.*)$/;
/** 选项文字可能带编号（老版本 `❯ 1. Yes, proceed`） */
const OPTION_NUM_RE = /^\d+\s*[.)]\s*/;
/** 「信任」选项的已知文案：claude 2.1.280 / 老版本 claude / codex */
const YES_OPTION_RE = /^yes,?\s+(i trust this folder|proceed\b|allow \S+ to work in this folder)/i;
/** 「不信任」选项的已知文案 —— 刻意不认「No, and tell Claude…」这类命令审批菜单的拒绝项 */
const NO_OPTION_RE = /^no,?\s+(exit|quit|ask me to approve)\b/i;
/** 提示下方最多容纳的非空行（剩下的选项 + 「Enter to confirm · Esc to cancel」） */
const MAX_LINES_AFTER_CURSOR = 6;
/** 正文到光标行的最大距离（claude 隔着「Security guide」等 ~6 行） */
const CONTEXT_LINES_ABOVE = 12;
/** 另一个选项离光标行的最大距离 */
const SIBLING_DISTANCE = 3;
/** agent 主界面输入框的上下边框 */
const BOX_BORDER_RE = /^\s*─{8,}/;

function lastCursorLine(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CURSOR_LINE_RE.test(lines[i]!)) return i;
  }
  return -1;
}

function optionText(line: string): string {
  return line.replace(/^\s*[❯›]?\s*/, '').replace(OPTION_NUM_RE, '').trim();
}

/**
 * 屏幕底部是不是正停在信任提示上；是 → 光标在哪个选项。不是 / 拿不准 → null。
 * 三个条件同时成立才算：光标项是已知「信任/不信任」文案、相邻几行里有**另一个**已知选项、
 * 光标行上方不远处有已知提示正文。
 */
export function parseTrustPrompt(screen: string): { cursor: TrustCursor } | null {
  const lines = screen.split('\n');
  const idx = lastCursorLine(lines);
  if (idx < 0) return null;
  const option = optionText(lines[idx]!);
  if (!option) return null; // 空输入框 = agent 主界面
  const after = lines.slice(idx + 1).filter((l) => l.trim());
  if (after.length > MAX_LINES_AFTER_CURSOR || after.some((l) => BOX_BORDER_RE.test(l))) return null;
  const cursor: TrustCursor | null = YES_OPTION_RE.test(option) ? 'yes' : NO_OPTION_RE.test(option) ? 'no' : null;
  if (!cursor) return null;
  const siblingRe = cursor === 'yes' ? NO_OPTION_RE : YES_OPTION_RE;
  const near = lines.slice(Math.max(0, idx - SIBLING_DISTANCE), idx + SIBLING_DISTANCE + 1);
  if (!near.some((l, i) => i !== Math.min(idx, SIBLING_DISTANCE) && siblingRe.test(optionText(l)))) return null;
  const context = lines.slice(Math.max(0, idx - CONTEXT_LINES_ABOVE), idx).join('\n');
  if (!TRUST_TEXT_RE.test(context)) return null;
  return { cursor };
}

/** agent 主界面已就绪：最后一个光标行是输入框（空，或下方紧跟输入框边框）。 */
export function agentInputReady(screen: string): boolean {
  const lines = screen.split('\n');
  const idx = lastCursorLine(lines);
  if (idx < 0) return false;
  const option = (CURSOR_LINE_RE.exec(lines[idx]!)?.[1] ?? '').trim();
  if (!option) return true;
  const next = lines.slice(idx + 1).find((l) => l.trim());
  return next !== undefined && BOX_BORDER_RE.test(next);
}

export interface TrustPromptIO {
  readScreen(): Promise<string>;
  /** 单独一个回车（确认当前高亮项） */
  pressEnter(): Promise<void>;
  /** 下箭头 + 回车（从 No 移到 Yes 并确认） */
  pressDownEnter(): Promise<void>;
  sleep?(ms: number): Promise<void>;
}

/**
 * - accepted：看到提示并已选中「信任」
 * - none：没出现提示（目录已信任）/ agent 已就绪
 * - stuck：提示一直在、作答没生效（或光标认不出）—— 调用方应告知用户去那个 tab 手动选
 * - unreadable：屏幕读不到，什么都没按
 */
export type TrustPromptOutcome = 'accepted' | 'none' | 'stuck' | 'unreadable';

export async function acceptTrustPrompt(
  io: TrustPromptIO,
  opts: { timeoutMs?: number; pollMs?: number; settleMs?: number; maxActions?: number; minReadyMs?: number } = {},
): Promise<TrustPromptOutcome> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  // agent 还没画出界面时，屏幕上是 shell 提示符 —— 有的 zsh 主题本身就是 `❯`，会被认成「输入框就绪」。
  // 早退前至少等这么久（claude 画出信任提示实测 ~2s）。
  const minReadyMs = opts.minReadyMs ?? 3000;
  const pollMs = opts.pollMs ?? 600;
  const settleMs = opts.settleMs ?? 1200;
  const maxActions = opts.maxActions ?? 2;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let actions = 0;
  let readFailures = 0;
  let sawPrompt = false;
  /** 最后一屏底部有提示正文、但光标认不出（版本改了文案 / 布局）→ 超时报 stuck 而不是 none */
  let unparsedTrustText = false;
  let waited = 0;
  while (waited < timeoutMs) {
    await sleep(pollMs);
    waited += pollMs;
    let screen: string;
    try {
      screen = await io.readScreen();
    } catch {
      if (++readFailures >= 3) return sawPrompt ? 'stuck' : 'unreadable';
      continue;
    }
    const prompt = parseTrustPrompt(screen);
    if (!prompt) {
      if (sawPrompt) return 'accepted';
      if (waited >= minReadyMs && agentInputReady(screen)) return 'none';
      unparsedTrustText = TRUST_TEXT_RE.test(screen.split('\n').slice(-20).join('\n'));
      continue;
    }
    sawPrompt = true;
    if (actions >= maxActions) return 'stuck';
    actions++;
    if (prompt.cursor === 'yes') await io.pressEnter();
    else await io.pressDownEnter();
    await sleep(settleMs);
    waited += settleMs;
  }
  return sawPrompt || unparsedTrustText ? 'stuck' : 'none';
}
