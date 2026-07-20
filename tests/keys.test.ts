import { describe, it, expect } from 'vitest';
import { parseKeySequence, tokenizeKeys } from '../packages/host-mac/src/terminal/keys.js';

describe('parseKeySequence', () => {
  it('ctrl+c → keystroke c + control down', () => {
    expect(parseKeySequence('ctrl+c')).toEqual([
      { kind: 'keystroke', text: 'c', mods: ['control down'] },
    ]);
  });

  it('命名方向键 → key code', () => {
    expect(parseKeySequence('down')).toEqual([{ kind: 'key', keyCode: 125, mods: [] }]);
    expect(parseKeySequence('⏎')).toEqual([{ kind: 'key', keyCode: 36, mods: [] }]);
    expect(parseKeySequence('esc')).toEqual([{ kind: 'key', keyCode: 53, mods: [] }]);
  });

  it('cmd+enter → key 36 + command down', () => {
    expect(parseKeySequence('cmd+enter')).toEqual([{ kind: 'key', keyCode: 36, mods: ['command down'] }]);
  });

  it('d*3 展开成三次', () => {
    const steps = parseKeySequence('d*3');
    expect(steps).toHaveLength(3);
    expect(steps.every((s) => s.kind === 'key' && s.keyCode === 125)).toBe(true);
  });

  it('3xd 展开成三次', () => {
    expect(parseKeySequence('3xd')).toHaveLength(3);
  });

  it('连体别名 ddd 展开成三次', () => {
    expect(parseKeySequence('ddd')).toHaveLength(3);
  });

  it('引号包裹当打字', () => {
    expect(parseKeySequence("'hi there'")).toEqual([
      { kind: 'keystroke', text: 'hi there', mods: [] },
    ]);
  });

  it('多 token 组合序列', () => {
    const steps = parseKeySequence('2d . ⏎');
    // 2d → 不是重复(需 2xd/d*2)，'2d' 作为一个 keystroke token
    expect(steps.length).toBeGreaterThanOrEqual(3);
  });

  it('未知修饰键抛错', () => {
    expect(() => parseKeySequence('bogus+c')).toThrow();
  });
});

describe('tokenizeKeys', () => {
  it('保留引号内空格为单 token', () => {
    expect(tokenizeKeys("2d . 'hello world' ⏎")).toEqual(['2d', '.', "'hello world'", '⏎']);
  });

  it('引号未闭合抛错', () => {
    expect(() => tokenizeKeys("'unclosed")).toThrow();
  });
});
