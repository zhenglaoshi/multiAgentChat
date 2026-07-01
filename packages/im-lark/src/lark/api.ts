import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename, extname, resolve as resolvePath } from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import { logger } from 'multiagent-orchestrator';

/**
 * 网络/瞬时错误自动重试：ENOTFOUND / ETIMEDOUT / ECONNRESET / 5xx / 429
 * 指数退避 1s / 2s / 4s
 */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = (e as Error).message || '';
      const retriable =
        /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|getaddrinfo/i.test(msg) ||
        / 5\d\d /.test(msg) ||
        /\b429\b/.test(msg);
      if (!retriable || attempt === maxAttempts) {
        throw e;
      }
      const delayMs = 1000 * Math.pow(2, attempt - 1);
      logger.warn(`lark ${label} retriable err (attempt ${attempt}/${maxAttempts})`, {
        err: msg.slice(0, 200),
        nextRetryMs: delayMs,
      });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

type FileType = 'pdf' | 'doc' | 'xls' | 'ppt' | 'mp4' | 'opus' | 'stream';

function inferFileType(filename: string): FileType {
  const ext = extname(filename).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (['.doc', '.docx'].includes(ext)) return 'doc';
  if (['.xls', '.xlsx'].includes(ext)) return 'xls';
  if (['.ppt', '.pptx'].includes(ext)) return 'ppt';
  if (ext === '.mp4') return 'mp4';
  if (ext === '.opus') return 'opus';
  return 'stream';
}

export async function sendTextMessage(
  client: Lark.Client,
  chatId: string,
  text: string,
): Promise<void> {
  await withRetry('sendText', () =>
    client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    }),
  );
}

export async function sendCardMessage(
  client: Lark.Client,
  chatId: string,
  card: unknown,
): Promise<void> {
  await withRetry('sendCard', () =>
    client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    }),
  );
}

/**
 * 发卡片并返回 message_id（用于后续 patch）。
 */
export async function sendCardReturnId(
  client: Lark.Client,
  chatId: string,
  card: unknown,
): Promise<string> {
  const resp = await withRetry('sendCardReturnId', () =>
    client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    }),
  );
  const msgId =
    (resp as { message_id?: string }).message_id ??
    (resp as { data?: { message_id?: string } }).data?.message_id ??
    '';
  if (!msgId) throw new Error(`sendCard 没返回 message_id：${JSON.stringify(resp)}`);
  return msgId;
}

/**
 * 编辑已发送的卡片（飞书 im.message.patch）。
 */
export async function patchCard(
  client: Lark.Client,
  messageId: string,
  card: unknown,
): Promise<void> {
  await withRetry('patchCard', () =>
    client.im.message.patch({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify(card),
      },
    }),
  );
}

export interface SendFileResult {
  fileKey: string;
  fileName: string;
  fileType: FileType;
  sizeBytes: number;
}

export async function sendFile(
  client: Lark.Client,
  chatId: string,
  filePath: string,
  options: { name?: string } = {},
): Promise<SendFileResult> {
  const abs = resolvePath(filePath);
  if (!existsSync(abs)) throw new Error(`文件不存在: ${abs}`);
  const st = statSync(abs);
  if (!st.isFile()) throw new Error(`不是普通文件: ${abs}`);
  const fileName = options.name ?? basename(abs);
  const fileType = inferFileType(fileName);

  const uploadResp = await withRetry('uploadFile', () =>
    client.im.file.create({
      data: {
        file_type: fileType,
        file_name: fileName,
        file: createReadStream(abs),
      },
    }),
  );
  const fileKey =
    (uploadResp as { file_key?: string }).file_key ??
    (uploadResp as { data?: { file_key?: string } }).data?.file_key ??
    '';
  if (!fileKey) throw new Error(`文件上传失败：${JSON.stringify(uploadResp)}`);

  await withRetry('sendFile.msg', () =>
    client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
      },
    }),
  );
  return { fileKey, fileName, fileType, sizeBytes: st.size };
}

export interface SendImageResult {
  imageKey: string;
  fileName: string;
  sizeBytes: number;
}

export async function sendImage(
  client: Lark.Client,
  chatId: string,
  imagePath: string,
): Promise<SendImageResult> {
  const abs = resolvePath(imagePath);
  if (!existsSync(abs)) throw new Error(`文件不存在: ${abs}`);
  const st = statSync(abs);
  if (!st.isFile()) throw new Error(`不是普通文件: ${abs}`);

  const uploadResp = await withRetry('uploadImage', () =>
    client.im.image.create({
      data: {
        image_type: 'message',
        image: createReadStream(abs),
      },
    }),
  );
  const imageKey =
    (uploadResp as { image_key?: string }).image_key ??
    (uploadResp as { data?: { image_key?: string } }).data?.image_key ??
    '';
  if (!imageKey) throw new Error(`图片上传失败：${JSON.stringify(uploadResp)}`);

  await withRetry('sendImage.msg', () =>
    client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      },
    }),
  );
  return { imageKey, fileName: basename(abs), sizeBytes: st.size };
}
