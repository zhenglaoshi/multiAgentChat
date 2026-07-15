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

const BUG_FIELDS = 'id,title,status,severity,priority,created,modified,reporter,current_owner,de,description';
const STORY_FIELDS = 'id,name,status,priority,created,modified,creator,owner,developer,description';

/**
 * 每类型要匹配"我"的字段列表（任一命中即算我的）。可用 env 覆盖：
 *   TAPD_STORY_OWNER_FIELDS（默认 owner,developer —— "处理人"+"开发负责人/开发人员"）
 *   TAPD_BUG_OWNER_FIELDS（默认 current_owner,de —— "当前处理人"+"开发人员"）
 * 关键：只查 owner 会漏掉"我只是开发负责人(developer)"的需求（实测踩过）。
 */
function ownerFieldsFor(system: TapdSystem): string[] {
  const raw = system === 'bug'
    ? (process.env['TAPD_BUG_OWNER_FIELDS'] ?? 'current_owner,de')
    : (process.env['TAPD_STORY_OWNER_FIELDS'] ?? 'owner,developer');
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * 拉某项目某类型、modified 在 date 当天、且"我"命中任一 owner 字段的项。
 * 逐字段各查一次（TAPD 过滤是 AND，跨字段 OR 只能多查合并），按 id 去重。
 */
async function fetchItems(
  client: TapdMcpClient,
  workspaceId: number,
  system: TapdSystem,
  nick: string,
  date: string | null,
): Promise<Record<string, unknown>[]> {
  const tool = system === 'bug' ? 'tapd-get-bug' : 'tapd-get-stories-or-tasks';
  const byId = new Map<string, Record<string, unknown>>();
  for (const ownerField of ownerFieldsFor(system)) {
    const options: Record<string, unknown> = {
      [ownerField]: nick,
      fields: system === 'bug' ? BUG_FIELDS : STORY_FIELDS,
      limit: 200,
    };
    if (date) options['modified'] = `${date}~${date}`; // date=null → 不限日期，列全部未结束
    let data: unknown[];
    try {
      data = await client.callTool<unknown[]>(tool, { workspace_id: workspaceId, options });
    } catch (e) {
      logger.warn('tapd fetchItems 单字段查询失败', { workspaceId, system, ownerField, err: (e as Error).message });
      continue;
    }
    const rows = Array.isArray(data) ? data : [];
    for (const r of rows) {
      const rr = r as Record<string, unknown>;
      const item = (rr['Bug'] ?? rr['Story'] ?? rr['Task'] ?? rr) as Record<string, unknown>;
      const id = String(item['id'] ?? '');
      if (id) byId.set(id, item);
    }
  }
  return [...byId.values()];
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
  // 处理人显示：current_owner → owner → developer → de（owner 常为空、我只是开发负责人时）
  const ownerVal = e['current_owner'] || e['owner'] || e['developer'] || e['de'];
  if (ownerVal) item.current_owner = String(ownerVal);
  if (e['created']) item.created = String(e['created']);
  if (e['modified']) item.modified = String(e['modified']);
  if (e['description']) item.description = String(e['description']);
  return item;
}

/** 拉单条详情（含 description，认领时注入 claude 用）。 */
export async function getItemDetail(
  client: TapdMcpClient,
  workspaceId: number,
  system: TapdSystem,
  id: string,
): Promise<{ title: string; description?: string; status?: string; severity?: string } | null> {
  const tool = system === 'bug' ? 'tapd-get-bug' : 'tapd-get-stories-or-tasks';
  const fields = system === 'bug'
    ? 'id,title,status,severity,description'
    : 'id,name,status,description';
  const data = await client.callTool<unknown[]>(tool, {
    workspace_id: workspaceId,
    options: { id, fields },
  });
  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) return null;
  const rr = rows[0] as Record<string, unknown>;
  const e = (rr['Bug'] ?? rr['Story'] ?? rr['Task'] ?? rr) as Record<string, unknown>;
  const out: { title: string; description?: string; status?: string; severity?: string } = {
    title: String(e['title'] ?? e['name'] ?? ''),
  };
  if (e['description']) out.description = String(e['description']);
  if (e['status']) out.status = String(e['status']);
  if (e['severity']) out.severity = String(e['severity']);
  return out;
}

export interface ListOptions {
  /** 覆盖"今天"（测试用，如 '2024-07-01~2024-07-31' 的单日）。默认北京今天。 */
  date?: string;
  /** true → 不限日期，列全部"未结束"的（/tapd 主动查询用）。 */
  allOpen?: boolean;
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
  const date = opts.allOpen ? null : (opts.date ?? beijingToday());
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
