import * as Lark from '@larksuiteoapi/node-sdk';
import { logger, getCareyclawKeyStatus } from 'multiagent-orchestrator';
import { listAllChats } from '../chats/store.js';
import { sendCardMessage } from '../lark/api.js';
import { careyclawKeyCard } from '../lark/cards.js';

const TICK_MS = 6 * 60 * 60 * 1000; // 每 6h 查一次
const FIRST_DELAY_MS = 20_000;
const REMIND_WITHIN_DAYS = 2;       // 剩 ≤2 天（含已过期）才提醒

// 内存去重：同一天最多提醒一次（dev 重启会重置，可接受）
let lastRemindDay = '';

/**
 * CareyClaw 调试密钥到期提醒：密钥剩 ≤2 天或已过期 → 推飞书弹框，带「更新密钥」按钮
 * （后台短信刷新后飞书贴回新密钥）。没设密钥 / 没填到期日 → 不提醒。
 */
export function startCareyclawKeyReminder(client: Lark.Client): void {
  const tick = async (): Promise<void> => {
    try {
      const st = await getCareyclawKeyStatus();
      if (!st.hasKey || typeof st.daysLeft !== 'number') return;
      if (st.daysLeft > REMIND_WITHIN_DAYS) return;
      const today = new Date().toISOString().slice(0, 10);
      if (lastRemindDay === today) return; // 今天提醒过了
      const chats = await listAllChats();
      let pushed = false;
      for (const c of chats) {
        try { await sendCardMessage(client, c.chatId, careyclawKeyCard(st, { remind: true })); pushed = true; }
        catch (e) { logger.warn('careyclaw key 提醒推送失败', { chatId: c.chatId, err: (e as Error).message }); }
      }
      if (pushed) { lastRemindDay = today; logger.info('careyclaw key 到期提醒已推', { daysLeft: st.daysLeft }); }
    } catch (e) {
      logger.warn('careyclaw key reminder tick 失败', { err: (e as Error).message });
    }
  };
  setInterval(() => void tick(), TICK_MS);
  setTimeout(() => void tick(), FIRST_DELAY_MS);
  logger.info('careyclaw key reminder started', { tickMs: TICK_MS, remindWithinDays: REMIND_WITHIN_DAYS });
}
