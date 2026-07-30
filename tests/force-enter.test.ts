import { describe, it, expect } from 'vitest';
import { parseForceEnterOutput } from '../packages/host-mac/src/terminal/tabs.js';

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
