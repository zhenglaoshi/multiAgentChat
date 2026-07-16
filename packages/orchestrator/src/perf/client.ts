import { logger } from '../logger.js';

/**
 * performance-platform-api 客户端 —— 直连其 REST（Fastify），HTTP Basic auth。
 * 429/5xx 退避重试。所有路径相对 `${apiUrl}/api`。
 */
export class PerfApiClient {
  private readonly authHeader: string;

  constructor(
    private readonly apiUrl: string,
    user: string,
    pass: string,
  ) {
    this.authHeader = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  }

  private async request<T>(method: string, path: string, body?: unknown, retriesLeft = 2): Promise<T> {
    const url = `${this.apiUrl}/api${path}`;
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: this.authHeader,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (res.status === 429 || res.status >= 500) {
        throw Object.assign(new Error(`perf-api HTTP ${res.status}`), { retriable: true });
      }
      if (!res.ok) {
        throw new Error(`perf-api ${method} ${path} HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
      }
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    } catch (e) {
      if ((e as { retriable?: boolean }).retriable && retriesLeft > 0) {
        const delay = 1000 * Math.pow(2, 2 - retriesLeft);
        logger.warn('perf-api retriable', { path, retriesLeft, delay });
        await new Promise((r) => setTimeout(r, delay));
        return this.request<T>(method, path, body, retriesLeft - 1);
      }
      throw e;
    }
  }

  /** GET /api/recommendations?status=&target= */
  listRecommendations(params: { status?: string; target?: string } = {}): Promise<Record<string, unknown>[]> {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.target) q.set('target', params.target);
    const qs = q.toString();
    return this.request<Record<string, unknown>[]>('GET', `/recommendations${qs ? `?${qs}` : ''}`);
  }

  /** GET /api/repos —— repo → databases 映射（做 database→repo→localPath 用）。 */
  listRepos(): Promise<Record<string, unknown>[]> {
    return this.request<Record<string, unknown>[]>('GET', '/repos');
  }

  /** PATCH /api/recommendations/:id —— 回写状态（P3；CAS 需 perf 侧支持期望状态）。 */
  patchRecommendation(id: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request('PATCH', `/recommendations/${encodeURIComponent(id)}`, body);
  }

  /** POST /api/recommendations/:id/verify —— 触发前后对比校验（P3）。 */
  verifyRecommendation(id: string, body: Record<string, unknown> = {}): Promise<unknown> {
    return this.request('POST', `/recommendations/${encodeURIComponent(id)}/verify`, body);
  }

  /** 轻量连通性检查。 */
  async ping(): Promise<boolean> {
    try {
      await this.listRecommendations({ status: 'pending' });
      return true;
    } catch (e) {
      logger.warn('perf-api ping failed', { err: (e as Error).message });
      return false;
    }
  }
}
