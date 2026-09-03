import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import {
  logger, reportWindow, collectWorkData, generateBrief, generatePptxReport,
  type ReportWindow,
} from 'multiagent-orchestrator';
import { activeReportRepos } from 'multiagent-host-mac';
import { listAllChats } from '../chats/store.js';
import { sendTextMessage, sendFile } from '../lark/api.js';

const TICK_MS = 15 * 60_000; // 15min
const FIRST_DELAY_MS = 20_000;
const FIRED_FILE = join(resolve('./data/report'), 'fired.json');

interface Sched { kind: ReportWindow; prev: boolean; format: 'brief' | 'pptx'; dow?: number; dom?: number; h: number; m: number }

/** 解析 "HH:MM" / "Mon HH:MM" / "1 HH:MM"。 */
function parseAt(spec: string): { h: number; m: number; token?: string } | null {
  const s = spec.trim();
  if (!s) return null;
  const parts = s.split(/\s+/);
  const time = parts[parts.length - 1]!;
  const mt = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!mt) return null;
  const out: { h: number; m: number; token?: string } = { h: Number(mt[1]), m: Number(mt[2]) };
  if (parts.length > 1) out.token = parts[0]!.toLowerCase();
  return out;
}

const DOW: Record<string, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };

function loadSchedules(): Sched[] {
  const out: Sched[] = [];
  const daily = parseAt(process.env['REPORT_DAILY_AT'] ?? '');
  if (daily) out.push({ kind: 'day', prev: false, format: 'brief', h: daily.h, m: daily.m });
  const weekly = parseAt(process.env['REPORT_WEEKLY_AT'] ?? '');
  if (weekly) out.push({ kind: 'week', prev: true, format: 'brief', dow: DOW[weekly.token ?? 'mon'] ?? 1, h: weekly.h, m: weekly.m });
  const monthly = parseAt(process.env['REPORT_MONTHLY_AT'] ?? '');
  if (monthly) out.push({ kind: 'month', prev: true, format: 'pptx', dom: Number(monthly.token ?? '1') || 1, h: monthly.h, m: monthly.m });
  return out;
}

async function loadFired(): Promise<Record<string, number>> {
  try { return JSON.parse(await readFile(FIRED_FILE, 'utf8')) as Record<string, number>; } catch { return {}; }
}
async function saveFired(map: Record<string, number>): Promise<void> {
  await mkdir(resolve('./data/report'), { recursive: true });
  const tmp = FIRED_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(map, null, 2), 'utf8');
  await rename(tmp, FIRED_FILE);
}

/** 本周期的触发时间戳 + 唯一 key（周期起点 + 配置的天偏移/时分）。 */
function dueOf(s: Sched): { due: number; key: string } {
  const { since, sinceLabel } = reportWindow(s.kind); // 当前周期起点
  let dayOffset = 0;
  if (s.kind === 'week') dayOffset = (s.dow ?? 1) - 1;       // 周一=0
  else if (s.kind === 'month') dayOffset = (s.dom ?? 1) - 1; // 1号=0
  const due = since.getTime() + dayOffset * 86400_000 + s.h * 3600_000 + s.m * 60_000;
  return { due, key: `${s.kind}:${sinceLabel}` };
}

/**
 * 定时工作报告：按 .env（REPORT_DAILY_AT / WEEKLY_AT / MONTHLY_AT）在到点后自动生成并推飞书。
 * 每周期只触发一次（fired.json 记录）；周报/月报采**上一个完整周期**。缺配置则不启。
 */
export function startReportScheduler(client: Lark.Client): void {
  const scheds = loadSchedules();
  if (scheds.length === 0) {
    logger.info('report scheduler 未启用（设 REPORT_DAILY_AT / REPORT_WEEKLY_AT / REPORT_MONTHLY_AT）');
    return;
  }

  const fireOne = async (s: Sched, key: string): Promise<void> => {
    const chats = await listAllChats();
    if (chats.length === 0) { logger.warn('report scheduler 无 chat 可推'); return; }
    // 报告候选仓库（dir-index 全量 ∪ tab/最近/worktasks）；下游按时间窗+mtime 过滤只留今天有活动的。
    const repos = await activeReportRepos().catch(() => [] as string[]);
    const collect = () => collectWorkData({ window: s.kind, repos, prev: s.prev });
    if (s.format === 'pptx') {
      const out = `/tmp/mchat-report-${key.replace(/[:\s]/g, '_')}.pptx`;
      const { path } = await generatePptxReport(collect, out, '郑纪泉');
      for (const c of chats) { try { await sendFile(client, c.chatId, path); } catch (e) { logger.warn('report pptx push failed', { chatId: c.chatId, err: (e as Error).message }); } }
    } else {
      const { markdown } = await generateBrief(collect);
      for (const c of chats) { try { await sendTextMessage(client, c.chatId, markdown); } catch (e) { logger.warn('report brief push failed', { chatId: c.chatId, err: (e as Error).message }); } }
    }
    logger.info('report scheduler fired', { kind: s.kind, format: s.format, key });
  };

  const tick = async (): Promise<void> => {
    try {
      const now = Date.now();
      const fired = await loadFired();
      for (const s of scheds) {
        const { due, key } = dueOf(s);
        if (now >= due && !fired[key]) {
          await fireOne(s, key).catch((e) => logger.warn('report fire failed', { key, err: (e as Error).message }));
          fired[key] = now;
          await saveFired(fired);
        }
      }
    } catch (e) {
      logger.warn('report scheduler tick 失败', { err: (e as Error).message });
    }
  };

  setInterval(() => void tick(), TICK_MS);
  setTimeout(() => void tick(), FIRST_DELAY_MS);
  logger.info('report scheduler started', {
    schedules: scheds.map((s) => `${s.kind}@${s.h}:${String(s.m).padStart(2, '0')}${s.format === 'pptx' ? '(PPT)' : ''}`),
  });
}
