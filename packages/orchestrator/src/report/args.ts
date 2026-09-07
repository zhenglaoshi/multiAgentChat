import type { ReportWindow } from './types.js';

/**
 * 报告命令参数解析（纯逻辑，无 IO）：把 `/report` 后面那串自由文本拆成
 * 「周期 + 日期锚点 + 是否简报」。
 *
 * 为什么要日期锚点：原来 `/report day` 只能出「今天」的日报——补昨天/上周某天的日报
 * （常见：忘发日报、周一补上周五）没法用。加锚点后 `/report 昨天`、`/report 2026-09-01`、
 * `/report week 2026-08-20`（那一周的周报）都能出，**不给日期时仍默认当天/当期**（向后兼容）。
 *
 * 锚点一律按**北京时区的日历日**表达（'YYYY-MM-DD'），与 reportWindow 的时区口径一致。
 */

/** 北京时区口径的日历日部件。 */
export interface DateParts { y: number; m: number; d: number }

const BJ_PARTS_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

/**
 * 某个时刻在北京时区是哪一天（部件形式）。
 * 直接给部件而不是"格式化成字符串再 parse 回来"：调用方（reportWindow）因此不需要
 * `parseYmd(...)!` 这种依赖"格式化输出恒合法"的非空断言——改错了时区/locale 也不会
 * 从优雅降级变成抛异常。
 */
export function beijingPartsOf(at: Date = new Date()): DateParts {
  const parts = BJ_PARTS_FMT.formatToParts(at);
  const g = (t: string) => Number(parts.find((x) => x.type === t)?.value ?? 'x');
  const p = { y: g('year'), m: g('month'), d: g('day') };
  // Intl 一定给出合法日期；真拿不到（宿主 ICU 异常）就退到 UTC 日历日，绝不产出 NaN
  if (!Number.isFinite(p.y) || !Number.isFinite(p.m) || !Number.isFinite(p.d)) {
    return { y: at.getUTCFullYear(), m: at.getUTCMonth() + 1, d: at.getUTCDate() };
  }
  return p;
}

/** 某个时刻在北京时区是哪一天（'YYYY-MM-DD'）。 */
export function beijingDateOf(at: Date = new Date()): string {
  return fmtParts(beijingPartsOf(at));
}

/** 'YYYY-MM-DD' → 部件；格式不合法返回 null。 */
export function parseYmd(s: string): DateParts | null {
  const mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!mt) return null;
  const y = Number(mt[1]); const m = Number(mt[2]); const d = Number(mt[3]);
  return isRealDate(y, m, d) ? { y, m, d } : null;
}

/**
 * 真实存在的日历日（挡掉 2026-02-30 这种）。
 * 年份限 20xx：报告只可能问这个工具存在期间的活，`0001-01-01` / `9999-12-31` 这类
 * 荒谬输入当作"没认出日期"进 unknown 回显提示，而不是静默出一份空报告。
 */
function isRealDate(y: number, m: number, d: number): boolean {
  if (y < 2000 || y > 2099) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function fmtParts(p: DateParts): string {
  return `${String(p.y).padStart(4, '0')}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** 日历日加减天数（纯日历运算，用 UTC 零点做载体，无时区/DST 影响）。 */
function shiftDays(p: DateParts, delta: number): DateParts {
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d) + delta * 86400_000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/**
 * 省略年份/月份的写法（`09-01` / `8月` / `15日`）取**最近一次已发生**的那个：
 * 9 月里说「12月」「12-25」指的是**去年**那次，说「30日」（今天 5 号）指的是**上月**30 号
 * ——按当年/当月硬算会得到一个未来日期、被 future 挡掉，反而要用户自己补年份。
 * 落定的窗口会在飞书「生成中」那条消息里回显（如 `📊 月报（2025-12-01~2025-12-31）`），
 * 不会猜错了还看不出来。
 * 带全年份的写法（`2026-12-25`）不做回退，未来就是未来、照旧拒绝。
 */
function mostRecent(p: DateParts, today: DateParts, back: 'year' | 'month'): DateParts | null {
  const todayStr = fmtParts(today);
  // 逐步往前找第一个「已发生且真实存在」的那天。
  // 必须允许多步：单步回退时「31日」有近一半月份是盲区——3/5/7/10/12 月的上一个月
  // （2/4/6/9/11 月）都没有 31 号，只试一步就会判 null。闰日同理（2月29日 要回退 4 年）。
  // 上限：按月最多 14 步（跨过任何连续短月），按年最多 8 步（够覆盖闰年间隔）。
  const maxSteps = back === 'year' ? 8 : 14;
  let cur = p;
  for (let i = 0; i <= maxSteps; i++) {
    if (fmtParts(cur) <= todayStr && isRealDate(cur.y, cur.m, cur.d)) return cur;
    cur = back === 'year'
      ? { ...cur, y: cur.y - 1 }
      : cur.m === 1 ? { ...cur, y: cur.y - 1, m: 12 } : { ...cur, m: cur.m - 1 };
  }
  return null; // 找不到（如 2 月 30 日这种永不存在的日子）→ 如实认不出，别硬凑
}

/** 命中的锚点：日期 + 该写法隐含的周期（如 '2026-08' 隐含月报）。 */
export interface AnchorHit { date: string; implied?: ReportWindow }

/**
 * 相对日（天）口令。
 * 用 Map 而不是对象字面量：对象查找会撞原型链键——`/report __proto__` 让
 * `REL_DAYS['__proto__']` 返回 `Object.prototype`（≠ undefined），于是绕过"没命中就往下走"
 * 的分支、`-rel` 变 NaN、拼出 `0NaN-NaN-NaN` 这种畸形锚点（虽被下游 parseYmd 兜住回退今天，
 * 但本该干脆进 unknown 提示"没认出"）。Map 没有原型键问题。
 */
const REL_DAYS = new Map<string, number>([
  ['今天', 0], ['今日', 0], ['当天', 0], ['本日', 0], ['today', 0],
  ['昨天', 1], ['昨日', 1], ['yesterday', 1],
  ['前天', 2], ['前日', 2],
]);

/**
 * 单个 token 解析成日期锚点。认不出返回 null。
 * 支持：
 *  - 相对：今天/昨天/前天/today/yesterday、`3天前`、`-3`
 *  - 相对期：本周/上周、本月/上月、今年/去年
 *  - 绝对：2026-09-01 / 2026/9/1 / 2026年9月1日 / 09-01（当年）/ 9月1日
 *  - 期：2026-08（月）/ 2026年8月（月）/ 2026（年）
 */
export function parseAnchorToken(tokRaw: string, now: Date = new Date()): AnchorHit | null {
  const tok = tokRaw.trim().toLowerCase();
  if (!tok) return null;
  const today = parseYmd(beijingDateOf(now));
  if (!today) return null; // 理论不可达（Intl 一定给合法日期）

  const rel = REL_DAYS.get(tok);
  if (rel !== undefined) return { date: fmtParts(shiftDays(today, -rel)), implied: 'day' };

  let mt = /^(\d{1,3})\s*天前$/.exec(tok) ?? /^-(\d{1,3})$/.exec(tok);
  if (mt) return { date: fmtParts(shiftDays(today, -Number(mt[1]))), implied: 'day' };

  if (/^(本周|这周|这个周|本星期|这星期)$/.test(tok)) return { date: fmtParts(today), implied: 'week' };
  if (/^(上周|上星期|上个周|上个星期|lastweek|last-week)$/.test(tok)) {
    return { date: fmtParts(shiftDays(today, -7)), implied: 'week' };
  }
  if (/^(本月|这个月|这月|当月)$/.test(tok)) return { date: fmtParts(today), implied: 'month' };
  if (/^(上月|上个月|lastmonth|last-month)$/.test(tok)) {
    // 本月 1 号往前一天 = 上月最后一天 → 落在上月
    return { date: fmtParts(shiftDays({ ...today, d: 1 }, -1)), implied: 'month' };
  }
  if (/^(今年|本年)$/.test(tok)) return { date: fmtParts(today), implied: 'year' };
  if (/^(去年|上年|上一年)$/.test(tok)) return { date: `${today.y - 1}-01-01`, implied: 'year' };

  // 周N：'周五' / '上周五' / '本星期三'（补「上周五的日报」这种最自然的说法）
  mt = /^(上|本|这)?(?:周|星期)([一二三四五六日天])$/.exec(tok);
  if (mt) {
    const nth = '一二三四五六'.indexOf(mt[2]!) >= 0 ? '一二三四五六'.indexOf(mt[2]!) + 1 : 7; // 日/天=7
    const dow = new Date(Date.UTC(today.y, today.m - 1, today.d)).getUTCDay(); // 0=周日
    const monday = shiftDays(today, -((dow + 6) % 7));
    const back = mt[1] === '上' ? 7 : 0; // 无前缀/本/这 → 本周
    return { date: fmtParts(shiftDays(monday, nth - 1 - back)), implied: 'day' };
  }

  // 绝对：YYYY-M-D
  mt = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(tok);
  if (mt) {
    const p = { y: Number(mt[1]), m: Number(mt[2]), d: Number(mt[3]) };
    return isRealDate(p.y, p.m, p.d) ? { date: fmtParts(p), implied: 'day' } : null;
  }
  // 绝对：M-D（省略年份 → 最近一次已发生的那个）
  mt = /^(\d{1,2})[-/.月](\d{1,2})日?$/.exec(tok);
  if (mt) {
    const hit = mostRecent({ y: today.y, m: Number(mt[1]), d: Number(mt[2]) }, today, 'year');
    return hit ? { date: fmtParts(hit), implied: 'day' } : null;
  }

  // 裸月份「8月」（省略年份 → 最近一次已发生的那个月）。
  // 必须在 parseWindowToken 之前消化掉：否则 `/月报?$/` 会把它当成纯「月报」关键词，
  // 9 月里问「8月」静默给出 9 月的报告，且 unknown 为空、用户毫无察觉（code-reviewer medium）。
  mt = /^(\d{1,2})月$/.exec(tok);
  if (mt) {
    const hit = mostRecent({ y: today.y, m: Number(mt[1]), d: 1 }, today, 'year');
    return hit ? { date: fmtParts(hit), implied: 'month' } : null;
  }

  // 裸日「15日」/「15号」（省略年月 → 最近一次已发生的那天）。同理要先于 `/日报?$/` 消化。
  mt = /^(\d{1,2})[日号]$/.exec(tok);
  if (mt) {
    const hit = mostRecent({ y: today.y, m: today.m, d: Number(mt[1]) }, today, 'month');
    return hit ? { date: fmtParts(hit), implied: 'day' } : null;
  }
  // 期：YYYY-MM（月）
  mt = /^(\d{4})[-/.年](\d{1,2})月?$/.exec(tok);
  if (mt) {
    const p = { y: Number(mt[1]), m: Number(mt[2]), d: 1 };
    return isRealDate(p.y, p.m, p.d) ? { date: fmtParts(p), implied: 'month' } : null;
  }
  // 期：YYYY（年）—— 限 2000-2099，避免把随手打的数字当年份
  mt = /^(20\d{2})年?$/.exec(tok);
  if (mt) return { date: `${mt[1]}-01-01`, implied: 'year' };

  return null;
}

/** 周期关键词（显式指定，优先于锚点写法隐含的周期）。 */
function parseWindowToken(tokRaw: string): ReportWindow | null {
  const tok = tokRaw.trim().toLowerCase();
  if (!tok) return null;
  // 中文先判「日」再判「月/年」：'9月1日' 这类已在锚点阶段消化，这里只剩纯关键词
  if (/日报?$/.test(tok)) return 'day';
  if (/(周|星期)报?$/.test(tok)) return 'week';
  if (/月报?$/.test(tok)) return 'month';
  if (/年报?$/.test(tok)) return 'year';
  // 英文：沿用历史的首字母判定（`d` / `day` / `daily` 都算）
  if (/^[a-z]+$/.test(tok)) {
    if (tok.startsWith('d')) return 'day';
    if (tok.startsWith('w')) return 'week';
    if (tok.startsWith('m')) return 'month';
    if (tok.startsWith('y')) return 'year';
  }
  return null;
}

export interface ReportArgs {
  window: ReportWindow;
  /** 要简报（月/年报默认 PPT，加这个出 markdown 简报）。 */
  brief: boolean;
  /** 'YYYY-MM-DD' 日期锚点；缺省 = 当天/当期。 */
  anchor?: string;
  /** 锚点落在未来（调用方应拒绝并提示）。 */
  future: boolean;
  /** 没认出来的 token（调用方可回显提示用法）。 */
  unknown: string[];
}

/**
 * 解析 `/report` 参数串。
 * 周期优先级：显式关键词 > 锚点写法隐含 > 'week'（历史默认）。
 * 日期缺省 = 当天/当期（anchor 为 undefined，reportWindow 走原有 now 口径）。
 */
export function parseReportArgs(rest: string, now: Date = new Date()): ReportArgs {
  const out: ReportArgs = { window: 'week', brief: false, future: false, unknown: [] };
  let explicit: ReportWindow | null = null;
  let implied: ReportWindow | undefined;

  for (const tok of rest.split(/[\s,，、]+/)) {
    const t = tok.trim();
    if (!t) continue;
    if (/^(--brief|-b|brief|简报)$/i.test(t)) { out.brief = true; continue; }
    const hit = parseAnchorToken(t, now);
    if (hit) {
      out.anchor = hit.date;
      if (hit.implied) implied = hit.implied;
      continue;
    }
    const w = parseWindowToken(t);
    if (w) { explicit = w; continue; }
    out.unknown.push(t);
  }

  out.window = explicit ?? implied ?? 'week';
  if (out.anchor && out.anchor > beijingDateOf(now)) out.future = true;
  return out;
}
