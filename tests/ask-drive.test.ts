import { describe, it, expect } from 'vitest';
import { buildDownEnterSeq, resolveAskAnswerIndex } from '../packages/im-lark/src/lark/ask-drive.js';
import { parseKeySequence } from '../packages/host-mac/src/terminal/keys.js';

describe('buildDownEnterSeq', () => {
  it('index 0 → 只回车（选默认高亮第一项）', () => {
    expect(buildDownEnterSeq(0)).toEqual(['enter']);
  });
  it('index N → N 次 down + 回车', () => {
    expect(buildDownEnterSeq(1)).toEqual(['down', 'enter']);
    expect(buildDownEnterSeq(3)).toEqual(['down', 'down', 'down', 'enter']);
  });
  it('序列经 parseKeySequence → key code 125(↓)×N + 36(⏎)', () => {
    // 这条把"纯逻辑产出的 token"接到真正发键的解析器上，验证端到端选项 2（index 1）
    const steps = parseKeySequence(buildDownEnterSeq(1).join(' '));
    expect(steps).toEqual([
      { kind: 'key', keyCode: 125, mods: [] },
      { kind: 'key', keyCode: 36, mods: [] },
    ]);
  });
});

describe('resolveAskAnswerIndex', () => {
  const opts = ['保守方案', '激进方案', '混合方案'];

  it('裸数字 1-based → 0-based index', () => {
    expect(resolveAskAnswerIndex('1', opts)).toBe(0);
    expect(resolveAskAnswerIndex('2', opts)).toBe(1);
    expect(resolveAskAnswerIndex(' 3 ', opts)).toBe(2);
  });
  it('越界数字 / 0 → -1', () => {
    expect(resolveAskAnswerIndex('0', opts)).toBe(-1);
    expect(resolveAskAnswerIndex('4', opts)).toBe(-1);
  });
  it('选项原文精确匹配（忽略大小写/空格）', () => {
    expect(resolveAskAnswerIndex('激进方案', opts)).toBe(1);
    expect(resolveAskAnswerIndex('  混合方案 ', opts)).toBe(2);
    expect(resolveAskAnswerIndex('Yes', ['yes', 'no'])).toBe(0);
  });
  it('唯一前缀/包含匹配', () => {
    expect(resolveAskAnswerIndex('激进', opts)).toBe(1);
    expect(resolveAskAnswerIndex('保', opts)).toBe(0);
  });
  it('歧义（多个含子串）→ -1（不猜）', () => {
    expect(resolveAskAnswerIndex('方案', opts)).toBe(-1);
  });
  it('空串 / 空选项 / 认不出的自由文本 → -1（不劫持）', () => {
    expect(resolveAskAnswerIndex('', opts)).toBe(-1);
    expect(resolveAskAnswerIndex('2', [])).toBe(-1);
    expect(resolveAskAnswerIndex('改主意了帮我看下别的', opts)).toBe(-1);
  });
});
