import { describe, expect, it } from 'vitest';
import { parseScreenLocked } from '../packages/host-mac/src/screen-lock.js';

// ioreg -n Root -d1 -a 的 plist：锁屏时有 <key>CGSSessionScreenIsLocked</key><true/>；未锁时通常没这个 key
describe('parseScreenLocked', () => {
  it('有 CGSSessionScreenIsLocked = true → 锁定', () => {
    const plist = '<dict>\n\t\t\t<key>CGSSessionScreenIsLocked</key>\n\t\t\t<true/>\n\t\t\t<key>kCGSSessionUserIDKey</key>\n\t\t\t<integer>501</integer>\n</dict>';
    expect(parseScreenLocked(plist)).toBe(true);
  });
  it('key 不存在（未锁的常态）→ 未锁', () => {
    const plist = '<dict>\n\t\t\t<key>kCGSSessionUserIDKey</key>\n\t\t\t<integer>501</integer>\n</dict>';
    expect(parseScreenLocked(plist)).toBe(false);
  });
  it('显式 <false/> → 未锁', () => {
    expect(parseScreenLocked('<key>CGSSessionScreenIsLocked</key>\n<false/>')).toBe(false);
  });
  it('空输出 → 未锁（调用方对 ioreg 失败另走 null 分支）', () => {
    expect(parseScreenLocked('')).toBe(false);
  });
});
