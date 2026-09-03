/**
 * relay（同事甩单中转）客户端配置。全部从 env 读；缺 RELAY_URL / RELAY_TOKEN /
 * RELAY_IDENTITY 任一 → 返回 null（整个 handoff 功能不启用，daemon 静默跳过）。
 */
export interface RelayClientConfig {
  url: string; // 形如 https://relay.example.com（无尾斜杠）
  token: string;
  identity: string; // 本人身份（邮箱）
  /**
   * 收件闸门：非空 = 严格 opt-in（只收名单内发件人）；**空 = 收所有**（门户模型：relay 已凭
   * SSO/邀请码登记发件人身份 + 收件人黑名单在 relay 侧拦，客户端默认放行）。见 poller.ts。
   */
  allow: Set<string>;
  /** @别名 → 身份（邮箱）。 */
  aliases: Map<string, string>;
}

function parseCsv(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 解析 "bob=bob@x.com,carol=carol@x.com" → Map。 */
function parseAliases(v: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of parseCsv(v)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const alias = pair.slice(0, eq).trim().replace(/^@/, '');
    const identity = pair.slice(eq + 1).trim();
    if (alias && identity) map.set(alias, identity);
  }
  return map;
}

export function loadRelayConfig(): RelayClientConfig | null {
  const url = process.env['RELAY_URL']?.trim();
  const token = process.env['RELAY_TOKEN']?.trim();
  const identity = process.env['RELAY_IDENTITY']?.trim();
  if (!url || !token || !identity) return null;
  // 强制 TLS（fail-closed）：非 https 一律拒绝，仅放行本地回环调试。
  // 用 URL.hostname 判定（而非字符串前缀），堵 `http://localhost:x@evil.com` 这类 userinfo 误判。
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`RELAY_URL 不是合法 URL：${url}`);
  }
  const isLocalHost = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalHost)) {
    throw new Error(
      `RELAY_URL 必须是 https://（Bearer token 与内容会明文过网络）：当前 ${url}。本地调试可用 http://localhost 或 http://127.0.0.1。`,
    );
  }
  return {
    url: url.replace(/\/+$/, ''),
    token,
    identity,
    allow: new Set(parseCsv(process.env['HANDOFF_ALLOW'])),
    aliases: parseAliases(process.env['HANDOFF_ALIASES']),
  };
}

/** @别名 / 邮箱 → 身份。找不到别名就按原样返回（可能本就是邮箱）。 */
export function resolveIdentity(cfg: RelayClientConfig, target: string): string {
  const t = target.trim().replace(/^@/, '');
  return cfg.aliases.get(t) ?? t;
}
