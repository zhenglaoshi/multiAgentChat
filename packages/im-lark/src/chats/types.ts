export interface ChatState {
  chatId: string;
  activeTty?: string;
  /** /watch on → 监听所有 claude tab 的本地任务，自动推送进度卡片 */
  watchAllTabs?: boolean;
  /**
   * /quiet on → 该 chat 里所有 pending 只发首次 + 最终收尾卡，中途不 patch。
   * 适合专注其他任务、后台跑 build/长任务时。
   */
  quietMode?: boolean;
  /**
   * 一次性问题回路：某个 tab 通过 PreToolUse AskUserQuestion hook 推来问题、
   * 或 /shells 里 [→ 发一条] 显式 arm 时写入。下一次飞书无 @target 的回复
   * one-shot 路由到该 tty 而不是 activeTty，消耗后：
   *  - 若来源是"举手场景"（AskUserQuestion / arm） → 消耗 tty 提升到 recentReplyTty（sticky）
   *  - 若过期则回退到 activeTty
   */
  pendingAnswerTty?: string;
  /** pendingAnswerTty 的写入时间戳；超过 PENDING_ANSWER_TTL_MS 视为过期。 */
  pendingAnswerAt?: number;
  /**
   * 最近对话的 tab：pendingAnswerTty 消耗后 promote 到这里，形成 sticky 对话。
   * 之后 5 min 内的裸文本继续路由到该 tab（每次刷新 at），实现多轮对话
   * 免重复 @tty。@target 显式指定 / /use / [⭐ 切到此 shell] 会清空它。
   */
  recentReplyTty?: string;
  /** recentReplyTty 的最近命中时间戳；超过 RECENT_REPLY_TTL_MS 视为过期。 */
  recentReplyAt?: number;
  /**
   * 当前 armed 的 AskUserQuestion 交互（单问题单选）。PreToolUse hook 把
   * question+options 推来、daemon 反查到 origin tty 时写入（见 server handleLarkSendText）。
   * 存在 → 该 tty 正卡在 claude 原生"上下键选择菜单"里；飞书应答必须用 **pty 数字直选**（旧：方向键驱动）
   * （sendKeys `(index)↓ + 回车`），而不是 `do script` 打选项文本 —— 打文本移动不了
   * 菜单高亮、选不中（历史 bug：选项推飞书变纯文本、回复不起作用、shell 卡在选项处）。
   * 依赖"菜单刚渲染、高亮固定在第 1 项"的前提（远程只有飞书一方在操作 → 可靠）。
   * 被应答（点选项 / 裸数字或选项文本回复）后清除；本地作答由 PostToolUse hook 走
   * `ask.disarm` 清除；超 ASK_ARM_TTL_MS 视为过期。options 为有序 label 列表，index 0-based。
   */
  askArm?: { tty: string; options: string[]; at: number };
  /**
   * askArm 期间用户发来的**非选项文本**（映射不到任何选项、也不是取消口令）。
   * 不能直接注入：pty 回车必提交 → 会被粘进原生菜单并默认选第 1 项、原话丢失。
   * 先存这里，菜单被选中 / 取消（或 arm 因本地作答消失）后自动补发；超过 ASK_HELD_TTL_MS 丢弃。
   * `tty` = 这句话原本要去的 tab（补发按它找，不能用补发时刻的当前 tty，否则多 tab 会投错）；
   * `armAt` = 暂存时那一轮提问的标识，补发时若该 tty 已是新一轮菜单则放弃补发（避免被当成对新问题的应答）。
   * **已知限制**：per-chat 单槽位（不按 tty 存 Map）。两个 tab 几乎同时进入「arm 消失且有存件」时，后者覆盖前者
   * （有 replaced 日志 + 用户提示）；若两次补发窗口重叠，落地顺序可能颠倒。触发条件窄、不丢消息，暂不做 Map。
   */
  askHeld?: { text: string; at: number; messageId: string; tty: string; armAt: number };
  createdAt: number;
  lastActiveAt: number;
}

/** pendingAnswerTty 过期时间：10 分钟。举手后长时间不答 → 视为放弃。 */
export const PENDING_ANSWER_TTL_MS = 10 * 60 * 1000;
/** recentReplyTty 过期时间：5 分钟。sticky 对话在这段时间内每次回复自动刷新。 */
export const RECENT_REPLY_TTL_MS = 5 * 60 * 1000;
/**
 * askArm 过期时间：5 分钟。原生 AskUserQuestion 菜单弹出后长时间不答 → 视为已放弃 /
 * 已在本地作答；过期后飞书点选项 / 裸数字回复不再驱动菜单（避免注错已关闭的菜单）。
 */
export const ASK_ARM_TTL_MS = 5 * 60 * 1000;
/** askHeld 过期时间：10 分钟。菜单迟迟没处理 → 存着的那句话大概率已过时，不再补发。 */
export const ASK_HELD_TTL_MS = 10 * 60 * 1000;
/**
 * askHeld 文本长度上限：4000 字。超过就不暂存（提示用户答完菜单再重发）——
 * 存件会明文落到 ./data/chats/<chatId>.json，不该把大段内容写进去；截断又会毁掉补发的原文。
 */
export const ASK_HELD_MAX_LEN = 4000;
