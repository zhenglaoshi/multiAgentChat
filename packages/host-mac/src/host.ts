/**
 * macOS 宿主实现 —— 把本包散落的函数装配成一个 [`HostController`](../../host-api/src/controller.ts)。
 *
 * 这里**只做装配**，不含逻辑：每个方法直接指向原函数，行为与重构前逐字一致。
 * 新增宿主（host-win 等）照此写一个同构的对象即可，上层无需改动。
 */

import type {
  HostCapabilities,
  HostController,
  HostPermissionId,
  HostPermissionSpec,
} from 'multiagent-host-api';

import { captureScreen } from './terminal/screen.js';
import { sendCtrlC, sendKeys } from './terminal/keys.js';
import { inferTabStatus } from './terminal/status.js';
import { probeSystemEvents } from './terminal/probe.js';
import { isScreenLocked } from './screen-lock.js';
import { detectLidAwake, LID_AWAKE_INSTALL_CMD } from './lid-awake.js';
import {
  detectHostPermissions,
  getHostPermissionSpec,
  HOST_PERMISSION_SPECS,
  openPermissionPane,
} from './terminal/permissions.js';
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
} from './terminal/tabs.js';
import {
  closeTabGracefully,
  detectSelfTty,
  exitAgentInTab,
  isAgentTab,
  launchAgentInTab,
  launchDefaultAgentInTab,
  restartAgentInPlace,
} from './terminal/restart.js';

export const MAC_HOST_CAPABILITIES: HostCapabilities = {
  platform: 'darwin',
  displayName: 'macOS Terminal.app',
  // 按键注入走 System Events：需 Accessibility 授权，锁屏时静默失败（见 CLAUDE.md「System Events 术语故障」）
  keyInjection: true,
  // 锁屏下 System Events 送不进去却返回 ok（假成功）→ 调用方必须先确认没锁屏才敢发 Esc/方向键
  keyInjectionBlockedWhenLocked: true,
  screenCapture: true,
  screenLockDetection: true,
  permissionModel: true,
  keepAwake: true,
};

export const macHost: HostController = {
  capabilities: MAC_HOST_CAPABILITIES,

  // tab 枚举与读取
  listTabsRaw,
  listTabs,
  enrichTabsWithCwd,
  getCwd,
  getHistory,
  detectSelfTty,
  getUserFocus,
  isScreenLocked,

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
  captureScreen,

  // 宿主自检
  listPermissionSpecs: (): HostPermissionSpec[] => HOST_PERMISSION_SPECS,
  getPermissionSpec: (id: HostPermissionId) => getHostPermissionSpec(id),
  detectHostPermissions,
  openPermissionPane,
  probeKeyInjection: probeSystemEvents,

  // 电源 / 合盖
  keepAwakeInstallCmd: LID_AWAKE_INSTALL_CMD,
  detectKeepAwake: detectLidAwake,
};
