import { describe, it, expect } from 'vitest';
import { parseReportArgs, parseAnchorToken, beijingDateOf, beijingPartsOf, parseYmd } from '../packages/orchestrator/src/report/args.js';
import { reportWindow } from '../packages/orchestrator/src/report/collect.js';

// 固定「现在」：2026-09-07（北京时间周一 15:00） → UTC 2026-09-07T07:00Z
const NOW = new Date('2026-09-07T07:00:00Z');

describe('parseAnchorToken —— 日期锚点写法', () => {
  it('相对日', () => {
    expect(parseAnchorToken('今天', NOW)).toEqual({ date: '2026-09-07', implied: 'day' });
    expect(parseAnchorToken('昨天', NOW)).toEqual({ date: '2026-09-06', implied: 'day' });
    expect(parseAnchorToken('前天', NOW)).toEqual({ date: '2026-09-05', implied: 'day' });
    expect(parseAnchorToken('3天前', NOW)).toEqual({ date: '2026-09-04', implied: 'day' });
    expect(parseAnchorToken('-10', NOW)).toEqual({ date: '2026-08-28', implied: 'day' });
    expect(parseAnchorToken('yesterday', NOW)).toEqual({ date: '2026-09-06', implied: 'day' });
  });

  it('相对期（隐含周期）', () => {
    expect(parseAnchorToken('上周', NOW)).toEqual({ date: '2026-08-31', implied: 'week' });
    expect(parseAnchorToken('本月', NOW)).toEqual({ date: '2026-09-07', implied: 'month' });
    expect(parseAnchorToken('上个月', NOW)).toEqual({ date: '2026-08-31', implied: 'month' });
    expect(parseAnchorToken('去年', NOW)).toEqual({ date: '2025-01-01', implied: 'year' });
  });

  it('绝对日期多种写法', () => {
    expect(parseAnchorToken('2026-09-01', NOW)).toEqual({ date: '2026-09-01', implied: 'day' });
    expect(parseAnchorToken('2026/9/1', NOW)).toEqual({ date: '2026-09-01', implied: 'day' });
    expect(parseAnchorToken('2026年9月1日', NOW)).toEqual({ date: '2026-09-01', implied: 'day' });
    expect(parseAnchorToken('09-01', NOW)).toEqual({ date: '2026-09-01', implied: 'day' });
    expect(parseAnchorToken('9月1日', NOW)).toEqual({ date: '2026-09-01', implied: 'day' });
  });

  it('期写法：YYYY-MM → 月，YYYY → 年', () => {
    expect(parseAnchorToken('2026-08', NOW)).toEqual({ date: '2026-08-01', implied: 'month' });
    expect(parseAnchorToken('2026年8月', NOW)).toEqual({ date: '2026-08-01', implied: 'month' });
    expect(parseAnchorToken('2025', NOW)).toEqual({ date: '2025-01-01', implied: 'year' });
  });

  it('非日期 / 不存在的日期 → null（不会被误当锚点）', () => {
    expect(parseAnchorToken('day', NOW)).toBeNull();
    expect(parseAnchorToken('--brief', NOW)).toBeNull();
    expect(parseAnchorToken('日报', NOW)).toBeNull();
    expect(parseAnchorToken('2026-02-30', NOW)).toBeNull();  // 不存在
    expect(parseAnchorToken('2026-13-01', NOW)).toBeNull();
    expect(parseAnchorToken('1999', NOW)).toBeNull();        // 超出 20xx 年份范围
    // 原型链键不能撞出畸形锚点（security 复审 low）：干脆认不出、进 unknown
    for (const evil of ['__proto__', 'constructor', 'tostring', 'hasownproperty', 'valueof']) {
      expect(parseAnchorToken(evil, NOW)).toBeNull();
      expect(parseReportArgs(evil, NOW).anchor).toBeUndefined();
    }
    expect(parseReportArgs('__proto__', NOW).unknown).toEqual(['__proto__']);
    expect(parseAnchorToken('0001-01-01', NOW)).toBeNull();  // 荒谬年份也不当锚点
    expect(parseAnchorToken('9999-12-31', NOW)).toBeNull();
    expect(parseReportArgs('0001-01-01', NOW)).toMatchObject({ unknown: ['0001-01-01'] });
  });
});

describe('parseReportArgs —— 命令参数', () => {
  it('空参数 = 历史默认（周报、无锚点）', () => {
    expect(parseReportArgs('', NOW)).toEqual({ window: 'week', brief: false, future: false, unknown: [] });
  });

  it('历史写法向后兼容', () => {
    expect(parseReportArgs('day', NOW).window).toBe('day');
    expect(parseReportArgs('d', NOW).window).toBe('day');
    expect(parseReportArgs('日报', NOW).window).toBe('day');
    expect(parseReportArgs('month', NOW).window).toBe('month');
    expect(parseReportArgs('月', NOW).window).toBe('month');
    expect(parseReportArgs('year --brief', NOW)).toMatchObject({ window: 'year', brief: true });
    expect(parseReportArgs('month 简报', NOW)).toMatchObject({ window: 'month', brief: true });
    for (const k of ['day', 'week', 'month', 'year']) {
      expect(parseReportArgs(k, NOW).anchor).toBeUndefined();  // 不给日期 → 无锚点
    }
  });

  it('只给日期 → 用写法隐含的周期', () => {
    expect(parseReportArgs('昨天', NOW)).toMatchObject({ window: 'day', anchor: '2026-09-06' });
    expect(parseReportArgs('2026-09-01', NOW)).toMatchObject({ window: 'day', anchor: '2026-09-01' });
    expect(parseReportArgs('2026-08', NOW)).toMatchObject({ window: 'month', anchor: '2026-08-01' });
    expect(parseReportArgs('2025', NOW)).toMatchObject({ window: 'year', anchor: '2025-01-01' });
  });

  it('显式周期关键词优先于日期隐含的周期', () => {
    expect(parseReportArgs('week 2026-09-01', NOW)).toMatchObject({ window: 'week', anchor: '2026-09-01' });
    expect(parseReportArgs('day 2026-08', NOW)).toMatchObject({ window: 'day', anchor: '2026-08-01' });
  });

  it('未来日期打标记；无法识别的 token 单独收集', () => {
    expect(parseReportArgs('2026-09-08', NOW).future).toBe(true);
    expect(parseReportArgs('2026-09-07', NOW).future).toBe(false);
    expect(parseReportArgs('day 啥玩意', NOW)).toMatchObject({ window: 'day', unknown: ['啥玩意'] });
  });
});

describe('reportWindow —— 锚点时间窗（北京时区）', () => {
  const bj = (s: string) => new Date(s); // 断言用 label，不直接比 Date

  it('无锚点 = 历史行为（当期起点 → 现在）', () => {
    // 显式传同一个 now：否则 reportWindow 与断言各取一次 new Date()，午夜整那一瞬可能跨天 flaky
    const at = new Date();
    const d = reportWindow('day', false, undefined, at);
    expect(d.sinceLabel).toBe(beijingDateOf(at));
    expect(d.untilLabel).toBe(beijingDateOf(at));
    expect(d.until.getTime()).toBe(at.getTime());
  });

  it('历史某天的日报 = 那天整日闭合窗', () => {
    const d = reportWindow('day', false, '2026-09-01', NOW);
    expect(d.sinceLabel).toBe('2026-09-01');
    expect(d.untilLabel).toBe('2026-09-01');
    // 北京 09-01 00:00 = UTC 08-31 16:00；窗末 = 北京 09-02 00:00
    expect(d.since.toISOString()).toBe('2026-08-31T16:00:00.000Z');
    expect(d.until.toISOString()).toBe('2026-09-01T16:00:00.000Z');
  });

  it('历史某天的周报 = 含那天的整周（周一~周日）', () => {
    const w = reportWindow('week', false, '2026-08-20', NOW); // 2026-08-20 是周四
    expect(w.sinceLabel).toBe('2026-08-17');             // 周一
    expect(w.untilLabel).toBe('2026-08-23');             // 周日
  });

  it('历史月/年', () => {
    const m = reportWindow('month', false, '2026-08-15', NOW);
    expect([m.sinceLabel, m.untilLabel]).toEqual(['2026-08-01', '2026-08-31']);
    const dec = reportWindow('month', false, '2025-12-09', NOW);
    expect([dec.sinceLabel, dec.untilLabel]).toEqual(['2025-12-01', '2025-12-31']);
    const y = reportWindow('year', false, '2025-06-01', NOW);
    expect([y.sinceLabel, y.untilLabel]).toEqual(['2025-01-01', '2025-12-31']);
  });

  it('prev 相对锚点回退一个完整周期（定时报告语义不变）', () => {
    const d = reportWindow('day', true, '2026-09-02', NOW);
    expect([d.sinceLabel, d.untilLabel]).toEqual(['2026-09-01', '2026-09-01']);
    const w = reportWindow('week', true, '2026-08-20', NOW);
    expect([w.sinceLabel, w.untilLabel]).toEqual(['2026-08-10', '2026-08-16']);
    const m = reportWindow('month', true, '2026-01-15', NOW);
    expect([m.sinceLabel, m.untilLabel]).toEqual(['2025-12-01', '2025-12-31']);
  });

  it('锚点非法 → 回退到今天（不抛）', () => {
    const at = new Date();
    const d = reportWindow('day', false, 'garbage', at);
    expect(d.sinceLabel).toBe(beijingDateOf(at));
    expect(bj(d.since.toISOString()).getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('周N 写法（补「上周五的日报」）', () => {
  // NOW = 2026-09-07，北京时间周一
  it('本周 / 无前缀 = 本周那天', () => {
    expect(parseAnchorToken('周一', NOW)).toEqual({ date: '2026-09-07', implied: 'day' });
    expect(parseAnchorToken('本周三', NOW)).toEqual({ date: '2026-09-09', implied: 'day' });
    expect(parseAnchorToken('星期日', NOW)).toEqual({ date: '2026-09-13', implied: 'day' });
    expect(parseAnchorToken('周天', NOW)).toEqual({ date: '2026-09-13', implied: 'day' });
  });

  it('上周N = 上一周那天', () => {
    expect(parseAnchorToken('上周五', NOW)).toEqual({ date: '2026-09-04', implied: 'day' });
    expect(parseAnchorToken('上星期一', NOW)).toEqual({ date: '2026-08-31', implied: 'day' });
    expect(parseAnchorToken('上周日', NOW)).toEqual({ date: '2026-09-06', implied: 'day' });
  });

  it('不跟「周报/上周」这类周期写法冲突', () => {
    expect(parseAnchorToken('周报', NOW)).toBeNull();
    expect(parseReportArgs('周报', NOW).window).toBe('week');
    expect(parseReportArgs('周报', NOW).anchor).toBeUndefined();
    expect(parseReportArgs('上周', NOW)).toMatchObject({ window: 'week', anchor: '2026-08-31' });
    expect(parseReportArgs('上周五', NOW)).toMatchObject({ window: 'day', anchor: '2026-09-04' });
    // 本周未到的那天 = 未来 → 拒绝
    expect(parseReportArgs('本周五', NOW).future).toBe(true);
  });
});

describe('省略年份/月份 → 取最近一次已发生（code-reviewer medium）', () => {
  // NOW = 2026-09-07
  it('裸月份不再被「月报」关键词吞掉', () => {
    expect(parseAnchorToken('8月', NOW)).toEqual({ date: '2026-08-01', implied: 'month' });
    // 9 月里说「12月」= 去年 12 月（按当年算会是未来、被 future 挡掉）
    expect(parseAnchorToken('12月', NOW)).toEqual({ date: '2025-12-01', implied: 'month' });
    expect(parseReportArgs('8月', NOW)).toMatchObject({ window: 'month', anchor: '2026-08-01', future: false });
    expect(parseReportArgs('12月', NOW)).toMatchObject({ window: 'month', anchor: '2025-12-01', future: false });
    // 纯周期关键词仍是关键词
    expect(parseReportArgs('月报', NOW).anchor).toBeUndefined();
    expect(parseReportArgs('月', NOW).anchor).toBeUndefined();
  });

  it('裸日不再被「日报」关键词吞掉', () => {
    expect(parseAnchorToken('3日', NOW)).toEqual({ date: '2026-09-03', implied: 'day' });
    expect(parseAnchorToken('3号', NOW)).toEqual({ date: '2026-09-03', implied: 'day' });
    // 今天 7 号，说「30日」= 上月 30 号
    expect(parseAnchorToken('30日', NOW)).toEqual({ date: '2026-08-30', implied: 'day' });
    expect(parseReportArgs('日报', NOW).anchor).toBeUndefined();
    expect(parseReportArgs('日', NOW).anchor).toBeUndefined();
  });

  it('M-D 省略年份同样取最近一次', () => {
    expect(parseAnchorToken('09-01', NOW)).toEqual({ date: '2026-09-01', implied: 'day' });
    expect(parseAnchorToken('12-25', NOW)).toEqual({ date: '2025-12-25', implied: 'day' });
    // 带全年份的写法不回退：未来就是未来
    expect(parseReportArgs('2026-12-25', NOW).future).toBe(true);
  });

  it('回退后不存在的日子 → 如实认不出，不硬凑', () => {
    // 今天 9-07，「31日」→ 本月 31 号是未来 → 回退上月，8 月有 31 号 → 命中
    expect(parseAnchorToken('31日', NOW)).toEqual({ date: '2026-08-31', implied: 'day' });
    // 3 月 5 日说「31日」→ 2 月没有 31 号，多步回退继续找到 1 月 31 日
    // （单步回退时这里会误判 null，覆盖近半年份的盲区，code-reviewer 复审 low）
    const march = new Date('2026-03-05T07:00:00Z');
    expect(parseAnchorToken('31日', march)).toEqual({ date: '2026-01-31', implied: 'day' });
    // 「2月29日」→ 2026/2025/2024… 逐年回退，找到最近的闰日 2024-02-29
    expect(parseAnchorToken('2月29日', NOW)).toEqual({ date: '2024-02-29', implied: 'day' });
    // 永不存在的日子 → 如实 null（不硬凑）
    expect(parseAnchorToken('2月30日', NOW)).toBeNull();
    expect(parseAnchorToken('30日', new Date('2026-02-10T07:00:00Z'))).toEqual({ date: '2026-01-30', implied: 'day' });
    // 闰日带年份合法
    expect(parseAnchorToken('2028-02-29', NOW)).toEqual({ date: '2028-02-29', implied: 'day' });
  });
});

describe('北京时区部件（去掉非空断言的不变量）', () => {
  it('beijingPartsOf 恒给合法日期，且与 beijingDateOf 一致', () => {
    for (const iso of ['2026-09-07T07:00:00Z', '2026-09-06T16:00:00Z', '2026-01-01T15:59:59Z', '2026-12-31T16:00:00Z']) {
      const at = new Date(iso);
      const p = beijingPartsOf(at);
      expect(parseYmd(beijingDateOf(at))).toEqual(p);
    }
  });
});
