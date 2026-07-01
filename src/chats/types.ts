export interface ChatState {
  chatId: string;
  activeTty?: string;
  /** /watch on → 监听所有 claude tab 的本地任务，自动推送进度卡片 */
  watchAllTabs?: boolean;
  createdAt: number;
  lastActiveAt: number;
}
