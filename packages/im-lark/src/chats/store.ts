import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { logger } from 'multiagent-orchestrator';
import type { ChatState } from './types.js';

const DATA_DIR = resolve('./data/chats');

function pathFor(id: string): string {
  return join(DATA_DIR, `${id}.json`);
}

export async function loadChat(chatId: string): Promise<ChatState> {
  const p = pathFor(chatId);
  if (!existsSync(p)) {
    const now = Date.now();
    return { chatId, createdAt: now, lastActiveAt: now };
  }
  try {
    return JSON.parse(await readFile(p, 'utf8')) as ChatState;
  } catch (e) {
    logger.warn('failed to load chat', { chatId, err: (e as Error).message });
    const now = Date.now();
    return { chatId, createdAt: now, lastActiveAt: now };
  }
}

export async function saveChat(s: ChatState): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const filePath = pathFor(s.chatId);
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(s, null, 2), 'utf8');
  await rename(tmpPath, filePath);
}

/**
 * 串行化的「读-改-写」：同一 chatId 的并发调用排队执行，每次都**重新 load** 最新状态再改，
 * 避免各处 `loadChat` → (await …) → `saveChat` 之间被别的流程写入后整份覆盖（lost update）。
 *
 * 只保证本进程内串行（daemon 是单进程）；跨进程仍靠 saveChat 的 tmp+rename 原子替换。
 * mutator 抛错 → 不落盘，错误原样抛给调用方；队列不会因此卡死。
 */
const chatMutexes = new Map<string, Promise<unknown>>();

export async function mutateChat<T>(
  chatId: string,
  mutator: (chat: ChatState) => T | Promise<T>,
): Promise<T> {
  const prev = chatMutexes.get(chatId) ?? Promise.resolve();
  const run = prev.then(async () => {
    const chat = await loadChat(chatId);
    const out = await mutator(chat);
    await saveChat(chat);
    return out;
  });
  // 队尾用 catch 过的 promise：mutator 抛错不会让后续排队者一起 reject，但错误照常抛给本次调用方
  const tail = run.catch(() => undefined);
  chatMutexes.set(chatId, tail);
  try {
    return await run;
  } finally {
    if (chatMutexes.get(chatId) === tail) chatMutexes.delete(chatId);
  }
}

export async function listAllChats(): Promise<ChatState[]> {
  if (!existsSync(DATA_DIR)) return [];
  const files = await readdir(DATA_DIR);
  const chats: ChatState[] = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
    const id = f.slice(0, -'.json'.length);
    chats.push(await loadChat(id));
  }
  return chats;
}
