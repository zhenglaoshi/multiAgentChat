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

/**
 * 在 front window 里开新 tab。
 *
 * 坑：Terminal.app 的 `do script "cmd" in window` 在某些场景下会
 * **在 selected tab 里执行**而不是新开 tab（观察到当 selected tab
 * 是 alt-screen TUI 如 claude 时 do script 复用了当前 tab，返回原 tty）。
 * 所以先 snapshot 全 tab tty，do script 后如果返回的 tty 已存在，
 * fallback 到新 window，保证一定拿到全新 tty。
 */
const NEW_TAB_IN_FRONT_SCRIPT = `
on run argv
  set initCmd to item 1 of argv
  set prevTtys to {}
  tell application "Terminal"
    activate
    repeat with w in windows
      try
        repeat with t in tabs of w
          try
            set end of prevTtys to (tty of t)
          end try
        end repeat
      end try
    end repeat
    set frontWin to front window
    set newT to do script initCmd in frontWin
    set newTty to tty of newT
  end tell
  if newTty is in prevTtys then
    -- do script 复用了 existing tab，退到新 window
    tell application "Terminal"
      set newT to do script initCmd
      set newTty to tty of newT
    end tell
  end if
  return newTty
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

/**
 * 后台开新 tab：activate Terminal（`do script` 必需）→ 立刻切回原 app。
 * 200-300ms 闪 Terminal 一下，然后 Terminal 回后台。
 * 用于 SOP 派发这类"不想抢焦点"的场景。
 */
const NEW_TAB_BACKGROUND_SCRIPT = `
on run argv
  set initCmd to item 1 of argv
  set prevAppName to ""
  try
    tell application "System Events"
      set prevAppName to name of (first application process whose frontmost is true)
    end tell
  end try
  set prevTtys to {}
  set newTty to ""
  tell application "Terminal"
    activate
    repeat with w in windows
      try
        repeat with t in tabs of w
          try
            set end of prevTtys to (tty of t)
          end try
        end repeat
      end try
    end repeat
    try
      set frontWin to front window
      set newT to do script initCmd in frontWin
    on error
      set newT to do script initCmd
    end try
    set newTty to tty of newT
    if newTty is in prevTtys then
      set newT to do script initCmd
      set newTty to tty of newT
    end if
  end tell
  -- 立刻切回原 app（如果不是 Terminal）
  if prevAppName is not "" and prevAppName is not "Terminal" then
    try
      tell application "System Events"
        set frontmost of (first application process whose name is prevAppName) to true
      end tell
    end try
  end if
  return newTty
end run
`;

export interface NewTabOptions {
  cwd?: string;
  mode?: 'new-tab' | 'new-window' | 'new-tab-background';
}

/**
 * 开新 tab（默认在 front window 开），可选 cd。
 * 用 ':' 作 no-op 启动命令（shell 内置，无输出），尽量少污染终端。
 * 然后等 1.5s 让 shell 完成初始化，再发 cd。
 */
export async function newTab(opts: NewTabOptions = {}): Promise<string> {
  const initCmd = ':';
  let script: string;
  if (opts.mode === 'new-window') script = NEW_WINDOW_SCRIPT;
  else if (opts.mode === 'new-tab-background') script = NEW_TAB_BACKGROUND_SCRIPT;
  else script = NEW_TAB_IN_FRONT_SCRIPT;
  let tty: string;
  try {
    tty = (await runScriptOrThrow(script, [initCmd])).trim();
  } catch (e) {
    // fallback 到 new-window（无 front window 时 in front window 会失败）
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

  // 打开后补一次 Enter：有些 shell 集成 / 首启会残留一个"按回车继续/选择"的提示，
  // 一个空 do script（= 纯 Return 到该 tab，不抢焦点）把 prompt 落定到干净状态。
  await sendKeysRaw(tty, '');

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
 * 检测当前"用户焦点"：Terminal 是不是 frontmost app + front window 的 selected tab 是哪个 tty。
 * 返回：
 *  - { terminalFrontmost: true, tty: '/dev/ttysXXX' } — 用户正在盯着 Terminal 的这个 tab
 *  - { terminalFrontmost: true, tty: null } — 在 Terminal 但拿不到 tty（异常）
 *  - { terminalFrontmost: false } — 用户在别的 app
 */
const FRONT_FOCUS_SCRIPT = `
tell application "System Events"
  set frontApp to name of (first application process whose frontmost is true)
end tell
if frontApp is "Terminal" then
  try
    tell application "Terminal"
      set selTty to tty of selected tab of front window
      return "yes|" & selTty
    end tell
  on error
    return "yes|"
  end try
else
  return "no|"
end if
`;

export async function getUserFocus(): Promise<{
  terminalFrontmost: boolean;
  tty: string | null;
}> {
  try {
    const raw = (await runScriptOrThrow(FRONT_FOCUS_SCRIPT, [])).trim();
    const [flag, tty] = raw.split('|');
    return {
      terminalFrontmost: flag === 'yes',
      tty: tty && tty.length > 0 ? tty : null,
    };
  } catch {
    return { terminalFrontmost: false, tty: null };
  }
}

/**
 * 在目标 tab 显式发一次 Return 键。
 * 用于 claude TUI 这种"\n 不提交 prompt"的程序。
 */
export async function forceEnter(tty: string): Promise<boolean> {
  const out = await runScriptOrThrow(FORCE_ENTER_SCRIPT, [tty]);
  return out.trim() === 'ok';
}

// close w saving no 只处理"保存文档"，不处理 Terminal 的『关闭前确认（有进程在跑）』
// sheet —— 那个 sheet 会把窗口卡住关不掉。所以：close w 触发 sheet 后，若检测到 sheet
// 就按 Return 确认默认按钮（关闭）。没 sheet（未开该确认 / 空 shell）则不误发回车。
const CLOSE_SCRIPT = `
on run argv
  set targetTty to item 1 of argv
  set hit to false
  tell application "Terminal"
    repeat with w in windows
      try
        repeat with t in tabs of w
          if (tty of t) is equal to targetTty then
            set frontmost of w to true
            set hit to true
            close w
            exit repeat
          end if
        end repeat
        if hit then exit repeat
      end try
    end repeat
  end tell
  if not hit then return "not-found"
  delay 0.3
  tell application "System Events"
    try
      if exists (sheet 1 of window 1 of process "Terminal") then
        key code 36
      end if
    end try
  end tell
  return "ok"
end run
`;

export async function closeTab(tty: string): Promise<boolean> {
  const out = await runScriptOrThrow(CLOSE_SCRIPT, [tty]);
  return out.trim() === 'ok';
}
