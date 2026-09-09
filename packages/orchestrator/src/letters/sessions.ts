import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { logger } from '../logger.js';
import type { LetterSession } from './types.js';

/**
 * 「这封公函开过哪个 shell」的记录。
 *
 * 同一封公函往往要来回处理几轮（对方回函、补充材料），每轮都新开一个 tab 会攒下一堆
 * 同名目录的重复 tab，上下文也散了。记下 tty + 目录，下次优先回到原来那个。
 *
 * **只存 tty 是不够的**：tty 号会被系统回收复用（关掉 ttys003 后新开的 tab 可能又叫
 * ttys003），所以必须连目录一起存，复用前由调用方（host 侧）核对 tab 当前 cwd
 * 是否仍是这个目录——对不上就说明这个 tty 已经是别的 tab 了，得开新的。
 */

const FILE = resolve('./data/letters/sessions.json');

let cache: Record<string, LetterSession> | null = null;

async function load(): Promise<Record<string, LetterSession>> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(FILE, 'utf8')) as Record<string, LetterSession>;
  } catch {
    cache = {};
  }
  return cache;
}

async function flush(map: Record<string, LetterSession>): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(map, null, 2), 'utf8');
  await rename(tmp, FILE);
}

/** 这封公函上次开在哪个 shell（不保证还活着，调用方要核对 cwd）。 */
export async function getLetterSession(threadId: string): Promise<LetterSession | null> {
  const map = await load();
  return map[threadId] ?? null;
}

/** 记下这封公函开的 shell。 */
export async function rememberLetterSession(threadId: string, tty: string, dir: string): Promise<void> {
  const map = await load();
  map[threadId] = { threadId, tty, dir, openedAt: Date.now() };
  try {
    await flush(map);
  } catch (e) {
    logger.warn('公函 shell 记录落盘失败（下次会重开一个新 tab）', { threadId, err: (e as Error).message });
  }
}

/** 记录已失效（tab 关了 / tty 被别人占了）→ 清掉，避免下次还去核对它。 */
export async function forgetLetterSession(threadId: string): Promise<void> {
  const map = await load();
  if (!map[threadId]) return;
  delete map[threadId];
  try {
    await flush(map);
  } catch (e) {
    logger.warn('公函 shell 记录清理失败', { threadId, err: (e as Error).message });
  }
}

/**
 * 复用判定（纯逻辑，可测）：这条记录还能用吗？三个条件缺一不可。
 *
 * 1. **tty 还在**。
 * 2. **cwd 仍是当初那个目录** —— tty 号会被系统回收复用（关掉 ttys003 之后新开的 tab
 *    可能又叫 ttys003），只认 tty 就会把公函打进一个毫不相干的 tab 里。
 * 3. **那个 tab 里还跑着 agent（claude/codex）** —— 这条是安全边界，不是体验优化：
 *    公函在一个 tab 里往往要来回好几轮（跨度可能几天），期间用户很可能 `/exit` 退回裸 zsh，
 *    而 tab 没关、cwd 也没变，前两个条件照样成立。此时若还走复用，就会把**攻击者可控的
 *    公函正文**连同回车一起写进一个裸 shell —— Terminal 的 `do script` 把文本+`\r` 整块写入
 *    pty，对空闲 zsh 而言等价于「往终端粘贴多行命令」，正文里任何一行合法 shell 命令都会当场执行。
 *    那就把「人看过全文再点确认」的批准，变成了本地任意命令执行。
 *    复用分支还跳过了 `launchClaudeInTab`，所以更不能指望后面有人补救。
 *
 * `procs` 传 tab 的进程名列表，由调用方用 `detectAgentFromProcs` 判定后传入布尔值——
 * 这个模块是传输/宿主无关的叶子，不直接依赖 agents 注册表。
 */
export function canReuseSession(
  prev: LetterSession | null,
  tabs: { tty: string; cwd?: string; hasAgent?: boolean }[],
): boolean {
  if (!prev) return false;
  const hit = tabs.find((t) => t.tty === prev.tty);
  return Boolean(hit && hit.cwd === prev.dir && hit.hasAgent);
}
