import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetDaemonRestartForTest, requestDaemonRestart, type SpawnLike } from '../packages/im-lark/src/lark/daemon-restart.js';

/** 假 ChildProcess：测试只用得到 on('error', ...) 和 unref() 这两个方法 */
function fakeChild() {
  const handlers = new Map<string, (err: Error) => void>();
  return {
    on: vi.fn((event: string, cb: (err: Error) => void) => {
      handlers.set(event, cb);
    }),
    unref: vi.fn(),
    emitError(err: Error) {
      handlers.get('error')?.(err);
    },
  };
}

describe('requestDaemonRestart', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    __resetDaemonRestartForTest(); // 清掉模块级的去抖定时器，不让这个用例遗留的状态影响下一个
    vi.useRealTimers();
  });

  it('立即返回提示文案，不同步拉起进程', () => {
    const spawnImpl = vi.fn((_cmd: string, _args?: readonly string[], _opts?: unknown) => fakeChild());
    const { text } = requestDaemonRestart({ spawnImpl: spawnImpl as unknown as SpawnLike, delayMs: 1500 });
    expect(text).toMatch(/正在重启 daemon/);
    expect(spawnImpl).not.toHaveBeenCalled(); // 延迟执行：调用方先把这条回复发出去，不被进程退出打断
  });

  it('延迟后用 launchctl kickstart 拉起 daemon（不是别的命令），detached + unref', () => {
    const child = fakeChild();
    const spawnImpl = vi.fn((_cmd: string, _args?: readonly string[], _opts?: unknown) => child);
    requestDaemonRestart({ spawnImpl: spawnImpl as unknown as SpawnLike, delayMs: 1500 });
    vi.advanceTimersByTime(1499);
    expect(spawnImpl).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnImpl.mock.calls[0]!;
    expect(cmd).toBe('launchctl');
    expect(args).toEqual(expect.arrayContaining(['kickstart', '-k', expect.stringMatching(/^gui\/\d+\/com\.multiagent-chat\.daemon$/)]));
    expect(opts).toMatchObject({ stdio: 'ignore', detached: true });
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it('同步 spawn 抛错（dev / 非 launchd 托管）不往外抛，静默吞掉', () => {
    const spawnImpl = vi.fn((_cmd: string, _args?: readonly string[], _opts?: unknown) => {
      throw new Error('spawn ENOENT');
    });
    requestDaemonRestart({ spawnImpl: spawnImpl as unknown as SpawnLike, delayMs: 10 });
    expect(() => vi.advanceTimersByTime(10)).not.toThrow();
  });

  it('spawn 成功但子进程异步 error（launchctl 不存在）不炸进程：接住了 error 事件', () => {
    const child = fakeChild();
    const spawnImpl = vi.fn((_cmd: string, _args?: readonly string[], _opts?: unknown) => child);
    requestDaemonRestart({ spawnImpl: spawnImpl as unknown as SpawnLike, delayMs: 10 });
    vi.advanceTimersByTime(10);
    expect(child.on).toHaveBeenCalledWith('error', expect.any(Function));
    // 真实场景下这个事件是异步抛出的；这里手动模拟触发，确认有监听者接住（不会变成未捕获异常）
    expect(() => child.emitError(new Error('spawn launchctl ENOENT'))).not.toThrow();
  });

  it('短时间内连发多次（老板连续 /reload）：只保留最后一次定时器，只 kickstart 一次', () => {
    const spawnImpl = vi.fn((_cmd: string, _args?: readonly string[], _opts?: unknown) => fakeChild());
    requestDaemonRestart({ spawnImpl: spawnImpl as unknown as SpawnLike, delayMs: 1500 });
    vi.advanceTimersByTime(500);
    requestDaemonRestart({ spawnImpl: spawnImpl as unknown as SpawnLike, delayMs: 1500 }); // 第一个定时器被取消，重新计时
    vi.advanceTimersByTime(1499);
    expect(spawnImpl).not.toHaveBeenCalled(); // 从第二次调用算起还没到 1500ms
    vi.advanceTimersByTime(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1); // 不是两次：没有两个定时器互相打架
  });
});
