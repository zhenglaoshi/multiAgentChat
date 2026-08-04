import { describe, it, expect } from 'vitest';
import {
  runScript,
  DEFAULT_OSASCRIPT_TIMEOUT_MS,
} from '../packages/host-mac/src/terminal/applescript.js';

// runScript 给 osascript 子进程加了超时 + SIGTERM/SIGKILL：授权弹框会让 osascript 无限阻塞，
// 没有超时时上层（newTab / forceEnter…）永不返回 → 飞书端「没反应」。这里验证超时会 reject，
// 而正常快脚本照常 resolve。osascript 是 macOS 专有，非 darwin 跳过。
const onMac = process.platform === 'darwin';

describe('runScript osascript 超时', () => {
  it('默认超时是正有限数', () => {
    expect(Number.isFinite(DEFAULT_OSASCRIPT_TIMEOUT_MS)).toBe(true);
    expect(DEFAULT_OSASCRIPT_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it.skipIf(!onMac)('快脚本在超时内正常 resolve', async () => {
    const r = await runScript('return "hi"', [], 5000);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('hi');
  });

  it.skipIf(!onMac)('阻塞脚本超时 reject（不永久挂起）', async () => {
    const started = Date.now();
    // delay 5 会让 osascript 挂 5s；给 150ms 超时，应远早于此 reject。
    await expect(runScript('delay 5\nreturn "done"', [], 150)).rejects.toThrow(/超时/);
    // 断言确实是超时提前掐断（远小于脚本的 5s），而不是等脚本自己跑完。
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it.skipIf(!onMac)('timeoutMs=0 视为禁用超时，快脚本仍能跑完', async () => {
    const r = await runScript('return "ok"', [], 0);
    expect(r.stdout.trim()).toBe('ok');
  });
});
