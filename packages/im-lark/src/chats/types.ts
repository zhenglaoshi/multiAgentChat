export interface ChatState {
  chatId: string;
  activeTty?: string;
  /** /watch on → 监听所有 claude tab 的本地任务，自动推送进度卡片 */
  watchAllTabs?: boolean;
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
  createdAt: number;
  lastActiveAt: number;
}

/** pendingAnswerTty 过期时间：10 分钟。举手后长时间不答 → 视为放弃。 */
export const PENDING_ANSWER_TTL_MS = 10 * 60 * 1000;
/** recentReplyTty 过期时间：5 分钟。sticky 对话在这段时间内每次回复自动刷新。 */
export const RECENT_REPLY_TTL_MS = 5 * 60 * 1000;
