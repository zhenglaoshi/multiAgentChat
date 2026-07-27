import { describe, it, expect } from 'vitest';
import { browseCard, type BrowseCardEntry } from '../packages/im-lark/src/lark/cards.js';

// browseCard 返回 { config, header, elements }；下面几个 helper 从 elements 里抽出
// select_static 的选项、按钮文案、头部计数行，用来验证分页边界。
/* eslint-disable @typescript-eslint/no-explicit-any */
function allActions(card: any): any[] {
  return (card.elements as any[])
    .filter((e) => e?.tag === 'action')
    .flatMap((e) => e.actions as any[]);
}
function selectOptions(card: any): any[] | null {
  const s = allActions(card).find((a) => a?.tag === 'select_static');
  return s ? (s.options as any[]) : null;
}
function buttonTexts(card: any): string[] {
  return allActions(card)
    .filter((a) => a?.tag === 'button')
    .map((a) => a.text.content as string);
}
function headerLine(card: any): string {
  return (card.elements as any[])[0].text.content as string;
}

function mkdirs(n: number): BrowseCardEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    path: `/home/u/d${i}`,
    name: `dir${i}`,
    isGitRepo: false,
  }));
}
const HOME = '/home/u';

describe('browseCard 分页', () => {
  it('空目录：不渲染 select，文案提示无子文件夹', () => {
    const card = browseCard({ currentCwd: '/home/u/empty', subdirs: [], home: HOME });
    expect(selectOptions(card)).toBeNull();
    expect(headerLine(card)).toContain('这里没有子文件夹');
  });

  it('单页(<=25)：一页列全，无翻页按钮，无页码', () => {
    const card = browseCard({ currentCwd: '/home/u', subdirs: mkdirs(25), home: HOME });
    expect(selectOptions(card)).toHaveLength(25);
    expect(buttonTexts(card)).not.toContain('下一页 ▶');
    expect(buttonTexts(card)).not.toContain('◀ 上一页');
    expect(headerLine(card)).toContain('子文件夹 25 个');
    expect(headerLine(card)).not.toContain('页');
  });

  it('26 项第 0 页：25 个选项 + 只有「下一页」', () => {
    const card = browseCard({ currentCwd: '/home/u', subdirs: mkdirs(26), home: HOME, page: 0 });
    expect(selectOptions(card)).toHaveLength(25);
    expect(buttonTexts(card)).toContain('下一页 ▶');
    expect(buttonTexts(card)).not.toContain('◀ 上一页');
    expect(headerLine(card)).toContain('第 1/2 页');
  });

  it('26 项第 1 页(末页)：1 个选项 + 只有「上一页」', () => {
    const card = browseCard({ currentCwd: '/home/u', subdirs: mkdirs(26), home: HOME, page: 1 });
    expect(selectOptions(card)).toHaveLength(1);
    expect(buttonTexts(card)).toContain('◀ 上一页');
    expect(buttonTexts(card)).not.toContain('下一页 ▶');
    expect(headerLine(card)).toContain('第 2/2 页');
  });

  it('越界 page(过大)：夹到末页', () => {
    const card = browseCard({ currentCwd: '/home/u', subdirs: mkdirs(26), home: HOME, page: 99 });
    expect(selectOptions(card)).toHaveLength(1); // 末页只剩 1 个
    expect(headerLine(card)).toContain('第 2/2 页');
  });

  it('越界 page(负数)：夹到第 0 页', () => {
    const card = browseCard({ currentCwd: '/home/u', subdirs: mkdirs(26), home: HOME, page: -5 });
    expect(selectOptions(card)).toHaveLength(25);
    expect(headerLine(card)).toContain('第 1/2 页');
  });

  it('翻页按钮 value 带 action:browse-dir + cwd + 目标 page', () => {
    const card = browseCard({ currentCwd: '/home/u', subdirs: mkdirs(60), home: HOME, page: 1 });
    const next = allActions(card).find((a) => a?.text?.content === '下一页 ▶');
    const prev = allActions(card).find((a) => a?.text?.content === '◀ 上一页');
    expect(next.value).toEqual({ action: 'browse-dir', cwd: '/home/u', page: 2 });
    expect(prev.value).toEqual({ action: 'browse-dir', cwd: '/home/u', page: 0 });
  });
});
