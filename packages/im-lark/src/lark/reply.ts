import * as Lark from '@larksuiteoapi/node-sdk';
import { appendFooterText } from './footer-gate.js';
import { redactMaybe } from './redact-gate.js';

const MAX_CHUNK = 3000;

/** 页脚只加在最后一块（长文本切多块时避免每块都带时间行）。全空则不加（不发页脚-only 消息）。 */
function withFooterOnLast(chunks: string[]): string[] {
  if (!chunks.length || !chunks.some((c) => c.trim())) return chunks;
  const out = chunks.slice();
  out[out.length - 1] = appendFooterText(out[out.length - 1]!);
  return out;
}

function splitText(text: string, maxLen = MAX_CHUNK): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    const window = remaining.slice(0, maxLen);
    let cut = window.lastIndexOf('\n');
    if (cut <= 0) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining.length) chunks.push(remaining);
  return chunks.map((c) => c.trim()).filter((c) => c.length > 0);
}

export interface ReplyContext {
  messageId: string;
  chatId: string;
}

export async function replyText(
  client: Lark.Client,
  ctx: ReplyContext,
  text: string,
): Promise<void> {
  // 脱敏 → 切块 → 页脚（顺序对齐 api.ts.sendTextMessage）。reply.ts 是绕过 api.ts 的独立文本通道，
  // 此前从不脱敏 → /report 等把 git log/memory 合成内容直发会漏审，这里补上单点闸门。
  const chunks = withFooterOnLast(splitText(redactMaybe(text)));
  const first = chunks[0];
  if (!first) return;

  await client.im.message.reply({
    path: { message_id: ctx.messageId },
    data: {
      content: JSON.stringify({ text: first }),
      msg_type: 'text',
    },
  });

  for (const chunk of chunks.slice(1)) {
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: ctx.chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: chunk }),
      },
    });
  }
}

export async function sendText(
  client: Lark.Client,
  chatId: string,
  text: string,
): Promise<void> {
  const chunks = withFooterOnLast(splitText(redactMaybe(text)));
  for (const chunk of chunks) {
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text: chunk }),
      },
    });
  }
}
