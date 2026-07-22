import { describe, it, expect } from 'vitest';
import { stuckDecision, digestDue, localDayStr } from '../packages/im-lark/src/monitor/fleet-monitor-logic.js';

const T = 5 * 60_000; // 5min 阈值

describe('stuckDecision — 卡住判定', () => {
  it('首次见到 → 记录不告警', () => {
    const r = stuckDecision(undefined, 100, 1_000_000, T);
    expect(r.alert).toBe(false);
    expect(r.state).toEqual({ charLen: 100, lastChangedAt: 1_000_000, alerted: false });
  });
  it('长度变化 → 刷新时间、清 alerted、不告警', () => {
    const prev = { charLen: 100, lastChangedAt: 0, alerted: true };
    const r = stuckDecision(prev, 150, 9_999, T);
    expect(r.alert).toBe(false);
    expect(r.state.lastChangedAt).toBe(9_999);
    expect(r.state.alerted).toBe(false);
  });
  it('停滞未到阈值 → 不告警', () => {
    const prev = { charLen: 100, lastChangedAt: 0, alerted: false };
    const r = stuckDecision(prev, 100, T - 1, T);
    expect(r.alert).toBe(false);
  });
  it('停滞到阈值且未报过 → 告警一次', () => {
    const prev = { charLen: 100, lastChangedAt: 0, alerted: false };
    const r = stuckDecision(prev, 100, T, T);
    expect(r.alert).toBe(true);
    expect(r.state.alerted).toBe(true);
    // 再来一次(仍停滞) → 不再重复告警
    const r2 = stuckDecision(r.state, 100, T + 60_000, T);
    expect(r2.alert).toBe(false);
    expect(r2.state.alerted).toBe(true);
    // lastChangedAt 保持不变(还是最初变化点)
    expect(r2.state.lastChangedAt).toBe(0);
  });
});

describe('digestDue / localDayStr — 每早摘要到点', () => {
  // 用固定本地时间构造 now
  const at9 = (dayOffset: number, h: number, m: number) =>
    new Date(2026, 6, 23 + dayOffset, h, m, 0).getTime();

  it('已过 09:00 且今天没推过 → due', () => {
    expect(digestDue(at9(0, 9, 30), '09:00', '2026-07-22')).toBe(true);
  });
  it('未到 09:00 → 不 due', () => {
    expect(digestDue(at9(0, 8, 59), '09:00', '2026-07-22')).toBe(false);
  });
  it('今天已推过 → 不 due', () => {
    expect(digestDue(at9(0, 10, 0), '09:00', '2026-07-23')).toBe(false);
  });
  it('非法 atSpec → 不 due', () => {
    expect(digestDue(at9(0, 23, 0), 'garbage', undefined)).toBe(false);
  });
  it('localDayStr 补零', () => {
    expect(localDayStr(new Date(2026, 0, 5, 0, 0, 0).getTime())).toBe('2026-01-05');
  });
});
