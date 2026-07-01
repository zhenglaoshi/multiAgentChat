import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { logger } from '../logger.js';
import type { TaskMemory } from './types.js';

const DATA_DIR = resolve('./data/memories');

class MemoryStore {
  private cache: TaskMemory[] = [];
  private loaded = false;

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!existsSync(DATA_DIR)) {
      this.loaded = true;
      return;
    }
    const files = await readdir(DATA_DIR);
    for (const f of files) {
      if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
      try {
        const raw = await readFile(join(DATA_DIR, f), 'utf8');
        this.cache.push(JSON.parse(raw) as TaskMemory);
      } catch (e) {
        logger.warn('memory load failed', { file: f, err: (e as Error).message });
      }
    }
    this.cache.sort((a, b) => a.startedAt - b.startedAt);
    this.loaded = true;
    logger.info('memories loaded', { count: this.cache.length });
  }

  async append(m: TaskMemory): Promise<void> {
    await this.ensureLoaded();
    this.cache.push(m);
    await mkdir(DATA_DIR, { recursive: true });
    const filePath = join(DATA_DIR, `${m.id}.json`);
    const tmpPath = `${filePath}.tmp`;
    await writeFile(tmpPath, JSON.stringify(m, null, 2), 'utf8');
    await rename(tmpPath, filePath);
  }

  async all(): Promise<TaskMemory[]> {
    await this.ensureLoaded();
    return this.cache.slice();
  }

  async listRecent(limit = 20): Promise<TaskMemory[]> {
    await this.ensureLoaded();
    return [...this.cache]
      .sort((a, b) => b.endedAt - a.endedAt)
      .slice(0, limit);
  }
}

export const memoryStore = new MemoryStore();
