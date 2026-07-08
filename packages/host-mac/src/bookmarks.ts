import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { logger } from 'multiagent-orchestrator';

const FILE = resolve('./data/dir-bookmarks.json');

export interface Bookmark {
  alias: string;
  path: string;
  addedAt: number;
}

interface BookmarksState {
  entries: Record<string, Bookmark>;
}

let cache: BookmarksState | null = null;

async function load(): Promise<BookmarksState> {
  if (cache) return cache;
  if (!existsSync(FILE)) {
    cache = { entries: {} };
    return cache;
  }
  try {
    cache = JSON.parse(await readFile(FILE, 'utf8')) as BookmarksState;
  } catch (e) {
    logger.warn('bookmarks parse failed', { err: (e as Error).message });
    cache = { entries: {} };
  }
  return cache;
}

async function flush(): Promise<void> {
  if (!cache) return;
  await mkdir(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
  await rename(tmp, FILE);
}

export async function addBookmark(alias: string, path: string): Promise<void> {
  const s = await load();
  s.entries[alias] = { alias, path, addedAt: Date.now() };
  await flush();
}

export async function removeBookmark(alias: string): Promise<boolean> {
  const s = await load();
  if (!(alias in s.entries)) return false;
  delete s.entries[alias];
  await flush();
  return true;
}

export async function getBookmark(alias: string): Promise<Bookmark | undefined> {
  const s = await load();
  return s.entries[alias];
}

export async function listBookmarks(): Promise<Bookmark[]> {
  const s = await load();
  return Object.values(s.entries).sort((a, b) => a.alias.localeCompare(b.alias));
}
