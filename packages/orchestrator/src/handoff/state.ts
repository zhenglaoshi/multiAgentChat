import type { HandoffRole, HandoffStatus } from './types.js';

export const HANDOFF_STATUS_LABEL: Record<HandoffStatus, string> = {
  sent: '📤 已发送',
  accepted: '🤝 已接收',
  in_progress: '🚧 进行中',
  done: '✅ 已完成',
  declined: '🙅 已拒绝',
  canceled: '↩️ 已撤回',
};

const TERMINAL: readonly HandoffStatus[] = ['done', 'declined', 'canceled'];

/**
 * 合法状态跃迁（有向图）。语义：必须先「接收」才能「开始」；开始后只能「完成」（或被发单方撤回）；
 * 「撤回(canceled)」在所有非终态可由 requester 发起、「拒绝(declined)」在 sent/accepted 由 assignee 发起。
 */
const TRANSITIONS: Record<HandoffStatus, readonly HandoffStatus[]> = {
  sent: ['accepted', 'declined', 'canceled'],
  accepted: ['in_progress', 'done', 'declined', 'canceled'],
  in_progress: ['done', 'canceled'],
  done: [],
  declined: [],
  canceled: [],
};

export function isTerminal(s: HandoffStatus): boolean {
  return TERMINAL.includes(s);
}

/** from → to 是否允许（幂等：to===from 视为允许的 no-op）。 */
export function canTransition(from: HandoffStatus, to: HandoffStatus): boolean {
  if (from === to) return true;
  return TRANSITIONS[from].includes(to);
}

/** 某状态下的下一步可选项（渲染按钮用）。 */
export function nextStatuses(from: HandoffStatus): HandoffStatus[] {
  return [...TRANSITIONS[from]];
}

/**
 * 角色感知的跃迁鉴权（单一事实源，卡片按钮与 CLI/sendHandoffStatus 都调它）：
 * 状态图合法之外，还要求语义角色对——撤回(canceled)只属发单方 requester；
 * 拒绝/接收/开始/完成属收单方 assignee。
 */
export function canRoleTransition(role: HandoffRole, from: HandoffStatus, to: HandoffStatus): boolean {
  if (!canTransition(from, to)) return false;
  if (from === to) return true; // 幂等 no-op
  if (to === 'canceled') return role === 'requester';
  return role === 'assignee'; // accepted/in_progress/done/declined 都是收单方的动作
}

/** 某角色在当前状态下可点的下一步（渲染按钮用）。 */
export function allowedNextForRole(role: HandoffRole, from: HandoffStatus): HandoffStatus[] {
  return nextStatuses(from).filter((to) => canRoleTransition(role, from, to));
}
