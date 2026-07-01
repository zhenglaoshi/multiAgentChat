import { spawn } from 'node:child_process';
import { runScript, runScriptOrThrow } from './applescript.js';
import type { SendResult, TerminalTab } from './types.js';

const TUI_PROCS = new Set([
  'vim', 'vi', 'nvim', 'emacs', 'nano', 'pico', 'micro',
  'less', 'more', 'man',
  'top', 'htop', 'btop', 'atop',
  'fzf', 'tmux', 'screen',
  'mc', 'ranger', 'nnn', 'lf',
]);

const FS = String.fromCharCode(31); // field separator
const RS = String.fromCharCode(30); // record separator

const LIST_SCRIPT = `
set fs to character id 31
set rs to character id 30
set out to ""
set frontWin to missing value
tell application "Terminal"
  try
    set frontWin to id of front window
  end try
  set wList to windows
  set wCount to count of wList
  repeat with wIdx from 1 to wCount
    try
      set w to item wIdx of wList
      set wId to id of w
      set isFront to "false"
      if frontWin is not missing value then
        if wId is equal to frontWin then set isFront to "true"
      end if
      set tList to tabs of w
      set tCount to count of tList
      repeat with tIdx from 1 to tCount
        try
          set t to item tIdx of tList
          set theTty to (tty of t) as text
          set theTitle to ""
          try
            set theTitle to (custom title of t) as text
          end try
          set theBusy to "false"
          try
            if (busy of t) then set theBusy to "true"
          end try
          set theProcs to ""
          try
            set procList to processes of t
            set p2 to ""
            repeat with p in procList
              if p2 is equal to "" then
                set p2 to (p as text)
              else
                set p2 to p2 & "," & (p as text)
              end if
            end repeat
            set theProcs to p2
          end try
          set out to out & (wId as text) & fs & isFront & fs & (tIdx as text) & fs & theTty & fs & theBusy & fs & theTitle & fs & theProcs & rs
        end try
      end repeat
    end try
  end repeat
end tell
return out
`;

export async function listTabsRaw(): Promise<TerminalTab[]> {
  const out = await runScriptOrThrow(LIST_SCRIPT);
  const tabs: TerminalTab[] = [];
  for (const rec of out.split(RS)) {
    if (!rec) continue;
    const fields = rec.split(FS);
    if (fields.length < 7) continue;
    const [wId, front, tIdx, tty, busy, title, procs] = fields;
    if (!tty) continue;
    const procList = (procs ?? '').split(',').filter(Boolean);
    tabs.push({
      tty,
      windowId: Number(wId),
      windowFrontmost: front === 'true',
      tabIndex: Number(tIdx),
      title: title ?? '',
      busy: busy === 'true',
      processes: procList,
      hasTUI: procList.some((p) => TUI_PROCS.has(p.toLowerCase())),
    });
  }
  return tabs;
}

function execCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolveP) => {
    const p = spawn(cmd, args);
    let out = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    p.on('close', () => resolveP(out));
    p.on('error', () => resolveP(''));
  });
}

export async function getCwd(tty: string): Promise<string | undefined> {
  const dev = tty.replace(/^\/dev\//, '');
  const ps = await execCapture('ps', ['-t', dev, '-o', 'pid=,comm=']);
  for (const line of ps.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = m[1]!;
    const comm = m[2]!;
    if (!/zsh|bash|fish|sh$/.test(comm)) continue;
    const lsof = await execCapture('lsof', ['-a', '-d', 'cwd', '-p', pid, '-Fn']);
    for (const lline of lsof.split('\n')) {
      if (lline.startsWith('n')) return lline.slice(1);
    }
  }
  return undefined;
}

export async function enrichTabsWithCwd(tabs: TerminalTab[]): Promise<TerminalTab[]> {
  const cwds = await Promise.all(tabs.map((t) => getCwd(t.tty)));
  return tabs.map((t, i) => {
    const cwd = cwds[i];
    return cwd !== undefined ? { ...t, cwd } : t;
  });
}

export async function listTabs(): Promise<TerminalTab[]> {
  const raw = await listTabsRaw();
  return enrichTabsWithCwd(raw);
}

const HISTORY_SCRIPT = `
on run argv
  set targetTty to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      try
        repeat with t in tabs of w
          if (tty of t) is equal to targetTty then
            return (history of t)
          end if
        end repeat
      end try
    end repeat
  end tell
  return ""
end run
`;

export async function getHistory(tty: string): Promise<string> {
  return runScriptOrThrow(HISTORY_SCRIPT, [tty]);
}

function escapeForAS(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const SEND_SCRIPT = `
on run argv
  set targetTty to item 1 of argv
  set theCmd to item 2 of argv
  tell application "Terminal"
    repeat with w in windows
      try
        repeat with t in tabs of w
          if (tty of t) is equal to targetTty then
            do script theCmd in t
            return "ok"
          end if
        end repeat
      end try
    end repeat
  end tell
  return "not-found"
end run
`;

export async function sendKeysRaw(tty: string, text: string): Promise<boolean> {
  const out = await runScriptOrThrow(SEND_SCRIPT, [tty, text]);
  return out.trim() === 'ok';
}

/**
 * 高级 send：检测 TUI / busy / 然后 send，并做差量记录。
 */
export async function send(tty: string, text: string): Promise<SendResult> {
  const tabs = await listTabsRaw();
  const tab = tabs.find((t) => t.tty === tty);
  if (!tab) return { ok: false, reason: `tab 不存在：${tty}` };
  if (tab.hasTUI) {
    const tuiProc = tab.processes.find((p) => TUI_PROCS.has(p.toLowerCase()));
    return {
      ok: false,
      reason: `tab ${tty} 当前在跑 ${tuiProc}（TUI），发字符会破坏，已拒绝。可在终端里退出后重试。`,
    };
  }
  const before = (await getHistory(tty)).split('\n').length;
  const sent = await sendKeysRaw(tty, text);
  if (!sent) return { ok: false, reason: 'do script 没找到 tab' };
  return { ok: true, before };
}

/**
 * 发完后等差量稳定（busy 变 false 或超时），拿新增内容。
 */
export async function waitForOutput(
  tty: string,
  beforeLineCount: number,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const pollMs = opts.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let lastLen = -1;
  let stableTicks = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const tabs = await listTabsRaw();
    const tab = tabs.find((t) => t.tty === tty);
    const hist = await getHistory(tty);
    const arr = hist.split('\n');
    if (arr.length === lastLen) {
      stableTicks++;
    } else {
      stableTicks = 0;
      lastLen = arr.length;
    }
    if (tab && !tab.busy && stableTicks >= 2) {
      const diff = arr.slice(beforeLineCount).join('\n').trim();
      // diff 太短或丢失，回退到 tail
      if (diff.split('\n').length < 3) {
        return arr.slice(-30).join('\n').trim();
      }
      return diff;
    }
  }
  const hist = await getHistory(tty);
  const arr = hist.split('\n');
  const diff = arr.slice(beforeLineCount).join('\n').trim();
  if (diff.split('\n').length < 3) {
    return arr.slice(-30).join('\n').trim();
  }
  return diff;
}

const NEW_TAB_IN_FRONT_SCRIPT = `
on run argv
  set initCmd to item 1 of argv
  tell application "Terminal"
    activate
    set frontWin to front window
    set newT to do script initCmd in frontWin
    return tty of newT
  end tell
end run
`;

const NEW_WINDOW_SCRIPT = `
on run argv
  set initCmd to item 1 of argv
  tell application "Terminal"
    activate
    set newT to do script initCmd
    return tty of newT
  end tell
end run
`;

export interface NewTabOptions {
  cwd?: string;
  mode?: 'new-tab' | 'new-window';
}

/**
 * 开新 tab（默认在 front window 开），可选 cd。
 * 用 ':' 作 no-op 启动命令（shell 内置，无输出），尽量少污染终端。
 * 然后等 1.5s 让 shell 完成初始化，再发 cd。
 */
export async function newTab(opts: NewTabOptions = {}): Promise<string> {
  const initCmd = ':';
  const script =
    opts.mode === 'new-window' ? NEW_WINDOW_SCRIPT : NEW_TAB_IN_FRONT_SCRIPT;
  let tty: string;
  try {
    tty = (await runScriptOrThrow(script, [initCmd])).trim();
  } catch (e) {
    if (opts.mode !== 'new-window') {
      tty = (await runScriptOrThrow(NEW_WINDOW_SCRIPT, [initCmd])).trim();
    } else {
      throw e;
    }
  }
  if (!tty) throw new Error('newTab: 没拿到新 tab 的 tty');

  // 等 shell 初始化完（spike 时验证 1.5s 后发命令字符不丢）
  await new Promise((r) => setTimeout(r, 1500));

  if (opts.cwd) {
    const safe = opts.cwd.replace(/'/g, `'\\''`);
    await sendKeysRaw(tty, `cd '${safe}'`);
  }
  return tty;
}

/**
 * 显式发 Return 键事件到目标 tab（claude TUI 用 \n 做 prompt multi-line，
 * 不会自动提交；需要真实键盘 Return 事件）。
 *
 * 流程：
 *  1. 记录原 frontmost app
 *  2. activate Terminal + 选定目标 tab
 *  3. System Events keystroke return
 *  4. 立即切回原 app（减少打扰，~200ms 闪屏）
 */
const FORCE_ENTER_SCRIPT = `
on run argv
  set targetTty to item 1 of argv
  -- 记录原 frontmost app（用于稍后切回）
  set prevAppName to ""
  try
    tell application "System Events"
      set prevAppName to name of (first application process whose frontmost is true)
    end tell
  end try

  set didEnter to false
  tell application "Terminal"
    repeat with w in windows
      try
        repeat with t in tabs of w
          if (tty of t) is equal to targetTty then
            activate
            set frontmost of w to true
            set selected tab of w to t
            delay 0.15
            tell application "System Events"
              key code 36  -- Return key
            end tell
            set didEnter to true
            exit repeat
          end if
        end repeat
        if didEnter then exit repeat
      end try
    end repeat
  end tell

  -- 切回原 app（如果不是 Terminal 本身）
  if didEnter and prevAppName is not "" and prevAppName is not "Terminal" then
    try
      tell application "System Events"
        set frontmost of (first application process whose name is prevAppName) to true
      end tell
    end try
  end if

  if didEnter then
    return "ok"
  else
    return "not-found"
  end if
end run
`;

/**
 * 在目标 tab 显式发一次 Return 键。
 * 用于 claude TUI 这种"\n 不提交 prompt"的程序。
 */
export async function forceEnter(tty: string): Promise<boolean> {
  const out = await runScriptOrThrow(FORCE_ENTER_SCRIPT, [tty]);
  return out.trim() === 'ok';
}

const CLOSE_SCRIPT = `
on run argv
  set targetTty to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      try
        repeat with t in tabs of w
          if (tty of t) is equal to targetTty then
            close w saving no
            return "ok"
          end if
        end repeat
      end try
    end repeat
  end tell
  return "not-found"
end run
`;

export async function closeTab(tty: string): Promise<boolean> {
  const out = await runScriptOrThrow(CLOSE_SCRIPT, [tty]);
  return out.trim() === 'ok';
}
