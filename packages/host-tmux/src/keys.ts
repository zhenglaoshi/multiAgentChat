/**
 * tmux 侧的按键映射 —— 把中性 `KeyStep` 翻译成 `tmux send-keys` 的按键名。
 *
 * 与 macOS 宿主共用 `orchestrator/keys/tokens.ts` 的同一套按键语法（别名 / 重复展开 / 引号打字），
 * 这里只负责最后一跳的表示差异。
 *
 * **和 macOS 最大的不同：不需要焦点。** System Events 那条路要把 Terminal 拉到前台、要 Accessibility
 * 授权、锁屏时静默失败；tmux 是后台 server 直接往 pane 的 pty 写字节，
 * 所以锁屏 / 别的窗口在前台 / 系统弹框压着都照送 —— 这正是 Ctrl-C、Esc、方向键在 Mac 上的老短板。
 */

import type { SendKeysOptions } from 'multiagent-host-api';
import { parseKeySteps, type CanonicalKey, type Modifier } from 'multiagent-orchestrator';
import { sendKeyName, sendLiteral } from './tmux.js';
import { resolvePaneOrThrow } from './pane.js';

/** 具名键 → tmux send-keys 的按键名。必须覆盖 CanonicalKey 全集。 */
const TMUX_KEYS: Record<CanonicalKey, string> = {
  enter: 'Enter', tab: 'Tab', space: 'Space', backspace: 'BSpace', delete: 'DC', escape: 'Escape',
  left: 'Left', right: 'Right', up: 'Up', down: 'Down',
  f1: 'F1', f2: 'F2', f3: 'F3', f4: 'F4', f5: 'F5', f6: 'F6',
  f7: 'F7', f8: 'F8', f9: 'F9', f10: 'F10', f11: 'F11', f12: 'F12',
  home: 'Home', end: 'End', pageup: 'PPage', pagedown: 'NPage',
};

/**
 * 修饰键前缀。**`cmd` 没有对应物** —— 终端里根本没有 Command 这个修饰键（它是 macOS 窗口系统的概念），
 * 与其静默当成别的键送出去（用户以为发了 Cmd-Enter，实际发了个裸 Enter），不如明确抛错。
 */
const TMUX_MODIFIERS: Record<Modifier, string> = {
  ctrl: 'C-',
  alt: 'M-',
  shift: 'S-',
  cmd: '',
};

/** 纯函数：把一个中性步骤翻成 tmux 的按键名；返回 null 表示「这步要当字面文本送」。 */
export function toTmuxKey(step: { kind: 'named' | 'text'; key?: CanonicalKey; text?: string; mods: Modifier[] }): string | null {
  if (step.mods.includes('cmd')) {
    throw new Error('tmux 宿主不支持 Command 修饰键（终端里没有这个修饰键）');
  }
  const prefix = step.mods.map((m) => TMUX_MODIFIERS[m]).join('');
  if (step.kind === 'named') return prefix + TMUX_KEYS[step.key!];
  // 带修饰键的打字（ctrl+c）→ 按键名；不带修饰键的文本走字面通道（可能是整句话）
  if (prefix === '') return null;
  const text = step.text ?? '';
  if ([...text].length !== 1) {
    throw new Error(`修饰键只能配单个字符，收到：${text}`);
  }
  return prefix + text;
}

/** 往目标 pane 发一串按键（含修饰键 / 打字 / 重复）。 */
export async function sendKeys(tty: string, tokens: string | string[], opts?: SendKeysOptions): Promise<void> {
  const input = Array.isArray(tokens) ? tokens.join(' ') : tokens;
  const steps = parseKeySteps(input);
  if (steps.length === 0) return;
  const pane = await resolvePaneOrThrow(tty);
  const intervalMs = opts?.intervalMs ?? 50;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const key = toTmuxKey(step);
    if (key === null) await sendLiteral(pane, (step as { text: string }).text);
    else await sendKeyName(pane, key);
    if (intervalMs > 0 && i < steps.length - 1) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

/**
 * 发一个 Ctrl-C。
 * 与 macOS 宿主的注释差异：这里**不抢焦点、不需要前台**，所以没有"别高频调用"的告诫。
 */
export async function sendCtrlC(tty: string): Promise<void> {
  await sendKeys(tty, 'ctrl+c');
}
