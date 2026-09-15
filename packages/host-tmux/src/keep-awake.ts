/**
 * 「别让机器睡着」的只读探测。
 *
 * 为什么 tmux 宿主要管这个：本宿主的主场是 **WSL2**，而 Windows 的电源默认值比 macOS 更容易失联
 * （空闲睡眠 + 合盖睡眠 + Modern Standby 连接待机）。机器一睡，飞书发指令石沉大海，
 * 而**失败是静默的** —— 用户分不清是机器睡了、WSL 挂了还是 bot 断线。
 *
 * 这里**不负责替用户设置**（那是一次性的 powercfg 命令，见 keepAwakeInstallCmd），
 * 只负责**发现设置被改回去了**：OEM 电源管理软件（Lenovo Vantage / Dell Power Manager / MyASUS）、
 * Windows 功能更新、公司组策略都会覆盖电源方案。上层 lid-awake-probe 的告警卡因此照常有用。
 *
 * 非 WSL 的纯 Linux（服务器/桌面）没有这套东西 → 如实返回「不是笔记本、没装守护」，探针会跳过。
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { KeepAwakeState, PowerSource } from 'multiagent-host-api';

/** 一次性设好 AC 侧电源策略的命令（提示给用户，本程序不代跑）。 */
export const WSL_KEEP_AWAKE_CMD =
  'powercfg.exe /change standby-timeout-ac 0 && powercfg.exe /change hibernate-timeout-ac 0 '
  + '&& powercfg.exe -setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 '
  + '&& powercfg.exe -setactive SCHEME_CURRENT';

/** 跑在 WSL 里吗（决定能不能调 Windows 侧的 powercfg.exe）。 */
export function isWSL(): boolean {
  if (process.env['WSL_DISTRO_NAME'] || process.env['WSL_INTEROP']) return true;
  try {
    return /microsoft/i.test(readFileSync('/proc/sys/kernel/osrelease', 'utf8'));
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout ?? ''));
    });
  });
}

/**
 * 解析 `powercfg.exe /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE` 的 AC 生效值。
 * 该输出里 `Current AC Power Setting Index: 0x00000000` 的 0 表示「从不睡眠」。
 * 拿不到（没跑在 WSL / 命令不可用）返回 null，由调用方按"未知"处理，别当成已设好。纯函数。
 */
export function parseAcStandbyTimeout(out: string): number | null {
  const m = /Current AC Power Setting Index:\s*(0x[0-9a-fA-F]+|\d+)/.exec(out);
  if (!m) return null;
  const raw = m[1]!;
  const n = raw.startsWith('0x') ? Number.parseInt(raw, 16) : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** 解析 `powercfg.exe /batteryreport`/`/list` 之外最轻的电源来源判据：WMIC 太重，这里用 /q 的 AC/DC 差异兜底。 */
export function parsePowerSourceFromSysfs(acOnline: string): PowerSource {
  const t = acOnline.trim();
  if (t === '1') return 'ac';
  if (t === '0') return 'battery';
  return 'unknown';
}

/** Linux sysfs 里有没有电池（有 = 笔记本）。 */
async function readSysfs(path: string): Promise<string | null> {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 探「机器会不会睡」的当前状态。
 * WSL：调 Windows 侧 `powercfg.exe` 读 AC 空闲睡眠超时（0 = 从不睡 = 守护到位）。
 * 非 WSL：没有这套模型，如实报 false，上层探针会跳过。
 */
export async function detectKeepAwake(): Promise<KeepAwakeState> {
  if (!isWSL()) {
    return { isLaptop: false, installed: false, running: null, sleepDisabled: null, powerSource: 'unknown' };
  }
  const acOnline = await readSysfs('/sys/class/power_supply/AC/online');
  const powerSource = acOnline === null ? 'unknown' : parsePowerSourceFromSysfs(acOnline);
  const q = await run('powercfg.exe', ['/query', 'SCHEME_CURRENT', 'SUB_SLEEP', 'STANDBYIDLE']);
  const timeout = q === null ? null : parseAcStandbyTimeout(q);
  const sleepDisabled = timeout === null ? null : timeout === 0;
  return {
    // WSL2 拿不到可靠的"是不是笔记本"（/sys 的电池不一定透传）→ 只要能调通 powercfg 就按"需要关心"处理
    isLaptop: true,
    installed: sleepDisabled === true,
    running: sleepDisabled,
    sleepDisabled,
    powerSource,
  };
}
