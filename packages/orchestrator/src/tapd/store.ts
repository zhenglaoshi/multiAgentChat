import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { TapdItem } from './types.js';

const DATA_DIR = resolve('./data/tapd');
const SEEN_FILE = join(DATA_DIR, 'seen.json');

/** 每条：上次通知时的 modified + 时间。modified 变了 = 有更新，会再通知一次。 */
interface SeenRecord {
  modified?: string;
  status?: string;
  notifiedAt: number;
  /** 稍后提醒：此时间戳之前不再通知，之后重新通知一次。 */
  snoozeUntil?: number;
  /** 「不是我的」：永久不再通知（除非在 TAPD 改了处理人重新指派）。 */
  ignored?: boolean;
}
type SeenMap = Record<string, SeenRecord>;

async function ensureDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

async function loadSeen(): Promise<SeenMap> {
  try {
    return JSON.parse(await readFile(SEEN_FILE, 'utf8')) as SeenMap;
  } catch {
    return {};
  }
}

async function saveSeen(map: SeenMap): Promise<void> {
  await ensureDir();
  const tmp = SEEN_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(map, null, 2), 'utf8');
  await rename(tmp, SEEN_FILE);
}

/**
 * 从本轮拉到的 items 里，挑出"没通知过 / 通知后又更新了(modified 变化)"的。
 * 不落盘 —— 由调用方在成功推送后调 markNotified。
 */
export async function filterUnnotified(items: TapdItem[]): Promise<TapdItem[]> {
  const seen = await loadSeen();
  const now = Date.now();
  return items.filter((it) => {
    const rec = seen[it.id];
    if (!rec) return true;                       // 没见过
    if (rec.ignored) return false;               // 「不是我的」永久跳过
    if (rec.snoozeUntil) return now >= rec.snoozeUntil; // 稍后：到点才再通知
    if (it.modified && rec.modified !== it.modified) return true; // 又更新了
    return false;
  });
}

/** 稍后提醒：ms 毫秒后再通知（默认 3h）。 */
export async function markSnoozed(id: string, ms = 3 * 3600_000): Promise<void> {
  const seen = await loadSeen();
  const rec = seen[id] ?? { notifiedAt: Date.now() };
  rec.snoozeUntil = Date.now() + ms;
  delete rec.ignored;
  seen[id] = rec;
  await saveSeen(seen);
}

/** 「不是我的」：永久不再通知该条。 */
export async function markIgnoredForever(id: string): Promise<void> {
  const seen = await loadSeen();
  const rec = seen[id] ?? { notifiedAt: Date.now() };
  rec.ignored = true;
  delete rec.snoozeUntil;
  seen[id] = rec;
  await saveSeen(seen);
}

/** 推送成功后标记这些 item 已通知（记下当前 modified/status）。 */
export async function markNotified(items: TapdItem[]): Promise<void> {
  if (items.length === 0) return;
  const seen = await loadSeen();
  const now = Date.now();
  for (const it of items) {
    seen[it.id] = { modified: it.modified, status: it.status, notifiedAt: now };
  }
  await saveSeen(seen);
}
