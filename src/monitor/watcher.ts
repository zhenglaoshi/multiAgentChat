import { EventEmitter } from 'node:events';
import { logger } from '../logger.js';
import { enrichTabsWithCwd, getHistory, listTabsRaw } from '../terminal/tabs.js';
import type { TerminalTab } from '../terminal/types.js';
import { detectWaitingForInput } from './detector.js';
import { pendingTracker, type PendingOutput } from './pending.js';

interface TabSnapshot {
  tty: string;
  busy: boolean;
  waiting: boolean;
  waitingSince?: number;
  notifiedAt?: number;
  historyLen?: number;
  /** 本地任务跟踪：上次 trigger localTaskDetected 时的 history 行数 */
  localBaselineLen?: number;
  localLastTriggerAt?: number;
}

export interface WatcherEvents {
  needsInput: (payload: { tab: TerminalTab; promptSnippet: string }) => void;
  resolved: (payload: { tty: string }) => void;
  taskOutput: (payload: {
    pending: PendingOutput;
    tab: TerminalTab;
    output: string;
    outputTail: string;       // 整 tab 累积 tail（用于卡片展示）
    taskOnlyTail: string;     // 仅本任务新增内容 tail（用于 memory 记录，避免抓到历史 noise）
    isFinal: boolean;
  }) => void;
  /** 检测到本地用户在 claude tab 里发了显著操作（history 显著增长）。
   *  notifier 收到后会对所有 watchAllTabs=true 的 chat 发 progress card + 创建 pending。 */
  localTaskDetected: (payload: {
    tab: TerminalTab;
    beforeLen: number;
    currentLen: number;
    outputTail: string;
  }) => void;
  error: (err: Error) => void;
}

const PENDING_HARD_TIMEOUT_MS = 60 * 60 * 1000;
const PARAGRAPH_STABLE_MS = 30 * 1000;
const STABLE_REMOVE_MS = 3 * 60 * 1000;
const PATCH_THROTTLE_MS = 3500;
const OUTPUT_TAIL_LINES = 60;

// 本地任务检测
const LOCAL_TRIGGER_LINES = 8;       // history 增长 ≥ 8 行 = 显著事件
const LOCAL_COOLDOWN_MS = 30_000;    // trigger 后 30s 内不再 trigger 同一 tab

export class TabWatcher {
  readonly events = new EventEmitter();
  private snapshots = new Map<string, TabSnapshot>();
  private interval?: NodeJS.Timeout;
  private running = false;
  private isFirstTick = true;
  private pollMs: number;
  private renotifyMs: number;

  // Cache：每 tick 拿到的 tabs 和 histories，供 dashboard / commands 复用避免重复 osascript
  private cachedTabs: TerminalTab[] = [];
  private cachedHistories = new Map<string, string>();
  private cacheUpdatedAt = 0;

  constructor(opts: { pollMs?: number; renotifyMs?: number } = {}) {
    this.pollMs = opts.pollMs ?? 3000;
    this.renotifyMs = opts.renotifyMs ?? 10 * 60 * 1000; // 10 分钟再通知一次
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      void this.tick();
    }, this.pollMs);
    logger.info('tab watcher started', { pollMs: this.pollMs });
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;          // 上一次还没跑完，跳过
    this.running = true;
    try {
      const tabs = await listTabsRaw();
      // 异步并发拿 cwd（cache 用，dashboard 看到的 tab 含 cwd）
      const tabsWithCwd = await this.enrichForCache(tabs);
      this.cachedTabs = tabsWithCwd;
      this.cacheUpdatedAt = Date.now();
      const seenTtys = new Set<string>();
      // 并发处理所有 tab（每个 tab 一次 osascript，但 idle 直接 skip）
      // 注：processTab 内部用 listTabsRaw 拿到的 tab（无 cwd），cache 自己增强 cwd 不影响这里
      await Promise.all(
        tabs.map((tab) => {
          seenTtys.add(tab.tty);
          return this.processTab(tab).catch((e) => {
            logger.warn('processTab failed', { tty: tab.tty, err: (e as Error).message });
          });
        }),
      );
      // 清掉已经不存在的 tab 的 snapshot 和 cached history
      for (const tty of this.snapshots.keys()) {
        if (!seenTtys.has(tty)) this.snapshots.delete(tty);
      }
      for (const tty of this.cachedHistories.keys()) {
        if (!seenTtys.has(tty)) this.cachedHistories.delete(tty);
      }
      if (this.isFirstTick) {
        this.isFirstTick = false;
        logger.info('watcher first tick baseline established', {
          tabs: tabs.length,
        });
      }
    } catch (e) {
      this.events.emit('error', e as Error);
      logger.warn('watcher tick failed', { err: (e as Error).message });
    } finally {
      this.running = false;
    }
  }

  private async processTab(tab: TerminalTab): Promise<void> {
    if (tab.hasTUI) {
      this.snapshots.set(tab.tty, {
        tty: tab.tty,
        busy: tab.busy,
        waiting: false,
      });
      return;
    }

    const hasPending = pendingTracker.forTty(tab.tty).length > 0;

    // 如果有 pending，无论 busy 都拿一次 history 做稳定性检测
    // 否则 idle tab 跳过 history 调用（性能）
    let fullHist = '';
    let arr: string[] = [];
    if (hasPending || tab.busy) {
      try {
        fullHist = await getHistory(tab.tty);
        arr = fullHist.split('\n');
        this.cachedHistories.set(tab.tty, fullHist);
      } catch {
        return;
      }
    }

    if (hasPending) {
      this.processPendingByStability(tab, arr, fullHist);
    } else if (tab.busy) {
      // 没有 pending（不是飞书发起）+ tab 在 busy → 探测本地任务
      // 不限制 claude，普通 shell 跑的命令（npm test / 长 log 等）也要观察
      // 防误报靠 LOCAL_TRIGGER_LINES (8 行) + LOCAL_COOLDOWN_MS (30s)
      this.detectLocalTask(tab, arr);
    }

    if (!tab.busy) {
      const prev = this.snapshots.get(tab.tty);
      if (prev?.waiting) this.events.emit('resolved', { tty: tab.tty });
      this.snapshots.set(tab.tty, {
        tty: tab.tty,
        busy: false,
        waiting: false,
      });
      return;
    }

    const tail = arr.slice(-30).join('\n');

    const det = detectWaitingForInput(tail, tab.busy);
    const prev = this.snapshots.get(tab.tty);

    const next: TabSnapshot = {
      tty: tab.tty,
      busy: tab.busy,
      waiting: det.waiting,
      historyLen: arr.length,
    };

    if (det.waiting) {
      // 第一次 tick 不通知（只建立 baseline，防止 dev 启动 spam）
      if (this.isFirstTick) {
        next.waitingSince = Date.now();
        next.notifiedAt = undefined;
      } else {
        // 状态转变 idle/busy -> waiting，或 waiting 持续超 renotifyMs 重发
        const newlyWaiting = !prev?.waiting;
        const stale =
          prev?.notifiedAt !== undefined &&
          Date.now() - prev.notifiedAt > this.renotifyMs;
        if (newlyWaiting || stale) {
          next.waitingSince = prev?.waiting ? prev.waitingSince : Date.now();
          next.notifiedAt = Date.now();
          const snippet = det.promptSnippet ?? '';
          logger.info('tab needs input', {
            tty: tab.tty,
            pattern: det.matchedPattern,
          });
          this.events.emit('needsInput', { tab, promptSnippet: snippet });
        } else {
          next.waitingSince = prev?.waitingSince;
          next.notifiedAt = prev?.notifiedAt;
        }
      }
    } else if (prev?.waiting) {
      // 从 waiting 退出
      this.events.emit('resolved', { tty: tab.tty });
    }

    this.snapshots.set(tab.tty, next);
  }

  /**
   * 本地任务自动跟踪：claude tab busy 且 history 显著增长（≥ LOCAL_TRIGGER_LINES）→ emit。
   * baseline 在第一次见到 tab 时建立；trigger 后 cooldown LOCAL_COOLDOWN_MS 避免重复。
   * 一旦 emit，notifier 会接管（创建 pending + 发 progress card），后续走 pending 流程。
   */
  private detectLocalTask(tab: TerminalTab, arr: string[]): void {
    const prev = this.snapshots.get(tab.tty);
    const currentLen = arr.length;
    const now = Date.now();

    // 第一次见 → 建 baseline 不 trigger
    if (this.isFirstTick || prev?.localBaselineLen === undefined) {
      this.snapshots.set(tab.tty, {
        ...(prev ?? { tty: tab.tty, busy: tab.busy, waiting: false }),
        tty: tab.tty,
        busy: tab.busy,
        waiting: prev?.waiting ?? false,
        localBaselineLen: currentLen,
      });
      return;
    }

    // cooldown 内不 trigger
    if (
      prev.localLastTriggerAt &&
      now - prev.localLastTriggerAt < LOCAL_COOLDOWN_MS
    ) {
      // 但要持续刷新 baseline 让 trigger 后的输出归属到下次
      return;
    }

    const growth = currentLen - prev.localBaselineLen;
    if (growth < LOCAL_TRIGGER_LINES) return;

    // 显著增长 → emit
    const outputTail = arr.slice(-OUTPUT_TAIL_LINES).join('\n');
    logger.info('local task detected', {
      tty: tab.tty,
      baseline: prev.localBaselineLen,
      current: currentLen,
      growth,
    });
    this.events.emit('localTaskDetected', {
      tab,
      beforeLen: prev.localBaselineLen,
      currentLen,
      outputTail,
    });
    // 更新 baseline + cooldown 时间
    this.snapshots.set(tab.tty, {
      ...prev,
      localBaselineLen: currentLen,
      localLastTriggerAt: now,
    });
  }

  /**
   * 实时进度跟踪：用 **字符长度**（不是行数！）检测变化。
   *
   * 为什么用字符长度？claude code 是 TUI 程序，用 \r 在同一行原地重绘，
   * 行数（split('\n').length）几乎不增长但字符在不断变化。用行数会误判"稳定"。
   *
   * 行数仍用作 tail slice（拿最近 60 行作展示）。
   */
  private processPendingByStability(
    tab: TerminalTab,
    arr: string[],
    fullHist: string,
  ): void {
    const pendings = pendingTracker.forTty(tab.tty);
    const currentLen = arr.length;
    const currentCharLen = fullHist.length;
    const now = Date.now();
    const outputTail = arr.slice(-OUTPUT_TAIL_LINES).join('\n');

    const computeTaskOnlyTail = (beforeCharLen: number | undefined): string => {
      if (beforeCharLen === undefined || beforeCharLen >= currentCharLen) {
        return '';
      }
      const onlyThis = fullHist.slice(beforeCharLen);
      const taskArr = onlyThis.split('\n');
      return taskArr.slice(-OUTPUT_TAIL_LINES).join('\n');
    };

    for (const p of pendings) {
      // hard timeout
      if (now - p.sentAt > PENDING_HARD_TIMEOUT_MS) {
        logger.warn('pending hard timeout, dropping', {
          tty: tab.tty,
          age: now - p.sentAt,
        });
        this.events.emit('taskOutput', {
          pending: p,
          tab,
          output: '(超过 1h 硬超时)',
          outputTail,
          taskOnlyTail: computeTaskOnlyTail(p.beforeCharLen),
          isFinal: true,
        });
        pendingTracker.remove(tab.tty, p.sentAt);
        continue;
      }

      const lastSeenCharLen = p.lastSeenCharLen ?? p.beforeCharLen ?? currentCharLen;
      const lastPatchedAt = p.lastPatchedAt ?? p.sentAt;
      const lastPatchedLen = p.lastPatchedLen ?? p.beforeLen;
      const charChanged = currentCharLen !== lastSeenCharLen;

      if (charChanged) {
        // 字符长度变了 — claude 在重绘 or 输出新行
        p.lastSeenCharLen = currentCharLen;
        p.lastSeenLen = currentLen;
        p.stableSince = undefined;

        // 节流 patch
        if (now - lastPatchedAt >= PATCH_THROTTLE_MS) {
          this.events.emit('taskOutput', {
            pending: p,
            tab,
            output: arr.slice(lastPatchedLen).join('\n').trim(),
            outputTail,
            taskOnlyTail: computeTaskOnlyTail(p.beforeCharLen),
            isFinal: false,
          });
          p.lastPatchedLen = currentLen;
          p.lastPatchedAt = now;
          p.lastPushedLen = currentLen;
        }
      } else {
        // history 没增长 — 累计稳定时间
        if (p.stableSince === undefined) {
          p.stableSince = now;
          p.lastSeenLen = currentLen;
        }
        const stableFor = now - p.stableSince;

        // 段落稳定（30s）：catch-up patch 一次，但保持 running（pending 不移除）
        // 这样后续如果 claude 又开始输出，仍然被跟踪
        if (
          stableFor >= PARAGRAPH_STABLE_MS &&
          currentLen > lastPatchedLen &&
          (!p.lastPatchedAt || now - p.lastPatchedAt > PARAGRAPH_STABLE_MS / 2)
        ) {
          logger.info('pending paragraph stable, catch-up patch', {
            tty: tab.tty,
            chatId: p.chatId,
            stableForMs: stableFor,
          });
          this.events.emit('taskOutput', {
            pending: p,
            tab,
            output: arr.slice(lastPatchedLen).join('\n').trim(),
            outputTail,
            taskOnlyTail: computeTaskOnlyTail(p.beforeCharLen),
            isFinal: false,
          });
          p.lastPatchedLen = currentLen;
          p.lastPatchedAt = now;
        }

        // 真正稳定（3 分钟）= 任务完成，发 final + remove pending
        if (stableFor >= STABLE_REMOVE_MS) {
          logger.info('pending task done (3min stable)', {
            tty: tab.tty,
            chatId: p.chatId,
            stableForMs: stableFor,
            totalLines: currentLen - p.beforeLen,
          });
          this.events.emit('taskOutput', {
            pending: p,
            tab,
            output: arr.slice(lastPatchedLen).join('\n').trim(),
            outputTail,
            taskOnlyTail: computeTaskOnlyTail(p.beforeCharLen),
            isFinal: true,
          });
          pendingTracker.remove(tab.tty, p.sentAt);
        }
      }
    }
  }

  /**
   * 内部：每 tick 给 tabs 加 cwd（用于 cache）。
   * 注意性能 — 14 tabs 并发拿 cwd ~200ms，可接受。
   */
  private async enrichForCache(tabs: TerminalTab[]): Promise<TerminalTab[]> {
    try {
      return await enrichTabsWithCwd(tabs);
    } catch {
      return tabs;
    }
  }

  /** 拿最近一次 tick 的 tabs（带 cwd）。给 dashboard / commands 复用，避免重复 osascript */
  getCachedTabs(): TerminalTab[] {
    return this.cachedTabs;
  }

  getCachedHistory(tty: string): string | undefined {
    return this.cachedHistories.get(tty);
  }

  /** cache 时戳（ms since epoch），太老的话 caller 可以选择 fallback to osascript */
  getCacheAge(): number {
    return Date.now() - this.cacheUpdatedAt;
  }
}

export const watcher = new TabWatcher();
