import { afterEach, describe, expect, it } from 'vitest';
import { TabWatcher } from '../packages/im-lark/src/monitor/watcher.js';
import type { TerminalTab } from '../packages/host-api/src/types.js';
import { setHost, type HostController } from '../packages/host-api/src/index.js';
import { resetHostForTests } from '../packages/host-api/src/testing.js';

// 只测「本 tick 要读哪些 tab 的 history」的选择逻辑：无 pending 的 agent tab 降频 + 摊匀，
// 裸 shell busy 每 tick 读，keepHot 的 tty 每 tick 读。
function tab(tty: string, processes: string[], busy = true): TerminalTab {
  return { tty, windowId: 1, windowFrontmost: false, tabIndex: 1, title: '', busy, processes, hasTUI: false };
}

type Internals = {
  cachedTabs: TerminalTab[];
  histFetchedAt: Map<string, number>;
  pickHistoryTtys(): string[];
};

function make(tabs: TerminalTab[]): Internals {
  const w = new TabWatcher({ pollMs: 3000 }) as unknown as Internals;
  w.cachedTabs = tabs;
  return w;
}

describe('TabWatcher.pickHistoryTtys', () => {
  it('busy 裸 shell 每 tick 读，idle tab 不读', () => {
    const w = make([tab('/dev/ttys001', ['login', '-zsh', 'npm']), tab('/dev/ttys002', ['login', '-zsh'], false)]);
    expect(w.pickHistoryTtys()).toEqual(['/dev/ttys001']);
  });

  it('agent tab 刚读过就不读；到期的按最久没读优先、每 tick 有份额上限', () => {
    const now = Date.now();
    const tabs = Array.from({ length: 10 }, (_, i) => tab(`/dev/ttys0${10 + i}`, ['login', '-zsh', 'claude']));
    const w = make(tabs);
    tabs.forEach((t, i) => w.histFetchedAt.set(t.tty, now - 60_000 + i)); // 全部到期，ttys010 最旧
    const picked = w.pickHistoryTtys();
    // 10 个 × 3000ms / 15000ms = 2
    expect(picked).toEqual(['/dev/ttys010', '/dev/ttys011']);

    w.histFetchedAt.set('/dev/ttys010', now);
    w.histFetchedAt.set('/dev/ttys011', now);
    expect(w.pickHistoryTtys()).toEqual(['/dev/ttys012', '/dev/ttys013']);
  });

  it('keepHot 的 agent tab 即使刚读过也每 tick 读', () => {
    const w = new TabWatcher({ pollMs: 3000 });
    const i = w as unknown as Internals;
    i.cachedTabs = [tab('/dev/ttys020', ['login', '-zsh', 'claude'])];
    i.histFetchedAt.set('/dev/ttys020', Date.now());
    expect(i.pickHistoryTtys()).toEqual([]);
    w.keepHot('/dev/ttys020', 10_000);
    expect(i.pickHistoryTtys()).toEqual(['/dev/ttys020']);
  });
});

describe('TabWatcher 降频状态清理', () => {
  afterEach(() => resetHostForTests());

  it('agent tab 关掉后 histFetchedAt / hotUntil 被清（tty 复用时新 tab 不继承旧时间戳）', async () => {
    let tabs = [tab('/dev/ttys030', ['login', '-zsh', 'claude'])];
    setHost({
      snapshotTabs: async (opts?: { historyTtys?: string[] }) => ({
        tabs,
        histories: new Map((opts?.historyTtys ?? []).map((t) => [t, 'x\n'])),
      }),
      getCwd: async () => undefined,
    } as unknown as HostController);
    const w = new TabWatcher({ pollMs: 3000 });
    const i = w as unknown as Internals & { tick(): Promise<void>; hotUntil: Map<string, number> };
    await i.tick(); // 第一拍：cachedTabs 为空，不读
    w.keepHot('/dev/ttys030', 10_000);
    await i.tick(); // 第二拍：读到 → 记时间戳
    expect(i.histFetchedAt.has('/dev/ttys030')).toBe(true);
    tabs = [];
    await i.tick();
    expect(i.histFetchedAt.has('/dev/ttys030')).toBe(false);
    expect(i.hotUntil.has('/dev/ttys030')).toBe(false);
  });
});
