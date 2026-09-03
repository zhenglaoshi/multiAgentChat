import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { HandoffAttachment, HandoffEnvelope } from 'multiagent-orchestrator';
import { resolveIdentity, type RelayClientConfig } from './config.js';

export interface RelayContact {
  identity: string;
  online: boolean;
  lastSeen: number | null;
  self: boolean;
}

/** 与 multiagent-relay 服务通信的 HTTP 客户端。 */
export class RelayClient {
  constructor(private readonly cfg: RelayClientConfig) {}

  get identity(): string {
    return this.cfg.identity;
  }
  get allow(): Set<string> {
    return this.cfg.allow;
  }

  /** @别名 / 邮箱 → 身份。 */
  resolveTarget(target: string): string {
    return resolveIdentity(this.cfg, target);
  }

  private async req(path: string, init: RequestInit & { timeoutMs?: number }): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 30_000);
    try {
      const headers = new Headers(init.headers);
      headers.set('authorization', `Bearer ${this.cfg.token}`);
      return await fetch(`${this.cfg.url}${path}`, { ...init, headers, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async json<T>(res: Response): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try {
        msg = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        /* keep raw */
      }
      throw new Error(`relay ${res.status}: ${msg}`);
    }
    return JSON.parse(text) as T;
  }

  /** 发信封。返回 relay 回执（deduped=去重；blocked=收件人已拉黑本人，静默丢弃）。 */
  async send(env: HandoffEnvelope): Promise<{ id: string; msgId: string; deduped?: boolean; blocked?: boolean }> {
    const res = await this.req('/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(env),
    });
    return this.json(res);
  }

  /** 长轮询取信封（不删）。waitSec=0 立即返回。 */
  async poll(waitSec: number): Promise<HandoffEnvelope[]> {
    const res = await this.req(`/v1/poll?wait=${Math.max(0, Math.floor(waitSec))}`, {
      method: 'GET',
      timeoutMs: (waitSec + 10) * 1000,
    });
    const data = await this.json<{ items: HandoffEnvelope[] }>(res);
    return data.items ?? [];
  }

  /** 确认已处理，从队列删除。 */
  async ack(msgIds: string[]): Promise<number> {
    if (msgIds.length === 0) return 0;
    const res = await this.req('/v1/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgIds }),
    });
    const data = await this.json<{ removed: number }>(res);
    return data.removed ?? 0;
  }

  /** 上传字节 → blob（调用方负责脱敏后再传）。 */
  async uploadBytes(name: string, bytes: Buffer): Promise<HandoffAttachment> {
    // 拷进一块 ArrayBuffer 支撑的视图：类型是 Uint8Array<ArrayBuffer>，同时满足 DOM 与 undici 的
    // BodyInit（Node Buffer 是 Uint8Array<ArrayBufferLike>，比 DOM 约束更宽，不能直接当 body）
    const view = new Uint8Array(new ArrayBuffer(bytes.byteLength));
    view.set(bytes);
    const res = await this.req('/v1/blob', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-blob-name': encodeURIComponent(name),
        'x-blob-size': String(bytes.length),
      },
      body: view,
      timeoutMs: 120_000,
    });
    const data = await this.json<{ blobId: string; size: number }>(res);
    return { blobId: data.blobId, name, size: data.size };
  }

  /** 上传本地文件 → blob（原始字节，不脱敏；脱敏请在调用方做后走 uploadBytes）。 */
  async uploadBlob(path: string): Promise<HandoffAttachment> {
    return this.uploadBytes(basename(path), await readFile(path));
  }

  /** 下载 blob 到目录，返回落盘路径。 */
  async downloadBlob(att: HandoffAttachment, destDir: string): Promise<string> {
    const res = await this.req(`/v1/blob/${att.blobId}`, { method: 'GET', timeoutMs: 120_000 });
    if (!res.ok) throw new Error(`下载 blob 失败 ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(destDir, { recursive: true });
    const safeName = att.name.replace(/[/\\]/g, '_') || 'file';
    const dest = join(destDir, `${att.blobId.slice(0, 8)}_${safeName}`);
    await writeFile(dest, buf);
    return dest;
  }

  async contacts(): Promise<RelayContact[]> {
    const res = await this.req('/v1/contacts', { method: 'GET', timeoutMs: 15_000 });
    const data = await this.json<{ contacts: RelayContact[] }>(res);
    return data.contacts ?? [];
  }
}

// ---- 单例：daemon 启动时 init，server handler / poller 共用 ----

let singleton: RelayClient | null = null;

export function initRelay(cfg: RelayClientConfig): RelayClient {
  singleton = new RelayClient(cfg);
  return singleton;
}

export function getRelayClient(): RelayClient | null {
  return singleton;
}
