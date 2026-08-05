import * as Lark from '@larksuiteoapi/node-sdk';
import {
  logger,
  loadTapdConfig,
  TapdMcpClient,
  listActionableItems,
  classifyNotifications,
  markNotified,
  ensureTapdMcp,
  tapdCooldownLeftMs,
  type TapdItem,
  type TapdNotification,
  type TapdNotifyKind,
} from 'multiagent-orchestrator';
import { listAllChats } from '../chats/store.js';
import { sendCardMessage } from '../lark/api.js';
import { tapdItemCard, tapdInfoCard } from '../lark/cards.js';

/** TAPD_SPLIT_NOTIFY=0 → 回退旧行为（任何变动都推认领卡）；默认开（分级：认领卡 vs 提示卡）。 */
const SPLIT_NOTIFY = process.env['TAPD_SPLIT_NOTIFY'] !== '0';

/** 按分级选卡：claim → 认领卡；status/update → 轻量提示卡。 */
function cardFor(n: TapdNotification): unknown {
  if (!SPLIT_NOTIFY || n.kind === 'claim') return tapdItemCard(n.item);
  const d: { item: TapdItem; kind: 'status' | 'update'; prevStatus?: string; prevStatusLabel?: string } = {
    item: n.item,
    kind: n.kind,
  };
  if (n.prevStatus) d.prevStatus = n.prevStatus;
  if (n.prevStatusLabel) d.prevStatusLabel = n.prevStatusLabel;
  return tapdInfoCard(d);
}

/** 启动后延迟首跑，等 lark client / WS 就绪。 */
const FIRST_TICK_DELAY_MS = 12_000;

/**
 * 额外通知钩子：给非飞书传输（如企微）用。返回是否成功推送。
 * 放 daemon 注入（daemon 能引 framework CardSpec + wecom transport，避免 im-lark↔framework 循环依赖）。
 */
export type TapdExtraNotify = (item: TapdItem, kind: TapdNotifyKind) => Promise<boolean>;

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

  const pushOne = async (n: TapdNotification): Promise<boolean> => {
    let ok = false;
    const item = n.item;
    const card = cardFor(n);
    // 飞书：所有已知 chat。claim → 认领卡（toggle/patch 认领流）；status/update → 轻量提示卡。
    for (const chat of await listAllChats()) {
      try {
        await sendCardMessage(client, chat.chatId, card);
        ok = true;
      } catch (e) {
        logger.warn('tapd 卡片单 chat 推送失败(lark)', { chatId: chat.chatId, id: item.id, err: (e as Error).message });
      }
    }
    // 其它传输（企微等）：daemon 注入的钩子（带上 kind，供其决定推认领卡还是提示）
    if (onExtraNotify) {
      try {
        if (await onExtraNotify(item, n.kind)) ok = true;
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
      const notes = await classifyNotifications(items);
      if (notes.length === 0) return;
      logger.info('tapd watcher 发现待通知', {
        total: items.length,
        claim: notes.filter((n) => n.kind === 'claim').length,
        status: notes.filter((n) => n.kind === 'status').length,
        update: notes.filter((n) => n.kind === 'update').length,
      });
      const pushed: TapdItem[] = [];
      for (const n of notes) {
        if (await pushOne(n)) pushed.push(n.item);
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
