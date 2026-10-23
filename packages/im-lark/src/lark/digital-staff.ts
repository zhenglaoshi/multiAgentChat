import type * as Lark from '@larksuiteoapi/node-sdk';
import { logger } from 'multiagent-orchestrator';
import type { LarkBotProfile } from './bots.js';
import { sendTextMessage, sendCardMessage } from './api.js';
import { staffReplyCard } from './cards.js';

/**
 * 数字员工 bot（role = digital-staff）的入站适配器。
 *
 * 这个 bot **不派 tab**：它把飞书消息翻译成 ../digital-staff（`~/ihealth-work/digital-staff`）的 HTTP 调用，
 * 再把员工的回复送回同一个飞书会话。执行引擎是 digital-staff 自己（员工人设 / 组织关系 / 协作工具 /
 * 只读闸 / 审核链 / 外部文本隔离都在它那边），这里只做翻译 + 鉴别「发消息的人是谁」。
 *
 * 分支键 = 发送者：
 *  - 老板（`DIGITAL_STAFF_OWNER_OPEN_IDS` 白名单，open_id **按应用隔离**，要用该 bot 会话里 `/whoami` 拿）
 *      · `@员工 内容`                → POST /api/messages（聊天，可信域：员工能当场问同事 / 派活 / 操作 MCP）
 *      · `派任务 [@员工] 标题⏎描述` / `让 X 做 Y` / `/task …` → POST /api/tasks
 *      · `/answer <askId> 内容`      → POST /api/inbox/asks/:id/answer（请示卡过期后的兜底）
 *      · `/staff` `/asks` `/whoami` `/help`
 *      · 裸文本 → 30min 内上一次聊过的员工（sticky）；没有则提示 @谁
 *  - 其他人 → 只允许 POST /api/tasks 且 `untrusted:true`（外部文本：不进 Codex、不带工作区、不能装工具 / 推飞书）；
 *    不能回答请示、不能审核、不能直接和员工聊天 —— digital-staff 把老板聊天当可信域，全群都走聊天等于把可信域开给全群。
 *  - 白名单没配 → 只回 open_id 与配置提示，什么都不做（fail-closed）。
 *
 * 请示 / 审核的回答**不在这里**：digital-staff 出站本来就是 `agent lark ask … --chat $LARK_CHAT_ID`，
 * 把 LARK_CHAT_ID 设成本 bot 的命名空间 chatId（`staff:oc_xxx`）后，ask 卡由本 bot 发出、回答走 handlers.ts
 * 既有的 ask 流程（在进入本模块之前就被消费掉），天然不会把「请示的回答」再当聊天转发回去形成回环。
 *
 * 回复是异步的：`POST /api/messages?wait=N` 同步最多等 300s；超时返回 pending，这里再按 message id 轮询补推。
 */

export interface DigitalStaffConfig {
  baseUrl: string;
  /** digital-staff 的 AUTH_API_TOKEN（开了 AUTH_REQUIRED 才需要） */
  token: string;
  ownerOpenIds: string[];
  /** POST /api/messages 同步等待秒数（≤300） */
  waitSec: number;
  /** 裸文本沿用上一位员工的时限 */
  stickyMs: number;
}

export function loadDigitalStaffConfig(env: NodeJS.ProcessEnv = process.env): DigitalStaffConfig {
  const wait = Number(env['DIGITAL_STAFF_WAIT_SEC'] ?? 120);
  const stickyMin = Number(env['DIGITAL_STAFF_STICKY_MIN'] ?? 30);
  return {
    baseUrl: (env['DIGITAL_STAFF_URL']?.trim() || 'http://127.0.0.1:3900').replace(/\/+$/, ''),
    token: env['DIGITAL_STAFF_TOKEN']?.trim() ?? '',
    ownerOpenIds: (env['DIGITAL_STAFF_OWNER_OPEN_IDS'] ?? '')
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
    waitSec: Number.isFinite(wait) ? Math.min(300, Math.max(0, wait)) : 120,
    stickyMs: (Number.isFinite(stickyMin) ? Math.max(0, stickyMin) : 30) * 60_000,
  };
}

// ---------------- 意图解析（纯函数，便于测试） ----------------

export type StaffIntent =
  | { kind: 'help' }
  | { kind: 'list' }
  | { kind: 'asks' }
  | { kind: 'whoami' }
  | { kind: 'answer'; askId: string; text: string }
  | { kind: 'task'; title: string; description: string; assignee?: string }
  | { kind: 'chat'; employee?: string; content: string };

const AT_RE = /^@([^\s:：,，]+)[\s:：,，]*/;
/** 任务描述上限：与 digital-staff `str(body.description, 4000)` 对齐，本侧先截，不把超长文本原样转发 */
const MAX_DESCRIPTION = 4000;

function splitTitleBody(s: string): { title: string; description: string } {
  const [first = '', ...rest] = s.trim().split('\n');
  return { title: first.trim().slice(0, 120), description: rest.join('\n').trim() };
}

export function parseStaffIntent(raw: string): StaffIntent {
  const text = raw.trim();
  const lower = text.toLowerCase();
  if (/^(\/help|\/帮助|帮助|help)$/i.test(lower)) return { kind: 'help' };
  if (/^(\/staff|\/员工|\/list|员工列表|谁在|有谁)$/i.test(lower)) return { kind: 'list' };
  if (/^(\/asks|\/请示|待办请示|请示列表)$/i.test(lower)) return { kind: 'asks' };
  if (/^(\/whoami|我是谁)$/i.test(lower)) return { kind: 'whoami' };

  let m = /^(?:\/answer|回复请示|答复)\s+(\S+)\s+([\s\S]+)$/i.exec(text);
  if (m) return { kind: 'answer', askId: m[1]!, text: m[2]!.trim() };

  // 让 X 做 Y / 给 X 派任务 Y / 让 X 去 Y
  m = /^(?:让|给)\s*([^\s做去派：:]{1,20})\s*(?:做|去|派任务|派活|：|:)\s*([\s\S]+)$/.exec(text);
  if (m) {
    const { title, description } = splitTitleBody(m[2]!);
    return { kind: 'task', title, description, assignee: m[1]!.replace(/^@/, '') };
  }
  // 派任务 [@X] 标题⏎描述   /task [@X] 标题⏎描述
  m = /^(?:\/task|派任务|派活|新建任务|建任务)\s*[:：]?\s*([\s\S]*)$/i.exec(text);
  if (m) {
    let rest = m[1]!.trim();
    let assignee: string | undefined;
    const at = AT_RE.exec(rest);
    if (at) {
      assignee = at[1]!;
      rest = rest.slice(at[0].length);
    }
    const { title, description } = splitTitleBody(rest);
    return { kind: 'task', title, description, ...(assignee ? { assignee } : {}) };
  }
  // @X 内容
  const at = AT_RE.exec(text);
  if (at) {
    const content = text.slice(at[0].length).trim();
    return { kind: 'chat', employee: at[1]!, content };
  }
  return { kind: 'chat', content: text };
}

// ---------------- 员工 / 团队匹配 ----------------

export interface StaffEmployee {
  id: string;
  name: string;
  role?: string;
  teamId?: string | null;
  status?: string;
  paused?: boolean;
}
export interface StaffTeam {
  id: string;
  name: string;
}

export function matchEmployee(
  query: string,
  employees: StaffEmployee[],
): { match?: StaffEmployee; candidates: StaffEmployee[] } {
  const q = query.trim().toLowerCase();
  if (!q) return { candidates: [] };
  const exact = employees.filter((e) => e.name.toLowerCase() === q);
  if (exact.length === 1) return { match: exact[0]!, candidates: exact };
  if (exact.length > 1) return { candidates: exact };
  const partial = employees.filter(
    (e) => e.name.toLowerCase().includes(q) || (e.role ?? '').toLowerCase().includes(q),
  );
  if (partial.length === 1) return { match: partial[0]!, candidates: partial };
  return { candidates: partial };
}

export function matchTeam(query: string, teams: StaffTeam[]): StaffTeam | undefined {
  const q = query.trim().replace(/^(整组|团队|team:)\s*/i, '').toLowerCase();
  if (!q) return undefined;
  const hits = teams.filter((t) => t.name.toLowerCase() === q);
  return hits.length === 1 ? hits[0] : undefined;
}

// ---------------- HTTP client ----------------

export interface StaffStateSnapshot {
  employees: StaffEmployee[];
  teams: StaffTeam[];
  inbox?: { asks?: Array<{ id: string; employeeId: string; question: string; at?: string | number; channel?: string }> };
}
export interface StaffMessage {
  id: string;
  fromId: string;
  toId: string;
  content: string;
  at?: string | number;
}
export interface StaffReplyPayload {
  message: StaffMessage;
  reply: { id: string; employeeId: string; employeeName: string; content: string; at?: string | number } | null;
  pending: boolean;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class DigitalStaffClient {
  constructor(
    private readonly cfg: DigitalStaffConfig,
    private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i),
  ) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      // digital-staff 的防跨站要求：会话 / 免登录模式下所有写请求都要带；Bearer 模式不需要但带着无害
      'X-Requested-With': 'fetch',
    };
    if (this.cfg.token) h['Authorization'] = `Bearer ${this.cfg.token}`;
    return h;
  }

  private async call<T>(method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
    const url = `${this.cfg.baseUrl}${path}`;
    const resp = await this.fetchImpl(url, {
      method,
      headers: this.headers(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const textBody = await resp.text();
    let json: unknown = null;
    try {
      json = textBody ? JSON.parse(textBody) : null;
    } catch {
      /* 非 JSON 响应 */
    }
    if (!resp.ok) {
      const err = (json as { error?: string } | null)?.error ?? textBody.slice(0, 200) ?? `HTTP ${resp.status}`;
      throw new Error(`${method} ${path} → ${resp.status}：${err}`);
    }
    return json as T;
  }

  state(): Promise<StaffStateSnapshot> {
    return this.call<StaffStateSnapshot>('GET', '/api/state');
  }

  /** 聊天：同步等 waitSec 秒；超时 pending=true，之后用 reply(id) 轮询 */
  chat(toId: string, content: string, waitSec = this.cfg.waitSec): Promise<StaffReplyPayload | StaffMessage> {
    const q = waitSec > 0 ? `?wait=${waitSec}` : '';
    return this.call<StaffReplyPayload | StaffMessage>('POST', `/api/messages${q}`, { toId, content }, waitSec * 1000 + 15_000);
  }

  reply(messageId: string): Promise<StaffReplyPayload> {
    return this.call<StaffReplyPayload>('GET', `/api/messages/${encodeURIComponent(messageId)}/reply`);
  }

  createTask(input: { title: string; description: string; assigneeId: string | null; untrusted: boolean }): Promise<{ id: string; title: string; assigneeId?: string | null }> {
    return this.call('POST', '/api/tasks', { ...input, assigneeId: input.assigneeId ?? 'auto' });
  }

  answerAsk(askId: string, answer: string): Promise<{ ok: boolean }> {
    return this.call('POST', `/api/inbox/asks/${encodeURIComponent(askId)}/answer`, { answer });
  }
}

// ---------------- 入站处理 ----------------

export interface StaffInboundEvent {
  chatId: string;
  messageId: string;
  senderOpenId: string;
  text: string;
  /** 本条消息带的图片（已下载到本地）。digital-staff 聊天只收文本，这里只用来提示「图片没转发」 */
  imagePaths?: string[];
}

export interface StaffHandlerDeps {
  cfg?: DigitalStaffConfig;
  api?: DigitalStaffClient;
  /** pending 时的轮询间隔 / 总时长（测试缩短） */
  pollIntervalMs?: number;
  pollMaxMs?: number;
  now?: () => number;
}

interface Sticky {
  employeeId: string;
  name: string;
  at: number;
}
const sticky = new Map<string, Sticky>();

/** 仅测试用 */
export function __resetDigitalStaffForTest(): void {
  sticky.clear();
}

const HELP = [
  '🤖 数字员工 bot 用法',
  '1. @员工名 内容 —— 和这位员工聊天（可以让他问同事 / 派活 / 查数据）',
  '2. 直接打字 —— 继续和上一位聊过的员工说（30 分钟内）',
  '3. 派任务 @员工 标题⏎描述 —— 建任务（不写 @ 则按职责自动匹配；@整组 X 派给整个团队）',
  '4. 让 X 做 Y —— 同上的口语写法',
  '5. /staff 员工列表 · /asks 待回答的请示 · /answer <id> 内容 回答请示 · /whoami 看自己的 open_id',
  '请示 / 审核卡由员工主动推过来，直接在卡片上答即可。',
].join('\n');

function errMsg(e: unknown): string {
  return (e as Error).message ?? String(e);
}

function renderEmployeeList(s: StaffStateSnapshot): string {
  if (!s.employees.length) return '还没有员工。先到数字员工后台添加。';
  const teamName = new Map(s.teams.map((t) => [t.id, t.name]));
  const lines = s.employees.map((e, i) => {
    const st = e.status === 'working' ? '🔧 忙' : e.status === 'paused' || e.paused ? '⏸ 暂停' : '🟢 空闲';
    const team = e.teamId ? teamName.get(e.teamId) : undefined;
    return `${i + 1}. ${e.name}${e.role ? ` · ${e.role}` : ''}${team ? ` · ${team}` : ''} · ${st}`;
  });
  return `👥 员工（${s.employees.length}）\n${lines.join('\n')}\n\n@员工名 即可开聊`;
}

function renderAsks(s: StaffStateSnapshot): string {
  const asks = s.inbox?.asks ?? [];
  if (!asks.length) return '没有待回答的请示。';
  const nameOf = new Map(s.employees.map((e) => [e.id, e.name]));
  const lines = asks.map((a, i) => `${i + 1}. [${a.id}] ${nameOf.get(a.employeeId) ?? a.employeeId}：${a.question.slice(0, 200)}`);
  return `📨 待回答的请示（${asks.length}）\n${lines.join('\n')}\n\n/answer <id> 你的答复`;
}

/**
 * 处理数字员工 bot 收到的一条文本。调用方 fire-and-forget（飞书 ack 窗口 3-5s，这里会同步等员工回复最长几分钟）。
 */
export async function handleDigitalStaffMessage(
  client: Lark.Client,
  bot: LarkBotProfile,
  ev: StaffInboundEvent,
  deps: StaffHandlerDeps = {},
): Promise<void> {
  const cfg = deps.cfg ?? loadDigitalStaffConfig();
  const api = deps.api ?? new DigitalStaffClient(cfg);
  const now = deps.now ?? Date.now;
  const say = (text: string) => sendTextMessage(client, ev.chatId, text);
  const intent = parseStaffIntent(ev.text);

  // ── 白名单没配：fail-closed，只回自己的 open_id 与配置方法 ──
  if (cfg.ownerOpenIds.length === 0) {
    await say(
      `⚠️ 数字员工 bot 还没配老板白名单，所有消息都不处理。\n` +
        `你的 open_id（本应用下）：${ev.senderOpenId || '未知'}\n` +
        `在 multiAgentChat 的 .env 里加：DIGITAL_STAFF_OWNER_OPEN_IDS=${ev.senderOpenId || 'ou_xxx'}，然后在本机 bot 会话发 /reload。`,
    );
    return;
  }
  const isOwner = cfg.ownerOpenIds.includes(ev.senderOpenId);

  if (intent.kind === 'whoami') {
    await say(`你的 open_id（${bot.label} 应用下）：${ev.senderOpenId || '未知'}\n身份：${isOwner ? '老板（白名单内）' : '外部（不在白名单）'}`);
    return;
  }
  if (intent.kind === 'help') {
    await say(isOwner ? HELP : '你不在老板白名单里，只能提交外部任务：直接发「任务标题⏎描述」，会以不可信来源登记。');
    return;
  }

  // ── 非老板：只能建 untrusted 任务 ──
  if (!isOwner) {
    const body = intent.kind === 'task' ? intent : splitTitleBody(ev.text);
    const title = body.title || ev.text.slice(0, 120);
    try {
      const t = await api.createTask({ title, description: body.description.slice(0, MAX_DESCRIPTION), assigneeId: null, untrusted: true });
      await say(`📥 已按外部来源登记任务 #${t.id}「${t.title}」，由系统按职责分派。`);
      logger.info('digital-staff: 外部任务已登记', { chatId: ev.chatId, sender: ev.senderOpenId, taskId: t.id });
    } catch (e) {
      // 这条入口谁都能碰到：内部报错（地址 / 端口 / 后端异常文本）只进日志，对外一律通用文案
      logger.warn('digital-staff: 外部任务登记失败', { chatId: ev.chatId, sender: ev.senderOpenId, err: errMsg(e) });
      await say('❌ 登记失败，请稍后再试。');
    }
    return;
  }

  // ── 老板 ──
  try {
    if (intent.kind === 'list') {
      await say(renderEmployeeList(await api.state()));
      return;
    }
    if (intent.kind === 'asks') {
      await say(renderAsks(await api.state()));
      return;
    }
    if (intent.kind === 'answer') {
      await api.answerAsk(intent.askId, intent.text);
      await say(`✅ 已答复请示 ${intent.askId}`);
      return;
    }

    const snapshot = await api.state();

    if (intent.kind === 'task') {
      if (!intent.title) {
        await say('任务标题不能为空。格式：派任务 @员工 标题⏎描述');
        return;
      }
      let assigneeId: string | null = null;
      let assigneeLabel = '按职责自动匹配';
      if (intent.assignee) {
        const team = matchTeam(intent.assignee, snapshot.teams);
        if (team) {
          assigneeId = `team:${team.id}`;
          assigneeLabel = `整组 · ${team.name}`;
        } else {
          const { match, candidates } = matchEmployee(intent.assignee, snapshot.employees);
          if (!match) {
            await say(
              candidates.length
                ? `「${intent.assignee}」匹配到多位：${candidates.map((c) => c.name).join(' / ')}，请写全名。`
                : `没有叫「${intent.assignee}」的员工或团队。/staff 看名单。`,
            );
            return;
          }
          assigneeId = match.id;
          assigneeLabel = match.name;
        }
      }
      const t = await api.createTask({ title: intent.title, description: intent.description.slice(0, MAX_DESCRIPTION), assigneeId, untrusted: false });
      await say(`✅ 已派任务 #${t.id}「${t.title}」→ ${assigneeLabel}`);
      return;
    }

    // chat
    let target: StaffEmployee | undefined;
    if (intent.employee) {
      const { match, candidates } = matchEmployee(intent.employee, snapshot.employees);
      if (!match) {
        await say(
          candidates.length
            ? `「${intent.employee}」匹配到多位：${candidates.map((c) => c.name).join(' / ')}，请写全名。`
            : `没有叫「${intent.employee}」的员工。/staff 看名单。`,
        );
        return;
      }
      target = match;
    } else {
      const st = sticky.get(ev.chatId);
      if (st && now() - st.at <= cfg.stickyMs) {
        target = snapshot.employees.find((e) => e.id === st.employeeId);
      }
      if (!target && snapshot.employees.length === 1) target = snapshot.employees[0];
      if (!target) {
        await say(`先告诉我找谁：@员工名 内容。\n${renderEmployeeList(snapshot)}`);
        return;
      }
    }
    if (!intent.content) {
      sticky.set(ev.chatId, { employeeId: target.id, name: target.name, at: now() });
      await say(`好，接下来的话都发给 ${target.name}。`);
      return;
    }
    const content = ev.imagePaths?.length
      ? `${intent.content}\n（注：飞书里还附了 ${ev.imagePaths.length} 张图，数字员工聊天暂不收图，已略去）`
      : intent.content;

    sticky.set(ev.chatId, { employeeId: target.id, name: target.name, at: now() });
    const r = await api.chat(target.id, content);
    const payload: StaffReplyPayload = 'reply' in r ? r : { message: r, reply: null, pending: true };
    if (payload.reply) {
      await sendCardMessage(client, ev.chatId, staffReplyCard({ employeeName: payload.reply.employeeName || target.name, body: payload.reply.content }));
      return;
    }
    await say(`⏳ ${target.name} 还在想（已等 ${cfg.waitSec}s）。回复到了我再推过来。`);
    void pollReply(client, ev.chatId, api, payload.message.id, target.name, deps);
  } catch (e) {
    const msg = errMsg(e);
    logger.warn('digital-staff: 调用失败', { chatId: ev.chatId, err: msg });
    await say(
      /ECONNREFUSED|fetch failed|timeout|aborted/i.test(msg)
        ? `❌ 数字员工服务不可达（${cfg.baseUrl}）：${msg}\n确认 digital-staff 在跑（cd ~/ihealth-work/digital-staff && npm start）。`
        : `❌ 失败：${msg}`,
    );
  }
}

async function pollReply(
  client: Lark.Client,
  chatId: string,
  api: DigitalStaffClient,
  messageId: string,
  employeeName: string,
  deps: StaffHandlerDeps,
): Promise<void> {
  const interval = deps.pollIntervalMs ?? 15_000;
  const maxMs = deps.pollMaxMs ?? 10 * 60_000;
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    await new Promise((r) => setTimeout(r, interval));
    try {
      const p = await api.reply(messageId);
      if (p.reply) {
        await sendCardMessage(client, chatId, staffReplyCard({ employeeName: p.reply.employeeName || employeeName, body: p.reply.content }));
        return;
      }
    } catch (e) {
      logger.warn('digital-staff: 轮询回复失败', { messageId, err: (e as Error).message });
      return;
    }
  }
  await sendTextMessage(client, chatId, `⌛ ${employeeName} 10 分钟内没回复（消息 ${messageId}）。可以到数字员工后台看，或稍后再问一句。`).catch(() => {});
}
