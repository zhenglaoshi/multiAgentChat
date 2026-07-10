import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runScriptOrThrow } from './applescript.js';

const FOCUS_AND_BOUNDS_SCRIPT = `
on run argv
  set targetTty to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      try
        repeat with t in tabs of w
          if (tty of t) is equal to targetTty then
            activate
            set frontmost of w to true
            set selected tab of w to t
            delay 0.15
            set b to bounds of w
            return ((item 1 of b) as text) & "," & ((item 2 of b) as text) & "," & (((item 3 of b) - (item 1 of b)) as text) & "," & (((item 4 of b) - (item 2 of b)) as text)
          end if
        end repeat
      end try
    end repeat
  end tell
  return "not-found"
end run
`;

/**
 * 抓 Terminal.app 指定 tab 所在窗口的截图（含 alt-screen TUI 内容）。
 * 会先把 tab 拉到 front（activate + selected tab），delay 150ms 让窗口重绘。
 * 用 `screencapture -R x,y,w,h`（AppleScript window bounds 提供坐标），不用 -l
 * 是因为 AppleScript window id 与 CGWindowID 有时不同，-R 更稳。
 * 返回：/tmp 下的 png 绝对路径。
 */
export async function captureScreen(tty: string): Promise<string> {
  const raw = (await runScriptOrThrow(FOCUS_AND_BOUNDS_SCRIPT, [tty])).trim();
  if (raw === 'not-found') throw new Error(`tab ${tty} not found`);
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`invalid bounds: ${raw}`);
  }
  const [x, y, w, h] = parts as [number, number, number, number];
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const outPath = join(tmpdir(), `mchat-screen-${stamp}.png`);
  await new Promise<void>((resolveP, rejectP) => {
    const p = spawn(
      'screencapture',
      ['-o', '-x', '-R', `${x},${y},${w},${h}`, outPath],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    p.on('error', rejectP);
    p.on('close', (code) => {
      if (code === 0) resolveP();
      else rejectP(new Error(`screencapture exit ${code}: ${stderr || '(未授权屏幕录制？System Settings → Privacy & Security → Screen Recording)'}`));
    });
  });
  return outPath;
}
