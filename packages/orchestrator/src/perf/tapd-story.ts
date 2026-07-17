import { TapdMcpClient } from '../tapd/client.js';
import { loadTapdConfig } from '../tapd/config.js';
import { logger } from '../logger.js';
import type { PerfItem } from './types.js';

/**
 * perf 建议「认领并创建需求」：把一条 performance 建议落成 workspace 36983849
 * 「后端服务」分类下的一条 TAPD 需求，创建人 + 开发负责人 = 认领者（nick）。
 *
 * 走 Node 侧 TapdMcpClient（复用 TAPD MCP url/token，同一网关），不经 tab 里的 claude。
 * 目标 workspace / 分类可 env 覆盖；缺省即用户给的后端服务项目。
 */

/**
 * perf → TAPD 优先级映射。注意「后端服务」(36983849) 的 priority_label 候选值是**英文**
 * High/Middle/Low/Nice To Have（实测 get_stories_fields_info），不是默认的高/中/低。
 */
const PRIORITY_MAP: Record<string, string> = { P0: 'High', P1: 'Middle', P2: 'Low' };

/**
 * perf 建需求的目标 workspace / 分类。默认「后端服务」项目 + 「数据库优化」分类
 * （36983849 实测分类：数据库优化 id=1136983849001000190，最契合 perf 慢查询/索引建议）。可 env 覆盖。
 */
export function perfTapdTarget(): { workspaceId: number; categoryName: string; categoryId: string } {
  const workspaceId = Number(process.env['PERF_TAPD_WORKSPACE_ID'] ?? '36983849');
  const categoryName = (process.env['PERF_TAPD_CATEGORY'] ?? '').trim(); // 只在没配 id 时按名解析
  const categoryId = (process.env['PERF_TAPD_CATEGORY_ID'] ?? '1136983849001000190').trim(); // 默认「数据库优化」
  return { workspaceId, categoryName, categoryId };
}

export interface PerfStoryResult {
  ok: boolean;
  storyId?: string;
  url?: string;
  error?: string;
}

/** 用 perf 建议的字段拼 TAPD 需求描述（根因/索引/改动文件/repo 等，尽量可执行）。 */
export function buildPerfStoryDescription(item: PerfItem): string {
  const lines: string[] = [`来源：performance-platform 性能建议（${item.priority}${item.target ? ` · ${item.target}` : ''}）`];
  if (item.repo) lines.push(`仓库：${item.repo}`);
  const ns = [item.database, item.collection].filter(Boolean).join('.');
  if (ns) lines.push(`命名空间：${ns}`);
  if (item.rootCause) lines.push(`根因：${item.rootCause}`);
  if (item.rationale) lines.push(`说明：${item.rationale}`);
  if (item.indexCommand) lines.push(`建议索引：${item.indexCommand}`);
  if (item.codeFile) lines.push(`涉及文件：${item.codeFile}${item.codePermalink ? `（${item.codePermalink}）` : ''}`);
  if (item.codeChange) lines.push(`建议改动：${item.codeChange}`);
  lines.push('验证只用本地/测试环境，严禁连线上库/生产。');
  // TAPD 描述支持 HTML；用 <br/> 换行
  return lines.map((l) => escapeHtml(l)).join('<br/>');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 从 create 工具返回里防御式抽 story id（信封形状因网关而异）。 */
function extractStoryId(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, any>;
  return (
    d['Story']?.id ??
    d['id'] ??
    d['data']?.Story?.id ??
    d['data']?.id ??
    undefined
  )?.toString();
}

/**
 * 创建一条 perf → TAPD 需求。creator/developer = nick（认领者；缺省用 TAPD_NICK）。
 * 幂等由调用方负责（item.tapdStoryId 已存在则不该再调）。
 */
export async function createPerfStory(item: PerfItem, nickOverride?: string): Promise<PerfStoryResult> {
  const cfg = loadTapdConfig();
  if (!cfg.mcpUrl || !cfg.token) return { ok: false, error: 'TAPD 未配置（缺 TAPD_MCP_URL / TAPD_MCP_TOKEN）' };
  const nick = (nickOverride || cfg.nick || '').trim();
  if (!nick) return { ok: false, error: '缺 TAPD 昵称（creator/developer 无法设置，配 TAPD_NICK）' };

  const { workspaceId, categoryName, categoryId } = perfTapdTarget();
  const client = new TapdMcpClient(cfg.mcpUrl, cfg.token);

  const options: Record<string, unknown> = {
    entity_type: 'stories',
    creator: nick,        // 需求创建人 = 认领者
    developer: nick,      // 开发负责人 = 认领者（TAPD 中开发负责人落 developer 字段）
    description: buildPerfStoryDescription(item),
    priority_label: PRIORITY_MAP[item.priority] ?? 'Middle',
  };
  if (categoryId) options['category_id'] = categoryId;
  else if (categoryName) options['category_name'] = categoryName;

  try {
    const data = await client.callTool<unknown>('tapd-create-story-or-task', {
      workspace_id: workspaceId,
      name: `[性能] ${item.title}`.slice(0, 200),
      options,
    });
    const storyId = extractStoryId(data);
    const url = storyId
      ? `https://www.tapd.cn/tapd_fe/${workspaceId}/story/detail/${storyId}`
      : `https://www.tapd.cn/tapd_fe/${workspaceId}/story/list`;
    logger.info('perf tapd story created', { storyId, workspaceId, title: item.title.slice(0, 40) });
    return { ok: true, ...(storyId ? { storyId } : {}), url };
  } catch (e) {
    const error = (e as Error).message;
    logger.warn('perf tapd story create failed', { error, workspaceId });
    return { ok: false, error };
  }
}
