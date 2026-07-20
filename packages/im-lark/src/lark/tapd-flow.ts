import { randomUUID } from 'node:crypto';
import {
  tapdClientOrNull,
  listCreateProjects,
  createTapdStory,
  listStatusTransitions,
  updateTapdStatus,
  listActionableItems,
  loadTapdConfig,
  type TapdSystem,
} from 'multiagent-orchestrator';
import {
  tapdSelectCard,
  tapdCreateFormCard,
  tapdCreateResultCardV2,
  tapdListCard,
  tapdStatusPickCard,
  type TapdListItem,
} from './cards.js';

/**
 * `/tapd new` 建需求两步流程的状态机 + 编排：
 *   ① 选项目（位置）→ ② 表单填「主题(标题)+内容(描述)」→ 建。
 * 创建人/开发负责人自动=当前账号（TAPD_NICK），不问。需求类别用项目默认（不再单独选）。
 * 草稿在内存（TTL 30min，建需求一般 <1min 完成；daemon 重启则重来，可接受）。
 * 所有 MCP 调用走 orchestrator 的 tasks-api（Node 侧，不经 tab 里的 claude）。
 */

interface CreateDraft {
  chatId: string;
  /** 命令行带的标题（`/tapd new 标题`），预填进第二步表单；可空。 */
  prefillTitle?: string;
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

function newDraft(chatId: string, prefillTitle?: string): string {
  gcDrafts();
  const id = randomUUID().slice(0, 8);
  drafts.set(id, { chatId, ...(prefillTitle ? { prefillTitle } : {}), createdAt: Date.now() });
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

/** `/tapd new [标题]`：建草稿 + 拉项目 → 返回①选项目卡。标题可选（有则预填进第二步表单）。 */
export async function startCreateFlow(chatId: string, rawArg: string): Promise<CardOrError> {
  // 标题可选：命令行带了就预填第二步表单，不带则留空在表单里填。描述统一放第二步「内容」。
  const prefillTitle = rawArg.split('|')[0]?.trim() || undefined;

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

  const draftId = newDraft(chatId, prefillTitle);
  return {
    card: tapdSelectCard({
      header: '📝 新建 TAPD 需求 · ①选位置',
      body: `第一步：选择创建到哪个项目${prefillTitle ? `\n（标题「${prefillTitle}」已带上，下一步可改）` : ''}`,
      placeholder: `选择项目…（${projects.length}）`,
      action: 'tapd-nw-p',
      draftId,
      options: projects.map((p) => ({ label: p.name, value: `${p.id}|${p.name}` })),
    }),
  };
}

/** ①选完项目 → 返回②「填主题+内容」表单卡 + 一张把原选项目卡收尾的 ack（同 v1 schema，供 patch）。 */
export async function pickProjectShowForm(
  draftId: string,
  optionValue: string,
): Promise<CardOrError & { ack?: unknown }> {
  const draft = drafts.get(draftId);
  if (!draft) return { error: '草稿已过期，请重新 `/tapd new`' };
  const { id, name } = splitOpt(optionValue);
  const ws = Number(id);
  if (!Number.isFinite(ws) || ws <= 0) return { error: '项目无效' };
  draft.ws = ws;
  draft.wsName = name;

  return {
    card: tapdCreateFormCard({ draftId, projectName: name, ...(draft.prefillTitle ? { title: draft.prefillTitle } : {}) }),
    // 原「选项目」卡（v1 schema）→ 收尾提示，避免用户重复选（v1→v1 patch 安全）
    ack: {
      config: { wide_screen_mode: true, update_multi: true },
      header: { template: 'grey', title: { tag: 'plain_text', content: '📝 新建 TAPD 需求 · ①已选项目' } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: `已选项目：**${name}**\n请在下方新卡片填写「主题 + 内容」并创建。` } },
      ],
    },
  };
}

/** ②表单提交 → 建需求 → 返回结果卡（成功/失败都用 2.0 结果卡，供 patch 表单卡）。 */
export async function submitCreate(
  draftId: string,
  input: { title: string; content?: string },
): Promise<CardOrError> {
  const draft = drafts.get(draftId);
  if (!draft || !draft.ws) return { error: '草稿已过期，请重新 `/tapd new`' };
  const title = input.title.trim();
  if (!title) return { error: '主题(标题)不能为空' };

  const conn = tapdClientOrNull();
  if (!conn) return { error: 'TAPD 未配置' };

  const content = input.content?.trim();
  const res = await createTapdStory(conn.client, {
    workspaceId: draft.ws,
    name: title,
    ...(content ? { description: content } : {}),
    nick: conn.nick,
  });
  const projectName = draft.wsName ?? String(draft.ws);
  if (!res.ok) {
    // 网关连不上等网络失败 → 结果卡显示原因；**不删草稿**，恢复后可再点「创建」重试。
    return { card: tapdCreateResultCardV2({ ok: false, title, projectName, ...(res.error ? { error: res.error } : {}) }) };
  }
  drafts.delete(draftId);
  return {
    card: tapdCreateResultCardV2({
      ok: true,
      title,
      projectName,
      ...(res.id ? { id: res.id } : {}),
      ...(res.url ? { url: res.url } : {}),
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
