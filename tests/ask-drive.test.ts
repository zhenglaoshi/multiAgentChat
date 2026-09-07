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

// ---- 2026-09-07：pty 数字直选 + 非选项文本暂存 ----
import { afterEach, beforeEach, vi } from 'vitest';
import { buildAskHoldNotice, buildPtyDigit, isAskCancelWord, resolveAskDriveMode } from '../packages/im-lark/src/lark/ask-drive.js';

describe('resolveAskDriveMode', () => {
  beforeEach(() => { vi.stubEnv('MCHAT_ASK_DRIVE', ''); });
  afterEach(() => { vi.unstubAllEnvs(); });
  it('未设 / 空 / 乱值 → pty（默认）', () => {
    expect(resolveAskDriveMode(undefined)).toBe('pty');
    expect(resolveAskDriveMode('')).toBe('pty');
    expect(resolveAskDriveMode('arrow')).toBe('pty');
  });
  it('keys（大小写/空白不敏感）→ keys', () => {
    expect(resolveAskDriveMode('keys')).toBe('keys');
    expect(resolveAskDriveMode(' KEYS ')).toBe('keys');
  });
  it('环境变量设了 keys、不传参 → keys', () => {
    vi.stubEnv('MCHAT_ASK_DRIVE', 'keys');
    expect(resolveAskDriveMode()).toBe('keys');
  });
});

describe('buildPtyDigit', () => {
  it('index 0..8 → "1".."9"', () => {
    expect(buildPtyDigit(0)).toBe('1');
    expect(buildPtyDigit(1)).toBe('2');
    expect(buildPtyDigit(8)).toBe('9');
  });
  it('越界 / 非整数 → null（调用方退回方向键）', () => {
    expect(buildPtyDigit(9)).toBeNull();
    expect(buildPtyDigit(-1)).toBeNull();
    expect(buildPtyDigit(1.5)).toBeNull();
  });
});

describe('isAskCancelWord', () => {
  it('整句取消口令（含末尾标点/大小写）→ true', () => {
    expect(isAskCancelWord('取消')).toBe(true);
    expect(isAskCancelWord('算了。')).toBe(true);
    expect(isAskCancelWord(' Cancel ')).toBe(true);
    expect(isAskCancelWord('esc')).toBe(true);
  });
  it('只是句子里含有取消字样 → false（别把任务误判成取消）', () => {
    expect(isAskCancelWord('取消这个定时任务')).toBe(false);
    expect(isAskCancelWord('帮我跳过失败的用例继续跑')).toBe(false);
    expect(isAskCancelWord('')).toBe(false);
  });
});

describe('buildAskHoldNotice', () => {
  const opts = ['春', '夏', '秋'];
  it('列出编号选项 + 暂存预览', () => {
    const n = buildAskHoldNotice('/dev/ttys008', opts, '锁屏合盖插电源下，再回我一个ok看下', false);
    expect(n).toContain('1. 春');
    expect(n).toContain('3. 秋');
    expect(n).toContain('/dev/ttys008');
    expect(n).toContain('锁屏合盖插电源下');
  });
  it('locked=false（确认没锁）→ 才提示可以回「取消」', () => {
    const n = buildAskHoldNotice('/dev/ttys008', opts, 'x', false);
    expect(n).toContain('回「取消」');
  });
  it('locked=true（确认锁屏）→ 提示 Esc 送不进去、只能选数字', () => {
    const n = buildAskHoldNotice('/dev/ttys008', opts, 'x', true);
    expect(n).toContain('屏幕已锁定');
    expect(n).not.toContain('回「取消」');
  });
  it('locked=null（读不到）→ 按最坏情况说，不承诺取消可用（三态不能并成两态）', () => {
    const n = buildAskHoldNotice('/dev/ttys008', opts, 'x', null);
    expect(n).toContain('读不到锁屏状态');
    expect(n).not.toContain('不想选 → 回「取消」');
  });
  it('长文本截断到 40 字 + …', () => {
    const n = buildAskHoldNotice('/dev/ttys008', opts, 'a'.repeat(80), null);
    expect(n).toContain('a'.repeat(40) + '…');
    expect(n).not.toContain('a'.repeat(41));
  });
});
