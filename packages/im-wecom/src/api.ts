import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { logger } from 'multiagent-orchestrator';
import type { TokenManager } from './auth.js';
import type { WeComConfig } from './config.js';

/**
 * 企微 REST API 封装。所有 API 都需要 access_token，出错 (errcode=42001) 时
 * invalidate token 并重试一次。
 *
 * 参考：https://developer.work.weixin.qq.com/document/path/90236
 */

const BASE = 'https://qyapi.weixin.qq.com/cgi-bin';
const MAX_RETRY = 1;

export interface WeComApiOpts {
  cfg: WeComConfig;
  token: TokenManager;
}

async function postJson(
  opts: WeComApiOpts,
  pathAndQuery: string,
  body: unknown,
  retry = 0,
): Promise<Record<string, unknown>> {
  const accessToken = await opts.token.get();
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const url = `${BASE}${pathAndQuery}${sep}access_token=${encodeURIComponent(accessToken)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`wecom POST ${pathAndQuery} HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
  }
  const data = await resp.json() as Record<string, unknown>;
  const errcode = data['errcode'] as number | undefined;
  if (errcode !== 0) {
    // 42001 token 过期；40014 invalid token；都 invalidate 后重试
    if ((errcode === 42001 || errcode === 40014) && retry < MAX_RETRY) {
      opts.token.invalidate();
      return postJson(opts, pathAndQuery, body, retry + 1);
    }
    throw new Error(`wecom errcode=${errcode} errmsg=${String(data['errmsg'])}`);
  }
  return data;
}

/**
 * 发消息。企微「应用消息」接口。
 *
 * touser / toparty / totag 至少一个。触发消息卡片交互时企微把点击 event 回调到
 * 你配的接收 URL，daemon 收到走 crypto.ts 解密。
 */
export interface SendMsgPayload {
  touser?: string;    // userid1|userid2|@all
  toparty?: string;
  totag?: string;
  msgtype: string;
  agentid: number;
  enable_id_trans?: number;
  enable_duplicate_check?: number;
  [key: string]: unknown;   // msgtype-specific 字段
}

export async function sendAppMessage(
  opts: WeComApiOpts,
  payload: SendMsgPayload,
): Promise<{ msgid: string; response_code?: string }> {
  const body = {
    ...payload,
    agentid: Number(opts.cfg.agentId),
  };
  const data = await postJson(opts, '/message/send', body);
  return {
    msgid: String(data['msgid'] ?? ''),
    response_code: data['response_code'] as string | undefined,
  };
}

/**
 * 发群聊消息 —— 走 /cgi-bin/appchat/send。跟 /message/send 的区别是 target 是
 * chatid（企微里由 /appchat/create 创建的应用群，不是普通企业群）。
 *
 * 参考：https://developer.work.weixin.qq.com/document/path/90248
 */
export interface SendAppChatPayload {
  chatid: string;
  msgtype: string;
  safe?: number;
  [key: string]: unknown;
}

export async function sendAppChat(
  opts: WeComApiOpts,
  payload: SendAppChatPayload,
): Promise<{ ok: true }> {
  await postJson(opts, '/appchat/send', payload);
  return { ok: true };
}

/**
 * 更新已发出的模板卡片。企微有两种：
 *   /message/update_template_card —— 只能更新交互按钮的 checked 状态之类
 *   建议改用 /message/recall（撤回）+ 重新 send —— 简单可靠
 *
 * 这里我们用 update_template_card 走"局部按钮状态更新"；如果 card body 变了要
 * 重新 send（transport 侧做决策）。
 */
export async function updateTemplateCard(
  opts: WeComApiOpts,
  payload: {
    userids?: string[];
    partyids?: number[];
    tagids?: number[];
    atall?: number;
    response_code: string;   // 从上一次 sendAppMessage 的 response_code 拿
    button?: { replace_name?: string };
    quote_area?: { title?: string; quote_text?: string };
  },
): Promise<Record<string, unknown>> {
  const body = {
    ...payload,
    agentid: Number(opts.cfg.agentId),
  };
  return postJson(opts, '/message/update_template_card', body);
}

/**
 * 撤回消息（清空后重发比 update 更可靠，但受"发送后 24h 内"限制）。
 */
export async function recallMessage(
  opts: WeComApiOpts,
  msgid: string,
): Promise<void> {
  await postJson(opts, '/message/recall', { msgid });
}

/**
 * 上传临时素材（image / voice / video / file）。返回 media_id，3 天有效。
 */
export type MediaType = 'image' | 'voice' | 'video' | 'file';

export async function uploadMedia(
  opts: WeComApiOpts,
  filePath: string,
  type: MediaType,
  fileName?: string,
): Promise<{ media_id: string; created_at: string }> {
  const accessToken = await opts.token.get();
  const url = `${BASE}/media/upload?access_token=${encodeURIComponent(accessToken)}&type=${type}`;
  const buf = await readFile(filePath);
  const name = fileName ?? basename(filePath);

  // 手写 multipart（避免加 form-data 依赖；Node 22 有 native FormData/Blob）
  const form = new FormData();
  const blob = new Blob([new Uint8Array(buf)]);
  form.append('media', blob, name);

  const resp = await fetch(url, { method: 'POST', body: form });
  if (!resp.ok) {
    throw new Error(`wecom media upload HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
  }
  const data = await resp.json() as Record<string, unknown>;
  if ((data['errcode'] as number | undefined) !== 0) {
    throw new Error(`wecom upload errcode=${data['errcode']} errmsg=${String(data['errmsg'])}`);
  }
  const media_id = String(data['media_id'] ?? '');
  if (!media_id) throw new Error(`wecom upload 无 media_id`);
  logger.info('wecom media uploaded', { type, name, media_id, size: buf.length });
  return { media_id, created_at: String(data['created_at'] ?? '') };
}

/**
 * 下载临时素材（入站图片用）：GET /media/get?media_id=xxx。
 * 成功返回二进制流；失败时企微返回 JSON（errcode!=0）。写入 destPath。
 * 参考：https://developer.work.weixin.qq.com/document/path/90254
 */
export async function downloadMedia(
  opts: WeComApiOpts,
  mediaId: string,
  destPath: string,
): Promise<string> {
  const accessToken = await opts.token.get();
  const url = `${BASE}/media/get?access_token=${encodeURIComponent(accessToken)}&media_id=${encodeURIComponent(mediaId)}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`wecom media get HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
  }
  // 出错时企微以 application/json 返回 {errcode,errmsg}
  const ct = resp.headers.get('content-type') ?? '';
  if (ct.includes('application/json') || ct.includes('text/plain')) {
    const data = await resp.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(`wecom media get errcode=${data['errcode']} errmsg=${String(data['errmsg'])}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  await writeFile(destPath, buf);
  logger.info('wecom media downloaded', { media_id: mediaId, size: buf.length, destPath });
  return destPath;
}

/**
 * 猜文件的 MediaType：图片走 image，其他走 file。
 */
export function guessMediaType(path: string): MediaType {
  const ext = extname(path).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(ext)) return 'image';
  if (['.amr'].includes(ext)) return 'voice';
  if (['.mp4'].includes(ext)) return 'video';
  return 'file';
}
