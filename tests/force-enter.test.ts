import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forceEnter, parseForceEnterOutput, resolveEnterMode } from '../packages/host-mac/src/terminal/tabs.js';

// forceEnter 前台守卫：脚本输出 "ok" / "blocked|<app>" / "not-found"，parseForceEnterOutput 解析成结构。
describe('parseForceEnterOutput', () => {
  it('"ok" → 回车已发', () => {
    expect(parseForceEnterOutput('ok')).toEqual({ ok: true, blocked: false });
  });

  it('带首尾空白也能识别 ok', () => {
    expect(parseForceEnterOutput('  ok\n')).toEqual({ ok: true, blocked: false });
  });

  it('"blocked|<app>" → 被弹框挡住，带前台 app 名', () => {
    expect(parseForceEnterOutput('blocked|UserNotificationCenter')).toEqual({
      ok: false, blocked: true, frontApp: 'UserNotificationCenter',
    });
  });

  it('"blocked|"（空 app，多半锁屏）→ blocked 且 frontApp 为空串', () => {
    expect(parseForceEnterOutput('blocked|')).toEqual({ ok: false, blocked: true, frontApp: '' });
  });

  it('"not-found" → 既没发也没被挡（tab 没找到）', () => {
    expect(parseForceEnterOutput('not-found')).toEqual({ ok: false, blocked: false });
  });

  it('无法识别的输出 → 保守当作没发、未 blocked', () => {
    expect(parseForceEnterOutput('weird osascript error')).toEqual({ ok: false, blocked: false });
  });
});

// 回车提交通道选择：默认 pty（空 do script 直写 \r，不依赖焦点），只有显式 keystroke 才退回键盘事件路径。
describe('resolveEnterMode', () => {
  // 显式传 undefined 会走默认参数读 process.env → 隔离环境，别让本机 shell 里残留的 MCHAT_ENTER_MODE 污染断言
  beforeEach(() => { vi.stubEnv('MCHAT_ENTER_MODE', ''); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('未设 → pty（默认）', () => {
    expect(resolveEnterMode(undefined)).toBe('pty');
    expect(resolveEnterMode('')).toBe('pty');
  });

  it('keystroke（大小写/空白不敏感）→ keystroke', () => {
    expect(resolveEnterMode('keystroke')).toBe('keystroke');
    expect(resolveEnterMode('  KeyStroke ')).toBe('keystroke');
  });

  it('环境变量设了 keystroke、不传参 → keystroke', () => {
    vi.stubEnv('MCHAT_ENTER_MODE', 'keystroke');
    expect(resolveEnterMode()).toBe('keystroke');
  });

  it('其它乱值 → 保守回落 pty', () => {
    expect(resolveEnterMode('pty')).toBe('pty');
    expect(resolveEnterMode('yes')).toBe('pty');
    expect(resolveEnterMode('0')).toBe('pty');
  });
});

describe('forceEnter 通道分派', () => {
  it('pty 模式：往 tab 写一次空 do script（= 单独一个 \r），成功即 ok，绝不走键盘事件', async () => {
    const calls: Array<[string, string]> = [];
    let keystrokeCalled = false;
    const r = await forceEnter('/dev/ttys009', { mode: 'pty' }, {
      sendRaw: async (tty, text) => { calls.push([tty, text]); return true; },
      keystroke: async () => { keystrokeCalled = true; return { ok: true, blocked: false }; },
    });
    expect(calls).toEqual([['/dev/ttys009', '']]);
    expect(keystrokeCalled).toBe(false);
    expect(r).toEqual({ ok: true, blocked: false, via: 'pty' });
  });

  it('pty 模式：tab 不存在 → ok=false 且不算 blocked（不会触发「前台被挡」告警）', async () => {
    const r = await forceEnter('/dev/ttys999', { mode: 'pty' }, { sendRaw: async () => false });
    expect(r).toEqual({ ok: false, blocked: false, via: 'pty' });
  });

  it('keystroke 模式：走键盘事件路径，原样透传其 blocked 结果', async () => {
    let rawCalled = false;
    const r = await forceEnter('/dev/ttys009', { mode: 'keystroke' }, {
      sendRaw: async () => { rawCalled = true; return true; },
      keystroke: async () => ({ ok: false, blocked: true, frontApp: 'Google Chrome', via: 'keystroke' }),
    });
    expect(rawCalled).toBe(false);
    expect(r).toEqual({ ok: false, blocked: true, frontApp: 'Google Chrome', via: 'keystroke' });
  });
});
