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
  return out.join('\n');
}
