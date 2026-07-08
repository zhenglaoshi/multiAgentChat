import { EventEmitter } from 'node:events';
import { logger } from 'multiagent-orchestrator';
import { enrichTabsWithCwd, getHistory, listTabsRaw } from 'multiagent-host-mac';
import type { TerminalTab } from 'multiagent-host-mac';
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
  // cwd cache：idle 且已知 cwd 的 tab 不再每 tick 重刷（省 ps+lsof）
  // 只在 tab busy / 有 pending / 首次见 / TTL 过期 时重取
  private cwdCache = new Map<string, { cwd: string; updatedAt: number }>();
  private static readonly CWD_STALE_MS = 5 * 60 * 1000; // 5min TTL 兜底

  constructor(opts: { pollMs?: number; renotifyMs?: number } = {}) {
    // 默认 1s poll —— 让飞书卡片有"接近流式"的更新节奏（原来 3s 太慢）
    // 可通过 WATCHER_POLL_MS env 调整（500ms 更快但 CPU 稍高；≥5000 会明显滞后）
    const envPoll = Number(process.env['WATCHER_POLL_MS']);
    this.pollMs =
      opts.pollMs ?? (Number.isFinite(envPoll) && envPoll >= 200 ? envPoll : 1000);
    this.renotifyMs = opts.renotifyMs ?? 60 * 60 * 1000; // 60 分钟再通知一次（避免同 tab 反复骚扰）
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

    // Claude 进程 tab 完全跳过 needsInput 检测：
    //   1. Claude 的 AskUserQuestion 组件绘制在 alt-screen buffer，`history of tab` 拿不到 →
    //      watcher 看到的是滚回区的 task list checkbox（`◻ ...`），会假阳性触发 pattern
    //   2. 触发后推给飞书的 promptSnippet 是 scrollback tail，跟真问题无关，
    //      手机端看到"要输入"但没有问题原文 —— 信息量为零反而添乱
    //   3. Claude 用 AskUserQuestion 时应自己主动 `agent lark send-text` 推问题+选项
    //      （skill 和 SYSTEM_GUIDANCE 里补了这条规则）
    const isClaudeTab = tab.processes.some((p) =>
      /(^|\/)claude(-code)?$/i.test(p) || p.toLowerCase().includes('claude'),
    );
    if (isClaudeTab) {
      // 保留 snapshot 便于其他逻辑（比如 processPendingByStability），但不做 waiting 判定
      const prev = this.snapshots.get(tab.tty);
      this.snapshots.set(tab.tty, {
        ...(prev ?? { tty: tab.tty, busy: tab.busy, waiting: false }),
        tty: tab.tty,
        busy: tab.busy,
        waiting: false,
        historyLen: arr.length,
      });
      return;
    }

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
   *
   * 优化：只对**需要**重取 cwd 的 tab 调 ps+lsof：
   *   - 首次见（cache 无记录）
   *   - tab 当前 busy（可能刚 cd）
   *   - 有 pending（该 tab 是任务派发目标）
   *   - cache 过期（超过 5min，兜底）
   * idle 且已缓存的 tab 直接复用，省 2 个 spawn/tab/tick。
   *
   * 极端场景：用户在 idle shell 手动 cd 又不跑命令 → dashboard 看到旧 cwd，
   * 但 5min TTL 会自然纠正；tab busy 后也立刻纠正。
   */
  private async enrichForCache(tabs: TerminalTab[]): Promise<TerminalTab[]> {
    const now = Date.now();
    const needsRefresh: TerminalTab[] = [];
    for (const t of tabs) {
      const cached = this.cwdCache.get(t.tty);
      const hasPending = pendingTracker.forTty(t.tty).length > 0;
      const stale = !cached || now - cached.updatedAt > TabWatcher.CWD_STALE_MS;
      if (!cached || t.busy || hasPending || stale) {
        needsRefresh.push(t);
      }
    }
    // 并发拿需要 refresh 的
    try {
      const refreshed = await enrichTabsWithCwd(needsRefresh);
      for (const t of refreshed) {
        if (t.cwd) this.cwdCache.set(t.tty, { cwd: t.cwd, updatedAt: now });
      }
    } catch {
      // 失败就 fallback 到 cache
    }
    // 清 cache 里已消失的 tab
    const seen = new Set(tabs.map((t) => t.tty));
    for (const tty of this.cwdCache.keys()) {
      if (!seen.has(tty)) this.cwdCache.delete(tty);
    }
    // 输出 tab：优先 cache（含新 refresh 的），否则原样返回（无 cwd）
    return tabs.map((t) => {
      const cached = this.cwdCache.get(t.tty);
      return cached ? { ...t, cwd: cached.cwd } : t;
    });
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
