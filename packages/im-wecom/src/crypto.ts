import { createDecipheriv, createHash, randomBytes, createCipheriv } from 'node:crypto';

/**
 * 企业微信消息加解密（WXBizMsgCrypt 的 Node 版）
 *
 * 参考：https://developer.work.weixin.qq.com/document/path/90968
 *
 * 加密算法：AES-256-CBC，key = base64(aesKey + '=')，IV = key 的前 16 字节
 * 明文格式：[随机 16B][网络字节序 4B 消息长度][正文][corpid]
 * PKCS#7 padding
 * 签名：sha1(token, timestamp, nonce, encrypt) → hex，排序后拼接
 */

export interface CryptoContext {
  token: string;
  aesKey: string;   // 43 位 base64（企微后台的 EncodingAESKey）
  corpId: string;
}

function decodeAesKey(aesKey43: string): Buffer {
  // 企微 43 位 base64 → 加上 '=' 补齐成 44 位 → base64 decode 得 32B key
  return Buffer.from(aesKey43 + '=', 'base64');
}

/**
 * PKCS#7 unpad：末字节表明 pad 长度。
 */
function pkcs7Unpad(buf: Buffer): Buffer {
  const padLen = buf[buf.length - 1] ?? 0;
  if (padLen < 1 || padLen > 32) return buf;
  return buf.subarray(0, buf.length - padLen);
}

function pkcs7Pad(buf: Buffer, blockSize = 32): Buffer {
  const padLen = blockSize - (buf.length % blockSize);
  const pad = Buffer.alloc(padLen, padLen);
  return Buffer.concat([buf, pad]);
}

/**
 * 签名验证：signature = sha1(sorted([token, timestamp, nonce, echostr | encrypt])) hex
 */
export function verifySignature(
  ctx: CryptoContext,
  signature: string,
  timestamp: string,
  nonce: string,
  msgOrEcho: string,
): boolean {
  const parts = [ctx.token, timestamp, nonce, msgOrEcho].sort();
  const hash = createHash('sha1').update(parts.join('')).digest('hex');
  return hash === signature;
}

/**
 * 解密 Encrypt 字段。返回 {plainMsg, fromCorpId}。
 * fromCorpId 应等于 ctx.corpId，不等 → 报错（潜在 spoofing）。
 */
export function decrypt(ctx: CryptoContext, encryptBase64: string): {
  plainMsg: string;
  fromCorpId: string;
} {
  const key = decodeAesKey(ctx.aesKey);
  const iv = key.subarray(0, 16);
  const ciphertext = Buffer.from(encryptBase64, 'base64');

  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const unpad = pkcs7Unpad(decrypted);

  // [16B random][4B msg_len BE][msg][corpid]
  if (unpad.length < 20) throw new Error('wecom decrypt: payload too short');
  const msgLen = unpad.readUInt32BE(16);
  if (msgLen < 0 || msgLen > unpad.length - 20) {
    throw new Error(`wecom decrypt: invalid msg_len ${msgLen}`);
  }
  const plainMsg = unpad.subarray(20, 20 + msgLen).toString('utf8');
  const fromCorpId = unpad.subarray(20 + msgLen).toString('utf8');

  if (fromCorpId !== ctx.corpId) {
    throw new Error(`wecom decrypt: corpid mismatch (got=${fromCorpId}, expect=${ctx.corpId})`);
  }
  return { plainMsg, fromCorpId };
}

/**
 * 加密回复（企微文档要求 response body 也加密，即使 URL 验证时的 echostr 也要 decrypt）。
 * 生成 signature + timestamp + nonce + encrypt 打包 XML。
 */
export function encrypt(ctx: CryptoContext, plainMsg: string): {
  encrypt: string;
} {
  const key = decodeAesKey(ctx.aesKey);
  const iv = key.subarray(0, 16);
  const random = randomBytes(16);
  const msgBuf = Buffer.from(plainMsg, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);
  const corpBuf = Buffer.from(ctx.corpId, 'utf8');
  const plain = Buffer.concat([random, lenBuf, msgBuf, corpBuf]);
  const padded = pkcs7Pad(plain);

  const cipher = createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  const enc = Buffer.concat([cipher.update(padded), cipher.final()]);
  return { encrypt: enc.toString('base64') };
}

export function signResponse(
  ctx: CryptoContext,
  encryptBase64: string,
  timestamp: string,
  nonce: string,
): string {
  const parts = [ctx.token, timestamp, nonce, encryptBase64].sort();
  return createHash('sha1').update(parts.join('')).digest('hex');
}

/**
 * URL 验证专用（企微首次配 URL 时发 GET，echostr 是加密的，需要 decrypt 后按明文返回）。
 */
export function verifyUrl(
  ctx: CryptoContext,
  signature: string,
  timestamp: string,
  nonce: string,
  echostr: string,
): string {
  if (!verifySignature(ctx, signature, timestamp, nonce, echostr)) {
    throw new Error('wecom URL verify: signature mismatch');
  }
  const { plainMsg } = decrypt(ctx, echostr);
  return plainMsg;
}
