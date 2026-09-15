import { describe, expect, it, beforeEach } from 'vitest';
import { resetHostForTests } from '../packages/host-api/src/testing.js';
import {
  getHost,
  hasHost,
  inferTabStatus,
  listTabs,
  send,
  setHost,
  hostCapabilities,
  keepAwakeInstallCmd,
  type HostCapabilities,
  type HostController,
  type TerminalTab,
} from '../packages/host-api/src/index.js';

const TAB: TerminalTab = {
  tty: '/dev/ttys001',
  windowId: 1,
  windowFrontmost: true,
  tabIndex: 1,
  title: 'fake',
  busy: false,
  processes: ['login', '-zsh'],
};

const CAPS: HostCapabilities = {
  platform: 'win32',
  displayName: 'Fake Host',
  keyInjection: false,
  keyInjectionBlockedWhenLocked: false,
  screenCapture: false,
  screenLockDetection: false,
  permissionModel: false,
  keepAwake: false,
};

/** 最小假宿主 —— 只实现用例真正会调到的方法，其余用 notImpl 占位。 */
function makeFakeHost(overrides: Partial<HostController> = {}): HostController {
  const notImpl = () => {
    throw new Error('fake host: not implemented');
  };
  return {
    capabilities: CAPS,
    listTabsRaw: async () => [TAB],
    listTabs: async () => [TAB],
    enrichTabsWithCwd: async (tabs) => tabs,
    getCwd: async () => undefined,
    getHistory: async () => '',
    detectSelfTty: () => undefined,
    getUserFocus: async () => ({ terminalFrontmost: false, tty: null }),
    isScreenLocked: async () => null,
    send: async (tty, text) => ({ ok: true, reason: `${tty}:${text}` }),
    sendKeysRaw: async () => true,
    forceEnter: async () => ({ ok: true, blocked: false, via: 'pty' as const }),
    sendKeys: notImpl,
    sendCtrlC: notImpl,
    waitForOutput: async () => '',
    newTab: async () => TAB.tty,
    closeTab: async () => true,
    closeTabGracefully: async () => ({ ok: true, closed: true, hadAgent: false, agentExited: true }),
    exitAgentInTab: async () => ({ exited: true, hadAgent: false }),
    restartAgentInPlace: async () => ({ ok: true, tty: TAB.tty }),
    launchAgentInTab: async () => ({ ok: true }),
    launchDefaultAgentInTab: async () => ({ ok: true, kind: 'claude' as const }),
    isAgentTab: () => false,
    inferTabStatus: () => ({ kind: 'shell-idle' as const, label: 'fake-idle', icon: '💤' }),
    captureScreen: notImpl,
    listPermissionSpecs: () => [],
    getPermissionSpec: () => undefined,
    detectHostPermissions: async () => [],
    openPermissionPane: () => {},
    probeKeyInjection: async () => ({ ok: true }),
    keepAwakeInstallCmd: null,
    detectKeepAwake: async () => ({
      isLaptop: false,
      installed: false,
      running: null,
      sleepDisabled: null,
      powerSource: 'unknown' as const,
    }),
    ...overrides,
  };
}

describe('host registry', () => {
  beforeEach(() => resetHostForTests());

  it('未注册时 getHost 抛带指引的错，而不是返回 undefined 往下传', () => {
    expect(hasHost()).toBe(false);
    expect(() => getHost()).toThrow(/尚未注册/);
  });

  it('注册后 hasHost/getHost 生效', () => {
    const host = makeFakeHost();
    setHost(host);
    expect(hasHost()).toBe(true);
    expect(getHost()).toBe(host);
  });

  it('重复注册同一实例是 no-op（多个入口都调 ensureHostRegistered）', () => {
    const host = makeFakeHost();
    setHost(host);
    expect(() => setHost(host)).not.toThrow();
  });

  it('换成另一个实例要抛 —— 一个进程里混用两套宿主一定是 bug', () => {
    setHost(makeFakeHost());
    expect(() => setHost(makeFakeHost())).toThrow(/不能再换成/);
  });
});

describe('host facade', () => {
  beforeEach(() => resetHostForTests());

  it('模块级函数派发到当前注册的宿主', async () => {
    setHost(makeFakeHost());
    await expect(listTabs()).resolves.toEqual([TAB]);
    await expect(send('/dev/ttys009', 'hi')).resolves.toEqual({
      ok: true,
      reason: '/dev/ttys009:hi',
    });
    expect(inferTabStatus(TAB).label).toBe('fake-idle');
  });

  it('能力声明与可选能力如实透出（假宿主没有合盖守护）', () => {
    setHost(makeFakeHost());
    expect(hostCapabilities().keyInjection).toBe(false);
    expect(keepAwakeInstallCmd()).toBeNull();
  });

  it('换宿主后同一个 facade 函数派发到新实现（不缓存）', async () => {
    setHost(makeFakeHost());
    await expect(listTabs()).resolves.toHaveLength(1);
    resetHostForTests();
    setHost(makeFakeHost({ listTabs: async () => [] }));
    await expect(listTabs()).resolves.toHaveLength(0);
  });
});
