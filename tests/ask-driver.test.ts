import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { driveAskSelect, type AskDriveDeps } from '../packages/im-lark/src/lark/ask-driver.js';

// driveAskSelect 是"锁屏也能作答"承诺的落地点：默认 pty 写数字，越界 / 显式配置才退回 System Events 方向键。
// 依赖注入假发送器：测试绝不能真去写某个 tty（会把字符打进正在跑测试的终端）。
const TTY = '/dev/ttysTEST';

describe('driveAskSelect', () => {
  let deps: AskDriveDeps;
  let raw: ReturnType<typeof vi.fn>;
  let keys: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('MCHAT_ASK_DRIVE', '');
    raw = vi.fn().mockResolvedValue(true);
    keys = vi.fn().mockResolvedValue(undefined);
    deps = { sendKeysRaw: raw as never, sendKeys: keys as never };
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('默认 pty：写 1-based 数字，不碰 System Events', async () => {
    const r = await driveAskSelect(TTY, 1, deps);
    expect(raw).toHaveBeenCalledWith(TTY, '2');
    expect(keys).not.toHaveBeenCalled();
    expect(r).toEqual({ via: 'pty', how: 'pty 数字 2' });
  });

  it('index 0 → 写 "1"', async () => {
    const r = await driveAskSelect(TTY, 0, deps);
    expect(raw).toHaveBeenCalledWith(TTY, '1');
    expect(r.via).toBe('pty');
  });

  it('index 超出数字快捷键范围（≥9）→ 退回方向键 ↓×N+⏎', async () => {
    const r = await driveAskSelect(TTY, 9, deps);
    expect(raw).not.toHaveBeenCalled();
    expect(keys).toHaveBeenCalledWith(TTY, [...Array(9).fill('down'), 'enter']);
    expect(r).toEqual({ via: 'keys', how: '↓×9+⏎' });
  });

  it('MCHAT_ASK_DRIVE=keys → 直接走方向键', async () => {
    vi.stubEnv('MCHAT_ASK_DRIVE', 'keys');
    const r = await driveAskSelect(TTY, 2, deps);
    expect(raw).not.toHaveBeenCalled();
    expect(keys).toHaveBeenCalledWith(TTY, ['down', 'down', 'enter']);
    expect(r.via).toBe('keys');
  });

  it('pty 写失败（tab 不存在）→ 抛错，不静默假成功', async () => {
    raw.mockResolvedValue(false);
    await expect(driveAskSelect(TTY, 0, deps)).rejects.toThrow(/tab .* 不存在/);
  });

  it('方向键路径异常 → 原样抛出', async () => {
    vi.stubEnv('MCHAT_ASK_DRIVE', 'keys');
    keys.mockRejectedValue(new Error('sendKeys: tab 不存在'));
    await expect(driveAskSelect(TTY, 0, deps)).rejects.toThrow('sendKeys: tab 不存在');
  });
});
