/**
 * 宿主无关的共享类型 —— 终端 tab 模型、各操作的入参/出参。
 *
 * 这些类型原本长在 `multiagent-host-mac` 里（AppleScript 实现旁边），上层 46 处 import 也就
 * 一并绑死了 macOS 实现。挪到这里后：**类型是契约、实现是插件**，framework / im-lark 只认契约，
 * 新增宿主（host-win 等）只要 implement [`HostController`](./controller.ts) 即可。
 *
 * ⚠ 字段语义保持与原 host-mac 逐字一致 —— 这是纯搬迁，不是重新设计。
 *
 * ⚠ host-mac 侧会看到成对出现的两行：
 *     export type { X } from 'multiagent-host-api';   // 对外重导出，保持老调用点可用
 *     import type { X } from 'multiagent-host-api';   // 本文件内部还要用 X 标注签名
 *   `export type … from` **不引入本地绑定**，所以两行都要，别当重复删掉其中一行。
 */

import type { AgentKind } from 'multiagent-orchestrator';

// ==================================================================
// Tab 模型
// ==================================================================

export interface TerminalTab {
  tty: string;              // /dev/ttys001 — 主键
  windowId: number;         // AppleScript window id (稳定)
  windowFrontmost: boolean; // 是否是 front window（do script 默认目标）
  tabIndex: number;         // window 内 1-based 索引
  title: string;
  busy: boolean;
  processes: string[];      // ['login', '-zsh', 'claude'] 等
  cwd?: string;             // ps + lsof 拿
  hasTUI?: boolean;         // 是否在跑 vim/htop 等会被 do script 弄坏的程序
}

/**
 * 一次性拿到「tab 列表 + 需要的 history」（watcher 每 tick 用）。
 * histories 覆盖：所有 busy 的 tab + 调用方额外点名的 tty；取失败的 tab 不在 map 里。
 * 每条 history 的字节语义与单独调 `getHistory(tty)` 一致（含尾部换行），beforeCharLen 偏移才对得上。
 */
export interface TabsSnapshot {
  tabs: TerminalTab[];
  histories: Map<string, string>;
}

export interface SnapshotTabsOptions {
  /** 除 busy tab 外，还要带回 history 的 tty（例如有 pending 但此刻不 busy 的 tab） */
  historyTtys?: string[];
}

export interface TerminalWindow {
  windowId: number;
  frontmost: boolean;
  tabs: TerminalTab[];
}

export interface SendResult {
  ok: boolean;
  reason?: string;          // 失败/拒绝原因
  before?: number;          // history 行数（送前）
  after?: number;           // history 行数（送后）
  diff?: string;            // 截取的新增内容
}

// ==================================================================
// Tab 操作入参
// ==================================================================

export interface NewTabOptions {
  cwd?: string;
  mode?: 'new-tab' | 'new-window' | 'new-tab-background';
}

export interface WaitForOutputOptions {
  timeoutMs?: number;
  pollMs?: number;
}

/** 前台焦点：谁在最前、最前的是哪个 tab。keystroke 类操作的守卫依据。 */
export interface UserFocus {
  terminalFrontmost: boolean;
  tty: string | null;
}

// ==================================================================
// 回车提交
// ==================================================================

/** 回车提交走哪条通道：pty（默认，空 do script 直写 \r）/ keystroke（System Events key code 36 兜底） */
export type EnterMode = 'pty' | 'keystroke';

/** forceEnter 的结果：区分「回车已发」「被前台弹框/锁屏挡住没敢发」「没找到 tab」。 */
export interface ForceEnterResult {
  /** Return 确实发出去了 */
  ok: boolean;
  /** 前台不是目标 tab（系统弹框/锁屏抢了焦点）→ 为防误触弹框默认按钮，没发回车。只有 keystroke 模式会出现 */
  blocked: boolean;
  /** blocked 时的前台 app 名（'' = 拿不到，多半是锁屏 loginwindow） */
  frontApp?: string;
  /** 实际走的通道 */
  via?: EnterMode;
}

export interface ForceEnterOptions {
  mode?: EnterMode;
}

// ==================================================================
// 按键注入
// ==================================================================

export interface SendKeysOptions {
  intervalMs?: number;
}

// ==================================================================
// Tab 状态推断
// ==================================================================

/**
 * tab 状态模型 —— 定义在 `multiagent-orchestrator`（判据只有进程名 + busy + 屏幕文本，宿主无关），
 * 这里再导出，保证「上层拿到的」与「宿主算出来的」是同一批类型。
 * 与本文件其它类型的方向相反（那些是从 host-mac 上移到这里），原因是这一段本就不该住在宿主层。
 */
export type { TabStatusKind, TabStatusInfo } from 'multiagent-orchestrator';

// ==================================================================
// agent 生命周期（退出 / 关 tab / 重启 / 启动）
// ==================================================================

export interface ExitAgentResult {
  /** agent 已退出（或本来就没 agent）。 */
  exited: boolean;
  /** 关前 tab 里确实在跑 agent。 */
  hadAgent: boolean;
  kind?: AgentKind;
}

export interface ExitAgentOptions {
  settleMs?: number;
  maxInterrupts?: number;
}

export interface CloseTabOptions {
  skipAgentExit?: boolean;
}

export interface CloseTabResult {
  ok: boolean;
  closed: boolean;
  hadAgent: boolean;
  agentExited: boolean;
  agentKind?: AgentKind;
  reason?: string;
}

export interface RestartAgentOptions {
  /** true → 重启后 `claude --continue` 续上次会话；false → 全新 `claude`（默认，不带历史）。 */
  continueSession?: boolean;
  /** 每次 Ctrl-C 后等多久再查是否退出。默认 700ms。 */
  settleMs?: number;
  /** 最多发几次 Ctrl-C 尝试退出 claude TUI。默认 3。 */
  maxInterrupts?: number;
}

export interface RestartAgentResult {
  ok: boolean;
  tty: string;
  cwd?: string;
  /** 失败原因；ok 时 undefined */
  reason?: string;
  /** 实际重启用的命令（ok 时有） */
  command?: string;
}

export interface LaunchAgentOptions {
  /** true → `claude --continue`；false → 纯 `claude`（默认，不带历史）。 */
  continueSession?: boolean;
  /** 启动后自动按 Return 接受首次的 trust 弹窗。默认 true。 */
  acceptTrust?: boolean;
}

export interface LaunchAgentResult {
  ok: boolean;
  command?: string;
  reason?: string;
}

export interface LaunchDefaultAgentResult extends LaunchAgentResult {
  kind: AgentKind;
}

// ==================================================================
// 宿主授权模型（macOS TCC；其它宿主可能没有 → capabilities.permissionModel=false）
// ==================================================================

/**
 * ⚠ 当前这组 id 是 macOS TCC 的集合。新增宿主若有**不同**的授权项，在这里扩并
 * 同步 `HOST_PERMISSION_SPECS` 的提供方；宿主没有授权模型则 `detectHostPermissions()` 返回 []。
 */
export type HostPermissionId = 'automation-terminal' | 'automation-system-events' | 'accessibility';

export interface HostPermissionSpec {
  id: HostPermissionId;
  /** 简短名（告警/doctor 标题用） */
  name: string;
  /** 在 macOS 哪里授 */
  macLocation: string;
  /** critical = 缺了核心功能全废 */
  severity: 'critical' | 'important';
  /** 缺了会废哪些功能（人话，逐条，直接进告警/文档） */
  affects: string[];
  /** 授权步骤（dev / launchd 两种模式通用） */
  grantSteps: string[];
}

export interface HostPermissionStatus {
  id: HostPermissionId;
  granted: boolean;
  /** AppleScript error number（诊断用；-1743=Automation 被拒，-25211/1002=Accessibility 被拒） */
  errNum?: number;
  /** 原始 stderr / 返回片段（诊断用，截断 200） */
  raw?: string;
}

export type PermissionPane = 'accessibility' | 'automation';

// ==================================================================
// 按键通路自检（macOS System Events 术语故障；见 CLAUDE.md）
// ==================================================================

export interface KeyInjectionProbeResult {
  ok: boolean;
  /** 失败时的 stderr（截断 300 字）；ok 时为 undefined */
  err?: string;
}

// ==================================================================
// 合盖不睡守护（macOS pmset/launchd；其它宿主 capabilities.keepAwake=false）
// ==================================================================

export type PowerSource = 'ac' | 'battery' | 'unknown';

export interface KeepAwakeState {
  /** `pmset -g batt` 里有 InternalBattery → 笔记本（台式机没有合盖问题） */
  isLaptop: boolean;
  /** 守护 plist 在 /Library/LaunchDaemons（已安装 ≠ 在跑，见 running） */
  installed: boolean;
  /** `launchctl print system/<label>` 显示 state = running（非 root 也能读）；null = launchctl 不可用 / 未安装 */
  running: boolean | null;
  /** `pmset -g` 的 SleepDisabled 生效值；null = 读不到 */
  sleepDisabled: boolean | null;
  powerSource: PowerSource;
}
