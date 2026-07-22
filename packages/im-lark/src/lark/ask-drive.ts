/**
 * AskUserQuestion（claude 原生上下键选择菜单）方向键驱动的纯逻辑。
 *
 * 背景：飞书注入终端走 `do script` 只能投"字符 + 回车"，驱动不了靠 ↑↓ 移动高亮的
 * 选择菜单（打选项文本进去只是塞字符、高亮不动、选不中）。解法是发**真方向键**
 * `key code 125(↓)/36(⏎)`（sendKeys），从菜单默认高亮的第 1 项按 index 次 ↓ 再回车。
 *
 * 这里只放**无副作用**的纯函数，方便单测；真正发键在 host-mac 的 sendKeys。
 */

/**
 * 选第 `index`（0-based）项的按键 token 序列：从默认高亮的第 1 项起按 `index` 次 `down`，
 * 再 `enter`。index=0 → 只回车（选默认高亮的第一项）。
 * 依赖"菜单刚渲染、高亮在第 1 项、期间只有一方在操作"的前提（远程只有飞书驱动 → 成立）。
 */
export function buildDownEnterSeq(index: number): string[] {
  const seq: string[] = [];
  for (let k = 0; k < index; k++) seq.push('down');
  seq.push('enter');
  return seq;
}

/**
 * 把一条飞书裸文本回复映射到 AskUserQuestion 选项 index（0-based）：
 *  - 裸数字 "2"（1-based，1..N）
 *  - 选项 label 精确匹配（忽略大小写 / 首尾空格）
 *  - 唯一前缀 / 包含匹配（歧义则不认）
 * 映射不出 → 返回 -1（调用方不劫持、照常走文本注入，不回归）。
 */
export function resolveAskAnswerIndex(text: string, options: string[]): number {
  const t = text.trim();
  if (!t || options.length === 0) return -1;
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return Number.isInteger(n) && n >= 1 && n <= options.length ? n - 1 : -1;
  }
  const lower = t.toLowerCase();
  const exact = options.findIndex((o) => o.trim().toLowerCase() === lower);
  if (exact >= 0) return exact;
  const hits = options
    .map((o, i) => ({ i, o: o.trim().toLowerCase() }))
    .filter((x) => x.o.startsWith(lower) || x.o.includes(lower));
  return hits.length === 1 ? hits[0]!.i : -1;
}
