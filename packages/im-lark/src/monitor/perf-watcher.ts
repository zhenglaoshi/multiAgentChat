import * as Lark from '@larksuiteoapi/node-sdk';
import {
  logger,
  loadPerfConfig,
  PerfApiClient,
  listActionablePerfItems,
  filterUnnotifiedPerf,
  markPerfNotified,
  savePerfItem,
  type PerfItem,
} from 'multiagent-orchestrator';
import { listAllChats } from '../chats/store.js';
import { sendCardMessage } from '../lark/api.js';
import { perfItemCard } from '../lark/cards.js';

const FIRST_TICK_DELAY_MS = 12_000;

/** 额外通知钩子（企微等），daemon 注入。返回是否成功推送。 */
export type PerfExtraNotify = (item: PerfItem) => Promise<boolean>;

/**
 * performance-platform 监听：每 pollMs 拉一次 pending recommendation（按 target/优先级/归属过滤），
 * 对没通知过（或状态变了）的推飞书卡让我认领 → 开 tab 修。纯 HTTP，不经 claude/LLM。
 * 缺 PERF_API_URL/USER/PASS 则不启。
 */
export function startPerfWatcher(client: Lark.Client, onExtraNotify?: PerfExtraNotify): void {
  const cfg = loadPerfConfig();
  if (!cfg.enabled) {
    logger.info('perf watcher 未启用（缺 PERF_API_URL / PERF_API_USER / PERF_API_PASS 任一）');
    return;
  }
  const api = new PerfApiClient(cfg.apiUrl, cfg.user, cfg.pass);

  const pushOne = async (item: PerfItem): Promise<boolean> => {
    savePerfItem(item); // 认领时据 id 取完整 item
    let ok = false;
    for (const chat of await listAllChats()) {
      try {
        await sendCardMessage(client, chat.chatId, perfItemCard(item));
        ok = true;
      } catch (e) {
        logger.warn('perf 卡片单 chat 推送失败(lark)', { chatId: chat.chatId, id: item.id, err: (e as Error).message });
      }
    }
    if (onExtraNotify) {
      try { if (await onExtraNotify(item)) ok = true; } catch (e) {
        logger.warn('perf extra-notify 失败', { id: item.id, err: (e as Error).message });
      }
    }
    return ok;
  };

  const tick = async (): Promise<void> => {
    try {
      const items = await listActionablePerfItems(api, cfg);
      const fresh = await filterUnnotifiedPerf(items);
      if (fresh.length === 0) return;
      logger.info('perf watcher 发现待通知', { total: items.length, fresh: fresh.length });
      const pushed: PerfItem[] = [];
      for (const it of fresh) { if (await pushOne(it)) pushed.push(it); }
      await markPerfNotified(pushed);
      logger.info('perf watcher 已推送', { pushed: pushed.length });
    } catch (e) {
      logger.warn('perf watcher tick 失败', { err: (e as Error).message });
    }
  };

  setInterval(() => void tick(), cfg.pollMs);
  setTimeout(() => void tick(), FIRST_TICK_DELAY_MS);
  logger.info('perf watcher started', {
    pollMs: cfg.pollMs, nick: cfg.nick,
    targets: cfg.targets.length ? cfg.targets : 'all',
    priorities: cfg.priorities,
    myRepos: cfg.myRepos.length ? cfg.myRepos : 'all',
  });
}
