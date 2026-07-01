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

const WAITING_PATTERNS: RegExp[] = [
  /^\s*[☐☒○●⊙◯◉]/m,                       // multi-select 项
  /^[❯>►▶]\s+\S/m,                           // 光标 + 选项
  /\(\s*[Yy]\s*\/\s*[Nn]\s*\)/,             // (y/n) / (Y/N)
  /\(\s*[Nn]\s*\/\s*[Yy]\s*\)/,             // (n/y)
  /\(\s*yes\s*\/\s*no\s*\)/i,                // (yes/no)
  /[Pp]ress\s+(Enter|Return|[Yy]|[Nn]|any\s+key|space)/,
  /(Choose|Select|Pick|Confirm)\b[^\n]*[:?]\s*$/m,
  /\[Y\/n\]/,
  /\[y\/N\]/,
  // 中文等待模式（claude 中文回复时常用）
  /(选哪[条个种]|告诉我就行|选\s*\d+|请[选告确])/,
  /[请要]?(选择|确认|输入|告诉|选一[条个个种])/,
  /[？?]\s*$/m,                              // 行尾问号
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
