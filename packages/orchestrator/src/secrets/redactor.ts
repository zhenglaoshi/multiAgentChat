/**
 * 明文凭证脱敏引擎 —— 全项目单一事实源。
 *
 * 背景：本项目会把终端输出/助手回复推到飞书、落盘到 data/（memories/knowledge），
 * claude/codex 又把整段会话明文写进 ~/.claude、~/.codex。只要在 shell 里 `cat .env`、
 * 连库、看 API 返回，SK/密码/token 就会明文外泄到手机或磁盘（AK 类已按需求不脱）。
 *
 * 这个引擎被两处复用（保持检测规则一致，不再各写一套）：
 *   1. 回显脱敏（redact-on-echo）：飞书推送 / data 落盘前 —— 见 im-lark 的推送路径
 *   2. 静态文件脱敏（at-rest）：扫 ~/.claude、~/.codex 会话历史 —— 见 secrets/scrub.ts
 *
 * 规则移植自成熟的 audit-claude-secrets scrubber（python），保持替换语义一致：
 *   - 连接串只脱密码段；高置信度整体脱；上下文赋值脱值（排除占位符）。
 * 故意**不含**"40 位以上 hex/base64 一律脱"这类宽规则 —— 会把 git SHA/哈希误脱、
 * 甚至损坏会话 transcript。宁可漏，不可乱（漏的靠 CTX/HIGH 兜 + 用户别 echo 敏感信息）。
 */

export interface RedactHit {
  kind: string;
  count: number;
}

export interface RedactResult {
  /** 脱敏后的文本 */
  clean: string;
  /** 各类型命中次数 */
  hits: RedactHit[];
  /** 总命中数 */
  redactedCount: number;
}

interface HighRule {
  kind: string;
  re: RegExp;
}

/** DB/AMQP 连接串：只脱 `scheme://user:PASS@` 里的密码段，保留结构。 */
const CONN_RE =
  /\b((?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/"]+:)([^\s:@/"]+)(@)/g;

/**
 * 高置信度：命中即整体替换成 [REDACTED-<KIND>]。
 * 注：AK（AWS AKIA/ASIA、阿里云 LTAI、华为云 HXWZ）前缀规则已按需求移除。
 */
const HIGH_RULES: HighRule[] = [
  { kind: 'ANTHROPIC', re: /\bsk-ant-[A-Za-z0-9\-_]{20,}/g },
  { kind: 'OPENAI', re: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/g },
  { kind: 'GH-TOKEN', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g },
  { kind: 'GH-PAT', re: /\bgithub_pat_[A-Za-z0-9_]{50,}/g },
  { kind: 'SLACK', re: /\bxox[baprs]-[A-Za-z0-9\-]{10,}/g },
  { kind: 'GOOGLE-KEY', re: /\bAIza[0-9A-Za-z\-_]{35}/g },
  { kind: 'GITLAB-PAT', re: /\bglpat-[A-Za-z0-9\-_]{20}/g },
  { kind: 'CAREYCLAW-TOKEN', re: /\boct_[A-Za-z0-9\-_]{40,}/g },
  { kind: 'RELAY-TOKEN', re: /\bmrt_[a-f0-9]{32,}/g }, // 同事甩单 relay 接入 token（自助门户签发）
  { kind: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
];

/**
 * 上下文赋值：`password: "x" / api_key=x / sk = x`，只脱赋值右边的 value。
 * group1 = key + 分隔符（含可选引号），group2 = value。
 * 注：access_key / ak 关键字已按需求移除，不再脱 AK 类赋值。
 */
const CTX_RE =
  /((?:pass(?:wd|word)?|pwd|secret|secret[_-]?key|app[_-]?secret|client[_-]?secret|api[_-]?key|auth[_-]?token|dev[_-]?token|\bsk\b)\s*["']?\s*[:=]\s*["']?)([A-Za-z0-9/+\-_.]{8,})/gi;

/** 占位符/明显非真值：命中则不脱（避免把 YOUR_KEY / xxxx / process.env.X 也脱了）。 */
const PLACEHOLDER_RE =
  /^(x{4,}|placeholder|none|null|true|false|undefined|changeme|redacted|test|dummy|foo|bar|abc123|\d{1,4}|process\.env.*|os\.environ.*)$/i;
const CTX_STOPWORDS = new Set([
  'password',
  'secret',
  'token',
  'key',
  'username',
  'user',
  'true',
  'false',
]);

/**
 * value 是否是占位符（不脱）。比 python 版更宽：额外认 `your*` / `example*` / `sample*`
 * 前缀、`*_here` 后缀 —— 文档/模板里的假值（YOUR_PASSWORD、example_key、TOKEN_HERE）常见，
 * 脱了它们是纯噪音。注：`<...>`/`${...}` 这类因含非 value 字符，CTX 正则本就不会捕获。
 */
function isPlaceholderValue(val: string): boolean {
  const v = val.toLowerCase();
  if (PLACEHOLDER_RE.test(v)) return true;
  if (CTX_STOPWORDS.has(v)) return true;
  if (v.startsWith('your') || v.startsWith('example') || v.startsWith('sample') || v.startsWith('dummy')) {
    return true;
  }
  if (v.endsWith('_here') || v.endsWith('-here')) return true;
  return false;
}

/**
 * 脱敏一段文本。返回脱敏后的文本 + 命中统计。无命中时 clean === input（不改）。
 * 顺序：连接串密码 → 高置信度 → 上下文赋值（与 python scrubber 一致）。
 */
export function redact(input: string): RedactResult {
  if (!input) return { clean: input, hits: [], redactedCount: 0 };
  const counts = new Map<string, number>();
  const bump = (k: string, n = 1) => counts.set(k, (counts.get(k) ?? 0) + n);

  let text = input;

  // 1) 连接串密码
  text = text.replace(CONN_RE, (_m, pre: string, _pass: string, at: string) => {
    bump('DBPASS');
    return `${pre}[REDACTED-DBPASS]${at}`;
  });

  // 2) 高置信度整体替换
  for (const rule of HIGH_RULES) {
    text = text.replace(rule.re, () => {
      bump(rule.kind);
      return `[REDACTED-${rule.kind}]`;
    });
  }

  // 3) 上下文赋值（排除占位符/停用词）
  text = text.replace(CTX_RE, (m: string, keyPart: string, val: string) => {
    if (isPlaceholderValue(val)) return m;
    bump('CTX');
    return `${keyPart}[REDACTED-VAL]`;
  });

  const hits = [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count);
  const redactedCount = hits.reduce((s, h) => s + h.count, 0);
  return { clean: text, hits, redactedCount };
}

/** 快速判断：文本里是否含疑似明文凭证（用于 gate / 决定是否加脱敏提示，不产生副本）。 */
export function hasSecrets(input: string): boolean {
  return redact(input).redactedCount > 0;
}

/** 便捷：只要脱敏后的文本。 */
export function redactText(input: string): string {
  return redact(input).clean;
}

/** 命中统计转成一行摘要，如 `OPENAI:1, DBPASS:2`（给日志/提示用）。 */
export function summarizeHits(hits: RedactHit[]): string {
  return hits.map((h) => `${h.kind}:${h.count}`).join(', ');
}
