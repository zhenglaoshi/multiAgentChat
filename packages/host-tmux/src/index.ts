/**
 * multiagent-host-tmux —— `HostController` 的 tmux 实现。
 *
 * 装配根只 import `tmuxHost`（见 framework/src/host-bootstrap.ts）；
 * 其余导出供测试与诊断使用。
 */

export { tmuxHost, TMUX_HOST_CAPABILITIES } from './host.js';
export { tmuxAvailable, TmuxError, MCHAT_SESSION, sendLiteral, buildTmuxErrorMessage } from './tmux.js';
export { parseProcName, parsePsLine, groupProcsByTty, inferBusy, detectSelfTty } from './procs.js';
export { parsePaneRow, listTabs, listTabsRaw, getHistory, send, sendKeysRaw, forceEnter, newTab, closeTab, buildNewTabArgs, newSessionName } from './tabs.js';
export { closeTabGracefully, exitAgentInTab, restartAgentInPlace } from './lifecycle.js';
export { toTmuxKey, sendKeys, sendCtrlC } from './keys.js';
export { isWSL, parseAcStandbyTimeout, parsePowerSourceFromSysfs, detectKeepAwake, WSL_KEEP_AWAKE_CMD } from './keep-awake.js';
export { isAgentTab } from './lifecycle.js';
