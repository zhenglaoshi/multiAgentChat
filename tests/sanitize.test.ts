import { describe, it, expect } from 'vitest';
import { sanitizeTerminalOutput } from '../packages/im-lark/src/monitor/sanitize.js';

describe('sanitizeTerminalOutput', () => {
  it('空输入 → 空串', () => {
    expect(sanitizeTerminalOutput('')).toBe('');
  });

  it('剥离 CSI 颜色序列', () => {
    expect(sanitizeTerminalOutput('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('剥离 OSC(窗口标题)序列', () => {
    expect(sanitizeTerminalOutput('\x1b]0;title\x07hello')).toBe('hello');
  });

  it('\\r 重绘只保留最终态', () => {
    expect(sanitizeTerminalOutput('loading...\rdone')).toBe('done');
  });

  it('连续同行去重（spinner 定帧）', () => {
    expect(sanitizeTerminalOutput('tick\ntick\ntick\nend')).toBe('tick\nend');
  });

  it('水平分隔线折叠成一条并在首尾被去掉', () => {
    // 中间的分隔线折叠成 ───；首尾的会被 trim 掉
    expect(sanitizeTerminalOutput('────────\nA\n══════\nB\n─────')).toBe('A\n───\nB');
  });

  it('折叠连续空行 + 去首尾空行', () => {
    expect(sanitizeTerminalOutput('\n\nA\n\n\nB\n\n')).toBe('A\n\nB');
  });

  it('普通文本原样保留', () => {
    expect(sanitizeTerminalOutput('hello\nworld')).toBe('hello\nworld');
  });
});
