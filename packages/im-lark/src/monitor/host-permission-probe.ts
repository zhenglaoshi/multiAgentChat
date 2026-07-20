import { platform } from 'node:os';
import * as Lark from '@larksuiteoapi/node-sdk';
import { logger } from 'multiagent-orchestrator';
import { detectHostPermissions, type HostPermissionStatus } from 'multiagent-host-mac';
import { listAllChats } from '../chats/store.js';
import { sendTextMessage, sendCardMessage } from '../lark/api.js';
import { hostPermissionCard } from '../lark/cards.js';

/** 每 2 分钟自检一次（授权状态是持久态，不需要更密；用户在系统设置里改完这里最多 2min 感知）。 */
const PROBE_INTERVAL_MS = 120_000;
/** 持续缺权限时，每 30 分钟再提醒一次（避免刷屏，也避免报一次就忘）。 */
const REALERT_INTERVAL_MS = 30 * 60_000;

const RECOVERED_ALERT =
  '✅ macOS 授权已恢复 —— 相关功能重新可用（Terminal 控制 / 按键注入 / 关 tab / 回车提交）。';

/**
 * 后台自检本项目依赖的三个 macOS TCC 授权（Automation→Terminal / Automation→System Events /
 * Accessibility）。与 startSystemEventsProbe（探术语通路）**并列、各司其职**：这个探"授了没"，
 * 那个探"术语坏没坏"。
 *
 * 只在**授权集合翻转**时推送，避免刷屏：
 *  - 出现新的缺失（或缺失集合变化）→ 立刻向所有 chat 报警，列出缺哪项 + 会废哪些功能 + 怎么授；
 *    持续缺失每 30min 再提醒。
 *  - 全部补齐 → 发一条恢复通知。
 *
 * 把原本"doctor 全绿但功能其实是坏的"这类隐蔽假绿，变成飞书显性、可行动的告警。
 */
export function startHostPermissionProbe(client: Lark.Client): void {
  if (platform() !== 'darwin') {
    logger.info('host-permission probe skipped (non-darwin)');
    return;
  }

  // null = 尚未探测；'' = 全部已授；否则 = 缺失项 id 排序后 join（集合指纹）
  let lastDeniedKey: string | null = null;
  let lastAlertAt = 0;

  const broadcast = async (kind: 'card' | 'text', payload: unknown): Promise<void> => {
    const chats = await listAllChats();
    if (chats.length === 0) {
      logger.warn('host-permission probe：无 chat 可推送告警');
      return;
    }
    for (const chat of chats) {
      try {
        if (kind === 'card') await sendCardMessage(client, chat.chatId, payload as Record<string, unknown>);
        else await sendTextMessage(client, chat.chatId, payload as string);
      } catch (e) {
        logger.warn('host-permission 告警单 chat 推送失败', { chatId: chat.chatId, err: (e as Error).message });
      }
    }
  };

  const tick = async (): Promise<void> => {
    let statuses: HostPermissionStatus[];
    try {
      statuses = await detectHostPermissions();
    } catch (e) {
      logger.warn('host-permission 探测失败（跳过本轮）', { err: (e as Error).message });
      return;
    }
    const denied = statuses.filter((s) => !s.granted);
    const key = denied.map((d) => d.id).sort().join(',');
    const now = Date.now();

    if (key !== '') {
      const changed = key !== lastDeniedKey;
      if (changed || now - lastAlertAt >= REALERT_INTERVAL_MS) {
        logger.error('macOS 授权缺失', { denied: denied.map((d) => ({ id: d.id, errNum: d.errNum })) });
        try {
          await broadcast('card', hostPermissionCard(denied));
        } catch (e) {
          logger.warn('host-permission 告警广播失败', { err: (e as Error).message });
        }
        lastAlertAt = now;
      }
      lastDeniedKey = key;
      return;
    }

    // 全部已授
    if (lastDeniedKey !== null && lastDeniedKey !== '') {
      logger.info('macOS 授权已全部补齐');
      try {
        await broadcast('text', RECOVERED_ALERT);
      } catch (e) {
        logger.warn('host-permission 恢复通知失败', { err: (e as Error).message });
      }
    }
    lastDeniedKey = '';
  };

  setInterval(() => void tick(), PROBE_INTERVAL_MS);
  // 启动 10s 后先探一次（错开 system-events probe 的 8s；等 lark client / WS 就绪再有可能发告警）
  setTimeout(() => void tick(), 10_000);

  logger.info('host-permission probe started', {
    intervalMs: PROBE_INTERVAL_MS,
    realertMs: REALERT_INTERVAL_MS,
  });
}
