import { logger } from '../logger.js';
import type { LetterThread, LetterDetail, LetterBody, LetterItem } from './types.js';

/**
 * CareyClaw 公函（A2A）MCP 客户端 —— 直连平台 streamable-http MCP 网关的 JSON-RPC。
 *
 * **为什么走 MCP 而不是 REST**：平台的 `/api/v2/a2a/*` 只认浏览器 cookie，
 * `oct_dev_` 开发者令牌请求它直接 401「请先登录」，而 cookie 要靠手机验证码登录、
 * 会过期，做不了无人值守轮询。同样这批能力在 MCP 端点上用 Bearer 开发者令牌就能访问，
 * 于是整套登录态维护都省掉了。
 *
 * 网关无状态（不需要 initialize 握手），直接 tools/call。
 */

/** 单次 HTTP 超时：平台无响应时快速失败，别让轮询干挂在 OS TCP 超时上。 */
const HTTP_TIMEOUT_MS = 20_000;

/** 认证失效（令牌过期/被吊销）—— 上层据此推「令牌该续了」而不是当成普通网络错误。 */
export class LettersAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LettersAuthError';
  }
}

interface JsonRpcResp {
  result?: { content?: { type?: string; text?: string }[]; isError?: boolean };
  error?: { code?: number; message?: string };
}

/** 把 fetch 的网络级失败翻译成能自诊断的提示。 */
function describeNetErr(e: unknown, url: string): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string } };
  let host = url;
  try { host = new URL(url).host; } catch { /* keep raw */ }
  if (err?.name === 'AbortError') return `公函 MCP 请求超时（${HTTP_TIMEOUT_MS / 1000}s 无响应，${host}）`;
  if (err?.cause?.code) return `公函 MCP 连不上（${err.cause.code}，${host}）`;
  return `公函 MCP 请求失败：${err?.message ?? String(e)}（${host}）`;
}

export class LettersMcpClient {
  private seq = 0;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  /** 调一个 a2a 工具，返回解析后的 JSON（工具把结果放在 content[0].text 里）。 */
  async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(this.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          // 网关是 streamable-http，两种都要声明否则 406
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++this.seq,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new Error(describeNetErr(e, this.url));
    } finally {
      clearTimeout(timer);
    }

    // 401/403 单独成类：令牌过期是要提醒用户去续的，不该混在网络抖动里被无声重试
    if (resp.status === 401 || resp.status === 403) {
      throw new LettersAuthError(
        `公函 MCP 鉴权失败（HTTP ${resp.status}）—— CareyClaw 开发者令牌可能已过期，去平台「工具中心 → 本地调试密钥」刷新`,
      );
    }
    if (!resp.ok) throw new Error(`公函 MCP HTTP ${resp.status}`);

    const body = (await resp.json()) as JsonRpcResp;
    if (body.error) throw new Error(`公函 MCP 错误：${body.error.message ?? body.error.code}`);
    const text = body.result?.content?.find((c) => c.text)?.text ?? '';
    if (body.result?.isError) throw new Error(`公函工具 ${name} 返回错误：${text.slice(0, 200)}`);
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`公函工具 ${name} 返回的不是 JSON：${text.slice(0, 120)}`);
    }
  }

  /**
   * 读一条公函线程的完整内容。
   *
   * ⚠ 正文在 **`latest.body_md`**，返回顶层**没有** `body_md` 字段
   * （顶层是 `thread` / `latest` / `open_items` / `pending` / `history` / `receipt` / `_notice`）。
   * 早先按顶层 `body_md` 取、取不到就 `JSON.stringify` 整个响应当正文，
   * 结果推给人和喂给模型的都是一坨 JSON，还会被按字符数截断成非法片段。
   */
  async readThread(threadId: string): Promise<LetterDetail> {
    const raw = await this.callTool<Record<string, unknown>>('a2a_read_thread', { thread_id: threadId });
    return parseDetail(raw, threadId);
  }

  /** 我的公函收件箱。only_mine=true 只看「球在我这」的。 */
  async inbox(onlyMine = true): Promise<{ agent: string; threads: LetterThread[] }> {
    const raw = await this.callTool<Record<string, unknown>>('a2a_inbox', { only_mine: onlyMine });
    const agent = typeof raw['agent'] === 'string' ? raw['agent'] : '';
    const list = Array.isArray(raw['threads']) ? (raw['threads'] as unknown[]) : [];
    return { agent, threads: list.map(parseThread).filter((t): t is LetterThread => t !== null) };
  }
}

/**
 * `a2a_read_thread` 的返回 → `LetterDetail`（纯函数，可测）。
 *
 * ⚠ 正文在 **`latest.body_md`**，返回顶层**没有** `body_md` 字段。
 * 早先按顶层取、取不到就 `JSON.stringify` 整个响应当正文，结果推给人和喂给模型的
 * 都是一坨 JSON，还会被按字符数截断成非法片段。这个映射有回归测试锁着，别改回去。
 */
export function parseDetail(raw: Record<string, unknown>, threadId: string): LetterDetail {
    const thread = obj(raw['thread']);
    const latest = obj(raw['latest']);
    const items = Array.isArray(raw['open_items']) ? (raw['open_items'] as unknown[]) : [];
    const pend = Array.isArray(raw['pending']) ? (raw['pending'] as unknown[]) : [];
    const receipt = obj(raw['receipt']);
    const body: LetterBody = {
      seq: num(latest['seq'], 1),
      kind: str(latest['kind'], 'letter'),
      title: str(latest['title']),
      fromAgent: str(latest['from_agent']),
      toAgents: parseStrList(latest['to_agents']),
      bodyMd: str(latest['body_md']),
      createdAt: str(latest['created_at']),
    };
    return {
      threadId: str(thread['thread_id'], threadId),
      subject: str(thread['subject'], body.title),
      latest: body,
      openItems: items.map(parseItem).filter((i): i is LetterItem => i !== null),
      pending: pend.map((p) => {
        const o = obj(p);
        return { ownerAgent: str(o['owner_agent']), pending: num(o['pending'], 0) };
      }).filter((p) => p.ownerAgent),
      receiptNonce: str(receipt['nonce']),
      notice: str(raw['_notice']),
    };
}

/** 兼容 JSON 串与数组两种形态（平台返回的 participants 是 JSON 串）。 */
function parseStrList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string' && v.trim()) {
    try {
      const j = JSON.parse(v) as unknown;
      if (Array.isArray(j)) return j.filter((x): x is string => typeof x === 'string');
    } catch { /* 不是 JSON 串，按单值处理 */ }
    return [v];
  }
  return [];
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/** 解析一条待答项；没有 item_id 就没法引用它回函，丢弃。 */
function parseItem(raw: unknown): LetterItem | null {
  const o = obj(raw);
  const itemId = str(o['item_id']);
  if (!itemId) return null;
  return {
    itemId,
    text: str(o['text']),
    ownerAgent: str(o['owner_agent']),
    status: str(o['status'], 'open'),
    due: str(o['due']),
    kind: str(o['kind']),
  };
}

function num(v: unknown, dflt = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function str(v: unknown, dflt = ''): string {
  return typeof v === 'string' ? v : dflt;
}

/**
 * 防御性解析一条线程。
 *
 * MCP 工具没声明 outputSchema，字段形状是实际调用观察到的，平台随时可能加/改字段。
 * 少了非关键字段就降级（卡片少显示一行），只有连 `thread_id` 都没有才丢弃这条
 * ——没有 id 就无法去重，推出去会每轮重复刷屏，那比漏一条更糟。
 */
export function parseThread(raw: unknown): LetterThread | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const threadId = str(o['thread_id']);
  if (!threadId) {
    logger.warn('公函线程缺 thread_id，跳过', { keys: Object.keys(o).slice(0, 10) });
    return null;
  }
  return {
    threadId,
    subject: str(o['subject'], '(无标题)'),
    initiator: str(o['initiator_agent']),
    participants: parseStrList(o['participants']),
    status: str(o['status'], 'open'),
    nextOwner: str(o['next_owner_agent']),
    lastSeq: num(o['last_seq'], 1),
    // 平台用 0/1 而不是布尔
    strict: Boolean(num(o['strict'], 0)),
    pendingMine: num(o['pending_mine'], 0),
    pendingOthers: parseStrList(o['pending_others']),
    createdAt: str(o['created_at']),
    updatedAt: str(o['updated_at']),
  };
}
