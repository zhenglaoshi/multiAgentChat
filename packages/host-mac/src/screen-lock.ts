import { execFile } from 'node:child_process';
import { platform } from 'node:os';

/**
 * 屏幕是否锁定（macOS）。读 `ioreg -n Root -d1 -a` 里的 `CGSSessionScreenIsLocked`：
 * 锁屏时该 key 为 <true/>；未锁时通常**没有这个 key**。
 *
 * 用途：System Events 按键注入（sendKeys：方向键 / Esc / Ctrl-C）在锁屏下**送不进终端但 osascript 仍返回 ok**
 * （2026-09-07 真机实测），调用方据此改走 pty 通道或如实告知用户，别再报假成功。
 * 不依赖 pyobjc / Quartz，只用系统自带 ioreg。
 */

/** 解析 ioreg 的 plist 输出。纯函数，便于单测。 */
export function parseScreenLocked(ioregPlist: string): boolean {
  return /<key>CGSSessionScreenIsLocked<\/key>\s*<true\s*\/>/.test(ioregPlist);
}

/** 非 darwin / ioreg 失败 → null（未知），调用方按「未知」处理，不要当成未锁。 */
export async function isScreenLocked(timeoutMs = 2000): Promise<boolean | null> {
  if (platform() !== 'darwin') return null;
  return new Promise((resolve) => {
    execFile('/usr/sbin/ioreg', ['-n', 'Root', '-d1', '-a'], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : parseScreenLocked(String(stdout)));
    });
  });
}
