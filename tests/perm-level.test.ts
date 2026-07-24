import { describe, it, expect } from 'vitest';
import { riskTier, tierGatedAtLevel, shouldGate } from '../packages/orchestrator/src/guard/perm-level.js';

describe('riskTier — 命令分档', () => {
  it('catastrophic:递归删根/格式化/写裸设备/删库/fork bomb', () => {
    expect(riskTier('rm -rf /')).toBe('catastrophic');
    expect(riskTier('sudo rm -rf ~')).toBe('catastrophic');
    expect(riskTier('mkfs.ext4 /dev/sdb')).toBe('catastrophic');
    expect(riskTier('mysql -e "DROP DATABASE prod"')).toBe('catastrophic');
  });
  it('high:强删/强推/sudo/写.env(非致命高危)', () => {
    expect(riskTier('rm -rf node_modules')).toBe('high');
    expect(riskTier('git push --force')).toBe('high');
    expect(riskTier('sudo systemctl restart x')).toBe('high');
    expect(riskTier('echo X > .env')).toBe('high');
  });
  it('medium:任何push/任何rm/publish/kill/chmod', () => {
    expect(riskTier('git push origin main')).toBe('medium');
    expect(riskTier('rm file.txt')).toBe('medium');
    expect(riskTier('npm publish')).toBe('medium');
    expect(riskTier('kill 1234')).toBe('medium');
    expect(riskTier('chmod 644 x')).toBe('medium');
  });
  it('none:常规命令', () => {
    expect(riskTier('ls -la')).toBe('none');
    expect(riskTier('npm run build')).toBe('none');
    expect(riskTier('git commit -m "x"')).toBe('none');
    expect(riskTier('git commit -m "rm this and push that"')).toBe('none'); // 引号里的危险词不误判
  });
});

describe('tierGatedAtLevel — 等级阈值', () => {
  it('L0 全放,L4 全拦', () => {
    for (const t of ['catastrophic', 'high', 'medium', 'none'] as const) {
      expect(tierGatedAtLevel(t, 0)).toBe(false);
      expect(tierGatedAtLevel(t, 4)).toBe(true);
    }
  });
  it('L1 仅致命', () => {
    expect(tierGatedAtLevel('catastrophic', 1)).toBe(true);
    expect(tierGatedAtLevel('high', 1)).toBe(false);
    expect(tierGatedAtLevel('medium', 1)).toBe(false);
  });
  it('L2 致命+高危', () => {
    expect(tierGatedAtLevel('catastrophic', 2)).toBe(true);
    expect(tierGatedAtLevel('high', 2)).toBe(true);
    expect(tierGatedAtLevel('medium', 2)).toBe(false);
  });
  it('L3 致命+高危+中危', () => {
    expect(tierGatedAtLevel('medium', 3)).toBe(true);
    expect(tierGatedAtLevel('none', 3)).toBe(false);
  });
});

describe('shouldGate', () => {
  it('默认 L1:强删(high)不拦,删根(catastrophic)拦', () => {
    expect(shouldGate('rm -rf node_modules', 1).gate).toBe(false);
    expect(shouldGate('rm -rf /', 1).gate).toBe(true);
  });
  it('L2:强删要拦', () => {
    expect(shouldGate('rm -rf node_modules', 2).gate).toBe(true);
  });
});
