import { describe, it, expect } from 'vitest';
import { tapdRepoPickerCard, tapdAddPathCard, escapeLarkMd } from '../packages/im-lark/src/lark/cards.js';

// tapdRepoPickerCard 返回 { config, header, elements }。repo 多选卡按钮很多（repo toggle
// + 翻页 + 类型/基准/模式 + 开工/取消），下面 helper 按 value.action 把 repo toggle 按钮
// 单独挑出来验分页；另抽 select 选项、翻页按钮、说明文案。
/* eslint-disable @typescript-eslint/no-explicit-any */
function allActions(card: any): any[] {
  return (card.elements as any[])
    .filter((e) => e?.tag === 'action')
    .flatMap((e) => e.actions as any[]);
}
function repoButtons(card: any): any[] {
  return allActions(card).filter((a) => a?.tag === 'button' && a?.value?.action === 'tapd-pick-repo');
}
function repoCwds(card: any): string[] {
  return repoButtons(card).map((b) => b.value.cwd as string);
}
function selectOptions(card: any): any[] | null {
  const s = allActions(card).find((a) => a?.tag === 'select_static' && a?.value?.action === 'tapd-repo-select');
  return s ? (s.options as any[]) : null;
}
function navTexts(card: any): string[] {
  return allActions(card)
    .filter((a) => a?.tag === 'button' && a?.value?.action === 'tapd-repo-page')
    .map((a) => a.text.content as string);
}
function textOf(card: any): string {
  return (card.elements as any[])
    .filter((e) => e?.tag === 'div')
    .map((e) => e.text.content as string)
    .join('\n');
}

function mkCandidates(n: number): { path: string; label: string }[] {
  return Array.from({ length: n }, (_, i) => ({ path: `/home/u/repo${i}`, label: `repo${i}` }));
}
const HOME = '/home/u';
const baseClaim = { id: '123456', branch: 'fix_123456', title: 't', system: 'bug', selectedRepos: [] as string[] };

describe('tapdRepoPickerCard 分页（不再截断前 10 个）', () => {
  it('15 个 repo 第 0 页：显示 9 个（PAGE_SIZE），有「下一页」无「上一页」，页码 1/2', () => {
    const card = tapdRepoPickerCard(baseClaim, mkCandidates(15), HOME);
    expect(repoButtons(card)).toHaveLength(9);
    expect(navTexts(card)).toContain('下一页 ▶');
    expect(navTexts(card)).not.toContain('◀ 上一页');
    expect(textOf(card)).toContain('repo 15 个 · 第 1/2 页');
  });

  it('15 个 repo 第 1 页(末页)：剩 6 个，有「上一页」无「下一页」', () => {
    const card = tapdRepoPickerCard({ ...baseClaim, pickPage: 1 }, mkCandidates(15), HOME);
    expect(repoButtons(card)).toHaveLength(6);
    expect(navTexts(card)).toContain('◀ 上一页');
    expect(navTexts(card)).not.toContain('下一页 ▶');
    expect(textOf(card)).toContain('第 2/2 页');
  });

  it('翻页后两页并起来能覆盖全部 15 个 repo（关键：第 11 个及以后不再丢）', () => {
    const p0 = repoCwds(tapdRepoPickerCard({ ...baseClaim, pickPage: 0 }, mkCandidates(15), HOME));
    const p1 = repoCwds(tapdRepoPickerCard({ ...baseClaim, pickPage: 1 }, mkCandidates(15), HOME));
    const union = new Set([...p0, ...p1]);
    expect(union.size).toBe(15);
    expect(union.has('/home/u/repo10')).toBe(true); // 旧实现 slice(0,10) 选不到的
    expect(union.has('/home/u/repo14')).toBe(true);
  });

  it('越界 page（过大）夹到末页；负数夹到第 0 页', () => {
    const over = tapdRepoPickerCard({ ...baseClaim, pickPage: 99 }, mkCandidates(15), HOME);
    expect(repoButtons(over)).toHaveLength(6);
    expect(textOf(over)).toContain('第 2/2 页');
    const neg = tapdRepoPickerCard({ ...baseClaim, pickPage: -5 }, mkCandidates(15), HOME);
    expect(repoButtons(neg)).toHaveLength(9);
    expect(textOf(neg)).toContain('第 1/2 页');
  });

  it('9 个以内：单页列全，无翻页按钮、无页码', () => {
    const card = tapdRepoPickerCard(baseClaim, mkCandidates(9), HOME);
    expect(repoButtons(card)).toHaveLength(9);
    expect(navTexts(card)).toHaveLength(0);
    expect(textOf(card)).toContain('repo 9 个');
    expect(textOf(card)).not.toContain('页');
  });

  it('翻页按钮 value 带 action:tapd-repo-page + id + 目标 page', () => {
    const card = tapdRepoPickerCard({ ...baseClaim, pickPage: 1 }, mkCandidates(30), HOME);
    const next = allActions(card).find((a) => a?.text?.content === '下一页 ▶');
    const prev = allActions(card).find((a) => a?.text?.content === '◀ 上一页');
    expect(next.value).toEqual({ action: 'tapd-repo-page', id: '123456', page: 2 });
    expect(prev.value).toEqual({ action: 'tapd-repo-page', id: '123456', page: 0 });
  });
});

describe('tapdRepoPickerCard 搜索 select + 手输 + 说明（B/D）', () => {
  it('搜索 select 列出全部候选（≤50），option value 为 pick|<path>', () => {
    const card = tapdRepoPickerCard(baseClaim, mkCandidates(15), HOME);
    const opts = selectOptions(card);
    expect(opts).toHaveLength(15);
    expect(opts![0].value).toBe('pick|/home/u/repo0');
  });

  it('候选超 50 个：select 只列前 50（翻页按钮兜底其余）', () => {
    const card = tapdRepoPickerCard(baseClaim, mkCandidates(60), HOME);
    expect(selectOptions(card)).toHaveLength(50);
  });

  it('候选为空：不渲染 select，提示用「手输路径」', () => {
    const card = tapdRepoPickerCard(baseClaim, [], HOME);
    expect(selectOptions(card)).toBeNull();
    expect(textOf(card)).toContain('没扫到 repo');
  });

  it('始终有「➕ 手输路径」按钮，value.action = tapd-repo-addpath', () => {
    const card = tapdRepoPickerCard(baseClaim, [], HOME);
    const btn = allActions(card).find((a) => a?.value?.action === 'tapd-repo-addpath');
    expect(btn).toBeTruthy();
    expect(btn.value.id).toBe('123456');
  });

  it('带三组开关的中文说明（消除「看不懂」）', () => {
    const t = textOf(tapdRepoPickerCard(baseClaim, mkCandidates(3), HOME));
    expect(t).toContain('🏷 **类型**');
    expect(t).toContain('🔁 **基准**');
    expect(t).toContain('🧩 **模式**');
  });

  it('多选交互卡带 update_multi:true（否则第二次 patch 视觉不刷新）', () => {
    const card = tapdRepoPickerCard(baseClaim, mkCandidates(3), HOME) as any;
    expect(card.config.update_multi).toBe(true);
  });

  it('已勾选的 repo 渲染成 primary + ✅', () => {
    const card = tapdRepoPickerCard({ ...baseClaim, selectedRepos: ['/home/u/repo1'] }, mkCandidates(3), HOME);
    const b = repoButtons(card).find((x) => x.value.cwd === '/home/u/repo1');
    expect(b.type).toBe('primary');
    expect(b.text.content).toContain('✅');
  });
});

describe('escapeLarkMd（用户可控串拼进 lark_md 前转义，防卡片格式/链接注入）', () => {
  it('转义反引号 / 方括号 / 反斜杠 / 尖括号', () => {
    expect(escapeLarkMd('a`b')).toBe('a\\`b');
    expect(escapeLarkMd('[x](http://e.vil)')).toBe('\\[x\\](http://e.vil)');
    expect(escapeLarkMd('a<b')).toBe('a&lt;b');
    expect(escapeLarkMd('a\\b')).toBe('a\\\\b');
  });
  it('普通路径不受影响', () => {
    expect(escapeLarkMd('/Users/u/code/proj')).toBe('/Users/u/code/proj');
  });
});

describe('picker 已选 repo 回显做转义（手输路径可能带 markdown 元字符）', () => {
  it('selectedRepos 里的反引号/方括号在卡片文案里被转义', () => {
    const evil = '/home/u/a`b[c](http://e.vil)';
    const card = tapdRepoPickerCard({ ...baseClaim, selectedRepos: [evil] }, mkCandidates(1), HOME);
    const t = textOf(card);
    expect(t).not.toContain('a`b'); // 未转义的裸反引号不应出现
    expect(t).toContain('\\`');     // 已转义
    expect(t).toContain('\\[');
  });
});

describe('tapdAddPathCard（手输路径表单卡）', () => {
  it('schema 2.0，含 path 输入 + 提交按钮回调 tapd-repo-addpath-submit 带 id', () => {
    const card = tapdAddPathCard('987654') as any;
    expect(card.schema).toBe('2.0');
    const form = card.body.elements.find((e: any) => e.tag === 'form');
    const input = form.elements.find((e: any) => e.tag === 'input');
    const submit = form.elements.find((e: any) => e.tag === 'button');
    expect(input.name).toBe('path');
    expect(submit.form_action_type).toBe('submit');
    expect(submit.behaviors[0].value).toEqual({ action: 'tapd-repo-addpath-submit', id: '987654' });
  });
});
