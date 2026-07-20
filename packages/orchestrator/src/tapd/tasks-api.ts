import { TapdMcpClient } from './client.js';
import { loadTapdConfig } from './config.js';
import { logger } from '../logger.js';
import type { TapdSystem } from './types.js';

/**
 * TAPD 建任务 / 列表 / 状态变更的传输无关后端（`/tapd new` + `/tapd` 卡片用）。
 *
 * 全走 Node 侧 TapdMcpClient（复用 TAPD MCP url/token，同一网关），不经 tab 里的 claude。
 * 创建人 / 开发负责人一律取 env（TAPD_NICK）—— 单用户自用，谁跑就是谁。
 */

export interface TapdProject {
  id: number;
  name: string;
}
export interface TapdWorkitemType {
  id: string;
  name: string;
}
export interface TapdCreateResult {
  ok: boolean;
  id?: string;
  url?: string;
  error?: string;
}
export interface TapdStatusOption {
  /** 状态英文 key（如 'status_1'） */
  key: string;
  /** 中文状态名（update 用 v_status 传这个） */
  label: string;
}
export interface TapdSimpleResult {
  ok: boolean;
  error?: string;
}

/** 构造一个 client（缺配置返回 null，调用方给友好提示）。 */
export function tapdClientOrNull(): { client: TapdMcpClient; nick: string } | null {
  const cfg = loadTapdConfig();
  if (!cfg.mcpUrl || !cfg.token) return null;
  return { client: new TapdMcpClient(cfg.mcpUrl, cfg.token), nick: (cfg.nick || '').trim() };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 我参与的项目（过滤掉 category=organization 的公司节点）。 */
export async function listCreateProjects(client: TapdMcpClient, nick: string): Promise<TapdProject[]> {
  const data = await client.callTool<unknown[]>('tapd-get-user-participant-projects', { nick });
  const rows = Array.isArray(data) ? data : [];
  const out: TapdProject[] = [];
  for (const r of rows) {
    const w = ((r as { Workspace?: Record<string, unknown> }).Workspace ?? (r as Record<string, unknown>));
    const category = String(w['category'] ?? '');
    if (category === 'organization') continue; // 公司节点，不能建到这
    const id = Number(w['id']);
    const name = String(w['name'] ?? '');
    if (Number.isFinite(id) && id > 0) out.push({ id, name: name || String(id) });
  }
  return out;
}

/** 某项目下的需求类别（workitem_type）—— 建任务的第二级 + 状态流转必需的 workitem_type_id。 */
export async function listWorkitemTypes(client: TapdMcpClient, workspaceId: number): Promise<TapdWorkitemType[]> {
  const data = await client.callTool<unknown[]>('tapd-get-workitem-types', { workspace_id: workspaceId });
  const rows = Array.isArray(data) ? data : [];
  const out: TapdWorkitemType[] = [];
  for (const r of rows) {
    const t = ((r as { WorkitemType?: Record<string, unknown> }).WorkitemType ?? (r as Record<string, unknown>));
    const id = String(t['id'] ?? '');
    const name = String(t['name'] ?? '');
    if (id) out.push({ id, name: name || id });
  }
  return out;
}

function extractId(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, any>;
  return (
    d['Story']?.id ?? d['Task']?.id ?? d['id'] ??
    d['data']?.Story?.id ?? d['data']?.Task?.id ?? d['data']?.id ?? undefined
  )?.toString();
}

/**
 * 建一条 TAPD 需求（entity_type=stories）。creator/developer = nick。
 * workitemTypeId 可空（缺省用项目默认类别）。description 可空。
 */
export async function createTapdStory(
  client: TapdMcpClient,
  args: { workspaceId: number; name: string; description?: string; workitemTypeId?: string; nick: string },
): Promise<TapdCreateResult> {
  const { workspaceId, name, description, workitemTypeId, nick } = args;
  if (!nick) return { ok: false, error: '缺 TAPD_NICK（creator/developer 无法设置）' };
  const options: Record<string, unknown> = {
    entity_type: 'stories',
    creator: nick,
    developer: nick,
  };
  if (description && description.trim()) options['description'] = escapeHtml(description.trim());
  if (workitemTypeId) options['workitem_type_id'] = workitemTypeId;
  try {
    const data = await client.callTool<unknown>('tapd-create-story-or-task', {
      workspace_id: workspaceId,
      name: name.slice(0, 200),
      options,
    });
    const id = extractId(data);
    const url = id
      ? `https://www.tapd.cn/${workspaceId}/prong/stories/view/${id}`
      : `https://www.tapd.cn/${workspaceId}/prong/stories/list`;
    logger.info('tapd story created', { id, workspaceId, name: name.slice(0, 40) });
    return { ok: true, ...(id ? { id } : {}), url };
  } catch (e) {
    const error = (e as Error).message;
    logger.warn('tapd story create failed', { error, workspaceId });
    return { ok: false, error };
  }
}

/**
 * 某需求类别在某项目里、从 currentStatus 能流转到的状态候选。
 * all-transitions 返回形如 { from_status_key: { to_key: 中文名, ... }, ... }；
 * 取 currentStatus 那一支；拿不到就把所有出现过的 to 状态并集给出（宁多勿漏）。
 */
export async function listStatusTransitions(
  client: TapdMcpClient,
  args: { workspaceId: number; system: TapdSystem; workitemTypeId?: string; currentStatus?: string },
): Promise<TapdStatusOption[]> {
  const { workspaceId, system, workitemTypeId, currentStatus } = args;
  // 需求(story) 工作流按需求类别(workitem_type_id)区分；缺陷(bug) 工作流按项目走、无此概念，不传。
  const options: Record<string, unknown> = { system: system === 'bug' ? 'bug' : 'story' };
  if (system !== 'bug' && workitemTypeId) options['workitem_type_id'] = workitemTypeId;
  const data = await client.callTool<Record<string, unknown>>('tapd-get-workflows-all-transitions', {
    workspace_id: workspaceId,
    options,
  });
  if (!data || typeof data !== 'object') return [];
  const seen = new Map<string, string>(); // key -> label
  const addFrom = (branch: unknown) => {
    if (!branch || typeof branch !== 'object') return;
    for (const [k, v] of Object.entries(branch as Record<string, unknown>)) {
      if (!seen.has(k)) seen.set(k, typeof v === 'string' && v ? v : k);
    }
  };
  if (currentStatus && currentStatus in data) {
    addFrom((data as Record<string, unknown>)[currentStatus]);
  } else {
    for (const branch of Object.values(data)) addFrom(branch);
  }
  return [...seen.entries()].map(([key, label]) => ({ key, label }));
}

/** 改一条需求/任务状态。vStatus 传中文状态名（TAPD 的 v_status 支持中文）。 */
export async function updateTapdStatus(
  client: TapdMcpClient,
  args: { workspaceId: number; system: TapdSystem; id: string; vStatus: string },
): Promise<TapdSimpleResult> {
  const { workspaceId, system, id, vStatus } = args;
  try {
    await client.callTool('tapd-update-story-or-task', {
      workspace_id: workspaceId,
      options: { entity_type: system === 'bug' ? 'bug' : 'stories', id, v_status: vStatus },
    });
    logger.info('tapd status updated', { workspaceId, id, vStatus });
    return { ok: true };
  } catch (e) {
    const error = (e as Error).message;
    logger.warn('tapd status update failed', { error, workspaceId, id });
    return { ok: false, error };
  }
}
