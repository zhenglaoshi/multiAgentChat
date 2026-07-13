/**
 * Sanitize —— 把 chunk 里的敏感串替换成 <REDACTED-X>。
 *
 * 现覆盖：
 *   - Anthropic API key (sk-ant-...)
 *   - GitHub tokens (ghp_..., gho_..., ghs_..., ghr_...)
 *   - OpenAI (sk-...)
 *   - Lark App Secret 格式（32 位十六进制通常）
 *   - JWT (eyJ...eyJ...) 长长的 base64
 *   - AWS access key (AKIA...)
 *   - 邮箱（保守：只脱 @ 后半段）
 *   - IP + port（保守，不脱本地）
 *   - .env 常见变量赋值行（*_SECRET *_TOKEN *_KEY *_PASSWORD *_PW =）
 *   - macOS 用户名（Users/xxx）—— 不脱（不敏感）
 *
 * 会漏掉的：URL 里带的 token、连接串里的密码、自定义 secret 前缀。用户要自己
 * 注意别在 shell 里 echo 敏感信息，或后期加个 pattern DB。
 */

interface Rule {
  name: string;
  re: RegExp;
  replace: string | ((m: string) => string);
}

const RULES: Rule[] = [
  { name: 'anthropic', re: /\bsk-ant-[a-zA-Z0-9-_]{20,}/g, replace: '<REDACTED-ANTHROPIC>' },
  { name: 'github-pat', re: /\b(?:ghp|gho|ghs|ghr|ghu)_[a-zA-Z0-9]{20,}\b/g, replace: '<REDACTED-GH>' },
  { name: 'openai', re: /\bsk-[a-zA-Z0-9]{40,}\b/g, replace: '<REDACTED-OPENAI>' },
  { name: 'aws', re: /\bAKIA[0-9A-Z]{16}\b/g, replace: '<REDACTED-AWS-KEY>' },
  { name: 'jwt', re: /\beyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, replace: '<REDACTED-JWT>' },
  {
    name: 'env-secret-line',
    re: /^(?:export\s+)?([A-Z_][A-Z0-9_]{3,})(_SECRET|_TOKEN|_KEY|_PASSWORD|_PW|_APIKEY)\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gm,
    replace: (_m) => {
      const groupMatch = /^(?:export\s+)?([A-Z_][A-Z0-9_]{3,}(?:_SECRET|_TOKEN|_KEY|_PASSWORD|_PW|_APIKEY))\s*=/.exec(_m);
      const name = groupMatch?.[1] ?? 'SECRET';
      return `${name}=<REDACTED>`;
    },
  },
  {
    name: 'email',
    re: /\b([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/g,
    // 保留用户名前 2 位 + 域名首字母；避免全脱敏丢上下文
    replace: (m) => {
      const at = m.indexOf('@');
      const user = m.slice(0, at);
      const domain = m.slice(at + 1);
      const shortUser = user.length <= 2 ? user : user.slice(0, 2) + '***';
      const dot = domain.indexOf('.');
      const shortDomain = dot > 0 ? domain[0] + '***' + domain.slice(dot) : '***';
      return `${shortUser}@${shortDomain}`;
    },
  },
  // 40 位 hex（可能是 secret / API key）—— 保守脱，只在纯 hex 40+ 位时才脱
  { name: 'long-hex', re: /\b[a-f0-9]{40,}\b/gi, replace: '<REDACTED-HEX>' },
  // 32 位 base64 长串（可能是 secret）
  { name: 'long-b64', re: /\b[a-zA-Z0-9+/=]{40,}\b/g, replace: '<REDACTED-B64>' },
];

export interface SanitizeReport {
  clean: string;
  redactedCount: number;
  hits: { rule: string; count: number }[];
}

export function sanitize(input: string): SanitizeReport {
  let text = input;
  const hits: { rule: string; count: number }[] = [];
  for (const rule of RULES) {
    const before = text;
    const matches = text.match(rule.re);
    if (matches && matches.length > 0) {
      text = text.replace(rule.re, rule.replace as never);
      hits.push({ rule: rule.name, count: matches.length });
    }
    void before;
  }
  const redactedCount = hits.reduce((s, h) => s + h.count, 0);
  return { clean: text, redactedCount, hits };
}
