import { describe, it, expect, afterEach } from 'vitest';
import { shouldGateAutoPush } from '../packages/framework/src/control/server.js';

const KEY = 'MCHAT_ASK_MIRROR_BYPASS_WATCH';

describe('shouldGateAutoPush —— --auto 推送闸门（含 --question 穿透）', () => {
  afterEach(() => { delete process.env[KEY]; });

  it('非 --auto → 从不 gate', () => {
    expect(shouldGateAutoPush({ auto: false }, { watchAllTabs: false })).toBe(false);
  });

  it('--auto + watchAllTabs=true → 放行（不 gate）', () => {
    expect(shouldGateAutoPush({ auto: true }, { watchAllTabs: true })).toBe(false);
  });

  it('--auto + watch off + 普通消息 → gate', () => {
    expect(shouldGateAutoPush({ auto: true, question: false }, { watchAllTabs: false })).toBe(true);
  });

  it('--auto + watch off + --question → 默认穿透（不 gate）', () => {
    expect(shouldGateAutoPush({ auto: true, question: true }, { watchAllTabs: false })).toBe(false);
  });

  it('MCHAT_ASK_MIRROR_BYPASS_WATCH=0 → --question 也恢复受闸门', () => {
    process.env[KEY] = '0';
    expect(shouldGateAutoPush({ auto: true, question: true }, { watchAllTabs: false })).toBe(true);
  });
});
