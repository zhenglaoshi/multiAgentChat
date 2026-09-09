import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { logger } from '../logger.js';
import type { LetterNotification, LetterThread, SeenLetter } from './types.js';

const FILE = resolve('./data/letters/seen.json');

/** 内存缓存（daemon 常驻，避免每轮读盘）；tsx watch 重载后从盘恢复。 */
let cache: Record<string, SeenLetter> | null = null;

async function load(): Promise<Record<string, SeenLetter>> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(FILE, 'utf8')) as Record<string, SeenLetter>;
  } catch {
    cache = {};
  }
  return cache;
}

async function flush(map: Record<string, SeenLetter>): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(map, null, 2), 'utf8');
  await rename(tmp, FILE);
}

/**
 * 判定哪些线程值得推卡（纯逻辑，可测）。
 *
 * - 没见过 → `new`（第一次收到这封公函）
 * - 见过但 `lastSeq` 涨了 → `reply`（对方回函/追加）
 * - seq 没变 → 不推（否则每轮轮询都刷一遍屏）
 *
 * 只看 seq 不看 `updated_at`：平台可能因为无关变动（别人答了他那条待办）刷新时间戳，
 * 那不是「有新内容给我看」，推了就是噪音。
 */
export function classifyLetters(
  threads: LetterThread[],
  seen: Record<string, SeenLetter>,
): LetterNotification[] {
  const out: LetterNotification[] = [];
  for (const t of threads) {
    const prev = seen[t.threadId];
    if (!prev) {
      out.push({ thread: t, kind: 'new' });
    } else if (t.lastSeq > prev.seq) {
      out.push({ thread: t, kind: 'reply', prevSeq: prev.seq });
    }
  }
  return out;
}

/** 读「见过」记录。 */
export async function loadSeenLetters(): Promise<Record<string, SeenLetter>> {
  return { ...(await load()) };
}

/**
 * 记下已推送的线程。
 * **推送成功后才调**——先记后推的话，推送失败这封公函就永远不会再提醒了。
 */
export async function markLettersNotified(threads: LetterThread[]): Promise<void> {
  if (threads.length === 0) return;
  const map = await load();
  const now = Date.now();
  for (const t of threads) {
    map[t.threadId] = { threadId: t.threadId, seq: t.lastSeq, notifiedAt: now };
  }
  try {
    await flush(map);
  } catch (e) {
    logger.warn('公函去重记录落盘失败（下轮可能重复推送）', { err: (e as Error).message });
  }
}


/**
 * 公函「开工」目录名。
 *
 * `thread_id` 来自平台，**不能直接拼进路径**——`../../etc/x` 这种就是路径穿越。
 * 只留 `[A-Za-z0-9_-]`，压掉连续/首尾分隔符，封顶长度；清洗后为空则用 `letter` 兜底
 * （光留一个 `-` 当目录名既难认又像是出了 bug）。
 * 去掉 `t-YYYYMMDD-` 前缀是为了好认：`letter_channel-test` 比 `letter_t-20260909-channel-test` 短且够用。
 */
export function letterDirSlug(threadId: string): string {
  const base = threadId.replace(/^t-\d{8}-/, '') || threadId;
  const cleaned = base
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
    .replace(/-$/, '');
  return cleaned || 'letter';
}


/**
 * 公函正文的处理上限 —— **推给人看的和喂给模型的必须是同一段**。
 *
 * 曾经这两处用了不同的数（人看 3000、模型吃 6000），而确认卡上写的是「上一条消息是全文」：
 * 于是一封 3001~6000 字的公函，前 3000 字正常铺垫、第 3001 字起插注入，
 * 人在飞书上看到的「全文」毫无异常、点了确认，模型却收到了人从没见过的后半段指令。
 * 那等于把「人看过全文才执行」这道安全边界架空，还用文案向用户做了个假承诺。
 * 改这个值时，所有引用点会一起变——别再各写各的。
 *
 * 取 40000：实测一封真实公函正文约 1900 字，这个上限足够放下全文而不截断
 * （目标就是「全文都发」）；留这个数只是防病理输入把飞书刷屏 / 把 prompt 撑爆，
 * 真触发时会显式告知已截断，不会假装是全文。
 */
export const LETTER_BODY_MAX = 40_000;

/**
 * 把外部内容包进一个**正文中确实不出现**的随机定界符。
 *
 * 固定的三反引号围栏是不安全的：正文里只要有一行 ``` 就能提前闭合，
 * 后面的文本便跳出「引用材料」的语境，可以伪装成系统/用户指令直接对模型说话。
 * 这里生成随机 token 并校验不与正文冲突，撞了就换；连撞 8 次（实际不可能）
 * 才退到固定兜底，同时把正文里的定界相关字符打散，保证唯一。
 */
export function fenceExternal(body: string, rand: () => string = defaultRand): {
  fence: string;
  wrapped: string;
} {
  for (let i = 0; i < 8; i += 1) {
    const fence = `<<<LETTER-${rand()}>>>`;
    if (!body.includes(fence)) return { fence, wrapped: `${fence}\n${body}\n${fence}` };
  }
  const fence = '<<<LETTER-FALLBACK>>>';
  const safe = body.replace(/[<>`]/g, '·');
  return { fence, wrapped: `${fence}\n${safe}\n${fence}` };
}

function defaultRand(): string {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}
