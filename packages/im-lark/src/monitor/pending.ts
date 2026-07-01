/**
 * 飞书发到 tab 的命令未完成 → 进 pending 队列。
 * watcher 后台跟踪：busy→idle 时 push 新增输出，长 busy 时中间 push。
 */

export interface PendingOutput {
  tty: string;
  cwd?: string;                // 任务发起时 tab 的 cwd（写入 memory 用）
  chatId: string;
  sentAt: number;
  beforeLen: number;
  lastPushedLen: number;
  intermediatePushAt?: number;
  taskDescription: string;     // 最初 prompt 摘要
  originalPrompt?: string;     // 完整 prompt（用于「重发」）
  targetLabel?: string;        // @target 字符串（如果是 @ 触发）
  source?: 'feishu' | 'local'; // 任务来源：飞书发起 / 本地用户输入

  // 实时进度卡片（patch 而非新发消息）
  progressMessageId?: string;  // 进度卡片的 message_id (单任务 / 非批量)
  lastPatchedLen?: number;     // 上次 patch 时的 history line count（用于 tail slice）
  lastPatchedAt?: number;      // 上次 patch 时间

  // 批量任务（≥2 个 @target 一条消息）
  batchId?: string;            // 一批共享 ID
  batchMessageId?: string;     // 批量聚合卡 message_id（共享）
  doneAt?: number;             // 任务终态时间（用于聚合卡显示）
  finalStatus?: 'completed' | 'failed' | 'cancelled' | 'timeout'; // 终态

  // 任务链 chain（A 完成 → 自动触发 B）
  chainId?: string;            // chainManager 里的 chain id
  chainStepIndex?: number;     // 当前是链的第几步（0-based）

  // 变化检测（用字符长度而非行数 — 适应 claude TUI \r 重绘）
  lastSeenCharLen?: number;    // 上次 tick 看到的字符总数
  beforeCharLen?: number;      // send 时的字符总数（baseline）

  // history-stability 跟踪
  lastSeenLen?: number;        // 上次 tick 看到的 history line count（兼容字段）
  stableSince?: number;        // 字符数稳定起始时间
  pushedAtStableLen?: number;  // 已 push 过的 stable line count（避免重复 push）
}

export interface DoneRecord {
  tty: string;
  chatId: string;
  taskDescription: string;
  doneAt: number;
  batchId?: string;
  finalStatus?: 'completed' | 'failed' | 'cancelled' | 'timeout';
  outputTailShort?: string;
}

class PendingTracker {
  private items = new Map<string, PendingOutput[]>();
  private done: DoneRecord[] = [];
  private static DONE_LIMIT = 30;

  add(p: PendingOutput): void {
    const arr = this.items.get(p.tty) ?? [];
    arr.push(p);
    this.items.set(p.tty, arr);
  }

  forTty(tty: string): PendingOutput[] {
    return this.items.get(tty) ?? [];
  }

  remove(tty: string, sentAt: number): void {
    const arr = this.items.get(tty);
    if (!arr) return;
    const removed = arr.find((p) => p.sentAt === sentAt);
    const remaining = arr.filter((p) => p.sentAt !== sentAt);
    if (remaining.length) this.items.set(tty, remaining);
    else this.items.delete(tty);
    if (removed) {
      this.done.unshift({
        tty: removed.tty,
        chatId: removed.chatId,
        taskDescription: removed.taskDescription,
        doneAt: removed.doneAt ?? Date.now(),
        ...(removed.batchId ? { batchId: removed.batchId } : {}),
        ...(removed.finalStatus ? { finalStatus: removed.finalStatus } : {}),
      });
      if (this.done.length > PendingTracker.DONE_LIMIT) {
        this.done = this.done.slice(0, PendingTracker.DONE_LIMIT);
      }
    }
  }

  removeByTty(tty: string): void {
    this.items.delete(tty);
  }

  all(): PendingOutput[] {
    const out: PendingOutput[] = [];
    for (const arr of this.items.values()) out.push(...arr);
    return out;
  }

  forBatch(batchId: string): PendingOutput[] {
    return this.all().filter((p) => p.batchId === batchId);
  }

  /** 拿包括已完成的 done 记录（用于聚合卡渲染已结束的 task） */
  recentForBatch(batchId: string): { active: PendingOutput[]; done: DoneRecord[] } {
    const active = this.forBatch(batchId);
    const done = this.done.filter((d) => (d as DoneRecord & { batchId?: string }).batchId === batchId);
    return { active, done };
  }

  count(): number {
    let n = 0;
    for (const arr of this.items.values()) n += arr.length;
    return n;
  }

  recentDone(limit = 10): DoneRecord[] {
    return this.done.slice(0, limit);
  }
}

export const pendingTracker = new PendingTracker();
