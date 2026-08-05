import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { TapdItem } from './types.js';

const DATA_DIR = resolve('./data/tapd');
const SEEN_FILE = join(DATA_DIR, 'seen.json');

/** 每条：上次通知时的 modified + 状态 + 时间。modified 变了 = 有更新，会再通知一次。 */
export interface SeenRecord {
  modified?: string;
  status?: string;
  /** 上次通知时的状态中文名（渲染「旧 → 新」用，拿不到则回退英文 key）。 */
  statusLabel?: string;
  notifiedAt: number;
  /** 稍后提醒：此时间戳之前不再通知，之后重新通知一次。 */
  snoozeUntil?: number;
  /** 「不是我的」：永久不再通知（除非在 TAPD 改了处理人重新指派）。 */
  ignored?: boolean;
}
export type SeenMap = Record<string, SeenRecord>;

/**
 * 一条待发通知的分级：
 *  - claim  —— 首次成为我的（≈被指派/加入）→ 推可操作的认领卡
 *  - status —— 已知项、状态变了 → 推轻量提示卡「状态：旧 → 新」
 *  - update —— 已知项、其它内容变了（描述/字段/评论）→ 推轻量提示卡「内容有改动」
 */
export type TapdNotifyKind = 'claim' | 'status' | 'update';

export interface TapdNotification {
  item: TapdItem;
  kind: TapdNotifyKind;
  /** kind==='status' 时带上旧状态（英文 key / 中文名），渲染 old → new。 */
  prevStatus?: string;
  prevStatusLabel?: string;
}

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
 * 纯函数：给定本轮 items + 已存 seen + now，算出每条要发什么（claim/status/update）或不发。
 * 抽成纯函数便于单测（无 I/O）。语义与旧 filterUnnotified 对齐，只是把「又更新了」进一步分级：
 *  - 没见过 → claim（首次=被指派）
 *  - ignored → 跳过
 *  - snooze 未到点 → 跳过；到点 → claim（重发认领卡，保留旧「稍后」语义）
 *  - 见过且 modified 变了：状态也变 → status（带旧状态）；否则 → update
 *  - modified 没变（或本轮无 modified）→ 跳过
 */
export function classifyNotificationsPure(
  items: TapdItem[],
  seen: SeenMap,
  now: number,
): TapdNotification[] {
  const out: TapdNotification[] = [];
  for (const it of items) {
    const rec = seen[it.id];
    if (!rec) {
      out.push({ item: it, kind: 'claim' });
      continue;
    }
    if (rec.ignored) continue;
    if (rec.snoozeUntil) {
      if (now >= rec.snoozeUntil) out.push({ item: it, kind: 'claim' });
      continue;
    }
    // 只有 modified 存在且确实变了才算「有更新」（与旧逻辑一致，避免无 modified 时误刷）
    if (!it.modified || rec.modified === it.modified) continue;
    if (it.status && rec.status && it.status !== rec.status) {
      const n: TapdNotification = { item: it, kind: 'status', prevStatus: rec.status };
      if (rec.statusLabel) n.prevStatusLabel = rec.statusLabel;
      out.push(n);
    } else {
      out.push({ item: it, kind: 'update' });
    }
  }
  return out;
}

/**
 * 从本轮拉到的 items 里，算出每条该发的通知（分级：claim/status/update）。
 * 不落盘 —— 由调用方在成功推送后调 markNotified。
 */
export async function classifyNotifications(items: TapdItem[]): Promise<TapdNotification[]> {
  const seen = await loadSeen();
  return classifyNotificationsPure(items, seen, Date.now());
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
    const rec: SeenRecord = { notifiedAt: now };
    if (it.modified) rec.modified = it.modified;
    if (it.status) rec.status = it.status;
    if (it.statusLabel) rec.statusLabel = it.statusLabel;
    seen[it.id] = rec;
  }
  await saveSeen(seen);
}
