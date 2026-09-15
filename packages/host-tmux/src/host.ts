/**
 * tmux 宿主实现 —— 把本包的函数装配成一个 [`HostController`](../../host-api/src/controller.ts)。
 * 与 host-mac 的 `host.ts` 一样：**只做装配，不含逻辑**。
 *
 * 目标场景：Windows 上的 WSL2（见 docs/windows-port.md）以及任何装了 tmux 的 Linux / macOS。
 */

import type {
  HostCapabilities,
  HostController,
  HostPermissionId,
  HostPermissionSpec,
  KeyInjectionProbeResult,
} from 'multiagent-host-api';

import {
  closeTab,
  enrichTabsWithCwd,
  forceEnter,
  getCwd,
  getHistory,
  getUserFocus,
  listTabs,
  listTabsRaw,
  newTab,
  send,
  sendKeysRaw,
  waitForOutput,
} from './tabs.js';
import { sendCtrlC, sendKeys } from './keys.js';
import { inferTabStatus } from './status.js';
import { detectSelfTty } from './procs.js';
import { detectKeepAwake, isWSL, WSL_KEEP_AWAKE_CMD } from './keep-awake.js';
import {
  closeTabGracefully,
  exitAgentInTab,
  isAgentTab,
  launchAgentInTab,
  launchDefaultAgentInTab,
  restartAgentInPlace,
} from './lifecycle.js';

export const TMUX_HOST_CAPABILITIES: HostCapabilities = {
  platform: process.platform,
  displayName: isWSL() ? 'tmux (WSL2)' : 'tmux',
  // 按键注入走 tmux send-keys：后台 server 直写 pane 的 pty
  keyInjection: true,
  // **不受锁屏影响** —— 不经窗口系统/焦点，没人登录也照送。
  // 调用方必须读这一位而不是 isScreenLocked()：本宿主的 isScreenLocked() 恒为 null（它确实不知道），
  // 若调用方按"读不到就保守拒绝"处理，Esc / 方向键会被永久判死。
  keyInjectionBlockedWhenLocked: false,
  // 没有窗口可截（pane 的文字内容由 getHistory 的 capture-pane 提供，比截图更有用）
  screenCapture: false,
  screenLockDetection: false,
  // 没有 macOS TCC 那种授权模型
  permissionModel: false,
  // WSL 下能读 Windows 电源策略；纯 Linux 没有这套
  keepAwake: isWSL(),
};

export const tmuxHost: HostController = {
  capabilities: TMUX_HOST_CAPABILITIES,

  // tab 枚举与读取
  listTabsRaw,
  listTabs,
  enrichTabsWithCwd,
  getCwd,
  getHistory,
  detectSelfTty,
  getUserFocus,
  // tmux 不知道屏幕锁没锁 —— 如实返回 null（未知），而不是撒谎说 false。
  // 上层要判"能不能发按键"请读 capabilities.keyInjectionBlockedWhenLocked。
  isScreenLocked: async () => null,

  // 往 tab 写
  send,
  sendKeysRaw,
  forceEnter: (tty, opts) => forceEnter(tty, opts),
  sendKeys,
  sendCtrlC,
  waitForOutput,

  // tab 生命周期
  newTab,
  closeTab,
  closeTabGracefully,
  exitAgentInTab,
  restartAgentInPlace,
  launchAgentInTab,
  launchDefaultAgentInTab,

  // 观测
  isAgentTab,
  inferTabStatus,
  captureScreen: async (): Promise<string> => {
    throw new Error('tmux 宿主不支持截图（capabilities.screenCapture=false）；pane 的文字内容请用 getHistory');
  },

  // 宿主自检：没有授权模型 → 空实现，探针按 capabilities 自动跳过
  listPermissionSpecs: (): HostPermissionSpec[] => [],
  getPermissionSpec: (_id: HostPermissionId) => undefined,
  detectHostPermissions: async () => [],
  openPermissionPane: () => {},
  // 按键通路不经 System Events 之类的脆弱中间层，没有"术语故障"这种失败模式
  probeKeyInjection: async (): Promise<KeyInjectionProbeResult> => ({ ok: true }),

  // 电源
  keepAwakeInstallCmd: isWSL() ? WSL_KEEP_AWAKE_CMD : null,
  detectKeepAwake,
};
