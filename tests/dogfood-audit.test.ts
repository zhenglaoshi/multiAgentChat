import { describe, it, expect } from 'vitest';
import { extractJsonArray, coerceFindings } from '../packages/orchestrator/src/dogfood/audit.js';

describe('extractJsonArray — 从 claude -p 输出提 JSON 数组', () => {
  it('提出被文字包裹的数组', () => {
    const s = '这是分析结果:\n[{"title":"a"},{"title":"b"}]\n完成。';
    expect(extractJsonArray(s)).toEqual([{ title: 'a' }, { title: 'b' }]);
  });
  it('处理字符串里的 ] 不误判', () => {
    const s = '[{"title":"含]右括号","detail":"x"}]';
    expect(extractJsonArray(s)).toEqual([{ title: '含]右括号', detail: 'x' }]);
  });
  it('无数组 / 非法 → null', () => {
    expect(extractJsonArray('没有数组')).toBeNull();
    expect(extractJsonArray('[不是合法json')).toBeNull();
  });
});

describe('coerceFindings — 规整/兜底', () => {
  it('缺 title 丢弃;severity 非法归 medium;category 缺省 improve', () => {
    const out = coerceFindings([
      { severity: 'high', category: 'error', title: 'A', detail: 'd' },
      { severity: 'wat', title: 'B' }, // 非法 severity → medium; 无 category → improve
      { detail: 'no title' }, // 丢弃
      'garbage', // 丢弃
    ]);
    expect(out).toEqual([
      { severity: 'high', category: 'error', title: 'A', detail: 'd' },
      { severity: 'medium', category: 'improve', title: 'B' },
    ]);
  });
});
