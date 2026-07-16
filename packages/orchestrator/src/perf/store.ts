import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { PerfItem } from './types.js';

const DATA_DIR = resolve('./data/perf');
const SEEN_FILE = join(DATA_DIR, 'seen.json');

interface SeenRecord {
  updatedKey?: string;   // status(+windowDay) 快照；变了=有更新，再通知一次
  notifiedAt: number;
  snoozeUntil?: number;  // 稍后提醒：此时间戳前不再通知
  ignored?: boolean;     // 「不是我的」永久跳过
}
type SeenMap = Record<string, SeenRecord>;

// 内存态 item 缓存：卡片按钮只带 id，认领时据此取完整 item（避免按钮塞超长文本）。
const itemCache = new Map<string, PerfItem>();
export function savePerfItem(item: PerfItem): void {
  itemCache.set(item.id, item);
  if (itemCache.size > 200) {
    const firstKey = itemCache.keys().next().value;
    if (firstKey) itemCache.delete(firstKey);
  }
}
export function getPerfItem(id: string): PerfItem | undefined { return itemCache.get(id); }

async function ensureDir(): Promise<void> { await mkdir(DATA_DIR, { recursive: true }); }
async function loadSeen(): Promise<SeenMap> {
  try { return JSON.parse(await readFile(SEEN_FILE, 'utf8')) as SeenMap; } catch { return {}; }
}
async function saveSeen(map: SeenMap): Promise<void> {
  await ensureDir();
  const tmp = SEEN_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(map, null, 2), 'utf8');
  await rename(tmp, SEEN_FILE);
}

/** 挑出没通知过 / 通知后又更新了(updatedKey 变化)的项。不落盘，推送成功后调 markNotified。 */
export async function filterUnnotifiedPerf(items: PerfItem[]): Promise<PerfItem[]> {
  const seen = await loadSeen();
  const now = Date.now();
  return items.filter((it) => {
    const rec = seen[it.id];
    if (!rec) return true;
    if (rec.ignored) return false;
    if (rec.snoozeUntil) return now >= rec.snoozeUntil;
    if (it.updatedKey && rec.updatedKey !== it.updatedKey) return true;
    return false;
  });
}

export async function markPerfNotified(items: PerfItem[]): Promise<void> {
  if (items.length === 0) return;
  const seen = await loadSeen();
  const now = Date.now();
  for (const it of items) seen[it.id] = { updatedKey: it.updatedKey, notifiedAt: now };
  await saveSeen(seen);
}

export async function markPerfSnoozed(id: string, ms = 3 * 3600_000): Promise<void> {
  const seen = await loadSeen();
  const rec = seen[id] ?? { notifiedAt: Date.now() };
  rec.snoozeUntil = Date.now() + ms;
  delete rec.ignored;
  seen[id] = rec;
  await saveSeen(seen);
}

export async function markPerfIgnoredForever(id: string): Promise<void> {
  const seen = await loadSeen();
  const rec = seen[id] ?? { notifiedAt: Date.now() };
  rec.ignored = true;
  delete rec.snoozeUntil;
  seen[id] = rec;
  await saveSeen(seen);
}
