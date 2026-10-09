/**
 * 「发到 agent TUI 的文本到底提交了没有」的纯判定 —— 读当前可视屏幕，看输入框里还挂没挂着刚发的那段。
 *
 * 为什么需要：`do script` 把「文本+\r」整块写进 pty，TUI 当粘贴处理；之后单独补的那个 `\r`
 * 在 Claude Code 2.1.280 上**不提交**，而是触发粘贴安全提示
 * `Removed 1 invisible character · review and press Enter to send`（粘贴块里的不可见字符 = 块尾那个 `\r`，
 * 被剥掉后要求人再按一次回车确认）。实测 2026-10-09：143 字单行、3KB、8.8KB 补一次回车全部挂住、
 * 第二次才发出；23 字不算粘贴、靠块尾 `\r` 自己就提交了。所以调用方要「补回车 → 读屏校验 → 没提交再补」。
 *
 * ⚠ 判定必须偏保守（拿不准 → 不算挂着，不再补）：提交后 agent 可能立刻弹权限 / 选项菜单
 * （`❯ 1. Yes`），这时多补一个 `\r` 就是替人点了默认项。
 */

/** 去掉所有空白：TUI 会按宽度折行并给续行加缩进，逐字比对前先压平。 */
function compact(s: string): string {
  return s.replace(/\s+/g, '');
}

/** 用发送文本的末尾一小段当探针（输入框挂着时，屏幕底部一定是正文的结尾）。 */
const PROBE_LEN = 16;
const MIN_PROBE_LEN = 4;

/** 输入框起始行：claude `❯` / codex `›` */
const PROMPT_LINE_RE = /^\s*[❯›](\s|$)/;
/** 选择菜单的高亮项（`❯ 1. Yes` / `› 2) No`）—— 出现即说明已经提交并进入了菜单 */
const MENU_LINE_RE = /^\s*[❯›]\s*\d+\s*[.)]/;
/** 空输入框（已提交、等下一条） */
const EMPTY_PROMPT_RE = /^\s*[❯›]\s*$/;
/** agent 已开始响应的迹象：claude 的 ⏺ 输出块 / 工具调用结果 ⎿ */
const RESPONSE_RE = /[⏺⎿]/;
/** 已提交、正在想的过渡态：claude spinner 字形 / 「esc to interrupt」/ codex「Working」（安全评审 2026-10-09） */
const BUSY_RE = /[✻✢✳✶✽]|esc to interrupt|\bWorking\b/i;

export function submitProbe(sentText: string): string | null {
  const c = compact(sentText);
  if (c.length < MIN_PROBE_LEN) return null;
  return c.slice(-PROBE_LEN);
}

/**
 * true = 刚发的文本还挂在输入框里（没提交）；false = 已提交；null = 判断不了（调用方按「不再补」处理）。
 *
 * 规则：取屏幕上**最后一个**输入框起始行（`❯`/`›`）到底部为观察区（没有就整屏 —— 大段文本会把
 * 输入框起始行顶出屏幕）。观察区里能找到探针、且没有菜单项 / 空输入框 / 响应输出 / thinking 标记 → 挂着。
 * 调用方还应再叠一道「回车前后屏幕完全没变」（被吞的回车不引起任何重绘），见 screenUnchanged。
 */
export function promptStillInInput(screen: string, sentText: string): boolean | null {
  const probe = submitProbe(sentText);
  if (!probe) return null;
  const lines = screen.split('\n');
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PROMPT_LINE_RE.test(lines[i]!)) { start = i; break; }
  }
  const region = lines.slice(start);
  if (region.some((l) => MENU_LINE_RE.test(l) || EMPTY_PROMPT_RE.test(l) || RESPONSE_RE.test(l) || BUSY_RE.test(l))) return false;
  if (!compact(region.join('\n')).includes(probe)) {
    // 观察区没有探针：要么已提交（输入框清空 / 回显被折叠），要么屏幕还没渲染出来 —— 都不该再补
    return compact(screen).includes(probe) ? false : null;
  }
  return true;
}

/** 只比底部 6 个非空行（输入框末行 + 分隔线 + 状态栏）：再多会把顶部 shell 残留框进来（屏幕没填满时），残留被重绘清掉就误判「变了」。spinner / 菜单 / 空输入框一出现，这里必然变。 */
const TAIL_LINES = 6;
/**
 * 被吞的回车本身会让 claude 在状态栏右侧冒出 `ctrl+g to edit in Vim` 提示（实测 2.1.280，长/多行输入时）——
 * 这正是「回车没提交」的副作用，比较前剥掉；除此之外的任何变化都算 TUI 有反应。
 */
const SWALLOWED_ENTER_HINT_RE = /ctrl\+g\s*to\s*edit\s*in\s*\w+/gi;
function screenTail(screen: string): string {
  const tail = screen.split('\n').filter((l) => l.trim()).slice(-TAIL_LINES).join('\n');
  return compact(tail.replace(SWALLOWED_ENTER_HINT_RE, ''));
}

/**
 * 回车前后屏幕**底部**完全相同 —— 被吞的回车不改变输入框和状态栏；有任何变化都说明 TUI 有反应，不该再盲补。
 * 不比整屏：claude 收到回车会整屏重绘，把顶部的 shell 残留清掉（实测），整屏比较会让每次都判成「变了」。
 */
export function screenUnchanged(before: string, after: string): boolean {
  return screenTail(before) === screenTail(after);
}

/**
 * claude 粘贴安全提示：剥掉了不可见字符、要求「review and press Enter to send」。
 * 这是 agent 明确在等**这一段输入**的一个确认回车 —— 与「正文仍在输入框」同时成立时补回车是安全的。
 */
// 要求 claude 自己的完整措辞（「Removed N invisible character(s) · … press Enter to send」），
// 只匹配通用短语的话，外部正文（公函 / TAPD）里碰巧有这几个词就会多补回车（安全复审 2026-10-09）
// 在压平空白后的底部文本上匹配：提示可能被状态栏宽度折成两行
const CONFIRM_ENTER_RE = /invisiblecharacters?.{0,40}pressEntertosend/i;
export function awaitingConfirmEnter(screen: string): boolean {
  return CONFIRM_ENTER_RE.test(compact(screen.split('\n').filter((l) => l.trim()).slice(-TAIL_LINES).join('\n')));
}
