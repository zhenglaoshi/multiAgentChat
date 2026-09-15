/**
 * 按键序列的**宿主无关**解析（tokenize → 重复展开 → 归一成中性 KeyStep）。
 *
 * 原本整套长在 `host-mac/src/terminal/keys.ts` 里，别名表与 macOS 的 key code 混在一起。
 * 第二个宿主（tmux）要送同样的按键序列，若各解析各的，`d` 在一边是「方向键下」、在另一边变成打字 `d`
 * ——这类漂移在飞书上表现为"同一条 /raw 指令在两台机器上行为不同"，极难排查。
 *
 * 所以这里只做「文本 → 中性按键步骤」，**各宿主再把 CanonicalKey 映射到自己的表示**
 * （macOS = System Events key code；tmux = send-keys 的按键名）。
 */

/** 归一后的具名键。各宿主必须覆盖全集。 */
export type CanonicalKey =
  | 'enter' | 'tab' | 'space' | 'backspace' | 'delete' | 'escape'
  | 'left' | 'right' | 'up' | 'down'
  | 'f1' | 'f2' | 'f3' | 'f4' | 'f5' | 'f6' | 'f7' | 'f8' | 'f9' | 'f10' | 'f11' | 'f12'
  | 'home' | 'end' | 'pageup' | 'pagedown';

export type Modifier = 'ctrl' | 'cmd' | 'alt' | 'shift';

/**
 * 别名 → 具名键。**与原 host-mac NAMED_KEYS 的别名集合逐字一致**（含中文与符号别名、
 * 以及 e/t/x/l/r/d/u/. 这些单字母捷径）——改动这里等于改用户已经在用的按键语法。
 */
export const KEY_ALIASES: Record<string, CanonicalKey> = {
  return: 'enter', enter: 'enter', ret: 'enter', '⏎': 'enter', '↵': 'enter', '回': 'enter', e: 'enter',
  tab: 'tab', '⇥': 'tab', '表': 'tab', t: 'tab',
  space: 'space', sp: 'space', ' ': 'space', '␣': 'space', '.': 'space', '空': 'space',
  bs: 'backspace', backspace: 'backspace', '⌫': 'backspace',
  del: 'delete', forwarddelete: 'delete',
  esc: 'escape', escape: 'escape', '⎋': 'escape', x: 'escape',
  left: 'left', '←': 'left', l: 'left', '左': 'left',
  right: 'right', '→': 'right', r: 'right', '右': 'right',
  down: 'down', '↓': 'down', d: 'down', '下': 'down',
  up: 'up', '↑': 'up', u: 'up', '上': 'up',
  f1: 'f1', f2: 'f2', f3: 'f3', f4: 'f4', f5: 'f5', f6: 'f6',
  f7: 'f7', f8: 'f8', f9: 'f9', f10: 'f10', f11: 'f11', f12: 'f12',
  home: 'home', end: 'end', pageup: 'pageup', pagedown: 'pagedown', pgup: 'pageup', pgdn: 'pagedown',
};

export const MODIFIER_ALIASES: Record<string, Modifier> = {
  ctrl: 'ctrl', control: 'ctrl', '^': 'ctrl',
  cmd: 'cmd', command: 'cmd', '@': 'cmd', meta: 'cmd',
  alt: 'alt', opt: 'alt', option: 'alt', '~': 'alt',
  shift: 'shift',
};

export interface NamedKeyStep {
  kind: 'named';
  key: CanonicalKey;
  mods: Modifier[];
}
export interface TextKeyStep {
  kind: 'text';
  /** 直接打进去的字符（1+ 个） */
  text: string;
  mods: Modifier[];
}
export type KeyStep = NamedKeyStep | TextKeyStep;

/**
 * Tokenize 按键序列（保留引号包裹的 raw text）。
 *   `2d . 'hello world' ⏎ ctrl+c` → ['2d', '.', "'hello world'", '⏎', 'ctrl+c']
 */
export function tokenizeKeys(input: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i]!;
    if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }
    if (c === "'" || c === '"') {
      const q = c;
      let j = i + 1;
      let buf = '';
      while (j < n && input[j] !== q) buf += input[j++];
      if (j >= n) throw new Error(`引号未闭合：${input.slice(i)}`);
      out.push(q + buf + q);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < n && input[j] !== ' ' && input[j] !== '\t' && input[j] !== '\n') j++;
    out.push(input.slice(i, j));
    i = j;
  }
  return out;
}

/** 展开 `3xd` / `d*3` / `ddd` → 多份原 token。 */
export function expandRepeat(tok: string): string[] {
  if ((tok.startsWith("'") && tok.endsWith("'")) || (tok.startsWith('"') && tok.endsWith('"'))) {
    return [tok];
  }
  let m = /^(\d+)x(.+)$/i.exec(tok);
  if (m) {
    const n = Number(m[1]);
    if (n > 200) throw new Error(`重复次数过大：${n}`);
    return Array(n).fill(m[2]!);
  }
  m = /^(.+)\*(\d+)$/.exec(tok);
  if (m) {
    const n = Number(m[2]);
    if (n > 200) throw new Error(`重复次数过大：${n}`);
    return Array(n).fill(m[1]!);
  }
  // 单字母别名连体：`ddd` → 3 个 `d`。保守只认 d/u/l/r/e/t/x/. 这几个一字符别名
  if (/^[dulretxu.]+$/.test(tok) && tok.length >= 2 && tok.length <= 6) {
    return tok.split('');
  }
  return [tok];
}

function parseModifiers(prefix: string[]): Modifier[] {
  return prefix.map((p) => {
    const m = MODIFIER_ALIASES[p.toLowerCase()];
    if (!m) throw new Error(`未知修饰键：${p}`);
    return m;
  });
}

/** 单个 token → KeyStep。具名键优先，其余当打字。 */
export function parseKeyToken(tok: string): KeyStep {
  const parts = tok.split('+');
  const keyPart = parts.pop()!;
  const mods = parseModifiers(parts);
  const lower = keyPart.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(KEY_ALIASES, lower)) {
    return { kind: 'named', key: KEY_ALIASES[lower]!, mods };
  }
  // 单字符（含 emoji）→ 打字。中文单字直接打通常不生效（依赖输入法），英数符号可以
  if (keyPart.length >= 1) return { kind: 'text', text: keyPart, mods };
  throw new Error(`无法解析 token：${tok}`);
}

/** 整串按键序列 → KeyStep[]。 */
export function parseKeySteps(input: string): KeyStep[] {
  const expanded: string[] = [];
  for (const t of tokenizeKeys(input)) {
    for (const e of expandRepeat(t)) expanded.push(e);
  }
  const steps: KeyStep[] = [];
  for (const t of expanded) {
    if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
      const text = t.slice(1, -1);
      if (text.length > 0) steps.push({ kind: 'text', text, mods: [] });
      continue;
    }
    steps.push(parseKeyToken(t));
  }
  return steps;
}
