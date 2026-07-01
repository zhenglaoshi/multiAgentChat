/**
 * 启发式识别 tab 是否在「等待用户输入」。
 *
 * 输入：tab 的 history tail + 当前 busy 状态
 * 输出：{ waiting, promptSnippet }
 *
 * 模式（任一命中即认为是 waiting）：
 *  - multi-select checkbox 形式：行内含 ☐ ☒ ◯ ◉
 *  - 光标行标记：❯ > ► ▶ 在某行首
 *  - y/n / yes/no 问询
 *  - "Press Enter / Y / any key" 提示
 *  - "Choose / Select / Pick ... [:?]" 结尾问句
 *
 * 注意：busy 必须 = true 才认为 waiting（idle tab 不算）。
 */

// 只保留**明确指令性**的等待模式；删掉：
//   - `^[❯>►▶]\s+\S` — claude TUI idle 时 `❯ ` prompt 永远匹配（大误报源）
//   - `[？?]\s*$` — claude 输出结尾常带问号（大误报源）
//   - shell prompt `>` — 太宽
// 保留：y/n / [Y/n] / Press Enter / checkbox picker / 明确"选择/确认/输入"中文
const WAITING_PATTERNS: RegExp[] = [
  /^\s*[☐☒◯◉]\s+\S/m,                         // multi-select 项（要有内容，不是 ○● 等 unicode 装饰）
  /\(\s*[Yy]\s*\/\s*[Nn]\s*\)/,               // (y/n) / (Y/N)
  /\(\s*[Nn]\s*\/\s*[Yy]\s*\)/,               // (n/y)
  /\(\s*yes\s*\/\s*no\s*\)/i,                  // (yes/no)
  /[Pp]ress\s+(Enter|Return|[Yy]|[Nn]|any\s+key|space)/,
  /(Choose|Select|Pick|Confirm)\b[^\n]*[:?]\s*$/m,
  /\[Y\/n\]/,
  /\[y\/N\]/,
  // 中文明确等待（不含泛问号）
  /(告诉我就行|请[选告确认]\s*\d|按\s*(回车|Enter))/,
  /[请要](选择|确认|输入|告诉|选一[条个种])[^？?\n]{0,20}[?？]/,
];

export interface DetectResult {
  waiting: boolean;
  promptSnippet?: string;       // 截取最后 ~12 行作为通知正文
  matchedPattern?: string;
}

export function detectWaitingForInput(
  historyTail: string,
  busy: boolean,
): DetectResult {
  if (!busy) return { waiting: false };
  if (!historyTail) return { waiting: false };

  const lines = historyTail.split('\n');
  const last30 = lines.slice(-30);
  const text = last30.join('\n');

  for (const re of WAITING_PATTERNS) {
    if (re.test(text)) {
      const snippet = last30.slice(-12).join('\n').trim();
      return {
        waiting: true,
        promptSnippet: snippet,
        matchedPattern: re.source.slice(0, 40),
      };
    }
  }
  return { waiting: false };
}
