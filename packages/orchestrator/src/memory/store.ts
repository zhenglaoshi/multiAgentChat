import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';
import type { TaskMemory } from './types.js';

const DATA_DIR = resolve('./data/memories');

/** memory id → 文件名，必须是安全字符（防路径穿越）。store 层纵深防御，不依赖调用方自律。 */
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
function assertSafeId(id: string): void {
  if (!SAFE_ID.test(id)) throw new Error(`unsafe memory id: ${JSON.stringify(id)}`);
}

class MemoryStore {
  private cache: TaskMemory[] = [];
  private loaded = false;
  // 按 id 串行化写入：同一 id 的并发写（如同 tty 连续 Stop hook 触发 upsert）排队，
  // 避免「缓存被后写者更新、文件却是先写者内容」以及共享临时文件互相 clobber。
  private writeChains = new Map<string, Promise<void>>();

  /** 原子写单条 memory：唯一临时名（并发不互踩）→ rename 覆盖目标。 */
  private async writeFileAtomic(m: TaskMemory): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });
    const filePath = join(DATA_DIR, `${m.id}.json`);
    const tmpPath = `${filePath}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(m, null, 2), 'utf8');
    await rename(tmpPath, filePath);
  }

  /** 把一次「改缓存 + 写盘」按 id 串到队尾，保证同 id 顺序执行。 */
  private enqueue(id: string, task: () => Promise<void>): Promise<void> {
    const prev = this.writeChains.get(id) ?? Promise.resolve();
    const next = prev.then(task, task); // 前一个失败也继续，避免链卡死
    // 链尾清理：仅当自己仍是最新一环时删除，避免误删后来者的链
    this.writeChains.set(id, next);
    void next.finally(() => {
      if (this.writeChains.get(id) === next) this.writeChains.delete(id);
    });
    return next;
  }

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
    assertSafeId(m.id);
    await this.ensureLoaded();
    this.cache.push(m);
    await this.enqueue(m.id, () => this.writeFileAtomic(m));
  }

  /**
   * 按 id upsert：内存缓存里同 id 则替换、否则追加；文件同名覆盖（原子 rename）。
   * 用于「一个 key 只留一条、反复更新成最新」的场景（如 Stop hook 按 tty 留底），
   * 避免每次响应都 append 一条新文件把 data/memories 堆爆。
   * 缓存更新 + 写盘按 id 串行（enqueue），同 id 并发写不会 race 出「缓存/文件不一致」。
   */
  async upsert(m: TaskMemory): Promise<void> {
    assertSafeId(m.id);
    await this.ensureLoaded();
    await this.enqueue(m.id, async () => {
      const i = this.cache.findIndex((x) => x.id === m.id);
      if (i >= 0) this.cache[i] = m;
      else this.cache.push(m);
      await this.writeFileAtomic(m);
    });
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
