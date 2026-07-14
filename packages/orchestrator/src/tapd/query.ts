import { logger } from '../logger.js';
import type { TapdMcpClient } from './client.js';
import type { TapdConfig, TapdItem, TapdSystem } from './types.js';

/** 北京时区的今天 YYYY-MM-DD（TAPD 时间都是北京时）。 */
export function beijingToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

interface WorkspaceRef {
  id: number;
  name?: string;
}

// 项目列表 & 工作流终态几乎不变 —— 进程内缓存，砍掉每 tick 的重复调用（省限流额度）。
let wsCache: { at: number; data: WorkspaceRef[] } | null = null;
const WS_TTL_MS = 30 * 60_000; // 30min
const endStatesCache = new Map<string, Set<string>>(); // key: `${ws}:${system}`

/** 发现"我"参与的项目（workspace），带 30min 缓存。 */
export async function discoverWorkspaces(
  client: TapdMcpClient,
  nick: string,
): Promise<WorkspaceRef[]> {
  if (wsCache && Date.now() - wsCache.at < WS_TTL_MS) return wsCache.data;
  const data = await client.callTool<unknown[]>('tapd-get-user-participant-projects', { nick });
  const rows = Array.isArray(data) ? data : [];
  const out = rows.map((r) => {
    const w = (r as { Workspace?: Record<string, unknown> }).Workspace ?? (r as Record<string, unknown>);
    return { id: Number(w['id']), name: w['name'] as string | undefined };
  }).filter((w) => Number.isFinite(w.id) && w.id > 0);
  wsCache = { at: Date.now(), data: out };
  return out;
}

/** 某项目某类型（bug/story）的工作流"结束状态"英文 key 集合（进程内缓存）。 */
async function endStates(
  client: TapdMcpClient,
  workspaceId: number,
  system: TapdSystem,
): Promise<Set<string>> {
  const key = `${workspaceId}:${system}`;
  const cached = endStatesCache.get(key);
  if (cached) return cached;
  try {
    const data = await client.callTool<Record<string, string>>('tapd-get-workflows-last-steps', {
      workspace_id: workspaceId,
      options: { system },
    });
    const set = new Set(Object.keys(data ?? {}));
    endStatesCache.set(key, set);
    return set;
  } catch (e) {
    logger.warn('tapd endStates failed', { workspaceId, system, err: (e as Error).message });
    return new Set(); // 拿不到终态 → 不排除任何状态（宁可多推不漏）；不缓存失败结果
  }
}

const BUG_FIELDS = 'id,title,status,severity,priority,created,modified,reporter,current_owner,description';
const STORY_FIELDS = 'id,name,status,priority,created,modified,creator,owner,description';

/** 拉某项目某类型、current_owner=nick、modified 在 date 当天的项。 */
async function fetchItems(
  client: TapdMcpClient,
  workspaceId: number,
  system: TapdSystem,
  nick: string,
  date: string,
): Promise<Record<string, unknown>[]> {
  const tool = system === 'bug' ? 'tapd-get-bug' : 'tapd-get-stories-or-tasks';
  // 处理人字段名 per 类型：缺陷是 current_owner，需求是 owner。传错 → 过滤被忽略 → 误报全部！
  const ownerField = system === 'bug' ? 'current_owner' : 'owner';
  const options: Record<string, unknown> = {
    [ownerField]: nick,
    modified: `${date}~${date}`,
    fields: system === 'bug' ? BUG_FIELDS : STORY_FIELDS,
    limit: 200,
  };
  const data = await client.callTool<unknown[]>(tool, { workspace_id: workspaceId, options });
  const rows = Array.isArray(data) ? data : [];
  return rows.map((r) => {
    const rr = r as Record<string, unknown>;
    return (rr['Bug'] ?? rr['Story'] ?? rr['Task'] ?? rr) as Record<string, unknown>;
  });
}

function tapdUrl(workspaceId: number, system: TapdSystem, id: string): string {
  return system === 'bug'
    ? `https://www.tapd.cn/${workspaceId}/bugtrace/bugs/view/${id}`
    : `https://www.tapd.cn/${workspaceId}/prong/stories/view/${id}`;
}

function normalize(
  e: Record<string, unknown>,
  system: TapdSystem,
  ws: WorkspaceRef,
): TapdItem {
  const id = String(e['id'] ?? '');
  const item: TapdItem = {
    id,
    system,
    workspaceId: ws.id,
    title: String(e['title'] ?? e['name'] ?? '(无标题)'),
    status: String(e['status'] ?? ''),
    url: tapdUrl(ws.id, system, id),
    // 分支 id 用后六位（TAPD id 很长）：fix_005808 / feat_012345
    branch: `${system === 'bug' ? 'fix' : 'feat'}_${id.slice(-6)}`,
  };
  if (ws.name) item.workspaceName = ws.name;
  if (e['severity']) item.severity = String(e['severity']);
  if (e['priority']) item.priority = String(e['priority']);
  if (e['reporter'] ?? e['creator']) item.reporter = String(e['reporter'] ?? e['creator']);
  if (e['current_owner'] ?? e['owner']) item.current_owner = String(e['current_owner'] ?? e['owner']);
  if (e['created']) item.created = String(e['created']);
  if (e['modified']) item.modified = String(e['modified']);
  if (e['description']) item.description = String(e['description']);
  return item;
}

export interface ListOptions {
  /** 覆盖"今天"（测试用，如 '2024-07-01~2024-07-31' 的单日）。默认北京今天。 */
  date?: string;
  /** 只查这些类型，默认 ['bug','story']。 */
  systems?: TapdSystem[];
}

/**
 * 列出指派给"我"、当天有更新、且状态未结束（可处理）的缺陷+需求。
 * "当天更新"用 modified=今天~今天：创建当天也会 bump modified，故同时覆盖当天新建+当天更新。
 */
export async function listActionableItems(
  client: TapdMcpClient,
  cfg: TapdConfig,
  opts: ListOptions = {},
): Promise<TapdItem[]> {
  const date = opts.date ?? beijingToday();
  const systems = opts.systems ?? (['bug', 'story'] as TapdSystem[]);

  let workspaces: WorkspaceRef[];
  if (cfg.workspaceIds.length) {
    workspaces = cfg.workspaceIds.map((id) => ({ id }));
  } else {
    workspaces = await discoverWorkspaces(client, cfg.nick);
  }

  const out: TapdItem[] = [];
  for (const ws of workspaces) {
    for (const system of systems) {
      try {
        const ends = await endStates(client, ws.id, system);
        const rows = await fetchItems(client, ws.id, system, cfg.nick, date);
        for (const e of rows) {
          const status = String(e['status'] ?? '');
          if (ends.has(status)) continue; // 已结束 → 跳过
          out.push(normalize(e, system, ws));
        }
      } catch (e) {
        logger.warn('tapd list failed', {
          workspaceId: ws.id,
          system,
          err: (e as Error).message,
        });
      }
    }
  }
  return out;
}
