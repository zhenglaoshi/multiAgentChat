import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';

/**
 * 「插电合盖也能远程」守护的只读探测（守护本体是 root LaunchDaemon：`sudo scripts/lid-awake.sh install`，
 * 插电 → `pmset -a disablesleep 1`（合盖只灭屏锁屏、不睡），用电池 → 0）。
 * 这里只负责看：是不是笔记本、守护装没装、当前 SleepDisabled、电源来源。daemon 启动探针 + `agent doctor` 共用。
 */

export const LID_AWAKE_LABEL = 'com.multiagent-chat.lid-awake';
export const LID_AWAKE_PLIST = `/Library/LaunchDaemons/${LID_AWAKE_LABEL}.plist`;
export const LID_AWAKE_INSTALL_CMD = 'sudo scripts/lid-awake.sh install';

export type PowerSource = 'ac' | 'battery' | 'unknown';

export interface LidAwakeState {
  /** `pmset -g batt` 里有 InternalBattery → 笔记本（台式机没有合盖问题） */
  isLaptop: boolean;
  /** 守护 plist 在 /Library/LaunchDaemons（已安装 ≠ 在跑，见 running） */
  installed: boolean;
  /** `launchctl print system/<label>` 显示 state = running（非 root 也能读）；null = launchctl 不可用 / 未安装 */
  running: boolean | null;
  /** `pmset -g` 的 SleepDisabled 生效值；null = 读不到 */
  sleepDisabled: boolean | null;
  powerSource: PowerSource;
}

/** 解析 `pmset -g batt` 首行：Now drawing from 'AC Power' / 'Battery Power' / 'UPS Power'。纯函数。 */
export function parsePowerSource(battOut: string): PowerSource {
  const first = battOut.split('\n')[0] ?? '';
  if (/'AC Power'|'UPS Power'/.test(first)) return 'ac';
  if (/'Battery Power'/.test(first)) return 'battery';
  return 'unknown';
}

/** `pmset -g batt` 输出里有 InternalBattery 行 → 笔记本。纯函数。 */
export function parseIsLaptop(battOut: string): boolean {
  return /InternalBattery/.test(battOut);
}

/**
 * 解析 `pmset -g`（生效值）里的 SleepDisabled。注意它**不在** `pmset -g custom` 里。
 * 没这一行 = 0（未禁睡）；给的是整段输出为空/读不到时返回 null 由调用方处理。纯函数。
 */
export function parseSleepDisabled(pmsetG: string): boolean | null {
  if (!pmsetG.trim()) return null;
  const m = /^\s*SleepDisabled\s+(\d)/m.exec(pmsetG);
  return m ? m[1] === '1' : false;
}

/** 解析 `launchctl print system/<label>` 输出：state = running → true。纯函数。 */
export function parseLaunchctlRunning(out: string): boolean {
  return /^\s*state\s*=\s*running\b/m.test(out);
}

function run(cmd: string, args: string[], timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

export async function detectLidAwake(): Promise<LidAwakeState> {
  if (platform() !== 'darwin') {
    return { isLaptop: false, installed: false, running: null, sleepDisabled: null, powerSource: 'unknown' };
  }
  const installed = existsSync(LID_AWAKE_PLIST);
  const [batt, g, lc] = await Promise.all([
    run('/usr/bin/pmset', ['-g', 'batt']),
    run('/usr/bin/pmset', ['-g']),
    installed ? run('/bin/launchctl', ['print', `system/${LID_AWAKE_LABEL}`]) : Promise.resolve(null),
  ]);
  return {
    isLaptop: batt ? parseIsLaptop(batt) : false,
    installed,
    // launchctl print 对未加载的 job 直接非 0 退出 → run 返回 null → 视为没在跑
    running: installed ? (lc ? parseLaunchctlRunning(lc) : false) : null,
    sleepDisabled: g ? parseSleepDisabled(g) : null,
    powerSource: batt ? parsePowerSource(batt) : 'unknown',
  };
}
