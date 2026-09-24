/**
 * Facade · 把 [`HostController`](./controller.ts) 的方法摊平成模块级函数。
 *
 * 目的是**让调用点零改动**：原来 `import { getHistory } from 'multiagent-host-mac'` 改成
 * `import { getHistory } from 'multiagent-host-api'`，调用写法完全不变，但实际派发到运行时
 * 注册的那个宿主。这样 46 处调用点的迁移只动 import 行，不动逻辑 —— 纯搬迁，可逐行核对。
 *
 * 每次调用都现取 `getHost()`（不缓存），所以注册时机不敏感，测试里换宿主也立刻生效。
 */

import type { HostCapabilities, HostController } from './controller.js';
import { getHost } from './registry.js';
import type {
  CloseTabOptions,
  CloseTabResult,
  ExitAgentOptions,
  ExitAgentResult,
  ForceEnterOptions,
  ForceEnterResult,
  HostPermissionId,
  HostPermissionSpec,
  HostPermissionStatus,
  KeepAwakeState,
  KeyInjectionProbeResult,
  LaunchAgentOptions,
  LaunchAgentResult,
  LaunchDefaultAgentResult,
  NewTabOptions,
  PermissionPane,
  RestartAgentOptions,
  RestartAgentResult,
  SendKeysOptions,
  SendResult,
  TabStatusInfo,
  SnapshotTabsOptions,
  TabsSnapshot,
  TerminalTab,
  UserFocus,
  WaitForOutputOptions,
} from './types.js';
import type { AgentKind } from 'multiagent-orchestrator';

/** 当前宿主的能力声明 —— 调用方据此降级（别再写 `platform() !== 'darwin'`）。 */
export function hostCapabilities(): HostCapabilities {
  return getHost().capabilities;
}

// ---- tab 枚举与读取 ----

export const listTabsRaw = (): Promise<TerminalTab[]> => getHost().listTabsRaw();
export const listTabs = (): Promise<TerminalTab[]> => getHost().listTabs();
export const enrichTabsWithCwd = (tabs: TerminalTab[]): Promise<TerminalTab[]> =>
  getHost().enrichTabsWithCwd(tabs);
export const getCwd = (tty: string): Promise<string | undefined> => getHost().getCwd(tty);
export const getHistory = (tty: string): Promise<string> => getHost().getHistory(tty);
export const snapshotTabs = (opts?: SnapshotTabsOptions): Promise<TabsSnapshot> =>
  getHost().snapshotTabs(opts);
export const detectSelfTty = (): string | undefined => getHost().detectSelfTty();
export const getUserFocus = (): Promise<UserFocus> => getHost().getUserFocus();
export const isScreenLocked = (timeoutMs?: number): Promise<boolean | null> =>
  getHost().isScreenLocked(timeoutMs);

// ---- 往 tab 写 ----

export const send = (tty: string, text: string): Promise<SendResult> => getHost().send(tty, text);
export const sendKeysRaw = (tty: string, text: string): Promise<boolean> =>
  getHost().sendKeysRaw(tty, text);
export const forceEnter = (tty: string, opts?: ForceEnterOptions): Promise<ForceEnterResult> =>
  getHost().forceEnter(tty, opts);
export const sendKeys = (
  tty: string,
  tokens: string | string[],
  opts?: SendKeysOptions,
): Promise<void> => getHost().sendKeys(tty, tokens, opts);
export const pasteText = (tty: string, text: string): Promise<void> => getHost().pasteText(tty, text);
export const sendCtrlC = (tty: string): Promise<void> => getHost().sendCtrlC(tty);
export const waitForOutput = (
  tty: string,
  beforeLineCount: number,
  opts?: WaitForOutputOptions,
): Promise<string> => getHost().waitForOutput(tty, beforeLineCount, opts);

// ---- tab 生命周期 ----

export const newTab = (opts?: NewTabOptions): Promise<string> => getHost().newTab(opts);
export const closeTab = (tty: string): Promise<boolean> => getHost().closeTab(tty);
export const closeTabGracefully = (tty: string, opts?: CloseTabOptions): Promise<CloseTabResult> =>
  getHost().closeTabGracefully(tty, opts);
export const exitAgentInTab = (tty: string, opts?: ExitAgentOptions): Promise<ExitAgentResult> =>
  getHost().exitAgentInTab(tty, opts);
export const restartAgentInPlace = (
  tty: string,
  opts?: RestartAgentOptions,
): Promise<RestartAgentResult> => getHost().restartAgentInPlace(tty, opts);
export const launchAgentInTab = (
  tty: string,
  kind: AgentKind,
  opts?: LaunchAgentOptions,
): Promise<LaunchAgentResult> => getHost().launchAgentInTab(tty, kind, opts);
export const launchDefaultAgentInTab = (
  tty: string,
  opts?: LaunchAgentOptions,
): Promise<LaunchDefaultAgentResult> => getHost().launchDefaultAgentInTab(tty, opts);

// ---- 观测 ----

export const isAgentTab = (tab: TerminalTab): boolean => getHost().isAgentTab(tab);
export const inferTabStatus = (tab: TerminalTab, historyTail?: string): TabStatusInfo =>
  getHost().inferTabStatus(tab, historyTail);
export const captureScreen = (tty: string): Promise<string> => getHost().captureScreen(tty);

// ---- 宿主自检 ----

export const listPermissionSpecs = (): HostPermissionSpec[] => getHost().listPermissionSpecs();
/** ⚠ 与旧 host-mac 版签名的唯一差异：可能返回 undefined（宿主没有这项授权）。调用点须判空。 */
export const getHostPermissionSpec = (id: HostPermissionId): HostPermissionSpec | undefined =>
  getHost().getPermissionSpec(id);
export const detectHostPermissions = (): Promise<HostPermissionStatus[]> =>
  getHost().detectHostPermissions();
export const openPermissionPane = (pane: PermissionPane): void => getHost().openPermissionPane(pane);
export const probeKeyInjection = (): Promise<KeyInjectionProbeResult> => getHost().probeKeyInjection();

// ---- 电源 / 合盖 ----

/** 「合盖不睡」守护的安装命令；null = 本宿主没这能力，别提示用户装。 */
export const keepAwakeInstallCmd = (): string | null => getHost().keepAwakeInstallCmd;
export const detectKeepAwake = (): Promise<KeepAwakeState> => getHost().detectKeepAwake();

/** 需要整个宿主对象时用（少数场景，如把 host 传给纯逻辑模块做依赖注入）。 */
export const host = (): HostController => getHost();
