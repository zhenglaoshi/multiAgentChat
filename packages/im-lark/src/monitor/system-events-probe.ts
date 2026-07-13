import { platform } from 'node:os';
import * as Lark from '@larksuiteoapi/node-sdk';
import { logger } from 'multiagent-orchestrator';
import { probeSystemEvents } from 'multiagent-host-mac';
import { listAllChats } from '../chats/store.js';
import { sendTextMessage } from '../lark/api.js';

/** 每 2 分钟自检一次（术语故障是持久态，不需要更密） */
const PROBE_INTERVAL_MS = 120_000;
/** 持续故障时，每 30 分钟再提醒一次（避免刷屏，也避免报一次就忘） */
const REALERT_INTERVAL_MS = 30 * 60_000;

const ALERT_BROKEN =
  '🚨 System Events 术语解析挂了 —— 飞书注入的命令不会自动回车提交！\n\n' +
  '现象：@tab 发的命令停在命令行，claude/终端没真正执行。\n' +
  '原因：forceEnter 靠 `key code 36` 发 Enter，而 System Events 被挂起或注册损坏，' +
  'osascript 连术语都加载不了（常见诱因：Mac 过载、长时间没重启）。\n\n' +
  '修复：重启 Mac（最稳，顺带解过载），或先试 `sudo killall appleeventsd`。\n' +
  '⚠️ 修好前从飞书发的命令都不会真正跑起来，别依赖。';

const ALERT_RECOVERED =
  '✅ System Events 术语已恢复 —— 飞书注入的命令能正常回车提交了。';

/**
 * 后台自检 System Events 术语通路（forceEnter 的 `key code` 依赖）。
 *
 * 只在状态**翻转**时推送，避免刷屏：
 *  - 正常 → 故障：立刻向所有 chat 大声报警；持续故障每 30min 再提醒
 *  - 故障 → 正常：发一条恢复通知
 *
 * 这把原本只在 dev 日志里一条 WARN 的隐蔽故障（命令看着发了其实没回车）变成飞书显性告警。
 */
export function startSystemEventsProbe(client: Lark.Client): void {
  if (platform() !== 'darwin') {
    logger.info('system-events probe skipped (non-darwin)');
    return;
  }

  // null = 尚未探测；true = 上次正常；false = 上次故障
  let lastOk: boolean | null = null;
  let lastAlertAt = 0;

  const broadcast = async (text: string): Promise<void> => {
    const chats = await listAllChats();
    if (chats.length === 0) {
      logger.warn('system-events probe：无 chat 可推送告警');
      return;
    }
    for (const chat of chats) {
      try {
        await sendTextMessage(client, chat.chatId, text);
      } catch (e) {
        logger.warn('system-events 告警单 chat 推送失败', {
          chatId: chat.chatId,
          err: (e as Error).message,
        });
      }
    }
  };

  const tick = async (): Promise<void> => {
    const { ok, err } = await probeSystemEvents();
    const now = Date.now();

    if (!ok) {
      const firstBreak = lastOk !== false;
      if (firstBreak || now - lastAlertAt >= REALERT_INTERVAL_MS) {
        logger.error('System Events 术语探针失败 —— forceEnter 会静默失败', { err });
        try {
          await broadcast(ALERT_BROKEN + (err ? `\n\n诊断：${err}` : ''));
        } catch (e) {
          logger.warn('system-events 告警广播失败', { err: (e as Error).message });
        }
        lastAlertAt = now;
      }
      lastOk = false;
      return;
    }

    if (lastOk === false) {
      logger.info('System Events 术语探针恢复');
      try {
        await broadcast(ALERT_RECOVERED);
      } catch (e) {
        logger.warn('system-events 恢复通知失败', { err: (e as Error).message });
      }
    }
    lastOk = true;
  };

  setInterval(() => void tick(), PROBE_INTERVAL_MS);
  // 启动 8s 后先探一次（等 lark client / WS 就绪再有可能发出告警）
  setTimeout(() => void tick(), 8000);

  logger.info('system-events probe started', {
    intervalMs: PROBE_INTERVAL_MS,
    realertMs: REALERT_INTERVAL_MS,
  });
}
