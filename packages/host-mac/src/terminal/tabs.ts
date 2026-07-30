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
 * 开新 shell（一个全新 tty）。
 *
 * ⚠ 原来用 `do script initCmd in front window` 想在前台窗口开 tab，但 Terminal 的
 * `do script X in window` 在 selected tab **忙碌**时会**把 X 跑进那个 tab**（实测把
 * initCmd `:` 注入进前台 claude 会话！），返回原 tty → 撞 prevTtys → fallback 开新 window。
 * 于是既污染了前台 claude，又开成窗口。
 *
 * 改用**裸 `do script initCmd`**（不带 `in`）：永远新建、拿到全新 tty，绝不碰任何现有 tab。
 * 是"窗口"还是"tab"由 macOS「偏好标签页」(`AppleWindowTabbingMode`) 决定 —— 设为
 * `always` 且 Terminal 重启后即为 tab；否则为窗口。代码层不再纠结（也纠结不动，见该设置）。
 */
const NEW_TAB_IN_FRONT_SCRIPT = `
on run argv
  set initCmd to item 1 of argv
  tell application "Terminal"
    activate
    set newT to do script initCmd
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
  set newTty to ""
  tell application "Terminal"
    activate
    -- 裸 do script：永远新建、绝不碰现有 tab（不像 "in front window" 会把 initCmd 注入前台忙碌 tab）
    set newT to do script initCmd
    set newTty to tty of newT
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
 *  3. **前台守卫**：确认前台确实是 Terminal 且前台窗口选中 tab 就是目标 tty 才发 Return；
 *     否则（系统弹框 / 锁屏抢焦点，activate 顶不上去）**不盲按**——盲按会把 Return 打到
 *     弹框上、甚至误触其默认按钮（如权限「允许」），既没提交命令又有副作用。返回 "blocked"。
 *  4. System Events key code 36（Return）
 *  5. 立即切回原 app（减少打扰，~200ms 闪屏）
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

  -- 阶段1：纯匹配、零焦点副作用（仿 CLOSE_SCRIPT）。匹配的 try 只吞"某窗口枚举 tab 失败"，
  -- 不吞焦点操作的错——把 activate/set frontmost 放阶段2循环外，脚本真出错时会抛、被上层捕获，
  -- 不会误当成"被弹框挡住"。
  set foundWin to missing value
  set foundTab to missing value
  tell application "Terminal"
    repeat with w in windows
      try
        repeat with t in tabs of w
          if (tty of t) is equal to targetTty then
            set foundWin to w
            set foundTab to t
            exit repeat
          end if
        end repeat
      end try
      if foundWin is not missing value then exit repeat
    end repeat
  end tell
  if foundWin is missing value then return "not-found"

  -- 阶段2：循环外改焦点（失败就抛，别吞）
  tell application "Terminal"
    activate
    set frontmost of foundWin to true
    set selected tab of foundWin to foundTab
  end tell
  delay 0.15

  -- 前台守卫：弹框/锁屏抢焦点时 activate 顶不上去，此时绝不发回车
  set frontApp to ""
  try
    tell application "System Events"
      set frontApp to name of (first application process whose frontmost is true)
    end tell
  end try
  set curTty to ""
  try
    tell application "Terminal"
      set curTty to (tty of selected tab of front window)
    end tell
  end try

  set didEnter to false
  set blockedApp to ""
  if frontApp is "Terminal" and curTty is equal to targetTty then
    tell application "System Events"
      key code 36  -- Return key
    end tell
    set didEnter to true
  else
    set blockedApp to frontApp
  end if

  -- 切回原 app（成功/blocked 都切——阶段2已真实动过焦点，一律恢复以减少打扰）
  if prevAppName is not "" and prevAppName is not "Terminal" then
    try
      tell application "System Events"
        set frontmost of (first application process whose name is prevAppName) to true
      end tell
    end try
  end if

  if didEnter then
    return "ok"
  else
    return "blocked|" & blockedApp
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

/** forceEnter 的结果：区分「回车已发」「被前台弹框/锁屏挡住没敢发」「没找到 tab」。 */
export interface ForceEnterResult {
  /** Return 确实发出去了 */
  ok: boolean;
  /** 前台不是目标 tab（系统弹框/锁屏抢了焦点）→ 为防误触弹框默认按钮，没发回车 */
  blocked: boolean;
  /** blocked 时的前台 app 名（'' = 拿不到，多半是锁屏 loginwindow） */
  frontApp?: string;
}

/** 解析 FORCE_ENTER_SCRIPT 的输出（"ok" / "blocked|<app>" / "not-found"）→ 结果结构。纯函数，便于单测。 */
export function parseForceEnterOutput(out: string): ForceEnterResult {
  const s = out.trim();
  if (s === 'ok') return { ok: true, blocked: false };
  if (s.startsWith('blocked|')) return { ok: false, blocked: true, frontApp: s.slice('blocked|'.length) };
  return { ok: false, blocked: false };
}

/**
 * 在目标 tab 显式发一次 Return 键。
 * 用于 claude TUI 这种"\n 不提交 prompt"的程序。
 * 带前台守卫：只有确认前台就是目标 Terminal tab 才真按 Return，被弹框/锁屏挡住则返回 blocked。
 */
export async function forceEnter(tty: string): Promise<ForceEnterResult> {
  return parseForceEnterOutput(await runScriptOrThrow(FORCE_ENTER_SCRIPT, [tty]));
}

// 关**单个 tab**（不是整窗）：选中目标 tab → 前台化 → System Events Cmd-W（= Close Tab，
// 只关当前 tab；窗口仅剩此 tab 时顺带关窗）。原来用 `close w` 会把多 tab 同窗的**整窗全关**。
// Terminal 的『关闭前确认（有进程在跑）』sheet 会卡住关不掉 → Cmd-W 后若检测到 sheet，
// 按 Return 确认默认按钮（关闭）。没 sheet（已退出 agent / 空 shell / 未开该确认）则不误发回车。
//
// ⚠ 分两阶段（实测踩坑后重构）：**阶段1 只纯匹配、记下 window/tab 引用，绝不做焦点副作用**；
//   **阶段2 遍历结束后**才 activate/选中/Cmd-W。原来把 activate/set frontmost 塞进匹配循环、
//   又包在静默 `try` 里 → 一旦焦点操作瞬时抛错（如刚从系统设置切回、Terminal 被别的 app 压在
//   后面时 activate 抖动），错误被吞掉、`hit` 没置上 → **误报 "not-found"**（表现为"未找到或
//   关闭失败"但 tab 明明还在）。分阶段后焦点错误会显式抛出、由上层 catch 成准确原因，不再冒充
//   not-found。关前再做一道**二次确认**：前台窗口选中的确实是目标 tty 才 Cmd-W，防误关别的 tab。
const CLOSE_SCRIPT = `
on run argv
  set targetTty to item 1 of argv
  set foundWin to missing value
  set foundTab to missing value
  -- 阶段1：纯匹配，零焦点副作用
  tell application "Terminal"
    repeat with w in windows
      try
        repeat with t in tabs of w
          if (tty of t) is equal to targetTty then
            set foundWin to w
            set foundTab to t
            exit repeat
          end if
        end repeat
      end try
      if foundWin is not missing value then exit repeat
    end repeat
  end tell
  if foundWin is missing value then return "not-found"
  -- 阶段2：遍历外改焦点（失败就让它抛，别吞）
  tell application "Terminal"
    activate
    set frontmost of foundWin to true
    set selected tab of foundWin to foundTab
  end tell
  -- 关前二次确认：前台选中的就是目标才动手，否则宁可不关（防误关别的 tab）
  set curTty to ""
  tell application "Terminal"
    try
      set curTty to (tty of selected tab of front window)
    end try
  end tell
  if curTty is not equal to targetTty then return "focus-mismatch:" & curTty
  delay 0.2
  tell application "System Events"
    keystroke "w" using {command down}
    delay 0.3
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
  // 兜底归一到全形式（tty 是主键、恒 /dev/ttysNNN）——关是破坏性操作，绝不因调用方传了
  // 短形式 `ttys007` 就静默 not-found。CLOSE_SCRIPT 里 `tty of t` 永远全形式。
  const target = /^ttys\d+$/.test(tty) ? `/dev/${tty}` : tty;
  const out = (await runScriptOrThrow(CLOSE_SCRIPT, [target])).trim();
  if (out === 'ok') return true;
  if (out === 'not-found') return false;
  // focus-mismatch:<tty> 等异常态 → 抛出，让 closeTabGracefully 的 catch 拿到明确原因，
  // 而不是被当成 not-found 误报（曾经的坑）。
  throw new Error(`closeTab 中止（未 Cmd-W）: ${out}`);
}
