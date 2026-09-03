import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// store 惰性读 HANDOFF_DATA_DIR —— 必须在任何 store 调用前设好，隔离到临时目录
const DATA = mkdtempSync(join(tmpdir(), 'handoff-store-'));
process.env['HANDOFF_DATA_DIR'] = DATA;

const store = await import('../packages/orchestrator/src/handoff/store.js');
const { newTaskId, buildCreateEnvelope, buildStatusEnvelope } = await import(
  '../packages/orchestrator/src/handoff/envelope.js'
);

afterAll(() => {
  rmSync(DATA, { recursive: true, force: true });
});

describe('handoff store · applyIncoming', () => {
  it('create → 建 assignee 任务', async () => {
    const env = buildCreateEnvelope({ to: 'me@x.com', from: 'alice@x.com', title: 'help' });
    const r = await store.applyIncoming(env, 'me@x.com');
    expect(r.kind).toBe('created');
    expect(r.task?.role).toBe('assignee');
    expect(r.task?.peer).toBe('alice@x.com');
    expect(r.task?.status).toBe('sent');
  });

  it('重复 create → 幂等 ignored', async () => {
    const env = buildCreateEnvelope({ to: 'me@x.com', from: 'alice@x.com', title: 'dup' });
    await store.applyIncoming(env, 'me@x.com');
    const again = await store.applyIncoming(env, 'me@x.com'); // 同 id
    expect(again.kind).toBe('ignored');
    expect(again.changed).toBe(false);
  });

  it('peer 发合法状态 → 应用；非法跃迁 → ignored', async () => {
    const env = buildCreateEnvelope({ to: 'me@x.com', from: 'alice@x.com', title: 's' });
    await store.applyIncoming(env, 'me@x.com');
    const ok = await store.applyIncoming(
      buildStatusEnvelope({ id: env.id, to: 'me@x.com', from: 'alice@x.com', status: 'accepted' }),
      'me@x.com',
    );
    expect(ok.kind).toBe('status');
    expect(ok.task?.status).toBe('accepted');
    // sent 之后不能直接跳回 sent 之前——done→in_progress 非法
    const bad = await store.applyIncoming(
      buildStatusEnvelope({ id: env.id, to: 'me@x.com', from: 'alice@x.com', status: 'done' }),
      'me@x.com',
    );
    // accepted→done 合法，先做一次让它到 done，再测 done→in_progress
    expect(bad.kind).toBe('status');
    const illegal = await store.applyIncoming(
      buildStatusEnvelope({ id: env.id, to: 'me@x.com', from: 'alice@x.com', status: 'in_progress' }),
      'me@x.com',
    );
    expect(illegal.kind).toBe('ignored');
  });

  it('非对端发状态 → 被 from≠peer 守卫拦截', async () => {
    const env = buildCreateEnvelope({ to: 'me@x.com', from: 'alice@x.com', title: 'guard' });
    await store.applyIncoming(env, 'me@x.com');
    const evil = await store.applyIncoming(
      buildStatusEnvelope({ id: env.id, to: 'me@x.com', from: 'mallory@x.com', status: 'accepted' }),
      'me@x.com',
    );
    expect(evil.kind).toBe('ignored');
    expect(evil.reason).toContain('peer');
    const t = await store.getHandoffTask(env.id);
    expect(t?.status).toBe('sent'); // 未被篡改
  });
});

describe('handoff store · reply', () => {
  it('对端留言落到 statusHistory；终态任务忽略留言', async () => {
    const env = buildCreateEnvelope({ to: 'me@x.com', from: 'alice@x.com', title: 'r' });
    await store.applyIncoming(env, 'me@x.com');
    const mkReply = (text: string) => ({
      v: 1 as const, id: env.id, msgId: newTaskId(), kind: 'reply' as const,
      from: 'alice@x.com', to: 'me@x.com', createdAt: Date.now(), replyText: text,
    });
    const r1 = await store.applyIncoming(mkReply('看看这个'), 'me@x.com');
    expect(r1.kind).toBe('reply');
    expect(r1.task?.statusHistory.some((h) => h.note === '看看这个')).toBe(true);
    // 置终态后再留言 → ignored
    await store.applyIncoming(
      buildStatusEnvelope({ id: env.id, to: 'me@x.com', from: 'alice@x.com', status: 'declined' }),
      'me@x.com',
    );
    const r2 = await store.applyIncoming(mkReply('还在吗'), 'me@x.com');
    expect(r2.kind).toBe('ignored');
    expect(r2.reason).toContain('terminal');
  });
});

describe('handoff store · markProcessed 去重', () => {
  it('首次 true，之后 false', async () => {
    const id = 'msg-' + newTaskId();
    expect(await store.markProcessed(id)).toBe(true);
    expect(await store.markProcessed(id)).toBe(false);
  });
});

describe('handoff store · 并发写不丢更新', () => {
  it('并发 saveHandoffTask 两个不同 id 都保留', async () => {
    const mk = (id: string) =>
      store.saveHandoffTask({
        id,
        role: 'requester',
        self: 'me@x.com',
        peer: 'p@x.com',
        title: id,
        attachments: [],
        status: 'sent',
        statusHistory: [{ status: 'sent', at: 1, by: 'me@x.com' }],
        createdAt: 1,
        updatedAt: 1,
      });
    await Promise.all([mk('concurrent-a'), mk('concurrent-b'), mk('concurrent-c')]);
    expect(await store.getHandoffTask('concurrent-a')).toBeTruthy();
    expect(await store.getHandoffTask('concurrent-b')).toBeTruthy();
    expect(await store.getHandoffTask('concurrent-c')).toBeTruthy();
  });

  it('updateHandoffTask 锁内 mutate', async () => {
    await store.saveHandoffTask({
      id: 'upd-1',
      role: 'requester',
      self: 'me@x.com',
      peer: 'p@x.com',
      title: 'u',
      attachments: [],
      status: 'sent',
      statusHistory: [{ status: 'sent', at: 1, by: 'me@x.com' }],
      createdAt: 1,
      updatedAt: 1,
    });
    const r = await store.updateHandoffTask('upd-1', (t) => {
      t.status = 'accepted';
      return true;
    });
    expect(r?.status).toBe('accepted');
    expect((await store.getHandoffTask('upd-1'))?.status).toBe('accepted');
    const none = await store.updateHandoffTask('does-not-exist', () => true);
    expect(none).toBeNull();
  });
});
