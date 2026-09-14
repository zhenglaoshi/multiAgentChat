/**
 * AgentAdapter —— 把"哪个编码 agent（claude / codex）"的差异收进一个接口，
 * 让本项目从绑死 Claude Code 解耦成多 agent。host-mac（进程识别/启动命令）、
 * daemon（回传通道安装）、im-lark（slash 转发）都消费同一份 adapter。
 *
 * 宿主形态（Terminal.app CLI vs 桌面 GUI）是**另一条正交轴**，由 HostBackend 抽象
 * 处理（见 docs/codex-integration.md）；本接口只管 agent 种类，默认宿主=Terminal CLI。
 */
export type AgentKind = 'claude' | 'codex';

/**
 * 回传通道规格：alt-screen TUI 下飞书看不见屏幕，靠 agent 的"turn 结束"钩子把最后
 * 一条 assistant 消息推回飞书。daemon 据此幂等安装。
 *  - claude：~/.claude/settings.json 的 hooks.Stop → 脚本，stdin 收 JSON，取 last_assistant_message
 *  - codex ：~/.codex/config.toml 的 notify = [脚本]，argv 收 JSON 串，取 last-assistant-message
 */
export interface AgentReturnChannel {
  kind: 'claude-stop-hook' | 'codex-notify';
  /** 配置文件路径（相对 $HOME，installer 展开） */
  configPathFromHome: string;
  /** 响应 payload 怎么传给钩子脚本 */
  payloadSource: 'stdin-json' | 'argv-json';
  /** assistant 文本在 payload 里的字段名 */
  messageField: string;
}

/** 本项目会挂钩的 agent 生命周期事件。claude / codex 两边同名同义（codex 0.154+ 对齐了 Claude Code 的 hook 协议）。 */
export type AgentHookEvent = 'Stop' | 'PreToolUse' | 'PostToolUse';

/** 一条 hook 安装规格：什么事件 + 匹配哪个工具 + 交给 bin/ 下哪个脚本。 */
export interface AgentHookSpec {
  event: AgentHookEvent;
  /**
   * 工具名匹配器。两边语义**不同**，别混用：
   *  - claude：字面量工具名（`'*'` = 全部）
   *  - codex ：正则，且是全值匹配（内部包成 `\A(?:…)\z`）→ 全部要写 `'.*'`，不是 `'*'`
   */
  matcher: string;
  /** bin/ 下的脚本文件名（daemon 解析成绝对路径后写进配置） */
  script: string;
  /** 这条 hook 干什么 —— 日志与文档用，不参与逻辑 */
  purpose: string;
  /**
   * 脚本执行超时（秒）。只有 codex 的 TOML 会落这一项（claude 侧保持历史写法不落，避免改动既有 settings.json）。
   * 阻塞型 hook（高危命令审批要等人点飞书卡）必须给足；fire-and-forget 的给小值即可。
   */
  timeoutSec?: number;
}

/**
 * agent 的 hook 安装点。daemon 据此幂等 upsert 到各自的配置文件：
 *  - claude：`~/.claude/settings.json` 的 `hooks.<Event>[]`（JSON）
 *  - codex ：`~/.codex/config.toml` 的 `[[hooks.<Event>]]`（TOML，codex 0.154+）
 * 两种格式的条目结构一致（`matcher` + `hooks: [{type:'command', command}]`）。
 */
export interface AgentHookInstall {
  /** 配置文件路径（相对 $HOME） */
  configPathFromHome: string;
  format: 'claude-settings-json' | 'codex-config-toml';
  specs: AgentHookSpec[];
}

export interface AgentAdapter {
  kind: AgentKind;
  /** 展示名（状态卡/引导用） */
  displayName: string;
  /** 二进制名（`which` 探测本机是否可运行 + 进程名基准） */
  binaryName: string;
  /** 进程名（已小写）是不是这个 agent */
  detect(procLower: string): boolean;
  /** 登录态识别文案（历史屏幕里出现 = 需要登录） */
  loginPatterns: RegExp[];
  /** 启动 / 续接命令（注入 tab 用） */
  launchCommand(opts?: { continueSession?: boolean }): string;
  /** 内建 slash 命令白名单（收到这些不当 mchat 未知命令，静默转发给 tab 里的 agent） */
  builtinSlashCommands: string[];
  /** skill 安装目录（相对 $HOME） */
  skillDirsFromHome: string[];
  /** 回传通道规格 */
  returnChannel: AgentReturnChannel;
  /** 生命周期 hook 安装规格（daemon 幂等 upsert 到 configPathFromHome）。空数组 = 该 agent 不装 hook。 */
  hookInstall: AgentHookInstall;
  /** 注入给 tab 的系统引导（首次 / 每 6h 一次）—— 问答方式按 agent 能力分流，见 guidance.ts */
  systemGuidance: string;
  /** 每条消息末尾追加的短提醒 */
  tuiReminder: string;
  /** true = 该 adapter 的 codex 专属值尚未本机验证（codex CLI 未安装时写的，供告警/文档标注） */
  unverified?: boolean;
}
