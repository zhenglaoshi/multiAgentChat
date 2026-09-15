/**
 * HostController · 抽象「一台机器上的终端宿主」能提供的能力。
 *
 * 对标 [`IMTransport`](../../framework/src/im/transport.ts)：IM 侧一个接口让飞书/企微并存，
 * 宿主侧这个接口让 macOS（`multiagent-host-mac`，AppleScript + Terminal.app）与将来的
 * Windows（ConPTY）/ Linux 实现并存。
 *
 * 分层约定：
 *  - **本包只有契约，没有任何实现**，也不 spawn 任何进程 —— 所以它是叶子（只依赖 orchestrator 取 AgentKind）。
 *  - 上层（framework / im-lark）**只 import 本包**，进程启动时由 daemon 调
 *    [`setHost()`](./registry.ts) 注入具体实现。
 *  - 调用方想写平台分支时读 [`capabilities`](#HostCapabilities)，别再散落 `platform() !== 'darwin'`。
 *
 * 接口设计原则：**所有方法都必须存在**（不做 optional 方法），宿主没有的能力返回「不支持」的
 * 安全值（空数组 / ok:true / null），并在 `capabilities` 里如实标 false。这样调用方不写
 * `host.x?.()` 这种到处漏判的代码，只在**真要分支提示用户**时才看 capabilities。
 */

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
  TerminalTab,
  UserFocus,
  WaitForOutputOptions,
} from './types.js';
import type { AgentKind } from 'multiagent-orchestrator';

/**
 * 宿主能力声明 —— 调用方据此**降级**而不是崩溃/空转。
 * 例：Windows 下没有 TCC，`permissionModel:false` → host-permission-probe 直接不启动。
 */
export interface HostCapabilities {
  /** `process.platform` 值，仅用于日志/诊断展示 */
  readonly platform: NodeJS.Platform;
  /** 人类可读的宿主名（"macOS Terminal.app"）—— doctor / 告警文案用 */
  readonly displayName: string;
  /**
   * 能否注入**非回车**按键（Ctrl-C / Esc / 方向键）。
   * macOS 走 System Events，需 Accessibility 授权且锁屏时静默失败（见 CLAUDE.md）。
   */
  readonly keyInjection: boolean;
  /** 能否截 tab 所在窗口的图 */
  readonly screenCapture: boolean;
  /** 能否判断屏幕是否锁着（决定按键注入要不要如实告知"送不进去"） */
  readonly screenLockDetection: boolean;
  /**
   * 按键注入会不会被**锁屏**挡住。
   *
   * macOS = true：System Events 在锁屏下送不进终端却返回 ok（假成功），所以调用方必须先
   * `isScreenLocked()` 确认没锁才敢发 Esc/方向键，读不到状态时保守拒绝。
   * tmux / 直写 pty 的宿主 = false：字节由后台进程直接写进自己持有的 pty，不经窗口系统与焦点，
   * 锁屏照送 —— 这类宿主的 `isScreenLocked()` 返回 null（它确实不知道屏幕状态），
   * **调用方必须读本位而不是读 `isScreenLocked()`**，否则"读不到锁屏状态"会把功能永久判死。
   */
  readonly keyInjectionBlockedWhenLocked: boolean;
  /** 有无 TCC 式的宿主授权模型（false → 授权探针/卡片整套跳过） */
  readonly permissionModel: boolean;
  /** 有无「合盖不睡」守护（false → lid-awake 探针跳过） */
  readonly keepAwake: boolean;
}

export interface HostController {
  readonly capabilities: HostCapabilities;

  // ---- tab 枚举与读取 ----

  /** 列 tab，**不**补 cwd（快，watcher 每 tick 用） */
  listTabsRaw(): Promise<TerminalTab[]>;
  /** 列 tab 并补 cwd（慢，命令/面板用） */
  listTabs(): Promise<TerminalTab[]>;
  /** 给一批 tab 补 cwd */
  enrichTabsWithCwd(tabs: TerminalTab[]): Promise<TerminalTab[]>;
  getCwd(tty: string): Promise<string | undefined>;
  /** 取 scrollback 全文。⚠ 变化检测一律用字符数不是行数（见 CLAUDE.md） */
  getHistory(tty: string): Promise<string>;
  /** daemon 自己所在的 tty（用于拒绝自杀式操作） */
  detectSelfTty(): string | undefined;
  /** 前台焦点状况 */
  getUserFocus(): Promise<UserFocus>;
  /** 屏幕是否锁着；null = 未知（拿不到时调用方按「未知」处理，别当没锁） */
  isScreenLocked(timeoutMs?: number): Promise<boolean | null>;

  // ---- 往 tab 写 ----

  /** 送一行文本（宿主负责必要的转义/换行语义） */
  send(tty: string, text: string): Promise<SendResult>;
  /** 送裸文本、不加包装；`text=''` 即「只送一个回车」 */
  sendKeysRaw(tty: string, text: string): Promise<boolean>;
  /** 提交一次回车（TUI 里 send 出去的文本不会自动提交） */
  forceEnter(tty: string, opts?: ForceEnterOptions): Promise<ForceEnterResult>;
  /** 注入按键序列（'ctrl+c' / 'down down enter'）。capabilities.keyInjection=false 时宿主应抛错 */
  sendKeys(tty: string, tokens: string | string[], opts?: SendKeysOptions): Promise<void>;
  /** 送一个 Ctrl-C（解卡用；高频调用会抢焦点，别滥用） */
  sendCtrlC(tty: string): Promise<void>;
  /** 送完等输出稳定，返回新增内容 */
  waitForOutput(tty: string, beforeLineCount: number, opts?: WaitForOutputOptions): Promise<string>;

  // ---- tab 生命周期 ----

  /** 开新 tab，返回其 tty */
  newTab(opts?: NewTabOptions): Promise<string>;
  /** 硬关 tab（不先退 agent） */
  closeTab(tty: string): Promise<boolean>;
  /** 先优雅退 agent 再关 tab；拒绝关 daemon 自己那个 */
  closeTabGracefully(tty: string, opts?: CloseTabOptions): Promise<CloseTabResult>;
  /** 优雅退出 tab 里在跑的 agent（连发 Ctrl-C 直到进程消失） */
  exitAgentInTab(tty: string, opts?: ExitAgentOptions): Promise<ExitAgentResult>;
  /** 原地重启 tab 里的 agent（不关窗、保留 cwd） */
  restartAgentInPlace(tty: string, opts?: RestartAgentOptions): Promise<RestartAgentResult>;
  /** 在已停在 shell prompt 的 tab 里起指定 agent（并过 trust 弹窗） */
  launchAgentInTab(tty: string, kind: AgentKind, opts?: LaunchAgentOptions): Promise<LaunchAgentResult>;
  /** 同上但用 `MCHAT_DEFAULT_AGENT` 决定 agent 种类 */
  launchDefaultAgentInTab(tty: string, opts?: LaunchAgentOptions): Promise<LaunchDefaultAgentResult>;

  // ---- 观测 ----

  /** tab 在跑 agent 吗（进程名匹配，宿主相关） */
  isAgentTab(tab: TerminalTab): boolean;
  /** 由进程列表 + scrollback 尾巴推断 tab 状态（进程名集合宿主相关） */
  inferTabStatus(tab: TerminalTab, historyTail?: string): TabStatusInfo;
  /** 截 tab 所在窗口的图，返回本地 png 路径。capabilities.screenCapture=false 时应抛错 */
  captureScreen(tty: string): Promise<string>;

  // ---- 宿主自检 ----

  /** 列本宿主的授权项规格；无授权模型 → [] */
  listPermissionSpecs(): HostPermissionSpec[];
  /** 取单个授权项规格；不存在 → undefined */
  getPermissionSpec(id: HostPermissionId): HostPermissionSpec | undefined;
  /** 探各授权项是否已授；无授权模型 → []（**无副作用**，探针必须无害） */
  detectHostPermissions(): Promise<HostPermissionStatus[]>;
  /** 打开系统授权面板；无授权模型 → no-op */
  openPermissionPane(pane: PermissionPane): void;
  /** 自检按键注入通路是否可用（绝不真按键）；无此通路 → { ok: true } */
  probeKeyInjection(): Promise<KeyInjectionProbeResult>;

  // ---- 电源 / 合盖 ----

  /** 「合盖不睡」守护的安装命令（无此能力 → null，调用方不要提示用户装） */
  readonly keepAwakeInstallCmd: string | null;
  /** 探「合盖不睡」状态；无此能力 → isLaptop:false / installed:false */
  detectKeepAwake(): Promise<KeepAwakeState>;
}
