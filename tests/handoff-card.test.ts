import { describe, expect, it } from 'vitest';
import { handoffTaskCard } from '../packages/im-lark/src/lark/cards.js';
import type { HandoffStatus, HandoffTask } from '../packages/orchestrator/src/handoff/types.js';

function mk(role: 'requester' | 'assignee', status: HandoffStatus, over: Partial<HandoffTask> = {}): HandoffTask {
  return {
    id: 'task-abcdef12',
    role,
    self: 'me@x.com',
    peer: 'bob@x.com',
    title: '报错求助',
    attachments: [],
    status,
    statusHistory: [{ status: 'sent', at: 1, by: 'me@x.com' }],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buttons(card: any): Array<{ content: string; status: string }> {
  const out: Array<{ content: string; status: string }> = [];
  for (const el of card.elements) {
    if (el.tag === 'action') {
      for (const b of el.actions) out.push({ content: b.text.content, status: b.value.status });
    }
  }
  return out;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function allText(card: any): string {
  return JSON.stringify(card);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function larkMdContents(card: any): string[] {
  const md: string[] = [];
  const walk = (o: any): void => {
    if (o && typeof o === 'object') {
      if (o.tag === 'lark_md' && typeof o.content === 'string') md.push(o.content);
      for (const v of Object.values(o)) walk(v);
    }
  };
  walk(card);
  return md;
}

describe('handoffTaskCard · 按钮随角色+状态', () => {
  it('assignee sent → 接收/拒绝，header yellow', () => {
    const c = handoffTaskCard(mk('assignee', 'sent')) as any;
    expect(c.header.template).toBe('yellow');
    expect(buttons(c).map((b) => b.status).sort()).toEqual(['accepted', 'declined']);
  });
  it('assignee accepted → 开始/完成/拒绝', () => {
    const c = handoffTaskCard(mk('assignee', 'accepted'));
    expect(buttons(c).map((b) => b.status).sort()).toEqual(['declined', 'done', 'in_progress']);
  });
  it('assignee in_progress → 只剩完成', () => {
    const c = handoffTaskCard(mk('assignee', 'in_progress'));
    expect(buttons(c).map((b) => b.status)).toEqual(['done']);
  });
  it('requester 非终态 → 撤回', () => {
    const c = handoffTaskCard(mk('requester', 'sent')) as any;
    expect(c.header.template).toBe('blue');
    expect(buttons(c).map((b) => b.status)).toEqual(['canceled']);
  });
  it('终态 → 无按钮', () => {
    expect(buttons(handoffTaskCard(mk('assignee', 'done')))).toEqual([]);
    expect(buttons(handoffTaskCard(mk('requester', 'canceled')))).toEqual([]);
    expect((handoffTaskCard(mk('assignee', 'done')) as any).header.template).toBe('green');
    expect((handoffTaskCard(mk('assignee', 'declined')) as any).header.template).toBe('grey');
  });
  it('update_multi 必开（多次 patch 才生效）', () => {
    expect((handoffTaskCard(mk('assignee', 'sent')) as any).config.update_multi).toBe(true);
  });
});

describe('handoffTaskCard · 对端可控内容不进 lark_md（防注入）', () => {
  it('恶意 title/summary 不出现在任何 lark_md 元素里', () => {
    const evil = '[点我](https://evil.example/login)';
    const c = handoffTaskCard(
      mk('assignee', 'sent', { title: evil, summaryMd: `问题：${evil}`, peer: evil }),
    );
    // 内容确实进了卡（在 plain_text 里），但绝不在 lark_md 里
    expect(allText(c)).toContain('evil.example');
    for (const md of larkMdContents(c)) {
      expect(md).not.toContain('evil.example');
    }
  });
});
