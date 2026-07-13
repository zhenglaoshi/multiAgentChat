import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { logger } from '../logger.js';
import type { KnowledgeEntry } from './types.js';

const DATA_DIR = resolve('./data/knowledge');

async function ensureDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function nextKnowledgeId(): string {
  return `ke-${Date.now().toString(36)}-${shortId()}`;
}

/**
 * 写单条 KnowledgeEntry。原子写（tmp → rename）。文件名 <id>.json，扁平存储。
 */
export async function saveEntry(entry: KnowledgeEntry): Promise<string> {
  await ensureDir();
  const file = join(DATA_DIR, `${entry.id}.json`);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(entry, null, 2), 'utf8');
  await rename(tmp, file);
  logger.info('knowledge saved', {
    id: entry.id,
    kind: entry.kind,
    title: entry.title.slice(0, 50),
    tags: entry.tags,
    cwd: entry.source.cwd,
  });
  return file;
}

/** 简单遍历 —— 项目小时够用；上万条后需要 index / DB */
export async function listEntries(opts: {
  limit?: number;
  cwd?: string;
  tag?: string;
  kind?: string;
  chunkHash?: string;
} = {}): Promise<KnowledgeEntry[]> {
  if (!existsSync(DATA_DIR)) return [];
  const files = await readdir(DATA_DIR);
  const entries: KnowledgeEntry[] = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
    try {
      const raw = await readFile(join(DATA_DIR, f), 'utf8');
      const e = JSON.parse(raw) as KnowledgeEntry;
      if (opts.cwd && e.source.cwd !== opts.cwd) continue;
      if (opts.tag && !e.tags.includes(opts.tag)) continue;
      if (opts.kind && e.kind !== opts.kind) continue;
      if (opts.chunkHash && e.chunkHash !== opts.chunkHash) continue;
      entries.push(e);
    } catch (e) {
      logger.warn('failed to load knowledge', { file: f, err: (e as Error).message });
    }
  }
  entries.sort((a, b) => b.createdAt - a.createdAt);
  return opts.limit !== undefined ? entries.slice(0, opts.limit) : entries;
}

/**
 * 快速去重检查：给定 chunkHash 是否已提取过。
 */
export async function hasExtracted(chunkHash: string): Promise<boolean> {
  const hits = await listEntries({ chunkHash, limit: 1 });
  return hits.length > 0;
}

/** 简单统计 */
export async function statsSummary(): Promise<{
  total: number;
  byKind: Record<string, number>;
  latestAt: number | null;
}> {
  const all = await listEntries();
  const byKind: Record<string, number> = {};
  for (const e of all) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  }
  return {
    total: all.length,
    byKind,
    latestAt: all.length > 0 ? (all[0]?.createdAt ?? null) : null,
  };
}
