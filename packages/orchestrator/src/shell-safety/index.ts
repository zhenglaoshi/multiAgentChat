/**
 * shell-safety —— 防「把给 agent 的任务 prompt 灌进没跑 agent 的裸 shell」把 shell 卡死。
 *
 * 背景：飞书发消息到 tab 走 AppleScript `do script`（等价于在那个 shell 里逐行敲命令 + 回车）。
 * 当目标 tab 还没启动 claude/codex（就是个裸 zsh）时，一条自然语言任务 / 带不配对引号的文本
 * 被当命令跑：轻则一堆 `command not found`，重则引号不配对让 zsh 进入 `dquote>` / `quote>`
 * 续行提示等闭合 → 这个 tab 彻底卡死用不了（用户反复踩坑）。
 *
 * 这里放**传输无关的纯判定**（im-lark 负责拦截 + 卡片，host-mac 负责真发 Ctrl-C 解卡）：
 *   - looksLikeAgentTask：这条更像给 agent 的任务、而不是一条正经 shell 命令 → 该拦
 *   - hasUnbalancedQuotes：引号是否成对（不成对灌进 shell 必卡续行）
 *   - detectWedge：一段 history 结尾是不是卡在 zsh 续行提示（自愈用）
 */

/**
 * 引号（单/双/反引号）是否不成对。不成对 → 灌进 shell 会卡进 `quote>`/`dquote>` 续行。
 * 先去掉转义引号（`\'` `\"` `` \` ``），再按奇偶判断——启发式，够挡常见误伤。
 */
export function hasUnbalancedQuotes(text: string): boolean {
  const stripped = text.replace(/\\['"`]/g, '');
  const odd = (ch: string) => (stripped.split(ch).length - 1) % 2 !== 0;
  return odd("'") || odd('"') || odd('`');
}

/** 中日韩统一表意文字（含扩展 A / 兼容区）——出现即基本可判定为自然语言任务而非 shell 命令。 */
const CJK_RE = /[㐀-鿿豈-﫿]/;

/**
 * 这条文本更像「给 agent 的任务」而非一条正经 shell 命令（→ 发到裸 shell 前应拦截）。
 *
 * 判定为任务（保守，尽量不误伤真 shell 命令）：
 *   1. 含 CJK（中文任务，本项目主力场景）
 *   2. 多行（换行——粘贴的任务 / 多段说明；`do script` 会逐行当命令跑）
 *   3. 引号不配对（灌进 shell 必卡死续行）
 * 其余（单行 ASCII、引号成对）一律放行当 shell 命令——`npm test` / `git status` 这类正常用法不受影响。
 * 纯英文散文（无引号、单行）会漏判成命令，但那只会 `command not found`（可恢复、不卡死），可接受。
 */
export function looksLikeAgentTask(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  if (CJK_RE.test(t)) return true;
  if (/\r?\n/.test(t)) return true;
  if (hasUnbalancedQuotes(t)) return true;
  return false;
}

/**
 * zsh 续行提示符（PS2 = `%_>`）的具名前缀：quote/dquote/cmdsubst/pipe/for/while/... 后跟 `>`。
 * bash 的续行是裸 `> `，误报风险太高，故只认 zsh 这些**具名**前缀（精确、几乎无假阳）。
 */
const ZSH_CONT_PROMPTS = new Set([
  'quote', 'dquote', 'bquote',
  'cmdsubst', 'cmdand', 'cmdor', 'pipe',
  'for', 'while', 'if', 'then', 'else', 'elif', 'do', 'repeat', 'case', 'select',
  'func', 'math', 'braceparam', 'subsh', 'array',
]);

/**
 * 一段 terminal history 的结尾是否卡在 zsh 续行提示（= shell 被不配对引号/未闭合结构卡住）。
 * 只看**最后一条非空行**是不是形如 `dquote>` / `quote>` 等。
 */
export function detectWedge(historyTail: string): { wedged: boolean; prompt?: string } {
  if (!historyTail) return { wedged: false };
  const lines = historyTail.split('\n');
  let last = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim();
    if (line !== '') { last = line; break; }
  }
  const m = /^([a-z]+)>$/i.exec(last);
  if (m && m[1] && ZSH_CONT_PROMPTS.has(m[1].toLowerCase())) {
    return { wedged: true, prompt: last };
  }
  return { wedged: false };
}
