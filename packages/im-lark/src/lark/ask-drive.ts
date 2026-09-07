/**
 * AskUserQuestion（claude 原生上下键选择菜单）远程应答的纯逻辑。
 *
 * 通道演进：
 *  - 旧：System Events 发真方向键 `key code 125(↓)×index + 36(⏎)`（sendKeys）。缺点：依赖前台焦点 + Accessibility，
 *    **锁屏 / 合盖时按键送不进终端，但 osascript 仍返回 ok** → 假成功（2026-09-07 真机实测，三次"已选"都是假的）。
 *  - 新（默认）：**pty 直写数字**。claude 原生菜单支持按数字键直选，`do script "2"` 往 pty 写 `"2\r"`，
 *    菜单选中第 2 项并提交（实测 1.6s 内 PostToolUse disarm）。不依赖焦点 / Accessibility / System Events，锁屏可用。
 *    `MCHAT_ASK_DRIVE=keys` 可退回旧路径。
 *
 * 这里只放**无副作用**的纯函数，方便单测；真正发送在 ./ask-driver.ts。
 */

export type AskDriveMode = 'pty' | 'keys';

/** 解析 `MCHAT_ASK_DRIVE`：只认 `keys`（退回方向键路径），其它值 / 未设 → `pty`。 */
export function resolveAskDriveMode(raw: string | undefined = process.env['MCHAT_ASK_DRIVE']): AskDriveMode {
  return (raw ?? '').trim().toLowerCase() === 'keys' ? 'keys' : 'pty';
}

/**
 * pty 直写选第 `index`（0-based）项要写的字符：1-based 数字。
 * 原生菜单的数字快捷键只有单个键位（1..9）→ index ≥ 9 返回 null，调用方退回方向键路径。
 * （AskUserQuestion 最多 4 个选项 + 1 个「Other」，实际不会越界，这里只是兜住。）
 */
export function buildPtyDigit(index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index > 8) return null;
  return String(index + 1);
}

/**
 * 选第 `index`（0-based）项的按键 token 序列（旧路径 / 兜底）：从默认高亮的第 1 项起按 `index` 次 `down`，
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
 * 映射不出 → 返回 -1（调用方按「非选项文本」处理：暂存 + 提示，不注入，见 buildAskHoldNotice）。
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

/** 用户想关掉菜单（不选）的口令。整句精确匹配（忽略大小写 / 首尾空格 / 末尾标点），避免把正常任务误判成取消。 */
const ASK_CANCEL_WORDS = new Set(['取消', '跳过', '算了', '不选', '关掉菜单', '关闭菜单', 'cancel', 'skip', 'esc', 'escape']);

export function isAskCancelWord(text: string): boolean {
  const t = text.trim().replace(/[。．.!！]+$/u, '').toLowerCase();
  return ASK_CANCEL_WORDS.has(t);
}

/**
 * askArm 期间收到**映射不到选项**的文本时回给用户的提示。
 * 为什么不注入：pty 回车必提交 → 原话会被粘进菜单并默认选第 1 项、消息丢失（2026-09-07 当天发生 3 次）。
 *
 * `locked` 是**三态**，必须分开处理（合并会重演"假成功"）：
 *  - `false` 确认没锁 → 可以告诉用户「回取消」（取消走 Esc / System Events，只有没锁屏才真送得进去）
 *  - `true`  确认锁屏 → 明说 Esc 送不进去，只能回数字
 *  - `null`  读不到（ioreg 超时等，常与 System Events 故障同源）→ 按最坏情况说，别承诺取消可用
 */
export function buildAskHoldNotice(
  tty: string,
  options: string[],
  heldText: string,
  locked: boolean | null,
): string {
  const list = options.map((o, i) => `${i + 1}. ${o}`).join('\n');
  const preview = heldText.length > 40 ? heldText.slice(0, 40) + '…' : heldText;
  const cancelHint =
    locked === false
      ? '不想选 → 回「取消」关掉菜单。'
      : locked === true
        ? '屏幕已锁定，Esc 送不进去，只能回数字选一项（或到电脑前按 Esc）。'
        : '读不到锁屏状态，不敢保证「取消」（Esc）送得进去，建议直接回数字选一项。';
  return (
    `⏸ ${tty} 正在等你选（claude 原生菜单待答）：\n${list}\n` +
    `回数字选一项。${cancelHint}\n` +
    `你这句「${preview}」我先存着，菜单处理完自动发过去。`
  );
}
