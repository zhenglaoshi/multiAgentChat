import { describe, it, expect } from 'vitest';
import {
  classifyNotificationsPure,
  type SeenMap,
} from '../packages/orchestrator/src/tapd/store.js';
import type { TapdItem } from '../packages/orchestrator/src/tapd/types.js';

// TAPD 通知分级：首次=认领卡(claim)、状态变=status、其它内容变=update、没变/ignored/snooze 未到点=不发。
// classifyNotificationsPure 是纯函数（无 I/O），这里覆盖各分支。

function item(over: Partial<TapdItem> = {}): TapdItem {
  return {
    id: '1001',
    system: 'bug',
    workspaceId: 42,
    title: 't',
    status: 'in_progress',
    url: 'https://tapd/1001',
    branch: 'fix_001001',
    modified: '2026-08-05 10:00:00',
    ...over,
  };
}

const NOW = 1_000_000;

describe('classifyNotificationsPure', () => {
  it('没见过 → claim（首次=被指派）', () => {
    const out = classifyNotificationsPure([item()], {}, NOW);
    expect(out).toEqual([{ item: item(), kind: 'claim' }]);
  });

  it('见过、modified 没变 → 不发', () => {
    const seen: SeenMap = { '1001': { modified: '2026-08-05 10:00:00', status: 'in_progress', notifiedAt: 0 } };
    expect(classifyNotificationsPure([item()], seen, NOW)).toEqual([]);
  });

  it('见过、modified 变了、状态也变了 → status（带旧状态英文+中文）', () => {
    const seen: SeenMap = {
      '1001': { modified: '2026-08-04 09:00:00', status: 'new', statusLabel: '新', notifiedAt: 0 },
    };
    const it = item({ modified: '2026-08-05 10:00:00', status: 'in_progress', statusLabel: '处理中' });
    const out = classifyNotificationsPure([it], seen, NOW);
    expect(out).toEqual([{ item: it, kind: 'status', prevStatus: 'new', prevStatusLabel: '新' }]);
  });

  it('旧记录没存 statusLabel → status 不带 prevStatusLabel（回退英文 key）', () => {
    const seen: SeenMap = { '1001': { modified: '2026-08-04 09:00:00', status: 'new', notifiedAt: 0 } };
    const it = item({ status: 'in_progress' });
    const out = classifyNotificationsPure([it], seen, NOW);
    expect(out).toEqual([{ item: it, kind: 'status', prevStatus: 'new' }]);
    expect(out[0]).not.toHaveProperty('prevStatusLabel');
  });

  it('见过、modified 变了、状态没变 → update（内容改动）', () => {
    const seen: SeenMap = {
      '1001': { modified: '2026-08-04 09:00:00', status: 'in_progress', notifiedAt: 0 },
    };
    const it = item({ modified: '2026-08-05 10:00:00', status: 'in_progress' });
    expect(classifyNotificationsPure([it], seen, NOW)).toEqual([{ item: it, kind: 'update' }]);
  });

  it('ignored（不是我的）→ 永久不发', () => {
    const seen: SeenMap = { '1001': { status: 'new', notifiedAt: 0, ignored: true } };
    expect(classifyNotificationsPure([item()], seen, NOW)).toEqual([]);
  });

  it('snooze 未到点 → 不发', () => {
    const seen: SeenMap = { '1001': { status: 'new', notifiedAt: 0, snoozeUntil: NOW + 1000 } };
    expect(classifyNotificationsPure([item()], seen, NOW)).toEqual([]);
  });

  it('snooze 到点 → 重发认领卡（claim）', () => {
    const seen: SeenMap = { '1001': { status: 'new', notifiedAt: 0, snoozeUntil: NOW - 1 } };
    expect(classifyNotificationsPure([item()], seen, NOW)).toEqual([{ item: item(), kind: 'claim' }]);
  });

  it('旧记录无 status（如 snooze/ignored 生成的最简记录或历史数据）+ modified 变 → 退化为 update', () => {
    const seen: SeenMap = { '1001': { modified: '2026-08-04 09:00:00', notifiedAt: 0 } };
    const it = item({ modified: '2026-08-05 10:00:00', status: 'in_progress' });
    expect(classifyNotificationsPure([it], seen, NOW)).toEqual([{ item: it, kind: 'update' }]);
  });

  it('本轮 item 无 modified → 不发（避免无 modified 误刷）', () => {
    const seen: SeenMap = { '1001': { modified: '2026-08-04', status: 'in_progress', notifiedAt: 0 } };
    const it = item({ modified: undefined });
    expect(classifyNotificationsPure([it], seen, NOW)).toEqual([]);
  });
});
