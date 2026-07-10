import { EventEmitter } from 'node:events';
import { logger } from '../logger.js';
import type { AskAnswer, AskRequest, AskType } from './types.js';

export const DEFAULT_ASK_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingResolver {
  resolveP: (req: AskRequest) => void;
  timer: NodeJS.Timeout;
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function nextId(): string {
  return `ask-${Date.now().toString(36)}-${shortId()}`;
}

export class AskManager {
  readonly events = new EventEmitter();
  private active = new Map<string, AskRequest>();
  private resolvers = new Map<string, PendingResolver>();
  /** chatId → askId：input 类型时锁定 chat 下一条文本消息为答案 */
  private awaitingInputByChat = new Map<string, string>();

  async create(input: {
    chatId: string;
    type: AskType;
    title: string;
    options?: string[];
    timeoutMs?: number;
  }): Promise<{ request: AskRequest; result: Promise<AskRequest> }> {
    const id = nextId();
    const req: AskRequest = {
      id,
      chatId: input.chatId,
      type: input.type,
      title: input.title,
      options: input.options ?? [],
      createdAt: Date.now(),
      status: 'pending',
      selection: [],
    };
    this.active.set(id, req);
    if (input.type === 'input') {
      this.awaitingInputByChat.set(input.chatId, id);
    }
    logger.info('ask created', { id, type: req.type, chatId: req.chatId, options: req.options.length });
    this.events.emit('created', req);

    const timeoutMs = input.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
    const result = new Promise<AskRequest>((resolveP) => {
      const timer = setTimeout(() => {
        void this.timeout(id);
      }, timeoutMs);
      this.resolvers.set(id, { resolveP, timer });
    });

    return { request: req, result };
  }

  setCardMessageId(id: string, messageId: string): void {
    const req = this.active.get(id);
    if (!req) return;
    req.cardMessageId = messageId;
  }

  get(id: string): AskRequest | undefined {
    return this.active.get(id);
  }

  getAwaitingInputAskId(chatId: string): string | undefined {
    return this.awaitingInputByChat.get(chatId);
  }

  /** multi 类型：toggle 某项。返回更新后的 request（用于 card patch）。 */
  toggle(id: string, index: number): AskRequest | undefined {
    const req = this.active.get(id);
    if (!req || req.status !== 'pending' || req.type !== 'multi') return undefined;
    const pos = req.selection.indexOf(index);
    if (pos >= 0) {
      req.selection.splice(pos, 1);
    } else {
      req.selection.push(index);
      req.selection.sort((a, b) => a - b);
    }
    return req;
  }

  async answer(id: string, answer: AskAnswer, resolvedBy: string): Promise<AskRequest | undefined> {
    const req = this.active.get(id);
    if (!req) return undefined;
    if (req.status !== 'pending') return req;
    req.status = 'answered';
    req.answer = answer;
    req.resolvedAt = Date.now();
    req.resolvedBy = resolvedBy;
    this.finalize(req);
    logger.info('ask answered', { id, kind: answer.kind, resolvedBy });
    this.events.emit('resolved', req);
    return req;
  }

  async cancel(id: string, resolvedBy: string): Promise<AskRequest | undefined> {
    const req = this.active.get(id);
    if (!req) return undefined;
    if (req.status !== 'pending') return req;
    req.status = 'cancelled';
    req.resolvedAt = Date.now();
    req.resolvedBy = resolvedBy;
    this.finalize(req);
    logger.info('ask cancelled', { id, resolvedBy });
    this.events.emit('resolved', req);
    return req;
  }

  private async timeout(id: string): Promise<void> {
    const req = this.active.get(id);
    if (!req || req.status !== 'pending') return;
    req.status = 'timeout';
    req.resolvedAt = Date.now();
    req.resolvedBy = 'system:timeout';
    this.finalize(req);
    logger.info('ask timeout', { id });
    this.events.emit('resolved', req);
  }

  private finalize(req: AskRequest): void {
    const r = this.resolvers.get(req.id);
    if (r) {
      clearTimeout(r.timer);
      r.resolveP(req);
      this.resolvers.delete(req.id);
    }
    if (req.type === 'input' && this.awaitingInputByChat.get(req.chatId) === req.id) {
      this.awaitingInputByChat.delete(req.chatId);
    }
    this.active.delete(req.id);
  }
}

export const asks = new AskManager();
