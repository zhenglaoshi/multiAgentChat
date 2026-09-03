// 同事任务甩单（handoff）—— 传输无关的模型。
// wire envelope 与 ../../../../multiagent-relay/src/types.ts 保持一致，见 docs/handoff-integration.md。

export type HandoffKind = 'create' | 'status' | 'reply';

export type HandoffStatus =
  | 'sent'
  | 'accepted'
  | 'in_progress'
  | 'done'
  | 'declined'
  | 'canceled';

export type HandoffRole = 'requester' | 'assignee';

export interface HandoffAttachment {
  blobId: string;
  name: string;
  size: number;
}

export interface HandoffContext {
  cwd?: string;
  shell?: string;
  agent?: string;
  host?: string;
}

/** 网络传输的信封（relay ↔ 客户端契约）。 */
export interface HandoffEnvelope {
  v: 1;
  id: string; // 任务 id（create/status/reply 共用）
  msgId: string; // 每条信封唯一（去重 / ack）
  kind: HandoffKind;
  from: string; // relay 盖章
  to: string;
  createdAt: number;

  // create
  title?: string;
  summaryMd?: string;
  attachments?: HandoffAttachment[];
  context?: HandoffContext;

  // status
  status?: HandoffStatus;
  note?: string;

  // reply
  replyText?: string;
}

export interface HandoffStatusEntry {
  status: HandoffStatus;
  at: number;
  by: string; // 身份
  note?: string;
}

/** 本地落盘的任务视图（requester 与 assignee 各存一份）。 */
export interface HandoffTask {
  id: string;
  role: HandoffRole;
  self: string; // 本人身份
  peer: string; // 对端身份
  title: string;
  summaryMd?: string;
  attachments: HandoffAttachment[];
  context?: HandoffContext;
  status: HandoffStatus;
  statusHistory: HandoffStatusEntry[];
  /** 飞书那张卡的 message_id（用于 patch）。P2 用。 */
  larkMessageId?: string;
  /** 该任务所在飞书 chat（投递/后续 patch 用）。 */
  chatId?: string;
  createdAt: number;
  updatedAt: number;
}
