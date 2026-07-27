import { runScriptOrThrow } from './applescript.js';

// macOS key codes（System Events / kVK_ 系）
const NAMED_KEYS: Record<string, number> = {
  // 换行 / 回车
  return: 36, enter: 36, ret: 36, '⏎': 36, '↵': 36, '回': 36, 'e': 36,
  // Tab
  tab: 48, '⇥': 48, '表': 48, 't': 48,
  // 空格
  space: 49, sp: 49, ' ': 49, '␣': 49, '.': 49, '空': 49,
  // 退格 / 删除
  bs: 51, backspace: 51, '⌫': 51,
  del: 117, forwarddelete: 117,
  // Esc
  esc: 53, escape: 53, '⎋': 53, 'x': 53,
  // 方向
  left: 123, '←': 123, l: 123, '左': 123,
  right: 124, '→': 124, r: 124, '右': 124,
  down: 125, '↓': 125, d: 125, '下': 125,
  up: 126, '↑': 126, u: 126, '上': 126,
  // 功能键
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
  f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  // 特殊
  home: 115, end: 119, pageup: 116, pagedown: 121, pgup: 116, pgdn: 121,
};

const MODIFIER_ALIAS: Record<string, string> = {
  ctrl: 'control down',
  control: 'control down',
  '^': 'control down',
  cmd: 'command down',
  command: 'command down',
  '@': 'command down',
  meta: 'command down',
  alt: 'option down',
  opt: 'option down',
  option: 'option down',
  '~': 'option down',
  shift: 'shift down',
};

export interface SendKeysOptions {
  intervalMs?: number;
}

interface StepKey {
  kind: 'key';
  keyCode: number;
  mods: string[];
}
interface StepKeystroke {
  kind: 'keystroke';
  text: string;      // 直接 keystroke（1+ 字符）
  mods: string[];
}

type Step = StepKey | StepKeystroke;

function escAS(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function parseModifiers(prefix: string[]): string[] {
  return prefix.map((p) => {
    const m = MODIFIER_ALIAS[p.toLowerCase()];
    if (!m) throw new Error(`未知修饰键：${p}`);
    return m;
  });
}

/**
 * 解析 token（不含引号包裹的原始文本）到 Step。
 *   `down`   → { key: 125 }
 *   `ctrl+c` → { keystroke: 'c', mods: [ctrl] }
 *   `cmd+enter` → { key: 36, mods: [cmd] }
 *   单字母如 `a` → keystroke 'a'（打字）
 *   `1` `2` 等数字 → keystroke（打字）
 */
function parseSingleToken(tok: string): Step {
  const parts = tok.split('+');
  const keyPart = parts.pop()!;
  const mods = parseModifiers(parts);
  const lower = keyPart.toLowerCase();

  // 优先命名键
  if (Object.prototype.hasOwnProperty.call(NAMED_KEYS, lower)) {
    return { kind: 'key', keyCode: NAMED_KEYS[lower]!, mods };
  }
  // 单字符（含 emoji）→ 打字
  // 注意：中文单字直接 keystroke 通常不生效（依赖输入法），但英字/数字/符号可以
  if (keyPart.length >= 1) {
    return { kind: 'keystroke', text: keyPart, mods };
  }
  throw new Error(`无法解析 token：${tok}`);
}

/**
 * Tokenize 用户输入的按键序列（保留引号包裹的 raw text）。
 *   例：`2d . 'hello world' ⏎ ctrl+c`
 *   → ['2d', '.', "'hello world'", '⏎', 'ctrl+c']
 * 单引号内的内容按原样保留（含空格）。
 */
export function tokenizeKeys(input: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i]!;
    if (c === ' ' || c === '\t' || c === '\n') {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      let j = i + 1;
      let buf = '';
      while (j < n && input[j] !== q) {
        buf += input[j++];
      }
      if (j >= n) throw new Error(`引号未闭合：${input.slice(i)}`);
      out.push(q + buf + q);
      i = j + 1;
      continue;
    }
    // 一个 token 到下一个空白
    let j = i;
    while (j < n && input[j] !== ' ' && input[j] !== '\t' && input[j] !== '\n') j++;
    out.push(input.slice(i, j));
    i = j;
  }
  return out;
}

/** 展开 `3d` / `d*3` / `3xdown` → 3 份原 token */
function expandRepeat(tok: string): string[] {
  // 引号包裹 → 不展开
  if ((tok.startsWith("'") && tok.endsWith("'")) || (tok.startsWith('"') && tok.endsWith('"'))) {
    return [tok];
  }
  let m = /^(\d+)x(.+)$/i.exec(tok);
  if (m) {
    const n = Number(m[1]);
    const inner = m[2]!;
    if (n > 200) throw new Error(`重复次数过大：${n}`);
    return Array(n).fill(inner);
  }
  m = /^(.+)\*(\d+)$/.exec(tok);
  if (m) {
    const n = Number(m[2]);
    const inner = m[1]!;
    if (n > 200) throw new Error(`重复次数过大：${n}`);
    return Array(n).fill(inner);
  }
  // 单字母数字连体：`ddd` → 3 个 `d`；但只当整串都是命名键别名时才展开
  if (/^[dulretxu.]+$/.test(tok) && tok.length >= 2 && tok.length <= 6) {
    // 保守只支持 d/u/l/r/e/t/x/./ 这种一字符别名的连体
    return tok.split('');
  }
  return [tok];
}

export function parseKeySequence(input: string): Step[] {
  const raw = tokenizeKeys(input);
  const expanded: string[] = [];
  for (const t of raw) {
    for (const e of expandRepeat(t)) expanded.push(e);
  }
  const steps: Step[] = [];
  for (const t of expanded) {
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
      const text = t.slice(1, -1);
      if (text.length > 0) steps.push({ kind: 'keystroke', text, mods: [] });
      continue;
    }
    steps.push(parseSingleToken(t));
  }
  return steps;
}

function buildSendKeysScript(tty: string, steps: Step[], intervalMs: number): string {
  const seconds = Math.max(0, intervalMs) / 1000;
  const seLines: string[] = [];
  for (const s of steps) {
    const modsClause = s.mods.length > 0 ? ` using {${s.mods.join(', ')}}` : '';
    if (s.kind === 'key') {
      seLines.push(`    key code ${s.keyCode}${modsClause}`);
    } else {
      seLines.push(`    keystroke "${escAS(s.text)}"${modsClause}`);
    }
    if (seconds > 0) seLines.push(`    delay ${seconds}`);
  }
  return `
on run argv
  set targetTty to item 1 of argv
  set didFocus to false
  tell application "Terminal"
    repeat with w in windows
      try
        repeat with t in tabs of w
          if (tty of t) is equal to targetTty then
            activate
            set frontmost of w to true
            set selected tab of w to t
            set didFocus to true
            exit repeat
          end if
        end repeat
        if didFocus then exit repeat
      end try
    end repeat
  end tell
  if not didFocus then return "not-found"
  delay 0.15
  tell application "System Events"
${seLines.join('\n')}
  end tell
  return "ok"
end run
`;
}

/**
 * 往目标 tab 发一串按键（含修饰键 / 打字 / 重复）。
 * intervalMs 默认 50ms（够 inquirer / claude TUI 认）。
 * 必要权限：Accessibility（osascript System Events）+ Terminal 会被拉到 frontmost。
 */
export async function sendKeys(
  tty: string,
  tokens: string | string[],
  opts?: SendKeysOptions,
): Promise<void> {
  const input = Array.isArray(tokens) ? tokens.join(' ') : tokens;
  const steps = parseKeySequence(input);
  if (steps.length === 0) return;
  const script = buildSendKeysScript(tty, steps, opts?.intervalMs ?? 50);
  const out = await runScriptOrThrow(script, [tty]);
  if (out.trim() !== 'ok') throw new Error(`sendKeys: tab ${tty} 不存在`);
}

/**
 * 往目标 tab 发一个 Ctrl-C（SIGINT / 中断当前行编辑）。
 * 用途：裸 shell 被不配对引号卡进 `dquote>`/`quote>` 续行时，Ctrl-C 放弃当前输入、回到干净 prompt。
 * 注意：走 System Events，会把 Terminal 拉到 frontmost（抢 0.2s 焦点）——只在确认卡死时调，别高频。
 */
export async function sendCtrlC(tty: string): Promise<void> {
  await sendKeys(tty, 'ctrl+c');
}
