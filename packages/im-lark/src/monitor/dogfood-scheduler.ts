/**
 * Dogfood 自审调度 —— `/audit` 手动触发 + 每周定时(opt-in)。v1 只报告不改仓库。
 *
 * handleCommand 没有 lark client，所以 `/audit` 没法自己异步推卡：本模块在 daemon 启动时
 * 存下 client，暴露 `runAuditAndReport(chatId?)` 给命令 fire-and-forget 调用（跑完用存下的
 * client 推报告卡）。定时任务复用 report-scheduler 的"到点一次"思路(fired 内存去重)。
 *
 * 配置：DOGFOOD_ENABLED=1 启用每周定时；DOGFOOD_AT="Mon 09:00"(本机时区，默认周一 09:00)。
 * `/audit` 手动触发不受 DOGFOOD_ENABLED 限制(只要 daemon 起过就行)。
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import { logger, runSelfAudit } from 'multiagent-orchestrator';
import { listAllChats } from '../chats/store.js';
import { sendCardMessage, sendTextMessage } from '../lark/api.js';
import { auditReportCard } from '../lark/cards.js';

let larkClient: Lark.Client | null = null;
let running = false; // 防并发(自审跑 claude -p 较久)
let lastWeeklyKey = '';

const WEEK_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * 跑一次自审并推报告卡。
 * @param chatId 有值→只推该 chat(/audit 手动)；无值→推所有 watchAllTabs 的 chat(定时)。
 */
export async function runAuditAndReport(chatId?: string): Promise<void> {
  if (!larkClient) {
    logger.warn('dogfood: 无 lark client，跳过');
    return;
  }
  if (running) {
    if (chatId) await sendTextMessage(larkClient, chatId, '🔧 自审已在跑，稍等它出结果…').catch(() => {});
    return;
  }
  running = true;
  const client = larkClient;
  try {
    const targets = chatId
      ? [chatId]
      : (await listAllChats()).filter((c) => c.watchAllTabs === true).map((c) => c.chatId);
    if (targets.length === 0) {
      logger.info('dogfood: 无推送目标(定时且无 watch chat)');
      return;
    }
    const res = await runSelfAudit();
    const card = auditReportCard(res.findings, res.ok ? {} : { error: res.error ?? '未知错误' });
    for (const t of targets) {
      try {
        await sendCardMessage(client, t, card);
      } catch (e) {
        logger.warn('dogfood 报告推送失败', { chatId: t, err: (e as Error).message });
      }
    }
    logger.info('dogfood report pushed', { findings: res.findings.length, ok: res.ok, targets: targets.length });
  } catch (e) {
    logger.warn('dogfood audit 失败', { err: (e as Error).message });
    if (chatId) await sendTextMessage(client, chatId, `🔧 自审出错：${(e as Error).message}`).catch(() => {});
  } finally {
    running = false;
  }
}

/** 解析 "Mon HH:MM" / "HH:MM"。 */
function parseAt(spec: string): { day?: number; h: number; m: number } | null {
  const s = spec.trim();
  const withDay = /^([A-Za-z]{3})\s+(\d{1,2}):(\d{2})$/.exec(s);
  if (withDay) {
    const day = WEEK_DAYS.indexOf(withDay[1]!.toLowerCase());
    if (day < 0) return null;
    return { day, h: Number(withDay[2]), m: Number(withDay[3]) };
  }
  const timeOnly = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (timeOnly) return { h: Number(timeOnly[1]), m: Number(timeOnly[2]) };
  return null;
}

/** 启动：存 client + (opt-in)每周定时。`/audit` 靠 runAuditAndReport，不受 DOGFOOD_ENABLED 限制。 */
export function startDogfoodScheduler(client: Lark.Client): void {
  larkClient = client;
  if (process.env['DOGFOOD_ENABLED'] !== '1') {
    logger.info('dogfood scheduler: 定时未启用(DOGFOOD_ENABLED!=1)，/audit 手动仍可用');
    return;
  }
  const at = parseAt(process.env['DOGFOOD_AT'] ?? 'Mon 09:00') ?? { day: 1, h: 9, m: 0 };
  const TICK_MS = 15 * 60_000;
  const tick = (): void => {
    try {
      const now = new Date();
      if (at.day !== undefined && now.getDay() !== at.day) return;
      if (now.getHours() < at.h || (now.getHours() === at.h && now.getMinutes() < at.m)) return;
      const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`; // 一天一次
      if (lastWeeklyKey === key) return;
      lastWeeklyKey = key;
      void runAuditAndReport();
    } catch (e) {
      logger.warn('dogfood tick 失败', { err: (e as Error).message });
    }
  };
  setInterval(tick, TICK_MS);
  logger.info('dogfood scheduler started', { at });
}
