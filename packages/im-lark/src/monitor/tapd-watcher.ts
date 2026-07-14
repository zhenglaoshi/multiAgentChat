import * as Lark from '@larksuiteoapi/node-sdk';
import {
  logger,
  loadTapdConfig,
  TapdMcpClient,
  listActionableItems,
  filterUnnotified,
  markNotified,
  ensureTapdMcp,
  type TapdItem,
} from 'multiagent-orchestrator';
import { listAllChats } from '../chats/store.js';
import { sendCardMessage } from '../lark/api.js';
import { tapdItemCard } from '../lark/cards.js';

/** 启动后延迟首跑，等 lark client / WS 就绪。 */
const FIRST_TICK_DELAY_MS = 12_000;

/**
 * TAPD 监听：每 pollMs 拉一次"指派给我、当天更新、未结束"的缺陷/需求，
 * 对没通知过（或又更新了）的，推飞书卡片让我认领 → 建分支 → 开 tab。
 *
 * 检测走纯 HTTP（TapdMcpClient），不经 claude/LLM/CLI。缺 TAPD_* 配置则不启。
 */
export function startTapdWatcher(client: Lark.Client): void {
  const cfg = loadTapdConfig();
  if (!cfg.enabled) {
    logger.info('tapd watcher 未启用（缺 TAPD_MCP_URL / TAPD_MCP_TOKEN / TAPD_NICK 任一）');
    return;
  }
  const mcp = new TapdMcpClient(cfg.mcpUrl, cfg.token);

  // 幂等把 TAPD MCP 注册给 Claude Code（工作 tab 里的 claude 能读/改 TAPD）
  void ensureTapdMcp(cfg);

  const pushOne = async (item: TapdItem): Promise<boolean> => {
    const chats = await listAllChats();
    if (chats.length === 0) return false;
    let ok = false;
    for (const chat of chats) {
      try {
        await sendCardMessage(client, chat.chatId, tapdItemCard(item));
        ok = true;
      } catch (e) {
        logger.warn('tapd 卡片单 chat 推送失败', {
          chatId: chat.chatId,
          id: item.id,
          err: (e as Error).message,
        });
      }
    }
    return ok;
  };

  const tick = async (): Promise<void> => {
    try {
      const items = await listActionableItems(mcp, cfg, { systems: cfg.systems });
      const fresh = await filterUnnotified(items);
      if (fresh.length === 0) return;
      logger.info('tapd watcher 发现待通知', { total: items.length, fresh: fresh.length });
      const pushed: TapdItem[] = [];
      for (const it of fresh) {
        if (await pushOne(it)) pushed.push(it);
      }
      await markNotified(pushed);
      logger.info('tapd watcher 已推送', { pushed: pushed.length });
    } catch (e) {
      logger.warn('tapd watcher tick 失败', { err: (e as Error).message });
    }
  };

  setInterval(() => void tick(), cfg.pollMs);
  setTimeout(() => void tick(), FIRST_TICK_DELAY_MS);

  logger.info('tapd watcher started', {
    pollMs: cfg.pollMs,
    nick: cfg.nick,
    workspaces: cfg.workspaceIds.length ? cfg.workspaceIds : 'auto(全部参与项目)',
  });
}
