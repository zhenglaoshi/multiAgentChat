import * as Lark from '@larksuiteoapi/node-sdk';
import { logger, scrubSecrets, summarizeScrub } from 'multiagent-orchestrator';
import { listAllChats } from '../chats/store.js';
import { sendTextMessage } from '../lark/api.js';

/**
 * 定期扫 claude+codex 会话历史里的明文凭证。**opt-in**：只有设 SECRET_SCRUB_ENABLED=1 才启动。
 *
 * 安全默认：**报告模式**（dry-run，只推"发现 N 处、跑 scrub 清理"）。只有再设 SECRET_SCRUB_APPLY=1
 * 才真就地脱敏（改写 transcript 是破坏性操作 → 显式 opt-in）。apply 模式恒 skip 最近 24h 活跃会话。
 *
 * 配置：
 *   SECRET_SCRUB_ENABLED=1        启用
 *   SECRET_SCRUB_APPLY=1          就地脱敏（否则只报告）
 *   SECRET_SCRUB_INTERVAL_HOURS   周期小时，默认 24
 */
const FIRST_DELAY_MS = 60_000;
const SKIP_RECENT_MIN = 1440; // 24h：定期任务绝不碰当天活跃会话

let lastRunDay = '';

export function startSecretScrubScheduler(client: Lark.Client): void {
  if (process.env['SECRET_SCRUB_ENABLED'] !== '1') return;
  const apply = process.env['SECRET_SCRUB_APPLY'] === '1';
  const hours = Number(process.env['SECRET_SCRUB_INTERVAL_HOURS']);
  const tickMs = (Number.isFinite(hours) && hours > 0 ? hours : 24) * 60 * 60 * 1000;

  const tick = async (): Promise<void> => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      if (lastRunDay === today) return; // 一天一次
      lastRunDay = today;
      const report = await scrubSecrets({ apply, skipRecentMin: SKIP_RECENT_MIN });
      logger.info('secret scrub scheduled run', {
        apply,
        scanned: report.scanned,
        dirty: report.dirtyFiles,
      });
      if (report.dirtyFiles === 0) return; // 没发现 → 不打扰
      const head = apply
        ? '🧹 定期脱敏已执行（claude+codex 会话历史）'
        : '🔍 定期扫描发现明文凭证（未改动，报告模式）';
      const tail = apply
        ? '\n真实密钥仍需到各控制台 rotate 才算根治。'
        : '\n就地脱敏：本人跑 `agent secrets scrub`（或设 SECRET_SCRUB_APPLY=1 让定期任务自动清）。';
      const text = `${head}\n\n${summarizeScrub(report)}${tail}`;
      const chats = await listAllChats();
      for (const c of chats) {
        try {
          await sendTextMessage(client, c.chatId, text);
        } catch (e) {
          logger.warn('secret scrub 报告推送失败', { chatId: c.chatId, err: (e as Error).message });
        }
      }
    } catch (e) {
      logger.warn('secret scrub tick 失败', { err: (e as Error).message });
    }
  };
  setInterval(() => void tick(), tickMs);
  setTimeout(() => void tick(), FIRST_DELAY_MS);
  logger.info('secret scrub scheduler started', { apply, tickMs, skipRecentMin: SKIP_RECENT_MIN });
}
