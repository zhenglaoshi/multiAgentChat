import * as Lark from '@larksuiteoapi/node-sdk';
import {
  logger,
  loadLettersConfig,
  LettersMcpClient,
  LettersAuthError,
  classifyLetters,
  loadSeenLetters,
  markLettersNotified,
  type LetterThread,
  type LetterDetail,
} from 'multiagent-orchestrator';
import { listAllChats } from '../chats/store.js';
import { sendCardMessage } from '../lark/api.js';
import { sendText } from '../lark/reply.js';
import { sendLetterDetail } from '../lark/letter-send.js';
import { letterTaskCard, letterAuthCard } from '../lark/cards.js';

/** 启动后延迟首跑，等 lark client / WS 就绪（同 tapd-watcher）。 */
const FIRST_TICK_DELAY_MS = 15_000;
/**
 * 令牌失效告警的重复间隔。
 * 令牌过期后**每一轮**都会 401，不节流就是每 2 分钟刷一张红卡。
 */
const AUTH_ALERT_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * CareyClaw Agent 公函监听：每 pollMs 拉一次「球在我这」的公函线程，
 * 新线程 / 对方回函了 → 推一张飞书任务卡（带「开工」按钮）。
 *
 * 走平台 **MCP** 端点（Bearer 开发者令牌），不是 REST 的 `/api/v2/a2a/*`
 * ——后者只认浏览器 cookie，做不了无人值守轮询。详见 orchestrator/letters/client.ts。
 * 纯 HTTP，不经 claude/LLM。缺令牌则不启。
 */
export function startLettersWatcher(client: Lark.Client): void {
  const cfg = loadLettersConfig();
  if (!cfg.enabled) {
    logger.info('公函 watcher 未启用（没读到 CareyClaw 开发者令牌，或已在 /connect 停用）');
    return;
  }
  const mcp = new LettersMcpClient(cfg.mcpUrl, cfg.token);
  let lastAuthAlertAt = 0;

  const pushCard = async (card: unknown): Promise<boolean> => {
    let ok = false;
    for (const chat of await listAllChats()) {
      try {
        await sendCardMessage(client, chat.chatId, card);
        ok = true;
      } catch (e) {
        logger.warn('公函卡片单 chat 推送失败', { chatId: chat.chatId, err: (e as Error).message });
      }
    }
    return ok;
  };

  /**
   * 推**一封**公函：先发完整内容，再发任务卡。
   *
   * 顺序是刻意的——卡上的【✅ 确认，开工】按下去就会把这封公函交给一个高权限 claude
   * 会话，所以内容必须**先于**那个按钮出现在人眼前。多封时各推各的、绝不合并，
   * 否则手机上分不清哪段属于哪封（这也是用户明确要求的）。
   *
   * 拉全文失败不阻断：仍推卡（卡上有「📖 读全文」可重试），但会告知，
   * 免得人在没看到内容的情况下就点了开工。
   */
  const pushOne = async (n: ReturnType<typeof classifyLetters>[number], myAgent: string): Promise<boolean> => {
    const chats = await listAllChats();
    let detail: LetterDetail | null = null;
    try {
      detail = await mcp.readThread(n.thread.threadId);
    } catch (e) {
      logger.warn('公函拉全文失败（仍推卡）', { threadId: n.thread.threadId, err: (e as Error).message });
    }
    let ok = false;
    for (const chat of chats) {
      try {
        // 逐 chat 记「这个人到底看到内容没有」——只有看到了，卡上才会出现「确认，开工」。
        // seq 校验只挡「对方又更新了」，挡不住「这一版压根没推成功」：拉全文失败时 seq 没变、
        // 校验放行，正文照样会进到高权限会话，而人从没见过它。
        let bodyShown = false;
        if (detail) {
          await sendLetterDetail(client, chat.chatId, detail, myAgent);
          bodyShown = true;
        } else {
          await sendText(client, chat.chatId, `📮 ${n.thread.threadId} 内容拉取失败 —— 点卡片上的「📖 读全文（重试）」，读到了才会给开工按钮`);
        }
        await sendCardMessage(client, chat.chatId, letterTaskCard(n, bodyShown));
        ok = true;
      } catch (e) {
        logger.warn('公函单 chat 推送失败', { chatId: chat.chatId, threadId: n.thread.threadId, err: (e as Error).message });
      }
    }
    return ok;
  };

  const tick = async (): Promise<void> => {
    try {
      const { agent, threads } = await mcp.inbox(true);
      const seen = await loadSeenLetters();
      const notes = classifyLetters(threads, seen);
      if (notes.length === 0) return;
      logger.info('公函 watcher 发现待通知', {
        inbox: threads.length,
        new: notes.filter((n) => n.kind === 'new').length,
        reply: notes.filter((n) => n.kind === 'reply').length,
      });
      // 推成功了才记「见过」——先记后推的话，推送失败这封就永远不会再提醒
      const pushed: LetterThread[] = [];
      for (const n of notes) {
        if (await pushOne(n, agent)) pushed.push(n.thread);
      }
      await markLettersNotified(pushed);
      logger.info('公函 watcher 已推送', { pushed: pushed.length });
    } catch (e) {
      if (e instanceof LettersAuthError) {
        // 令牌过期 → 每轮都会撞，节流告警；不告知的话表现是「公函再也不推了」，极难察觉
        if (Date.now() - lastAuthAlertAt > AUTH_ALERT_INTERVAL_MS) {
          lastAuthAlertAt = Date.now();
          void pushCard(letterAuthCard(e.message));
        }
        logger.warn('公函 watcher 鉴权失败', { err: e.message });
        return;
      }
      logger.warn('公函 watcher tick 失败', { err: (e as Error).message });
    }
  };

  setInterval(() => void tick(), cfg.pollMs);
  setTimeout(() => void tick(), FIRST_TICK_DELAY_MS);
  logger.info('公函 watcher started', { pollMs: cfg.pollMs, workRoot: cfg.workRoot });
}
