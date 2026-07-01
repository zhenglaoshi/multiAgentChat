import { EventEmitter } from 'node:events';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { logger } from '../logger.js';
import type { ApprovalGateContext, ApprovalRequest, ApprovalStatus } from './types.js';

const DATA_DIR = resolve('./data/approvals');
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingResolver {
  resolveP: (req: ApprovalRequest) => void;
  timer: NodeJS.Timeout;
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function nextId(): string {
  return `ap-${Date.now().toString(36)}-${shortId()}`;
}

async function persist(req: ApprovalRequest): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const file = join(DATA_DIR, `${req.id}.json`);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(req, null, 2), 'utf8');
  await rename(tmp, file);
}

export class ApprovalManager {
  readonly events = new EventEmitter();
  private active = new Map<string, ApprovalRequest>();
  private resolvers = new Map<string, PendingResolver>();

  async create(input: {
    title: string;
    body: string;
    taskId?: string;
    chatId?: string;
    timeoutMs?: number;
    gateContext?: ApprovalGateContext;
  }): Promise<{ request: ApprovalRequest; result: Promise<ApprovalRequest> }> {
    const id = nextId();
    const req: ApprovalRequest = {
      id,
      title: input.title,
      body: input.body,
      taskId: input.taskId,
      chatId: input.chatId,
      createdAt: Date.now(),
      status: 'pending',
    };
    if (input.gateContext) req.gateContext = input.gateContext;
    this.active.set(id, req);
    await persist(req);
    logger.info('approval created', { id, taskId: req.taskId, chatId: req.chatId });
    this.events.emit('created', req);

    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const result = new Promise<ApprovalRequest>((resolveP) => {
      const timer = setTimeout(() => {
        void this.resolve(id, 'timeout', 'system:timeout');
      }, timeoutMs);
      this.resolvers.set(id, { resolveP, timer });
    });

    return { request: req, result };
  }

  async resolve(
    id: string,
    status: Exclude<ApprovalStatus, 'pending'>,
    resolvedBy: string,
  ): Promise<ApprovalRequest | undefined> {
    const req = this.active.get(id);
    if (!req) return undefined;
    if (req.status !== 'pending') return req;
    req.status = status;
    req.resolvedAt = Date.now();
    req.resolvedBy = resolvedBy;
    await persist(req);
    logger.info('approval resolved', { id, status, resolvedBy });
    const r = this.resolvers.get(id);
    if (r) {
      clearTimeout(r.timer);
      r.resolveP(req);
      this.resolvers.delete(id);
    }
    this.events.emit('resolved', req);
    this.active.delete(id);
    return req;
  }

  setCardMessageId(id: string, messageId: string): void {
    const req = this.active.get(id);
    if (!req) return;
    req.cardMessageId = messageId;
    void persist(req);
  }

  get(id: string): ApprovalRequest | undefined {
    return this.active.get(id);
  }

  listActive(): ApprovalRequest[] {
    return [...this.active.values()];
  }

  async listRecent(limit = 20): Promise<ApprovalRequest[]> {
    if (!existsSync(DATA_DIR)) return [];
    const files = await readdir(DATA_DIR);
    const records: ApprovalRequest[] = [];
    for (const f of files) {
      if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
      try {
        const raw = await readFile(join(DATA_DIR, f), 'utf8');
        records.push(JSON.parse(raw) as ApprovalRequest);
      } catch (e) {
        logger.warn('failed to load approval', { file: f, err: (e as Error).message });
      }
    }
    records.sort((a, b) => b.createdAt - a.createdAt);
    return records.slice(0, limit);
  }
}

export const approvals = new ApprovalManager();
