import { randomUUID } from 'node:crypto';
import {
  tapdClientOrNull,
  listCreateProjects,
  listWorkitemTypes,
  createTapdStory,
  listStatusTransitions,
  updateTapdStatus,
  listActionableItems,
  loadTapdConfig,
  type TapdSystem,
} from 'multiagent-orchestrator';
import {
  tapdSelectCard,
  tapdCreatedCard,
  tapdListCard,
  tapdStatusPickCard,
  type TapdListItem,
} from './cards.js';

/**
 * `/tapd new` 建任务级联流程的状态机 + 编排（选项目 → 选需求类别 → 建）。
 * 草稿在内存（TTL 30min，建任务一般 <1min 完成；daemon 重启则重来，可接受）。
 * 所有 MCP 调用走 orchestrator 的 tasks-api（Node 侧，不经 tab 里的 claude）。
 */

interface CreateDraft {
  chatId: string;
  title: string;
  description?: string;
  createdAt: number;
  ws?: number;
  wsName?: string;
}

const drafts = new Map<string, CreateDraft>();
const DRAFT_TTL_MS = 30 * 60_000;

function gcDrafts(): void {
  const now = Date.now();
  for (const [k, v] of drafts) if (now - v.createdAt > DRAFT_TTL_MS) drafts.delete(k);
}

function newDraft(chatId: string, title: string, description?: string): string {
  gcDrafts();
  const id = randomUUID().slice(0, 8);
  drafts.set(id, { chatId, title, ...(description ? { description } : {}), createdAt: Date.now() });
  return id;
}

/** 解析 "id|name" 形式的 option value。 */
function splitOpt(v: string): { id: string; name: string } {
  const i = v.indexOf('|');
  if (i < 0) return { id: v, name: '' };
  return { id: v.slice(0, i), name: v.slice(i + 1) };
}

export interface CardOrError {
  card?: unknown;
  error?: string;
}

/** `/tapd new <标题[ | 描述]>`：建草稿 + 拉项目 → 返回选项目卡。 */
export async function startCreateFlow(chatId: string, rawArg: string): Promise<CardOrError> {
  const arg = rawArg.trim();
  if (!arg) {
    return { error: '用法：`/tapd new <标题>`（可加描述：`/tapd new 标题 | 描述`）\n创建人/开发负责人自动取 TAPD_NICK。' };
  }
  const parts = arg.split('|');
  const title = (parts[0] ?? '').trim();
  const description = parts.slice(1).join('|').trim() || undefined;
  if (!title) return { error: '标题不能为空。用法：`/tapd new <标题>`' };

  const conn = tapdClientOrNull();
  if (!conn) return { error: 'TAPD 未配置（缺 TAPD_MCP_URL / TAPD_MCP_TOKEN）' };
  if (!conn.nick) return { error: '缺 TAPD_NICK（creator/developer 无法设置）' };

  let projects;
  try {
    projects = await listCreateProjects(conn.client, conn.nick);
  } catch (e) {
    return { error: `拉取项目失败：${(e as Error).message}` };
  }
  if (projects.length === 0) return { error: '没有可创建的项目（get-user-participant-projects 为空）' };

  const draftId = newDraft(chatId, title, description);
  return {
    card: tapdSelectCard({
      header: '📝 新建 TAPD 需求 · 选项目',
      body: `标题：**${title}**${description ? `\n描述：${description}` : ''}\n选择创建到哪个项目：`,
      placeholder: `选择项目…（${projects.length}）`,
      action: 'tapd-nw-p',
      draftId,
      options: projects.map((p) => ({ label: p.name, value: `${p.id}|${p.name}` })),
    }),
  };
}

/** 选完项目 → 拉需求类别 → 返回选类别卡。 */
export async function pickProjectBuildTypeCard(draftId: string, optionValue: string): Promise<CardOrError> {
  const draft = drafts.get(draftId);
  if (!draft) return { error: '草稿已过期，请重新 `/tapd new <标题>`' };
  const { id, name } = splitOpt(optionValue);
  const ws = Number(id);
  if (!Number.isFinite(ws) || ws <= 0) return { error: '项目无效' };
  draft.ws = ws;
  draft.wsName = name;

  const conn = tapdClientOrNull();
  if (!conn) return { error: 'TAPD 未配置' };

  let types;
  try {
    types = await listWorkitemTypes(conn.client, ws);
  } catch (e) {
    return { error: `拉取需求类别失败：${(e as Error).message}` };
  }
  // 类别为空 → 给一个「默认类别直接建」的占位项，不阻断
  const options = types.length
    ? types.map((t) => ({ label: t.name, value: `${t.id}|${t.name}` }))
    : [{ label: '（默认类别，直接创建）', value: '|' }];

  return {
    card: tapdSelectCard({
      header: '📝 新建 TAPD 需求 · 选类别',
      body: `标题：**${draft.title}**\n项目：${name}\n选择需求类别：`,
      placeholder: '选择需求类别…',
      action: 'tapd-nw-t',
      draftId,
      options,
    }),
  };
}

/** 选完类别 → 建需求 → 返回成功卡。 */
export async function pickTypeCreate(draftId: string, optionValue: string): Promise<CardOrError> {
  const draft = drafts.get(draftId);
  if (!draft || !draft.ws) return { error: '草稿已过期，请重新 `/tapd new <标题>`' };
  const { id: typeId, name: typeName } = splitOpt(optionValue);

  const conn = tapdClientOrNull();
  if (!conn) return { error: 'TAPD 未配置' };

  const res = await createTapdStory(conn.client, {
    workspaceId: draft.ws,
    name: draft.title,
    ...(draft.description ? { description: draft.description } : {}),
    ...(typeId ? { workitemTypeId: typeId } : {}),
    nick: conn.nick,
  });
  if (!res.ok) return { error: `创建失败：${res.error}` };

  drafts.delete(draftId);
  return {
    card: tapdCreatedCard({
      title: draft.title,
      projectName: draft.wsName ?? String(draft.ws),
      ...(typeName ? { typeName } : {}),
      ...(res.id ? { id: res.id } : {}),
      url: res.url ?? '',
    }),
  };
}

/** `/tapd`（卡片版）+「📋 我的 TAPD」按钮：列指派给我的未结束项。 */
export async function buildMyTapdListCard(): Promise<CardOrError> {
  const conn = tapdClientOrNull();
  if (!conn) return { error: 'TAPD 未配置（缺 TAPD_MCP_URL / TAPD_MCP_TOKEN / TAPD_NICK）' };
  const cfg = loadTapdConfig();
  let items;
  try {
    items = await listActionableItems(conn.client, cfg, { allOpen: true, systems: cfg.systems });
  } catch (e) {
    return { error: `TAPD 查询失败：${(e as Error).message}` };
  }
  const listItems: TapdListItem[] = items.map((it) => ({
    id: it.id,
    system: it.system,
    workspaceId: it.workspaceId,
    ...(it.workspaceName ? { workspaceName: it.workspaceName } : {}),
    title: it.title,
    statusLabel: it.statusLabel ?? it.status,
    ...(it.workitemTypeId ? { workitemTypeId: it.workitemTypeId } : {}),
    url: it.url,
  }));
  return { card: tapdListCard(listItems) };
}

/** 点某条「🔄 改状态」→ 拉可流转状态 → 返回选状态卡。 */
export async function buildStatusPickCard(args: {
  ws: number;
  sys: TapdSystem;
  id: string;
  wt: string;
  cur: string;
  title: string;
}): Promise<CardOrError> {
  const conn = tapdClientOrNull();
  if (!conn) return { error: 'TAPD 未配置' };
  // 需求(story) 的工作流按需求类别区分，缺 workitem_type_id 就查不了；缺陷(bug) 无此概念，可放行。
  if (args.sys !== 'bug' && !args.wt) {
    return { error: '这条缺需求类别 id，拿不到工作流流转（去 TAPD 网页改）。' };
  }
  let opts;
  try {
    opts = await listStatusTransitions(conn.client, {
      workspaceId: args.ws,
      system: args.sys,
      ...(args.wt ? { workitemTypeId: args.wt } : {}),
      currentStatus: args.cur,
    });
  } catch (e) {
    return { error: `拉取可流转状态失败：${(e as Error).message}` };
  }
  if (opts.length === 0) return { error: '当前状态没有可流转的目标（或工作流拿不到）。' };
  return {
    card: tapdStatusPickCard({
      title: args.title,
      workspaceId: args.ws,
      system: args.sys,
      id: args.id,
      currentStatus: args.cur,
      options: opts.map((o) => ({ label: o.label, value: `st|${o.label}` })),
    }),
  };
}

/** 选完目标状态 → 更新。返回中文结果供回执。 */
export async function applyStatusChange(args: {
  ws: number;
  sys: TapdSystem;
  id: string;
  vStatus: string;
}): Promise<{ ok: boolean; label: string; error?: string }> {
  const conn = tapdClientOrNull();
  if (!conn) return { ok: false, label: args.vStatus, error: 'TAPD 未配置' };
  const res = await updateTapdStatus(conn.client, {
    workspaceId: args.ws,
    system: args.sys,
    id: args.id,
    vStatus: args.vStatus,
  });
  return { ok: res.ok, label: args.vStatus, ...(res.error ? { error: res.error } : {}) };
}
