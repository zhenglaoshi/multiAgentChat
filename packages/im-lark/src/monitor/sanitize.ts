/**
 * 终端输出净化：把 watcher 从 Terminal.app 抓到的 raw scrollback
 * 转成对人友好的纯文本，供飞书卡片展示。
 *
 * 处理：
 *   1. 剥离 OSC 序列（窗口标题、hyperlink 之类：`ESC ] ... BEL/ST`）
 *   2. 剥离 CSI 序列（颜色、光标：`ESC [ ... letter`）
 *   3. 剥离其他单字符 ESC 序列
 *   4. 折叠 `\r` 重绘：TUI/spinner 会用 `\r` 回到行首重画，仅保留每行 `\r` 之后的最终态
 *   5. 去除连续重复行（spinner tick / progress bar 定帧重画后仍留下的同内容行）
 *   6. 折叠整行水平分隔线（TUI 画的 `────`/`———` 边框推到手机飞书会变成占满屏的横杠）
 *      → 归一成一条短 `───`，连续多条只留一条；再折叠连续空行 + 去首尾空行
 *
 * 不处理：
 *   - 换行符本身（\n 保留）
 *   - Backspace（\b）— 出现极少，先不处理
 */

// eslint-disable-next-line no-control-regex
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const CSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
// eslint-disable-next-line no-control-regex
const ESC_SINGLE_RE = /\x1b[()@-Z\\-_]/g;

/**
 * 整行水平分隔线判定：trim 后全是"分隔类"字符（box-drawing 横线 U+2500-257F、
 * 破折号 —–―、连字符 -、= _ ~ ·）且 ≥3 个、并至少含一个横线字符。
 * 命中的是 TUI 画的边框/分隔线，手机上会渲染成占满屏的横杠。
 */
function isRuleLine(line: string): boolean {
  const t = line.trim();
  if (t.length < 3) return false;
  if (!/^[\s─-╿—–―=_~·*-]+$/.test(t)) return false;
  return /[─-╿—–―=_-]/.test(t);
}

export function sanitizeTerminalOutput(raw: string): string {
  if (!raw) return '';
  let s = raw;
  s = s.replace(OSC_RE, '');
  s = s.replace(CSI_RE, '');
  s = s.replace(ESC_SINGLE_RE, '');

  // `\r` 折叠：每行仅保留最后一次重绘的内容
  const lines = s.split('\n').map((line) => {
    if (line.indexOf('\r') < 0) return line;
    const parts = line.split('\r');
    return parts[parts.length - 1] ?? '';
  });

  // 连续同行去重（TUI spinner / progress bar 定帧重复）
  const out: string[] = [];
  for (const line of lines) {
    if (out.length === 0 || out[out.length - 1] !== line) out.push(line);
  }

  // 折叠水平分隔线（→ 一条短 `───`，连续多条只留一条）+ 折叠连续空行
  const collapsed: string[] = [];
  for (const raw2 of out) {
    const line = isRuleLine(raw2) ? '───' : raw2;
    const prev = collapsed[collapsed.length - 1];
    if (line === '───' && prev === '───') continue;
    if (line.trim() === '' && (prev === undefined || prev.trim() === '')) continue;
    collapsed.push(line);
  }
  // 去首尾空行 / 首尾孤立分隔线
  while (collapsed.length && (collapsed[0]!.trim() === '' || collapsed[0] === '───')) collapsed.shift();
  while (collapsed.length && (collapsed[collapsed.length - 1]!.trim() === '' || collapsed[collapsed.length - 1] === '───')) collapsed.pop();
  return collapsed.join('\n');
}
