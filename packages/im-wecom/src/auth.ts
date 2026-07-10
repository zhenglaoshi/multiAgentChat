import { logger } from 'multiagent-orchestrator';
import type { WeComConfig } from './config.js';

/**
 * access_token 管理。企微 token 2h 有效期，我们**提前 60min 刷新**（早 refresh 防 corner
 * case）。内存缓存，daemon 挂就重来。
 *
 *   GET https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=X&corpsecret=Y
 *   → {errcode, errmsg, access_token, expires_in}
 */

interface CachedToken {
  token: string;
  expiresAt: number;   // ms epoch
}

const EARLY_REFRESH_MS = 60 * 60 * 1000;  // 提前 60min

export class TokenManager {
  private cached: CachedToken | null = null;
  private refreshingPromise: Promise<string> | null = null;

  constructor(private readonly cfg: WeComConfig) {}

  /** 拿 access_token（走缓存 / 自动刷新）*/
  async get(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt - EARLY_REFRESH_MS > now) {
      return this.cached.token;
    }
    // 已有 refresh in-flight → 复用
    if (this.refreshingPromise) return this.refreshingPromise;
    this.refreshingPromise = this.fetchAndCache().finally(() => {
      this.refreshingPromise = null;
    });
    return this.refreshingPromise;
  }

  /** 主动 invalidate（errcode 42001 时用）*/
  invalidate(): void {
    this.cached = null;
  }

  private async fetchAndCache(): Promise<string> {
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(this.cfg.corpId)}&corpsecret=${encodeURIComponent(this.cfg.secret)}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`gettoken HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
    }
    const data = await resp.json() as { errcode: number; errmsg: string; access_token?: string; expires_in?: number };
    if (data.errcode !== 0 || !data.access_token) {
      throw new Error(`gettoken errcode=${data.errcode} errmsg=${data.errmsg}`);
    }
    const expiresInMs = (data.expires_in ?? 7200) * 1000;
    this.cached = {
      token: data.access_token,
      expiresAt: Date.now() + expiresInMs,
    };
    logger.info('wecom access_token refreshed', {
      expiresInSec: data.expires_in,
      corpId: this.cfg.corpId,
    });
    return data.access_token;
  }
}
