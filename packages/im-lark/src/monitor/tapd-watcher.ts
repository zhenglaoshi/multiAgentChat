import * as Lark from '@larksuiteoapi/node-sdk';
import {
  logger,
  loadTapdConfig,
  TapdMcpClient,
  listActionableItems,
  filterUnnotified,
  markNotified,
  ensureTapdMcp,
  tapdCooldownLeftMs,
  type TapdItem,
} from 'multiagent-orchestrator';
import { listAllChats } from '../chats/store.js';
import { sendCardMessage } from '../lark/api.js';
import { tapdItemCard } from '../lark/cards.js';

/** 启动后延迟首跑，等 lark client / WS 就绪。 */
const FIRST_TICK_DELAY_MS = 12_000;

/**
 * 额外通知钩子：给非飞书传输（如企微）用。返回是否成功推送。
 * 放 daemon 注入（daemon 能引 framework CardSpec + wecom transport，避免 im-lark↔framework 循环依赖）。
 */
export type TapdExtraNotify = (item: TapdItem) => Promise<boolean>;

/**
 * TAPD 监听：每 pollMs 拉一次"指派给我、当天更新、未结束"的缺陷/需求，
 * 对没通知过（或又更新了）的，推飞书卡片让我认领 → 建分支 → 开 tab。
 *
 * 检测走纯 HTTP（TapdMcpClient），不经 claude/LLM/CLI。缺 TAPD_* 配置则不启。
 */
export function startTapdWatcher(client: Lark.Client, onExtraNotify?: TapdExtraNotify): void {
  const cfg = loadTapdConfig();
  if (!cfg.enabled) {
    logger.info('tapd watcher 未启用（缺 TAPD_MCP_URL / TAPD_MCP_TOKEN / TAPD_NICK 任一）');
    return;
  }
  const mcp = new TapdMcpClient(cfg.mcpUrl, cfg.token);

  // 幂等把 TAPD MCP 注册给 Claude Code（工作 tab 里的 claude 能读/改 TAPD）
  void ensureTapdMcp(cfg);

  const pushOne = async (item: TapdItem): Promise<boolean> => {
    let ok = false;
    // 飞书：所有已知 chat，用丰富卡（toggle/patch 认领流）
    for (const chat of await listAllChats()) {
      try {
        await sendCardMessage(client, chat.chatId, tapdItemCard(item));
        ok = true;
      } catch (e) {
        logger.warn('tapd 卡片单 chat 推送失败(lark)', { chatId: chat.chatId, id: item.id, err: (e as Error).message });
      }
    }
    // 其它传输（企微等）：daemon 注入的钩子
    if (onExtraNotify) {
      try {
        if (await onExtraNotify(item)) ok = true;
      } catch (e) {
        logger.warn('tapd extra-notify 失败', { id: item.id, err: (e as Error).message });
      }
    }
    return ok;
  };

  const tick = async (): Promise<void> => {
    // 限流冷却期：整轮跳过，别硬轮询把配额越打越死（熔断由 client 层管理）。
    const cd = tapdCooldownLeftMs();
    if (cd > 0) {
      logger.info('tapd watcher tick 跳过（限流冷却中）', { cooldownLeftS: Math.ceil(cd / 1000) });
      return;
    }
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
