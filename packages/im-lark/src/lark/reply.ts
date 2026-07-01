import * as Lark from '@larksuiteoapi/node-sdk';

const MAX_CHUNK = 3000;

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
  const chunks = splitText(text);
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
  const chunks = splitText(text);
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
