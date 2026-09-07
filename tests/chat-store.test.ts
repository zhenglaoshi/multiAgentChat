import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadChat, mutateChat } from '../packages/im-lark/src/chats/store.js';

// mutateChat 是本轮修 lost-update 竞态的核心原语：按 chatId 串行化的 load→mutate→save。
// 用一次性 chatId 落到真实 ./data/chats（gitignored），用例结束即清理。
const ids: string[] = [];
function newId(): string {
  const id = `test-mutate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  ids.push(id);
  return id;
}

afterEach(async () => {
  for (const id of ids.splice(0)) {
    const p = join(resolve('./data/chats'), `${id}.json`);
    if (existsSync(p)) await rm(p, { force: true });
  }
});

describe('mutateChat', () => {
  it('并发调用严格串行：每次都读到上一次的结果，不丢更新', async () => {
    const id = newId();
    // 20 个并发自增。若不串行（各自 load 到同一旧值再覆盖写），计数会小于 20
    await Promise.all(
      Array.from({ length: 20 }, () =>
        mutateChat(id, (c) => {
          const n = (c as unknown as { n?: number }).n ?? 0;
          (c as unknown as { n?: number }).n = n + 1;
        }),
      ),
    );
    const after = (await loadChat(id)) as unknown as { n?: number };
    expect(after.n).toBe(20);
  });

  it('mutator 抛错：错误抛给调用方、不落盘、不卡住后续排队者', async () => {
    const id = newId();
    await mutateChat(id, (c) => { (c as unknown as { v?: string }).v = 'first'; });
    const boom = mutateChat(id, (c) => {
      (c as unknown as { v?: string }).v = 'should-not-persist';
      throw new Error('boom');
    });
    const next = mutateChat(id, (c) => { (c as unknown as { v?: string }).v = 'second'; });
    await expect(boom).rejects.toThrow('boom');
    await expect(next).resolves.toBeUndefined();
    const after = (await loadChat(id)) as unknown as { v?: string };
    expect(after.v).toBe('second');
  });

  it('返回 mutator 的返回值（取件模式：读到旧值同时清空）', async () => {
    const id = newId();
    await mutateChat(id, (c) => { c.askHeld = { text: 'held', at: Date.now(), messageId: 'om_x', tty: '/dev/ttysTEST', armAt: 1 }; });
    const taken = await mutateChat(id, (c) => {
      const h = c.askHeld;
      if (h) delete c.askHeld;
      return h;
    });
    expect(taken?.text).toBe('held');
    expect((await loadChat(id)).askHeld).toBeUndefined();
    // 再取一次 → 已被清空，拿不到（并发下只有一方能取到，正是防重复补发的依据）
    expect(await mutateChat(id, (c) => c.askHeld)).toBeUndefined();
  });
});
