import { describe, it, expect } from 'vitest';
import {
  normalizeCmd,
  isNeverLearn,
  decideAutoAllow,
  type LearnedEntry,
} from '../packages/orchestrator/src/guard/learned-allow.js';

describe('normalizeCmd', () => {
  it('折叠空白 + trim（不泛化路径/参数）', () => {
    expect(normalizeCmd('  git   push   --force  ')).toBe('git push --force');
    expect(normalizeCmd('rm -rf /a')).toBe('rm -rf /a');
    // 不同目标 → 不同 key（安全：不泛化）
    expect(normalizeCmd('rm -rf /a')).not.toBe(normalizeCmd('rm -rf /b'));
  });
});

describe('isNeverLearn — 最灾难命令永不学习', () => {
  it('rm -rf / 或 ~、mkfs、dd of=/dev、fork bomb', () => {
    expect(isNeverLearn('rm -rf /')).toBe(true);
    expect(isNeverLearn('sudo rm -rf ~')).toBe(true);
    expect(isNeverLearn('mkfs.ext4 /dev/sdb')).toBe(true);
    expect(isNeverLearn('dd if=x of=/dev/disk2')).toBe(true);
    expect(isNeverLearn(':(){ :|:& };:')).toBe(true);
  });
  it('普通高危(可学习)不算 never', () => {
    expect(isNeverLearn('git push --force origin main')).toBe(false);
    expect(isNeverLearn('rm -rf node_modules')).toBe(false);
    expect(isNeverLearn('sudo systemctl restart x')).toBe(false);
  });
});

describe('decideAutoAllow', () => {
  const mk = (approvals: number, denied = false): LearnedEntry => ({ approvals, denied, lastAt: 0, sample: '' });
  it('无记录 / 未达阈值 → 不放行', () => {
    expect(decideAutoAllow(undefined, 'git push --force', 3)).toBe(false);
    expect(decideAutoAllow(mk(2), 'git push --force', 3)).toBe(false);
  });
  it('达阈值且未被拒 → 放行', () => {
    expect(decideAutoAllow(mk(3), 'git push --force', 3)).toBe(true);
    expect(decideAutoAllow(mk(9), 'git push --force', 3)).toBe(true);
  });
  it('被拒过 → 永不放行(即便批准多)', () => {
    expect(decideAutoAllow(mk(9, true), 'git push --force', 3)).toBe(false);
  });
  it('灾难命令 → 即便达阈值也不放行', () => {
    expect(decideAutoAllow(mk(99), 'rm -rf /', 3)).toBe(false);
  });
});
