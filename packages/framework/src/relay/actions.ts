import {
  buildStatusEnvelope,
  buildReplyEnvelope,
  canRoleTransition,
  getHandoffTask,
  isTerminal,
  redactText,
  updateHandoffTask,
  type HandoffStatus,
  type HandoffTask,
} from 'multiagent-orchestrator';
import { getRelayClient } from './client.js';

/**
 * 发一条状态信封给对端 + 锁内回写本地 task。CLI（server op）与飞书卡片按钮共用这一条路径。
 * 角色鉴权走 canRoleTransition（单一事实源，与卡片按钮一致）：requester 只能撤回、
 * assignee 才能接收/开始/完成/拒绝。note 发送前脱敏；回写走锁内重读避免旧快照覆盖。
 * applied=false 表示锁内二次校验时状态已被并发更新、本次未真正写入（结果不失真，task 是最新值）。
 */
export async function sendHandoffStatus(
  taskId: string,
  status: HandoffStatus,
  note?: string,
): Promise<{ ok: boolean; task?: HandoffTask; applied?: boolean; error?: string }> {
  const client = getRelayClient();
  if (!client) return { ok: false, error: 'relay 未配置' };
  const task = await getHandoffTask(taskId);
  if (!task) return { ok: false, error: `找不到 handoff 任务：${taskId}` };
  if (!canRoleTransition(task.role, task.status, status)) {
    return { ok: false, error: `不允许的状态变更：${task.role} 在 ${task.status} 下不能置为 ${status}` };
  }
  const redNote = note ? redactText(note) : undefined;
  const env = buildStatusEnvelope({
    id: task.id,
    to: task.peer,
    from: client.identity,
    status,
    ...(redNote ? { note: redNote } : {}),
  });
  await client.send(env);

  let applied = false;
  const updated = await updateHandoffTask(task.id, (t) => {
    if (!canRoleTransition(t.role, t.status, status)) return false; // 锁内二次校验（防并发）
    t.status = status;
    const entry: HandoffTask['statusHistory'][number] = { status, at: Date.now(), by: client.identity };
    if (redNote) entry.note = redNote;
    t.statusHistory.push(entry);
    applied = true;
    return true;
  });
  return { ok: true, task: updated ?? task, applied };
}

/** 给对端发一条留言（reply）+ 本地追加到 statusHistory。发送前脱敏。 */
export async function sendHandoffReply(
  taskId: string,
  text: string,
): Promise<{ ok: boolean; task?: HandoffTask; error?: string }> {
  const client = getRelayClient();
  if (!client) return { ok: false, error: 'relay 未配置' };
  const task = await getHandoffTask(taskId);
  if (!task) return { ok: false, error: `找不到 handoff 任务：${taskId}` };
  if (isTerminal(task.status)) return { ok: false, error: `任务已${task.status}，不能再留言` };
  const redText = redactText(text);
  if (!redText.trim()) return { ok: false, error: '留言为空' };
  const env = buildReplyEnvelope({ id: task.id, to: task.peer, from: client.identity, replyText: redText });
  await client.send(env);
  const updated = await updateHandoffTask(task.id, (t) => {
    if (isTerminal(t.status)) return false; // 锁内二次校验：并发置终态则不再本地记账（与 sendHandoffStatus 同模式）
    t.statusHistory.push({ status: t.status, at: Date.now(), by: client.identity, note: redText });
    return true;
  });
  return { ok: true, task: updated ?? task };
}
