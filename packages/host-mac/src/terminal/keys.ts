import { runScriptOrThrow } from './applescript.js';

/**
 * macOS 侧的按键映射 —— **只做「中性 KeyStep → System Events 表示」的翻译**。
 * tokenize / 别名 / 重复展开这些宿主无关的部分已提到 `orchestrator/keys/tokens.ts`，
 * 与 tmux 宿主共用同一套按键语法（否则 `d` 在两个宿主上会有不同含义）。
 */
import {
  parseKeySteps,
  tokenizeKeys as tokenizeKeysShared,
  type CanonicalKey,
  type Modifier,
} from 'multiagent-orchestrator';

/** 具名键 → macOS key code（System Events / kVK_ 系）。必须覆盖 CanonicalKey 全集。 */
const KEY_CODES: Record<CanonicalKey, number> = {
  enter: 36, tab: 48, space: 49, backspace: 51, delete: 117, escape: 53,
  left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
  f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  home: 115, end: 119, pageup: 116, pagedown: 121,
};

const MAC_MODIFIERS: Record<Modifier, string> = {
  ctrl: 'control down',
  cmd: 'command down',
  alt: 'option down',
  shift: 'shift down',
};

export type { SendKeysOptions } from 'multiagent-host-api';
import type { SendKeysOptions } from 'multiagent-host-api';

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

/** 按键序列 tokenize —— 转发共享实现，保持本模块对外签名不变。 */
export const tokenizeKeys = tokenizeKeysShared;

/** 解析成 macOS 的 Step（key code / keystroke + AppleScript 修饰键字面量）。 */
export function parseKeySequence(input: string): Step[] {
  return parseKeySteps(input).map((s): Step => {
    const mods = s.mods.map((m) => MAC_MODIFIERS[m]);
    return s.kind === 'named'
      ? { kind: 'key', keyCode: KEY_CODES[s.key], mods }
      : { kind: 'keystroke', text: s.text, mods };
  });
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
