import { describe, it, expect } from 'vitest';
import { tokenizeRag, rankBm25, type Scorable } from '../packages/orchestrator/src/memory/rag.js';

describe('tokenizeRag', () => {
  it('英文/数字按词(≥2字符)', () => {
    expect(tokenizeRag('Fix the API bug v2')).toEqual(['fix', 'the', 'api', 'bug', 'v2']);
    expect(tokenizeRag('a b')).toEqual([]); // 单字符英文丢弃
  });
  it('中文按 bigram(连续汉字生成重叠二元组)', () => {
    expect(tokenizeRag('数据库')).toEqual(['数据', '据库']);
    expect(tokenizeRag('修复登录')).toEqual(['修复', '复登', '登录']);
    expect(tokenizeRag('好')).toEqual(['好']); // 单字保留
  });
  it('中英混合(英文先,单汉字保留)', () => {
    expect(tokenizeRag('修 API')).toEqual(['api', '修']);
  });
});

describe('rankBm25', () => {
  const now = 1_000_000_000_000;
  const docs: Scorable[] = [
    { id: 'a', tokens: tokenizeRag('修复数据库连接超时'), at: now },
    { id: 'b', tokens: tokenizeRag('新增飞书卡片交互'), at: now },
    { id: 'c', tokens: tokenizeRag('数据库索引优化 慢查询'), at: now },
  ];
  it('查询命中的文档排前，无关的不返回', () => {
    const r = rankBm25(docs, tokenizeRag('数据库慢'), { now });
    const ids = r.map((x) => x.id);
    expect(ids).toContain('a');
    expect(ids).toContain('c');
    expect(ids).not.toContain('b'); // 飞书卡片跟"数据库慢"无关
  });
  it('空查询 / 空语料 → 空', () => {
    expect(rankBm25(docs, [], { now })).toEqual([]);
    expect(rankBm25([], tokenizeRag('数据库'), { now })).toEqual([]);
  });
  it('cwd 精确匹配加权(同查询下同 repo 排更前)', () => {
    const d2: Scorable[] = [
      { id: 'x', tokens: tokenizeRag('数据库优化'), at: now, cwd: '/p/other' },
      { id: 'y', tokens: tokenizeRag('数据库优化'), at: now, cwd: '/p/mine' },
    ];
    const r = rankBm25(d2, tokenizeRag('数据库'), { now, cwd: '/p/mine' });
    expect(r[0]!.id).toBe('y'); // 同 cwd 的排第一
  });
  it('时间衰减(越旧分越低)', () => {
    const old = now - 80 * 86_400_000;
    const d3: Scorable[] = [
      { id: 'new', tokens: tokenizeRag('数据库优化'), at: now },
      { id: 'old', tokens: tokenizeRag('数据库优化'), at: old },
    ];
    const r = rankBm25(d3, tokenizeRag('数据库'), { now });
    expect(r[0]!.id).toBe('new');
    expect(r.find((x) => x.id === 'new')!.score).toBeGreaterThan(r.find((x) => x.id === 'old')!.score);
  });
});
