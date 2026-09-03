import { describe, it, expect } from 'vitest';
import {
  canTransition,
  canRoleTransition,
  allowedNextForRole,
  isTerminal,
  nextStatuses,
  HANDOFF_STATUS_LABEL,
} from '../packages/orchestrator/src/handoff/state.js';
import {
  buildCreateEnvelope,
  buildStatusEnvelope,
  validateIncoming,
} from '../packages/orchestrator/src/handoff/envelope.js';

describe('handoff 状态机', () => {
  it('合法跃迁', () => {
    expect(canTransition('sent', 'accepted')).toBe(true);
    expect(canTransition('sent', 'declined')).toBe(true);
    expect(canTransition('accepted', 'in_progress')).toBe(true);
    expect(canTransition('in_progress', 'done')).toBe(true);
    expect(canTransition('sent', 'canceled')).toBe(true);
  });
  it('非法跃迁被挡', () => {
    expect(canTransition('done', 'in_progress')).toBe(false);
    expect(canTransition('declined', 'accepted')).toBe(false);
    expect(canTransition('canceled', 'done')).toBe(false);
    expect(canTransition('in_progress', 'sent')).toBe(false);
  });
  it('收紧后的语义：不能跳过接收直接开始 / 开始后不能再拒绝', () => {
    expect(canTransition('sent', 'in_progress')).toBe(false); // 必须先 accepted
    expect(canTransition('in_progress', 'declined')).toBe(false); // 开始后只能完成或被撤回
  });
  it('同状态幂等 no-op 视为允许', () => {
    expect(canTransition('accepted', 'accepted')).toBe(true);
  });
  it('终态判定', () => {
    expect(isTerminal('done')).toBe(true);
    expect(isTerminal('declined')).toBe(true);
    expect(isTerminal('canceled')).toBe(true);
    expect(isTerminal('sent')).toBe(false);
    expect(isTerminal('in_progress')).toBe(false);
  });
  it('nextStatuses 终态为空', () => {
    expect(nextStatuses('done')).toEqual([]);
    expect(nextStatuses('sent').length).toBeGreaterThan(0);
  });
  it('每个状态都有 label', () => {
    for (const s of ['sent', 'accepted', 'in_progress', 'done', 'declined', 'canceled'] as const) {
      expect(HANDOFF_STATUS_LABEL[s]).toBeTruthy();
    }
  });
});

describe('handoff 角色鉴权 canRoleTransition / allowedNextForRole', () => {
  it('撤回只属发单方，拒绝/接收/开始/完成只属收单方', () => {
    expect(canRoleTransition('requester', 'sent', 'canceled')).toBe(true);
    expect(canRoleTransition('assignee', 'sent', 'canceled')).toBe(false); // 收单方不能撤回
    expect(canRoleTransition('assignee', 'sent', 'accepted')).toBe(true);
    expect(canRoleTransition('requester', 'sent', 'accepted')).toBe(false); // 发单方不能替对方接收
    expect(canRoleTransition('requester', 'accepted', 'done')).toBe(false);
    expect(canRoleTransition('assignee', 'accepted', 'done')).toBe(true);
  });
  it('allowedNextForRole 与卡片按钮一致', () => {
    expect(allowedNextForRole('assignee', 'sent').sort()).toEqual(['accepted', 'declined']);
    expect(allowedNextForRole('assignee', 'accepted').sort()).toEqual(['declined', 'done', 'in_progress']);
    expect(allowedNextForRole('assignee', 'in_progress')).toEqual(['done']);
    expect(allowedNextForRole('requester', 'sent')).toEqual(['canceled']);
    expect(allowedNextForRole('requester', 'in_progress')).toEqual(['canceled']);
    expect(allowedNextForRole('assignee', 'done')).toEqual([]);
  });
});

describe('handoff envelope 构建', () => {
  it('create 带全字段', () => {
    const env = buildCreateEnvelope({
      to: 'bob@x.com',
      from: 'alice@x.com',
      title: '报错求助',
      summaryMd: '## 问题\nxxx',
      attachments: [{ blobId: 'a'.repeat(32), name: 't.md', size: 10 }],
      context: { cwd: '/tmp', shell: 'zsh' },
    });
    expect(env.v).toBe(1);
    expect(env.kind).toBe('create');
    expect(env.from).toBe('alice@x.com');
    expect(env.to).toBe('bob@x.com');
    expect(env.title).toBe('报错求助');
    expect(env.attachments).toHaveLength(1);
    expect(env.id).toBeTruthy();
    expect(env.msgId).toBeTruthy();
  });
  it('create 不带可选字段时不塞空数组/undefined', () => {
    const env = buildCreateEnvelope({ to: 'bob@x.com', from: 'alice@x.com', title: 'x' });
    expect(env.attachments).toBeUndefined();
    expect(env.summaryMd).toBeUndefined();
  });
  it('两次 create 的 id / msgId 互不相同', () => {
    const a = buildCreateEnvelope({ to: 'b@x.com', from: 'a@x.com', title: 't' });
    const b = buildCreateEnvelope({ to: 'b@x.com', from: 'a@x.com', title: 't' });
    expect(a.id).not.toBe(b.id);
    expect(a.msgId).not.toBe(b.msgId);
  });
  it('status envelope 复用 task id、新 msgId', () => {
    const s = buildStatusEnvelope({ id: 'task-1', to: 'a@x.com', from: 'b@x.com', status: 'accepted', note: 'ok' });
    expect(s.kind).toBe('status');
    expect(s.id).toBe('task-1');
    expect(s.status).toBe('accepted');
    expect(s.note).toBe('ok');
    expect(s.msgId).toBeTruthy();
  });
});

describe('handoff validateIncoming（纵深防御）', () => {
  const good = {
    v: 1,
    id: 't1',
    msgId: 'm1',
    kind: 'create',
    from: 'a@x.com',
    to: 'b@x.com',
    createdAt: 1,
    title: 'x',
  };
  it('合法通过', () => {
    expect(validateIncoming(good).ok).toBe(true);
  });
  it('非对象 / 缺字段拒绝', () => {
    expect(validateIncoming(null).ok).toBe(false);
    expect(validateIncoming('nope').ok).toBe(false);
    expect(validateIncoming({ ...good, v: 2 }).ok).toBe(false);
    expect(validateIncoming({ ...good, id: '' }).ok).toBe(false);
    expect(validateIncoming({ ...good, msgId: undefined }).ok).toBe(false);
    expect(validateIncoming({ ...good, from: '' }).ok).toBe(false);
  });
  it('kind / status 非法拒绝', () => {
    expect(validateIncoming({ ...good, kind: 'evil' }).ok).toBe(false);
    expect(validateIncoming({ ...good, kind: 'status', status: 'weird' }).ok).toBe(false);
    expect(validateIncoming({ ...good, kind: 'status', status: 'accepted' }).ok).toBe(true);
  });
  it('对端可控字段类型非法即拒绝（防脏数据落盘后 render 崩→静默丢通知）', () => {
    expect(validateIncoming({ ...good, title: {} }).ok).toBe(false);
    expect(validateIncoming({ ...good, summaryMd: 123 }).ok).toBe(false);
    expect(validateIncoming({ ...good, attachments: 'x' }).ok).toBe(false);
    expect(validateIncoming({ ...good, attachments: [{ blobId: 'a', name: 'n' }] }).ok).toBe(false); // 缺 size
    expect(validateIncoming({ ...good, attachments: [{ blobId: 'a', name: 'n', size: 1 }] }).ok).toBe(true);
    expect(validateIncoming({ ...good, context: 'nope' }).ok).toBe(false);
    expect(validateIncoming({ v: 1, id: 't', msgId: 'm', kind: 'create', from: 'a', to: 'b', createdAt: 1 }).ok).toBe(false); // create 缺 title
    expect(validateIncoming({ v: 1, id: 't', msgId: 'm', kind: 'reply', from: 'a', to: 'b', createdAt: 1 }).ok).toBe(false); // reply 缺 replyText
    expect(validateIncoming({ v: 1, id: 't', msgId: 'm', kind: 'reply', from: 'a', to: 'b', createdAt: 1, replyText: 'hi' }).ok).toBe(true);
  });
});
