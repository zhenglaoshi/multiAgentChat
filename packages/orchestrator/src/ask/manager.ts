import { EventEmitter } from 'node:events';
import { logger } from '../logger.js';
import type { AskAnswer, AskAnswerForm, AskFormQuestion, AskRequest, AskType } from './types.js';

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
  /** chatId → {askId,q}：form 向导里"武装"了自由输入，下一条文本记为该题答案 */
  private awaitingFormInputByChat = new Map<string, { askId: string; q: number }>();

  async create(input: {
    chatId: string;
    type: AskType;
    title: string;
    options?: string[];
    questions?: AskFormQuestion[];
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
    if (input.type === 'form') {
      req.questions = input.questions ?? [];
      req.formSelection = req.questions.map(() => []);
      req.formText = req.questions.map(() => undefined);
      req.formCursor = 0;
    }
    this.active.set(id, req);
    if (input.type === 'input') {
      this.awaitingInputByChat.set(input.chatId, id);
    }
    // wecom multi 走"文本回复数字"模式（企微 template_card 不支持真 checkbox toggle）
    if (input.type === 'multi' && input.chatId.startsWith('wecom:')) {
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

  /** 找某 chat 下当前 pending 的 ask（single/multi/form 都算）——用于打字兜底回答。 */
  getPendingByChat(chatId: string): AskRequest | undefined {
    for (const req of this.active.values()) {
      if (req.chatId === chatId && req.status === 'pending') return req;
    }
    return undefined;
  }

  /** form 类型：toggle 第 q 题的第 i 项。single → 互斥；multi → 增删。返回更新后的 request。 */
  toggleForm(id: string, q: number, i: number): AskRequest | undefined {
    const req = this.active.get(id);
    if (!req || req.status !== 'pending' || req.type !== 'form' || !req.questions || !req.formSelection) return undefined;
    const question = req.questions[q];
    const sel = req.formSelection[q];
    if (!question || !sel) return undefined;
    if (question.type === 'single') {
      req.formSelection[q] = sel.length === 1 && sel[0] === i ? [] : [i];
    } else {
      const pos = sel.indexOf(i);
      if (pos >= 0) sel.splice(pos, 1);
      else { sel.push(i); sel.sort((a, b) => a - b); }
    }
    // 点了固定选项 → 撤销该题的自由输入答案 + 解除武装
    if (req.formText) req.formText[q] = undefined;
    this.disarmFormText(req);
    return req;
  }

  /** form 向导：把游标移到 idx（clamp 到 [0, questions.length]）。返回更新后的 request。 */
  setFormCursor(id: string, idx: number): AskRequest | undefined {
    const req = this.active.get(id);
    if (!req || req.status !== 'pending' || req.type !== 'form' || !req.questions) return undefined;
    const max = req.questions.length; // == length 表示提交页
    req.formCursor = Math.max(0, Math.min(idx, max));
    this.disarmFormText(req);
    return req;
  }

  private disarmFormText(req: AskRequest): void {
    req.formTextArmed = undefined;
    const cur = this.awaitingFormInputByChat.get(req.chatId);
    if (cur && cur.askId === req.id) this.awaitingFormInputByChat.delete(req.chatId);
  }

  /** form 向导：武装第 q 题的自由输入（下一条文本记为该题答案）。返回更新后的 request。 */
  armFormText(id: string, q: number): AskRequest | undefined {
    const req = this.active.get(id);
    if (!req || req.status !== 'pending' || req.type !== 'form' || !req.questions) return undefined;
    if (!req.questions[q]?.allowText) return undefined;
    req.formTextArmed = q;
    req.formCursor = q;
    this.awaitingFormInputByChat.set(req.chatId, { askId: id, q });
    return req;
  }

  getAwaitingFormInput(chatId: string): { askId: string; q: number } | undefined {
    return this.awaitingFormInputByChat.get(chatId);
  }

  /** form 向导：把文本记为武装题的答案，解除武装，前进到下一题。返回更新后的 request。 */
  answerFormText(chatId: string, text: string): AskRequest | undefined {
    const await_ = this.awaitingFormInputByChat.get(chatId);
    if (!await_) return undefined;
    const req = this.active.get(await_.askId);
    if (!req || req.status !== 'pending' || req.type !== 'form' || !req.formText || !req.formSelection) return undefined;
    req.formText[await_.q] = text;
    req.formSelection[await_.q] = []; // 文本答案与选项互斥
    this.awaitingFormInputByChat.delete(chatId);
    req.formTextArmed = undefined;
    req.formCursor = Math.min(await_.q + 1, req.questions?.length ?? 0);
    return req;
  }

  /**
   * form 提交：校验每个 single 题都已选，构造 form 答案并 resolve。
   * 返回 { ok:false, missing } 表示还有单选题没选（不 resolve）。
   */
  async submitForm(id: string, resolvedBy: string): Promise<{ ok: true; request: AskRequest } | { ok: false; missing: number[] } | undefined> {
    const req = this.active.get(id);
    if (!req || req.status !== 'pending' || req.type !== 'form' || !req.questions || !req.formSelection) return undefined;
    // single 题必须有答案（选项 或 自由文字）；multi 可空
    const missing: number[] = [];
    req.questions.forEach((qq, qi) => {
      const hasText = !!(req.formText![qi]);
      const hasSel = (req.formSelection![qi]?.length ?? 0) > 0;
      if (qq.type === 'single' && !hasText && !hasSel) missing.push(qi);
    });
    if (missing.length > 0) return { ok: false, missing };
    const answer: AskAnswerForm = {
      kind: 'form',
      items: req.questions.map((qq, qi) => {
        const txt = req.formText![qi];
        if (txt !== undefined && txt !== '') {
          return { q: qi, kind: 'text' as const, text: txt };
        }
        const sel = [...(req.formSelection![qi] ?? [])].sort((a, b) => a - b);
        if (qq.type === 'single') {
          const idx = sel[0] ?? -1;
          return { q: qi, kind: 'single' as const, index: idx, value: qq.options[idx] ?? '' };
        }
        return { q: qi, kind: 'multi' as const, indices: sel, values: sel.map((s) => qq.options[s] ?? '') };
      }),
    };
    const updated = await this.answer(id, answer, resolvedBy);
    return updated ? { ok: true, request: updated } : undefined;
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
    if (this.awaitingInputByChat.get(req.chatId) === req.id) {
      this.awaitingInputByChat.delete(req.chatId);
    }
    const fi = this.awaitingFormInputByChat.get(req.chatId);
    if (fi && fi.askId === req.id) {
      this.awaitingFormInputByChat.delete(req.chatId);
    }
    this.active.delete(req.id);
  }
}

export const asks = new AskManager();
