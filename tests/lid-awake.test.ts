import { describe, expect, it } from 'vitest';
import { parseIsLaptop, parseLaunchctlRunning, parsePowerSource, parseSleepDisabled } from '../packages/host-mac/src/lid-awake.js';
import { buildLidAwakeNudge } from '../packages/im-lark/src/monitor/lid-awake-probe.js';

// 「插电合盖也能远程」守护的只读探测：pmset 输出解析（真机样本）
const BATT_AC = `Now drawing from 'AC Power'\n -InternalBattery-0 (id=6291555)\t100%; charged; 0:00 remaining present: true\n`;
const BATT_BAT = `Now drawing from 'Battery Power'\n -InternalBattery-0 (id=6291555)\t87%; discharging; 5:12 remaining present: true\n`;
const BATT_DESKTOP = `Now drawing from 'AC Power'\n`;

describe('parsePowerSource', () => {
  it('AC / Battery / UPS / 未知', () => {
    expect(parsePowerSource(BATT_AC)).toBe('ac');
    expect(parsePowerSource(BATT_BAT)).toBe('battery');
    expect(parsePowerSource(`Now drawing from 'UPS Power'\n`)).toBe('ac');
    expect(parsePowerSource('')).toBe('unknown');
  });
});

describe('parseIsLaptop', () => {
  it('有 InternalBattery 行才算笔记本', () => {
    expect(parseIsLaptop(BATT_AC)).toBe(true);
    expect(parseIsLaptop(BATT_DESKTOP)).toBe(false);
  });
});

describe('parseSleepDisabled', () => {
  const PMSET_G_ON = `System-wide power settings:\n SleepDisabled\t\t1\nCurrently in use:\n lidwake              1\n sleep                0 (sleep prevented by caffeinate)\n`;
  const PMSET_G_OFF = `System-wide power settings:\nCurrently in use:\n lidwake              1\n sleep                1\n`;
  it('有 SleepDisabled 1 → true；没这一行 → false；空输出 → null', () => {
    expect(parseSleepDisabled(PMSET_G_ON)).toBe(true);
    expect(parseSleepDisabled(PMSET_G_OFF)).toBe(false);
    expect(parseSleepDisabled('')).toBeNull();
  });
  it('不被别的含 Sleep 字样的行误判', () => {
    expect(parseSleepDisabled(`Currently in use:\n disksleep 10\n sleep 0\n`)).toBe(false);
  });
});

describe('buildLidAwakeNudge', () => {
  it('两种文案都带安装命令与关闭开关', () => {
    for (const sd of [true, false, null]) {
      const t = buildLidAwakeNudge(sd);
      expect(t).toContain('sudo scripts/lid-awake.sh install');
      expect(t).toContain('LID_AWAKE_NUDGE=0');
    }
    expect(buildLidAwakeNudge(true)).toContain('拔电放包里也不会睡');
    expect(buildLidAwakeNudge(false)).toContain('合盖就睡');
  });
});

describe('parseLaunchctlRunning', () => {
  it('launchctl print 有 state = running → true；其它 → false', () => {
    expect(parseLaunchctlRunning('system/com.multiagent-chat.lid-awake = {\n\tactive count = 1\n\tstate = running\n\tpid = 275\n}')).toBe(true);
    expect(parseLaunchctlRunning('\tstate = waiting\n')).toBe(false);
    expect(parseLaunchctlRunning('')).toBe(false);
  });
});
