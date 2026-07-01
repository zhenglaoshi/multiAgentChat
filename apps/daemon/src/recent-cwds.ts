import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { logger } from './logger.js';

const FILE = resolve('./data/recent-cwds.json');
const LIMIT = 10;

interface State {
  cwds: string[];
}

let cache: State | null = null;

async function load(): Promise<State> {
  if (cache) return cache;
  if (!existsSync(FILE)) {
    cache = { cwds: [] };
    return cache;
  }
  try {
    cache = JSON.parse(await readFile(FILE, 'utf8')) as State;
  } catch (e) {
    logger.warn('recent-cwds parse failed', { err: (e as Error).message });
    cache = { cwds: [] };
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

export async function recordCwd(cwd: string): Promise<void> {
  const s = await load();
  s.cwds = [cwd, ...s.cwds.filter((c) => c !== cwd)].slice(0, LIMIT);
  await flush();
}

export async function listRecentCwds(): Promise<string[]> {
  const s = await load();
  return s.cwds.slice();
}
