import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { logger } from '../logger.js';
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
