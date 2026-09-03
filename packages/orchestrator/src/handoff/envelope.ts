import { randomUUID } from 'node:crypto';
import type {
  HandoffAttachment,
  HandoffContext,
  HandoffEnvelope,
  HandoffStatus,
} from './types.js';

export function newTaskId(): string {
  return randomUUID();
}

function newMsgId(): string {
  return randomUUID();
}

export interface BuildCreateInput {
  to: string;
  from: string;
  title: string;
  summaryMd?: string;
  attachments?: HandoffAttachment[];
  context?: HandoffContext;
  /** 复用已有任务 id（重发场景）；否则新建。 */
  id?: string;
}

export function buildCreateEnvelope(input: BuildCreateInput): HandoffEnvelope {
  const env: HandoffEnvelope = {
    v: 1,
    id: input.id ?? newTaskId(),
    msgId: newMsgId(),
    kind: 'create',
    from: input.from,
    to: input.to,
    createdAt: Date.now(),
    title: input.title,
  };
  if (input.summaryMd) env.summaryMd = input.summaryMd;
  if (input.attachments && input.attachments.length) env.attachments = input.attachments;
  if (input.context) env.context = input.context;
  return env;
}

export function buildStatusEnvelope(input: {
  id: string;
  to: string;
  from: string;
  status: HandoffStatus;
  note?: string;
}): HandoffEnvelope {
  const env: HandoffEnvelope = {
    v: 1,
    id: input.id,
    msgId: newMsgId(),
    kind: 'status',
    from: input.from,
    to: input.to,
    createdAt: Date.now(),
    status: input.status,
  };
  if (input.note) env.note = input.note;
  return env;
}

export function buildReplyEnvelope(input: {
  id: string;
  to: string;
  from: string;
  replyText: string;
}): HandoffEnvelope {
  return {
    v: 1,
    id: input.id,
    msgId: newMsgId(),
    kind: 'reply',
    from: input.from,
    to: input.to,
    createdAt: Date.now(),
    replyText: input.replyText,
  };
}

const KINDS = new Set(['create', 'status', 'reply']);
const STATUSES = new Set<HandoffStatus>([
  'sent',
  'accepted',
  'in_progress',
  'done',
  'declined',
  'canceled',
]);

/** 收到 envelope 时的防御性校验（relay 已校验，这里是纵深防御）。 */
export function validateIncoming(raw: unknown): { ok: true; env: HandoffEnvelope } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'not an object' };
  const e = raw as Record<string, unknown>;
  if (e['v'] !== 1) return { ok: false, error: 'bad v' };
  if (typeof e['id'] !== 'string' || !e['id']) return { ok: false, error: 'no id' };
  if (typeof e['msgId'] !== 'string' || !e['msgId']) return { ok: false, error: 'no msgId' };
  if (typeof e['kind'] !== 'string' || !KINDS.has(e['kind'])) return { ok: false, error: 'bad kind' };
  if (typeof e['from'] !== 'string' || !e['from']) return { ok: false, error: 'no from' };
  if (typeof e['to'] !== 'string' || !e['to']) return { ok: false, error: 'no to' };
  if (e['kind'] === 'status' && (typeof e['status'] !== 'string' || !STATUSES.has(e['status'] as HandoffStatus))) {
    return { ok: false, error: 'bad status' };
  }
  // 半信任对端可控字段的类型校验：非法即丢弃，别让脏数据落盘后在 render 时崩溃、
  // 导致「已 markProcessed 但永不弹卡」的静默通知丢失。
  const strOk = (k: string) => e[k] === undefined || typeof e[k] === 'string';
  if (!strOk('title') || !strOk('summaryMd') || !strOk('note') || !strOk('replyText')) {
    return { ok: false, error: 'bad text field' };
  }
  if (e['kind'] === 'create' && (typeof e['title'] !== 'string' || !e['title'])) {
    return { ok: false, error: 'create requires title' };
  }
  if (e['kind'] === 'reply' && (typeof e['replyText'] !== 'string' || !e['replyText'])) {
    return { ok: false, error: 'reply requires replyText' };
  }
  if (e['attachments'] !== undefined) {
    if (!Array.isArray(e['attachments'])) return { ok: false, error: 'bad attachments' };
    for (const a of e['attachments']) {
      if (typeof a !== 'object' || a === null) return { ok: false, error: 'bad attachment' };
      const at = a as Record<string, unknown>;
      if (typeof at['blobId'] !== 'string' || typeof at['name'] !== 'string' || typeof at['size'] !== 'number') {
        return { ok: false, error: 'bad attachment shape' };
      }
    }
  }
  if (e['context'] !== undefined && (typeof e['context'] !== 'object' || e['context'] === null || Array.isArray(e['context']))) {
    return { ok: false, error: 'bad context' };
  }
  return { ok: true, env: e as unknown as HandoffEnvelope };
}
