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
  tapdCreateFormCard,
  tapdCreateResultCardV2,
  tapdListCard,
  tapdStatusPickCard,
  type TapdListItem,
} from './cards.js';

/**
 * `/tapd new` 建需求流程的状态机 + 编排：
 *   ① 选项目（位置）→ ② 选需求类别(workitem_type，>1 个才问；决定工作流) → ③ 表单填「主题+内容」→ 建。
 * 创建人/开发负责人自动=当前账号（TAPD_NICK），不问。带上 workitem_type_id → 建出的需求后续改状态拿得到流转。
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
  /** ②选的需求类别(workitem_type_id)——决定工作流，建时带上，后续改状态才拿得到流转。 */
  wt?: string;
  wtName?: string;
}

/** v1 grey 收尾 ack 卡（把上一步选择卡 patch 成"已选"，避免重复选；v1→v1 patch 安全）。 */
function stepAck(header: string, body: string): unknown {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'grey', title: { tag: 'plain_text', content: header } },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: body } }],
  };
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

/**
 * ①选完项目 → 拉该项目的**需求类别(workitem_type)**：
 *  - 有多个 → 返回②「选类别」级联卡（决定工作流，建时带上 → 后续改状态才拿得到流转）。
 *  - 0/1 个 → 跳过选类别（1 个则自动带上），直接进③表单。
 * 同时返回把「选项目」卡收尾的 ack（v1→v1 patch 安全）。
 */
export async function pickProjectShowCategory(
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

  const conn = tapdClientOrNull();
  if (!conn) return { error: 'TAPD 未配置' };

  let types: { id: string; name: string }[] = [];
  try {
    types = await listWorkitemTypes(conn.client, ws);
  } catch {
    types = []; // 拉类别失败 → 退化到"不选类别"（用项目默认），不阻断建单
  }

  const ack = stepAck('📝 新建 TAPD 需求 · ①已选项目', `已选项目：**${name}**`);

  if (types.length > 1) {
    return {
      card: tapdSelectCard({
        header: '📝 新建 TAPD 需求 · ②选类别',
        body: `项目「${name}」的需求类别（决定工作流；选对了后续改状态才拿得到流转）`,
        placeholder: `选择需求类别…（${types.length}）`,
        action: 'tapd-nw-c',
        draftId,
        options: types.map((t) => ({ label: t.name, value: `${t.id}|${t.name}` })),
      }),
      ack,
    };
  }

  // 0/1 个类别 → 跳过选类别，直接表单
  if (types.length === 1) {
    draft.wt = types[0]!.id;
    draft.wtName = types[0]!.name;
  }
  return {
    card: tapdCreateFormCard({
      draftId,
      projectName: name,
      ...(draft.prefillTitle ? { title: draft.prefillTitle } : {}),
    }),
    ack,
  };
}

/** ②选完需求类别 → 存草稿 → 返回③表单卡 + 把「选类别」卡收尾的 ack。 */
export async function pickCategoryShowForm(
  draftId: string,
  optionValue: string,
): Promise<CardOrError & { ack?: unknown }> {
  const draft = drafts.get(draftId);
  if (!draft || !draft.ws) return { error: '草稿已过期，请重新 `/tapd new`' };
  const { id, name } = splitOpt(optionValue);
  draft.wt = id;
  draft.wtName = name;
  return {
    card: tapdCreateFormCard({
      draftId,
      projectName: draft.wsName ?? String(draft.ws),
      ...(draft.prefillTitle ? { title: draft.prefillTitle } : {}),
    }),
    ack: stepAck('📝 新建 TAPD 需求 · ②已选类别', `项目：**${draft.wsName ?? draft.ws}**\n需求类别：**${name}**`),
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
    ...(draft.wt ? { workitemTypeId: draft.wt } : {}),
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
