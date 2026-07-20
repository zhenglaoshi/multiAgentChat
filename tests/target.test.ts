import { describe, it, expect } from 'vitest';
import { resolveTarget, parseMessage } from '../packages/im-lark/src/lark/target.js';
import type { TerminalTab } from '../packages/host-mac/src/terminal/types.js';

function tab(partial: Partial<TerminalTab>): TerminalTab {
  return {
    tty: '/dev/ttys000',
    cwd: '/Users/me/proj',
    title: '',
    processes: ['-zsh'],
    busy: false,
    windowId: 1,
    windowFrontmost: false,
    hasTUI: false,
    ...partial,
  } as TerminalTab;
}

describe('resolveTarget', () => {
  const tabs = [
    tab({ tty: '/dev/ttys003', cwd: '/Users/me/pigeon', title: '飞鸽任务' }),
    tab({ tty: '/dev/ttys004', cwd: '/Users/me/raven2', title: '' }),
  ];

  it('完整 /dev tty', () => {
    expect(resolveTarget(tabs, '/dev/ttys003')?.matchType).toBe('tty');
  });
  it('短 tty', () => {
    const r = resolveTarget(tabs, 'ttys004');
    expect(r?.matchType).toBe('short-tty');
    expect(r?.tab.tty).toBe('/dev/ttys004');
  });
  it('title 精确（不分大小写）', () => {
    expect(resolveTarget(tabs, '飞鸽任务')?.matchType).toBe('title-exact');
  });
  it('cwd basename 精确', () => {
    const r = resolveTarget(tabs, 'raven2');
    expect(r?.matchType).toBe('cwd-basename-exact');
    expect(r?.tab.tty).toBe('/dev/ttys004');
  });
  it('cwd 子串 fuzzy', () => {
    expect(resolveTarget(tabs, 'pige')?.matchType).toBe('cwd-fuzzy');
  });
  it('无匹配返回 undefined', () => {
    expect(resolveTarget(tabs, 'nonexistent')).toBeUndefined();
    expect(resolveTarget(tabs, '  ')).toBeUndefined();
  });
});

describe('parseMessage', () => {
  it('单 @target', () => {
    const r = parseMessage('@ttys003 npm test');
    expect(r.targeted).toEqual([{ target: 'ttys003', text: 'npm test' }]);
    expect(r.fallback).toBeUndefined();
  });

  it('无 @ → fallback', () => {
    const r = parseMessage('hello world');
    expect(r.targeted).toHaveLength(0);
    expect(r.fallback).toBe('hello world');
  });

  it('多 @target → batch', () => {
    const r = parseMessage('@a build\n@b test');
    expect(r.targeted).toEqual([
      { target: 'a', text: 'build' },
      { target: 'b', text: 'test' },
    ]);
  });

  it('单行 >> → chain', () => {
    const r = parseMessage('@a X >> @b Y >> @c Z');
    expect(r.chain).toEqual([
      { target: 'a', prompt: 'X' },
      { target: 'b', prompt: 'Y' },
      { target: 'c', prompt: 'Z' },
    ]);
  });

  it('多行含 >> → warning（不当 chain）', () => {
    const r = parseMessage('@a X >> @b Y\n@c Z');
    expect(r.warning).toBeTruthy();
    expect(r.chain).toBeUndefined();
  });

  it('chain 段缺 @前缀 → warning', () => {
    const r = parseMessage('@a X >> plain text no target');
    expect(r.warning).toBeTruthy();
  });

  it('@行后续非@行归入该 target（多行命令）', () => {
    const r = parseMessage('@a line1\nline2');
    expect(r.targeted).toHaveLength(1);
    expect(r.targeted[0]!.text).toBe('line1\nline2');
  });
});
