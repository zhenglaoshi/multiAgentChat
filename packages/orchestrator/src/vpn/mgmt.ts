/**
 * OpenVPN 管理接口（management interface）协议的纯逻辑：解析 openvpn 推过来的行、拼要发的命令。
 *
 * 背景：scripts/vpn/mchat-vpn（root 小程序）以 `--management-query-passwords --management-hold` 起 openvpn，
 * 管理 socket 交给本人；daemon 经它交账号 / 密码 / 6 位令牌（static-challenge），锁屏也能连
 * （Tunnelblick 的令牌框锁屏时辅助功能接口看不到，填不进去 —— 2026-11-05 实测）。
 */

export type VpnEnv = 'prod' | 'dev';
export const VPN_ENVS: readonly VpnEnv[] = ['prod', 'dev'];

export type MgmtEvent =
  | { type: 'need-auth'; staticChallenge: boolean }
  | { type: 'auth-failed'; reason: string }
  | { type: 'state'; state: string; detail: string; localIp: string }
  | { type: 'fatal'; message: string }
  | { type: 'hold' }
  | { type: 'other'; line: string };

/** 解析 openvpn 管理口推来的一行（已去掉行尾 \r\n）。 */
export function parseMgmtLine(line: string): MgmtEvent {
  if (line.startsWith(">PASSWORD:Need 'Auth'")) {
    return { type: 'need-auth', staticChallenge: /\bSC:/.test(line) };
  }
  if (line.startsWith('>PASSWORD:Verification Failed')) {
    // `>PASSWORD:Verification Failed: 'Auth' ['服务器给的原因']`（2.6 带原因；老版本没有）
    const m = /\['(.*)'\]\s*$/.exec(line);
    return { type: 'auth-failed', reason: m?.[1] ?? '' };
  }
  if (line.startsWith('>STATE:')) {
    // >STATE:<时间>,<状态>,<描述>,<本地 IP>,<远端 IP>,...
    const p = line.slice('>STATE:'.length).split(',');
    return { type: 'state', state: p[1] ?? '', detail: p[2] ?? '', localIp: p[3] ?? '' };
  }
  if (line.startsWith('>FATAL:')) return { type: 'fatal', message: line.slice('>FATAL:'.length) };
  if (line.startsWith('>HOLD:')) return { type: 'hold' };
  return { type: 'other', line };
}

/**
 * 管理协议参数：双引号包裹，转义 `\` 和 `"`。
 * 换行一律拒绝 —— 管理协议按行分命令，值里带换行就能多塞一条任意管理命令（如 `signal SIGTERM`）。
 */
export function quoteMgmtArg(v: string): string {
  if (/[\r\n]/.test(v)) throw new Error('管理协议参数不能含换行');
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** static-challenge 的密码字段：`SCRV1:<base64 密码>:<base64 令牌>`。 */
export function buildScrv1(password: string, otp: string): string {
  const b = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  return `SCRV1:${b(password)}:${b(otp)}`;
}

/**
 * 从用户回复里取 6 位令牌：恰好一段独立的 6 位数字才算（「令牌 123456」「123 456」都行），
 * 有零段或多段 → null（别猜）。
 */
export function extractOtp(text: string): string | null {
  const compact = text.replace(/(\d)\s+(?=\d)/g, '$1');
  const hits = compact.match(/(?<!\d)\d{6}(?!\d)/g) ?? [];
  return hits.length === 1 ? hits[0]! : null;
}

export function parseVpnEnv(s: string | undefined): VpnEnv | null {
  const v = (s ?? '').trim().toLowerCase();
  if (v === 'prod' || v === '正式' || v === 'production') return 'prod';
  if (v === 'dev' || v === 'test' || v === '测试') return 'dev';
  return null;
}

export const VPN_ENV_LABEL: Record<VpnEnv, string> = { prod: '正式环境', dev: '测试环境' };
