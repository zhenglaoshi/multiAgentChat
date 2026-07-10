/**
 * 从环境变量读企微凭证。缺任一必需字段 → 返回 null（daemon 就不 attach 企微 transport）。
 *
 * 必需：
 *   WECOM_CORP_ID       corpid，wx_xxxxxxxxxx
 *   WECOM_AGENT_ID      agentid，数字，如 1000002
 *   WECOM_SECRET        应用 secret
 *   WECOM_TOKEN         接收消息的验签 token（后台配的那个）
 *   WECOM_AES_KEY       接收消息加解密 key（43 位 base64 字符串）
 *
 * 可选：
 *   WECOM_CALLBACK_HTTP_PORT   内嵌 receiver 端口，默认 3939
 *   WECOM_CALLBACK_URL         公网 URL（doctor 检测用），默认空
 *   WECOM_DEFAULT_TO_USER      发消息缺 chatId 时的默认 touser（如 '@all' 或 userid）
 */

export interface WeComConfig {
  corpId: string;
  agentId: string;
  secret: string;
  token: string;
  aesKey: string;

  callbackHttpPort: number;
  callbackUrl?: string;
  defaultToUser?: string;
}

export function loadWeComConfig(): WeComConfig | null {
  const corpId = process.env['WECOM_CORP_ID'];
  const agentId = process.env['WECOM_AGENT_ID'];
  const secret = process.env['WECOM_SECRET'];
  const token = process.env['WECOM_TOKEN'];
  const aesKey = process.env['WECOM_AES_KEY'];

  if (!corpId || !agentId || !secret || !token || !aesKey) return null;

  const port = Number(process.env['WECOM_CALLBACK_HTTP_PORT'] ?? '3939');
  const cfg: WeComConfig = {
    corpId,
    agentId,
    secret,
    token,
    aesKey,
    callbackHttpPort: Number.isFinite(port) && port > 0 ? port : 3939,
  };
  const callbackUrl = process.env['WECOM_CALLBACK_URL'];
  if (callbackUrl) cfg.callbackUrl = callbackUrl;
  const defaultToUser = process.env['WECOM_DEFAULT_TO_USER'];
  if (defaultToUser) cfg.defaultToUser = defaultToUser;
  return cfg;
}
