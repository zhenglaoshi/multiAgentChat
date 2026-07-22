/**
 * fleet-monitor 的纯判定逻辑（无副作用、无重依赖，便于单测）。
 * 见 fleet-monitor.ts 的说明。
 */

// ---- 卡住判定 ----
export interface StallState {
  charLen: number;
  lastChangedAt: number;
  alerted: boolean;
}

/**
 * 依据上次快照 + 当前 history 字符数，决定是否告警"卡住"，并算出新状态。
 * 变化 → 刷新、清 alerted；不变且停滞 ≥ 阈值且未告警过 → alert=true（只报一次/次停滞）。
 * 用**字符长度**而非行数（claude TUI 用 \r 原地重绘，行数几乎不变）。
 */
export function stuckDecision(
  prev: StallState | undefined,
  curLen: number,
  now: number,
  thresholdMs: number,
): { state: StallState; alert: boolean } {
  if (!prev || prev.charLen !== curLen) {
    return { state: { charLen: curLen, lastChangedAt: now, alerted: false }, alert: false };
  }
  const stalledFor = now - prev.lastChangedAt;
  const alert = stalledFor >= thresholdMs && !prev.alerted;
  return {
    state: { charLen: curLen, lastChangedAt: prev.lastChangedAt, alerted: prev.alerted || alert },
    alert,
  };
}

// ---- 每早摘要到点判定 ----
/** 本机时区今天的 YYYY-MM-DD。 */
export function localDayStr(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 是否该推今天的摘要：已过今天的 atSpec(HH:MM) 且今天还没推过。 */
export function digestDue(now: number, atSpec: string, lastDigestDay?: string): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(atSpec.trim());
  if (!m) return false;
  const d = new Date(now);
  const due = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Number(m[1]), Number(m[2])).getTime();
  return now >= due && lastDigestDay !== localDayStr(now);
}
