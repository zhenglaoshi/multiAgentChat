import { describe, it, expect } from 'vitest';
import {
  looksLikeAgentTask,
  hasUnbalancedQuotes,
  detectWedge,
} from '../packages/orchestrator/src/shell-safety/index.js';

describe('hasUnbalancedQuotes', () => {
  it('成对 → false', () => {
    expect(hasUnbalancedQuotes('npm test')).toBe(false);
    expect(hasUnbalancedQuotes(`echo "hello world"`)).toBe(false);
    expect(hasUnbalancedQuotes(`git commit -m 'fix bug'`)).toBe(false);
    expect(hasUnbalancedQuotes('echo `date`')).toBe(false);
  });
  it('不成对 → true', () => {
    expect(hasUnbalancedQuotes(`帮我分析下 'foo 的问题`)).toBe(true);
    expect(hasUnbalancedQuotes(`echo "unterminated`)).toBe(true);
    expect(hasUnbalancedQuotes("it's a task")).toBe(true);
    expect(hasUnbalancedQuotes('run `cmd')).toBe(true);
  });
  it('转义引号不计入', () => {
    expect(hasUnbalancedQuotes(`echo \\"escaped\\"`)).toBe(false);
  });
});

describe('looksLikeAgentTask', () => {
  it('中文任务 → true', () => {
    expect(looksLikeAgentTask('跑一下测试并总结失败原因')).toBe(true);
    expect(looksLikeAgentTask('帮我看看这个 bug')).toBe(true);
  });
  it('多行 → true', () => {
    expect(looksLikeAgentTask('line1\nline2')).toBe(true);
  });
  it('引号不配对 → true', () => {
    expect(looksLikeAgentTask(`analyze 'this`)).toBe(true);
  });
  it('正经单行 shell 命令 → false（不误伤）', () => {
    expect(looksLikeAgentTask('npm test')).toBe(false);
    expect(looksLikeAgentTask('git status')).toBe(false);
    expect(looksLikeAgentTask('ls -la /tmp')).toBe(false);
    expect(looksLikeAgentTask(`git commit -m "wip"`)).toBe(false);
  });
  it('空串 → false', () => {
    expect(looksLikeAgentTask('')).toBe(false);
    expect(looksLikeAgentTask('   ')).toBe(false);
  });
});

describe('detectWedge', () => {
  it('结尾 dquote>/quote> → wedged', () => {
    expect(detectWedge('user@host ~ % echo "hi\ndquote> ').wedged).toBe(true);
    expect(detectWedge("some output\nquote> ").wedged).toBe(true);
    expect(detectWedge('foo\ncmdsubst>').prompt).toBe('cmdsubst>');
  });
  it('正常 prompt / 输出 → 不 wedged', () => {
    expect(detectWedge('user@host ~ % ').wedged).toBe(false);
    expect(detectWedge('npm test\nPASS\nuser@host ~ % ').wedged).toBe(false);
    expect(detectWedge('').wedged).toBe(false);
  });
  it('非续行的 xxx> 不误判（如某工具输出 result>）', () => {
    expect(detectWedge('output\nresult>').wedged).toBe(false);
  });
});
