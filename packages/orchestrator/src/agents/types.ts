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
  /**
   * 「这个 agent 正在等人选」的识别文案 —— 各 agent 的**原生**交互菜单长得不一样，
   * 通用判据（勾选框 / y-n / press enter）盖不住。
   *
   * 真实教训：codex 的命令审批菜单（"Would you like to run the following command?" +
   * "1. Yes, proceed (y)" + "Press enter to confirm"）**7 条通用判据一条都不命中**
   * —— 小写的 `press enter` 撞上要求大写 `Enter` 的正则、选项前缀是 `›` 不在 `[❯>►▶]` 里、
   * `(y)` 也不是 `(y/n)` 形式。结果是飞书连"codex 在等你选"这个提示都收不到。
   * 空数组 = 该 agent 只靠通用判据。
   */
  waitingPatterns: RegExp[];
  /**
   * 「这一屏确实是该 agent 的**原生交互菜单**」的高置信特征 —— 语义**与 `waitingPatterns` 不同**：
   *  - `waitingPatterns` 只驱动**显示**（推一句"⏳ 在等你选"），判错了最多是多推一条提示；
   *  - `nativeMenuPatterns` 驱动**按键注入**（把用户选的数字写进 pty），判错了会**往正在干活的
   *    tab 里注入一个数字**，可能被当成下一轮真实指令执行。代价完全不在一个量级。
   *
   * 因此这里的语义是 **全部命中（AND）**，且数组为空 = 该 agent 不启用原生菜单镜像。
   *
   * 真实教训（2026-09-15 评审）：最初把镜像的闸门接在 `waitingPatterns` + 通用判据的**并集**上，
   * 结果一段完全正常的 assistant 回答就能骗过全部三道闸：
   *     Do you want me to proceed with the fix?
   *     1. Yes, proceed and apply the patch now.
   *     2. No, show me the diff first...
   *     Press enter to see more of the changed files...
   * 「编号 1/2 + 是非问句 + press enter」在结构上与真菜单**完全同构**，而模型本来就常这么问问题。
   * 所以判据必须落在**只有该 agent 的菜单才会有的成对措辞**上，而不是结构特征。
   */
  nativeMenuPatterns: RegExp[];
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
