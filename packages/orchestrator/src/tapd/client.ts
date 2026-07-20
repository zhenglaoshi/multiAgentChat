import { logger } from '../logger.js';

/**
 * 全局限流熔断（circuit breaker）—— 模块级、跨所有 client 实例共享。
 * TAPD 的 429 是按凭证/公司算的，与 client 实例无关，故用模块级状态。
 *
 * 任一调用撞 429 → 开一个冷却窗口（指数增长，封顶 5min），窗口内所有 TAPD 调用
 * 直接快速失败、不打网络 —— 避免"限流时还硬轮询/重试"把配额越打越死（原来每调用各自
 * 重试 2 次，一个 tick 几十个请求全撞 429 再各 ×3，是雪上加霜）。成功一次即清零。
 */
const COOLDOWN_BASE_MS = 30_000; // 首次 429 冷却 30s
const COOLDOWN_MAX_MS = 5 * 60_000; // 封顶 5min
let cooldownUntil = 0;
let consecutive429 = 0;

/** 冷却剩余毫秒（0 = 未在冷却）。 */
function cooldownLeft(): number {
  const left = cooldownUntil - Date.now();
  return left > 0 ? left : 0;
}
/** 撞 429：拉长冷却窗口（指数退避，封顶）。 */
function trip429(): void {
  consecutive429 = Math.min(consecutive429 + 1, 6);
  const ms = Math.min(COOLDOWN_BASE_MS * 2 ** (consecutive429 - 1), COOLDOWN_MAX_MS);
  cooldownUntil = Date.now() + ms;
  logger.warn('tapd 限流熔断开启', { consecutive429, cooldownMs: ms });
}
/** 成功一次：清空熔断状态。 */
function reset429(): void {
  if (consecutive429 > 0) logger.info('tapd 限流熔断解除（调用恢复成功）');
  consecutive429 = 0;
  cooldownUntil = 0;
}
function isRateLimit(msg: string): boolean {
  return msg.includes('429') || msg.includes('Too Many Requests');
}

/** 供上层（watcher/CLI）观测当前是否在限流冷却。 */
export function tapdCooldownLeftMs(): number {
  return cooldownLeft();
}

/**
 * TAPD MCP 客户端 —— 直连 streamable-http MCP 网关的 JSON-RPC，用 Bearer token 鉴权。
 *
 * 监听/查询走这里：纯 HTTP，不经 claude/LLM/CLI（确定、快、便宜、可高频轮询）。
 * 网关是无状态的（initialize 不返回 session id），所以直接 tools/call 即可，无需握手。
 *
 * 每个工具返回 result.content[].text 里是 TAPD 标准信封 { status, data, info }，
 * 本客户端解包后返回 data；status != 1 或 isError 抛错。
 */
export class TapdMcpClient {
  private seq = 0;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  /**
   * 调一个 TAPD MCP 工具，返回 TAPD 信封里的 data。
   * 走全局限流熔断：冷却窗口内直接快速失败（不打网络）；撞 429 则开/拉长冷却；成功则清零。
   * 不再本地重试 429 —— 重试只会加剧限流；改由熔断 + 下一轮轮询自然重试。
   */
  async callTool<T = unknown>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const cd = cooldownLeft();
    if (cd > 0) {
      throw new Error(`TAPD 限流冷却中（剩 ${Math.ceil(cd / 1000)}s），跳过 ${name}`);
    }
    try {
      const out = await this.callToolOnce<T>(name, args);
      reset429();
      return out;
    } catch (e) {
      if (isRateLimit((e as Error).message)) trip429();
      throw e;
    }
  }

  private async callToolOnce<T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const body = {
      jsonrpc: '2.0',
      id: ++this.seq,
      method: 'tools/call',
      params: { name, arguments: args },
    };
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`TAPD MCP HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const rpc = parseMaybeSse(await res.text());
    if (rpc.error) {
      throw new Error(`TAPD MCP rpc error: ${JSON.stringify(rpc.error).slice(0, 200)}`);
    }
    const result = rpc.result ?? {};
    const text: string = Array.isArray(result.content)
      ? result.content.map((c: { text?: string }) => c.text ?? '').join('')
      : '';
    if (result.isError) {
      throw new Error(`TAPD tool ${name} error: ${text.slice(0, 200)}`);
    }
    let envelope: { status?: number; data?: unknown; info?: string };
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new Error(`TAPD tool ${name}: 无法解析返回 JSON: ${text.slice(0, 150)}`);
    }
    // 信封形状因工具而异：get-bug-count 是 {status:1,data,info}，get-bug(列表)是
    // {base_url,data}（无 status）。故仅在 status 存在且 != 1 时才当错误。
    if (envelope.status !== undefined && envelope.status !== 1) {
      throw new Error(`TAPD tool ${name} status=${envelope.status}: ${envelope.info ?? ''}`);
    }
    return envelope.data as T;
  }

  /** 轻量 ping：能不能拿到我参与的项目（也顺带验证 nick）。 */
  async ping(nick: string): Promise<boolean> {
    try {
      await this.callTool('tapd-get-user-participant-projects', { nick });
      return true;
    } catch (e) {
      logger.warn('tapd ping failed', { err: (e as Error).message });
      return false;
    }
  }
}

/** 网关可能回纯 JSON，也可能回 SSE（event:/data:）。统一取出 JSON-RPC 对象。 */
function parseMaybeSse(raw: string): { result?: any; error?: unknown } {
  const t = raw.trim();
  if (t.startsWith('{')) return JSON.parse(t);
  // SSE：拼所有 data: 行
  const data = t
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .join('');
  return JSON.parse(data);
}
