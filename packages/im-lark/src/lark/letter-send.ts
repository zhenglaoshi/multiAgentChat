import * as Lark from '@larksuiteoapi/node-sdk';
import { LETTER_BODY_MAX, letterFullText, redactText, type LetterDetail } from 'multiagent-orchestrator';
import { sendText } from './reply.js';

/** 单条飞书文本的分片长度（留出页脚/前缀余量）。 */
const LETTER_CHUNK = 2800;

/**
 * 把**一封**公函的完整内容推到一个飞书会话。
 *
 * 一封一串消息、各推各的 —— 一轮拉到多封时绝不合并，否则手机上根本分不清哪段属于哪封。
 *
 * 两点刻意为之：
 *  - **先整体脱敏再分片**：分片后各片各自脱敏的话，跨片的凭证（多行 PEM 之类）会因为
 *    匹配被切断而漏过去。发送层还会再脱一次，幂等无副作用。
 *  - 超上限时**显式告知已截断**，不写「全文」。上限（`LETTER_BODY_MAX`）取得足够大，
 *    正常公函（实测约 1900 字）不会触发；真触发时人据此知道还有没看到的部分，
 *    而喂给 claude 的也正是这同一段——两边同源是「人看过全文才执行」的前提。
 */
export async function sendLetterDetail(
  client: Lark.Client,
  chatId: string,
  detail: LetterDetail,
  myAgent: string,
): Promise<void> {
  const full = letterFullText(detail, myAgent);
  const shown = full.slice(0, LETTER_BODY_MAX);
  const truncated = full.length > LETTER_BODY_MAX;
  // 先整体脱敏，避免分片把凭证匹配切断
  const safe = redactText(shown);
  const chunks: string[] = [];
  for (let i = 0; i < safe.length; i += LETTER_CHUNK) chunks.push(safe.slice(i, i + LETTER_CHUNK));
  if (chunks.length === 0) chunks.push('(空)');
  for (let i = 0; i < chunks.length; i += 1) {
    const head = chunks.length > 1
      ? `📮 ${detail.threadId}（${i + 1}/${chunks.length}）`
      : `📮 ${detail.threadId}`;
    await sendText(client, chatId, `${head}\n\n${chunks[i]}`);
  }
  if (truncated) {
    await sendText(
      client,
      chatId,
      `⚠ 这封超过 ${LETTER_BODY_MAX} 字，以上是前 ${LETTER_BODY_MAX} 字（交给 claude 的也是这一段）。完整原文见公函页。`,
    );
  }
}
