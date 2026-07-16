import { basename, join } from 'node:path';
import { logger } from '../logger.js';
import { PerfApiClient } from './client.js';
import type { PerfConfig, PerfItem } from './types.js';

/** github permalink → repo 名（.../<org>/<repo>/blob/...）。 */
function repoFromPermalink(url?: string): string | undefined {
  if (!url) return undefined;
  const m = /github\.com\/[^/]+\/([^/]+)/.exec(url);
  return m?.[1];
}

/** 从 -api /repos 建 database → repoName 映射。 */
async function buildDbRepoMap(client: PerfApiClient): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const repos = await client.listRepos();
    for (const r of repos) {
      const name = String(r['name'] ?? '');
      const repoName = name.includes('/') ? name.split('/').pop()! : name;
      const dbs = Array.isArray(r['databases']) ? (r['databases'] as unknown[]) : [];
      for (const d of dbs) map.set(String(d), repoName);
    }
  } catch (e) {
    logger.warn('perf listRepos 失败（repo 映射降级）', { err: (e as Error).message });
  }
  return map;
}

/** 防御式把一条 -api recommendation 归一成 PerfItem。 */
function normalize(rec: Record<string, unknown>, dbRepo: Map<string, string>, reposBaseDir: string): PerfItem {
  const g = (k: string): unknown => rec[k];
  const nested = (obj: unknown, k: string): unknown => (obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[k] : undefined);
  const indexRec = g('indexRecommendation');
  const codeChange = g('codeChange');
  const codeMatches = g('codeMatches');
  const firstMatch = Array.isArray(codeMatches) ? (codeMatches[0] as Record<string, unknown> | undefined) : undefined;

  const database = g('database') ? String(g('database')) : undefined;
  const permalink = (nested(codeChange, 'permalink') as string | undefined) ?? (firstMatch?.['permalink'] as string | undefined);
  const repo = repoFromPermalink(permalink)
    ?? (firstMatch?.['repo'] ? String(firstMatch['repo']).split('/').pop() : undefined)
    ?? (database ? dbRepo.get(database) : undefined);
  const status = String(g('status') ?? 'pending');
  const windowDay = g('windowDay') ? String(g('windowDay')) : undefined;

  const item: PerfItem = {
    id: String(g('_id') ?? g('id') ?? ''),
    status,
    title: String(g('title') ?? '(无标题)'),
    priority: String(g('priority') ?? 'P2').toUpperCase(),
    updatedKey: `${status}|${windowDay ?? ''}`,
  };
  const set = (k: keyof PerfItem, v: unknown) => { if (v !== undefined && v !== null && v !== '') (item as unknown as Record<string, unknown>)[k] = v; };
  set('target', g('target'));
  set('rationale', g('rationale'));
  set('rootCause', g('rootCause') ?? nested(g('recommendation'), 'rootCause'));
  set('database', database);
  set('collection', g('collection'));
  set('indexCommand', nested(indexRec, 'command'));
  set('codeFile', nested(codeChange, 'file'));
  set('codePermalink', permalink);
  set('codeChange', nested(codeChange, 'change'));
  set('gitCommitUrl', g('gitCommitUrl'));
  set('windowDay', windowDay);
  if (repo) {
    item.repo = repo;
    if (reposBaseDir) item.localPath = join(reposBaseDir, basename(repo));
  }
  if (typeof g('createdAt') === 'number') item.createdAt = g('createdAt') as number;
  return item;
}

/**
 * 拉"待办 + 归我 + 命中优先级"的 recommendation。
 * P1 只读：GET pending（按 target 各拉一次或一次全拉）→ 归一 → 按 priorities / myRepos 过滤 → 去重。
 */
export async function listActionablePerfItems(client: PerfApiClient, cfg: PerfConfig): Promise<PerfItem[]> {
  const dbRepo = await buildDbRepoMap(client);
  const targets = cfg.targets.length ? cfg.targets : [undefined as unknown as string];
  const byId = new Map<string, PerfItem>();
  for (const target of targets) {
    let rows: Record<string, unknown>[];
    try {
      rows = await client.listRecommendations({ status: 'pending', ...(target ? { target } : {}) });
    } catch (e) {
      logger.warn('perf listRecommendations 失败', { target, err: (e as Error).message });
      continue;
    }
    for (const r of rows) {
      const item = normalize(r, dbRepo, cfg.reposBaseDir);
      if (!item.id) continue;
      if (cfg.priorities.length && !cfg.priorities.includes(item.priority)) continue;
      if (cfg.myRepos.length && (!item.repo || !cfg.myRepos.includes(item.repo))) continue;
      byId.set(item.id, item);
    }
  }
  return [...byId.values()];
}
