import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeMdSentinels,
  hasClaudeMdBlock,
  applyClaudeMdBlock,
  stripClaudeMdBlock,
  removeClaudeMdBlockText,
  installClaudeMdBlock,
  removeClaudeMdBlock,
  claudeMdBlockPresent,
} from '../packages/orchestrator/src/integrations/claudemd.js';
import type { Integration } from '../packages/orchestrator/src/integrations/registry.js';

const RULE = '## 评审门\n\n改代码要过 review。';
const K = 'review-gate';

describe('claudeMdSentinels', () => {
  it('按 key 派生 start/end 标记', () => {
    expect(claudeMdSentinels(K)).toEqual({
      start: '<!-- mchat:review-gate:start -->',
      end: '<!-- mchat:review-gate:end -->',
    });
  });
});

describe('applyClaudeMdBlock — 写入(对接)', () => {
  it('空文本 → 单个规则块 + 末尾换行', () => {
    const out = applyClaudeMdBlock('', K, RULE);
    expect(out).toBe(`<!-- mchat:review-gate:start -->\n${RULE}\n<!-- mchat:review-gate:end -->\n`);
    expect(hasClaudeMdBlock(out, K)).toBe(true);
  });

  it('保留已有内容，块追加在后面（空行隔开）', () => {
    const out = applyClaudeMdBlock('# 全局约定\n', K, RULE);
    expect(out.startsWith('# 全局约定\n\n<!-- mchat:review-gate:start -->')).toBe(true);
    expect(hasClaudeMdBlock(out, K)).toBe(true);
  });

  it('幂等：重复写入不产生第二份块', () => {
    const once = applyClaudeMdBlock('# 头\n', K, RULE);
    const twice = applyClaudeMdBlock(once, K, RULE);
    expect(twice).toBe(once);
    const starts = twice.split(claudeMdSentinels(K).start).length - 1;
    expect(starts).toBe(1);
  });

  it('规则更新：内容变了会替换旧块而非叠加', () => {
    const v1 = applyClaudeMdBlock('# 头\n', K, '旧规则');
    const v2 = applyClaudeMdBlock(v1, K, '新规则');
    expect(v2).toContain('新规则');
    expect(v2).not.toContain('旧规则');
    expect(v2.split(claudeMdSentinels(K).start).length - 1).toBe(1);
  });

  it('空规则报错', () => {
    expect(() => applyClaudeMdBlock('', K, '   ')).toThrow();
  });
});

describe('stripClaudeMdBlock / removeClaudeMdBlockText — 删除(断开)', () => {
  it('往返：写入再删除还原到原文本', () => {
    const base = '# 全局约定\n\n其他规则。\n';
    const withBlock = applyClaudeMdBlock(base, K, RULE);
    const removed = removeClaudeMdBlockText(withBlock, K);
    expect(hasClaudeMdBlock(removed, K)).toBe(false);
    expect(removed).toContain('# 全局约定');
    expect(removed).toContain('其他规则。');
  });

  it('只有该块的文件删完变空', () => {
    const only = applyClaudeMdBlock('', K, RULE);
    expect(removeClaudeMdBlockText(only, K)).toBe('');
  });

  it('不含该块时原样返回', () => {
    const t = '# 别的项目约定\n';
    expect(stripClaudeMdBlock(t, K)).toBe(t);
  });

  it('只删自己 key 的块，不误伤别的 sentinel 块', () => {
    let t = applyClaudeMdBlock('# 头\n', 'a', '规则A');
    t = applyClaudeMdBlock(t, 'b', '规则B');
    const afterDelA = removeClaudeMdBlockText(t, 'a');
    expect(hasClaudeMdBlock(afterDelA, 'a')).toBe(false);
    expect(hasClaudeMdBlock(afterDelA, 'b')).toBe(true);
    expect(afterDelA).toContain('规则B');
  });

  it('残缺块(只有 start 没 end)不动，避免误删用户内容', () => {
    const t = `# 头\n${claudeMdSentinels(K).start}\n半截\n更多用户内容\n`;
    expect(stripClaudeMdBlock(t, K)).toBe(t);
  });

  it('去重：文件里同 key 残留两份完整块 → 全清掉', () => {
    const dup = applyClaudeMdBlock(applyClaudeMdBlock('# 头\n', K, RULE), K, RULE);
    // applyClaudeMdBlock 本身幂等，手工拼两份模拟历史残留
    const twoBlocks = `# 头\n\n${claudeMdSentinels(K).start}\n${RULE}\n${claudeMdSentinels(K).end}\n\n${claudeMdSentinels(K).start}\n${RULE}\n${claudeMdSentinels(K).end}\n`;
    expect(twoBlocks.split(claudeMdSentinels(K).start).length - 1).toBe(2);
    expect(hasClaudeMdBlock(stripClaudeMdBlock(twoBlocks, K), K)).toBe(false);
    void dup;
  });
});

describe('install/remove I/O（可注入 path，真实临时文件）', () => {
  let dir: string;
  let file: string;
  const it0: Integration = { key: K, name: '评审门', group: '开发', desc: '', fields: [], claudeMdType: true, claudeMdRule: RULE };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'claudemd-test-'));
    file = join(dir, 'CLAUDE.md');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('文件不存在(ENOENT) → 当空文件，写入创建之', async () => {
    expect(await claudeMdBlockPresent(it0, file)).toBe(false);
    await installClaudeMdBlock(it0, file);
    expect(await claudeMdBlockPresent(it0, file)).toBe(true);
    expect(await readFile(file, 'utf8')).toContain(RULE);
  });

  it('往返：装→删 还原（保留用户既有内容）', async () => {
    await writeFile(file, '# 我的全局约定\n\n别的规则。\n', 'utf8');
    await installClaudeMdBlock(it0, file);
    await removeClaudeMdBlock(it0, file);
    const after = await readFile(file, 'utf8');
    expect(hasClaudeMdBlock(after, K)).toBe(false);
    expect(after).toContain('# 我的全局约定');
    expect(after).toContain('别的规则。');
  });

  it('残缺块 remove → 抛错(不假成功)', async () => {
    await writeFile(file, `# 头\n${claudeMdSentinels(K).start}\n半截\n`, 'utf8');
    await expect(removeClaudeMdBlock(it0, file)).rejects.toThrow(/结构异常/);
  });

  it('并发装两个不同 key 到同一文件 → 都在（锁防丢更新）', async () => {
    const a: Integration = { ...it0, key: 'ga', claudeMdRule: '规则A' };
    const b: Integration = { ...it0, key: 'gb', claudeMdRule: '规则B' };
    await Promise.all([installClaudeMdBlock(a, file), installClaudeMdBlock(b, file)]);
    const txt = await readFile(file, 'utf8');
    expect(hasClaudeMdBlock(txt, 'ga')).toBe(true);
    expect(hasClaudeMdBlock(txt, 'gb')).toBe(true);
  });
});
