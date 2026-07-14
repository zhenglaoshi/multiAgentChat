import { logger } from '../logger.js';

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

  /** 调一个 TAPD MCP 工具，返回 TAPD 信封里的 data。 */
  async callTool<T = unknown>(
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
