import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import { logger } from 'multiagent-orchestrator';

/** 飞书入站图片落地目录（绝对路径；data/ 已 gitignore）。 */
const INBOUND_DIR = resolve('./data/inbound');
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 从 image 消息 content 里取 image_key。 */
export function parseImageKey(content: string): string | null {
  try {
    return (JSON.parse(content) as { image_key?: string }).image_key ?? null;
  } catch {
    return null;
  }
}

/**
 * 解析 post（富文本）消息 content → 纯文字 + 内联 image_key 列表。
 * content 形如 { title, content: [[{tag:'text',text}, {tag:'img',image_key}, ...], ...] }
 */
export function parsePost(content: string): { text: string; imageKeys: string[] } {
  try {
    const p = JSON.parse(content) as {
      title?: string;
      content?: Array<Array<{ tag?: string; text?: string; image_key?: string }>>;
    };
    const texts: string[] = [];
    const keys: string[] = [];
    for (const para of p.content ?? []) {
      for (const el of para) {
        if ((el.tag === 'text' || el.tag === 'a' || el.tag === 'md') && el.text) texts.push(el.text);
        else if (el.tag === 'img' && el.image_key) keys.push(el.image_key);
      }
      texts.push('\n');
    }
    const text = texts.join('').replace(/@_user_\d+\s*/g, '').trim();
    return { text, imageKeys: keys };
  } catch {
    return { text: '', imageKeys: [] };
  }
}

/**
 * 下载飞书某条消息里的一张图片资源到本地，返回绝对路径。
 * 需要飞书应用开 im:resource（读消息资源）权限 + 机器人与消息在同一会话。
 */
export async function downloadMessageImage(
  client: Lark.Client,
  messageId: string,
  imageKey: string,
): Promise<string> {
  await mkdir(INBOUND_DIR, { recursive: true });
  const safe = imageKey.replace(/[^a-zA-Z0-9_-]/g, '').slice(-32) || 'img';
  const dest = join(INBOUND_DIR, `${Date.now()}-${safe}.png`);
  const resp = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: imageKey },
    params: { type: 'image' },
  });
  await resp.writeFile(dest);
  return dest;
}

/** 批量下载；单张失败跳过并告警。返回成功落地的绝对路径列表。 */
export async function downloadInboundImages(
  client: Lark.Client,
  messageId: string,
  imageKeys: string[],
): Promise<string[]> {
  void cleanupInboundImages(); // 顺手清理旧图（fire-and-forget）
  const out: string[] = [];
  for (const key of imageKeys) {
    try {
      out.push(await downloadMessageImage(client, messageId, key));
    } catch (e) {
      logger.warn('inbound image download failed', { key, err: (e as Error).message });
    }
  }
  return out;
}

/** 清理超过 24h 的入站图片，防止 data/inbound 无限增长。 */
export async function cleanupInboundImages(): Promise<void> {
  try {
    const now = Date.now();
    const files = await readdir(INBOUND_DIR).catch(() => [] as string[]);
    for (const f of files) {
      const full = join(INBOUND_DIR, f);
      try {
        const st = await stat(full);
        if (now - st.mtimeMs > MAX_AGE_MS) await unlink(full);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/** 拼接注入给 claude 的图片前缀（让它先 Read 再结合文字处理）。 */
export function buildImagePromptPrefix(paths: string[]): string {
  const lines = paths.map((p, i) => `图片${i + 1}: ${p}`);
  return [
    `[用户随消息发来 ${paths.length} 张图片，已存到本地。请**先用 Read 工具逐张查看**，再结合下面的文字处理]`,
    ...lines,
    '',
    '',
  ].join('\n');
}

/** 纯图（无文字描述）时的完整 prompt。 */
export function buildImageOnlyPrompt(paths: string[]): string {
  return (
    buildImagePromptPrefix(paths) +
    '（用户没有附文字说明。请先 Read 这些图片看懂内容，然后告诉我你看到了什么、判断需要做什么；不确定就用 `agent lark ask` 追问。）'
  );
}
