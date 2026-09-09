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
 * PEM 标签：限定成真实类型关键字，普通文本里的 `-----BEGIN X-----` 不会命中。
 *
 * 缩写一律加 `\b` 词边界。裸写 `EC` 会命中任何**含** "EC" 的词——
 * `-----BEGIN SECTION-----` / `-----BEGIN TECHNICAL NOTES-----` 这种文档分隔线全中招，
 * 然后规则1 贪婪吃到配对的 END，把中间整段业务正文替换成 `[REDACTED-PEM-BLOCK]`。
 * 那不是泄密，是**内容被静默销毁**，而且还回报「已脱敏」，比漏脱更难发现。
 */
const PEM_LABEL = String.raw`[A-Z0-9 ]{0,30}(?:PRIVATE KEY|PUBLIC KEY|CERTIFICATE|\bOPENSSH\b|\bPGP\b|\bRSA\b|\bDSA\b|\bEC\b)[A-Z0-9 ]{0,30}`;
/**
 * BEGIN 头，**容忍行尾的空白**。
 *
 * 少了这个 `[ \t]{0,8}` 会出最坏的一种结果：头行末尾多一个空格（富文本转纯文本、
 * 手滑多打一下，很常见），正文的每次迭代都以 `\r?\n` 起手、于是第一步就失配，
 * 「有 END」那条规则整体不匹配；而「无 END」那条的正文下限是 0 次，
 * 于是「头 + 零行正文」成了一次**成功**匹配——只吃掉头那几个字，
 * 密钥主体和 END 一个字节没动，引擎还回报「已脱敏 1 处」。
 * 假阳性比漏脱更危险：下游不会再有人去看那段文本。
 */
const PEM_HEAD = String.raw`-----BEGIN ${PEM_LABEL}-----[ \t]{0,8}`;
/** END 行（同样容忍前导空白）。 */
const PEM_END = String.raw`\r?\n?[ \t]{0,8}-----END ${PEM_LABEL}-----`;
/**
 * BEGIN 之后**没有换行**直接跟正文的情况。
 * 从网页表单 / 聊天工具里复制粘贴时换行常被吞掉，整个 key 挤成一行；
 * 只按「行」迭代的话正文一次都匹配不上，结果只有 BEGIN 那几个字被替换、主体照样明文。
 */
const PEM_INLINE = String.raw`(?:[A-Za-z0-9+/=]{16,})?`;
/** 一行「像 PEM 正文」的内容：base64 / `Key: Value` 头行 / PGP 的 `=CRC` 校验行。 */
const PEM_ALT = String.raw`(?:[A-Za-z0-9+/=]{16,}|[A-Za-z][A-Za-z-]{0,20}:[^\n]{0,80}|=[A-Za-z0-9+/]{4})`;
/** 一行实质正文（前后容忍引用前缀 `> ` 与空白）。 */
const PEM_LINE_REAL = String.raw`(?:\r?\n[ \t>]{0,8}${PEM_ALT}[ \t]{0,8})`;
/** 一行正文，允许整行为空（PEM 头与正文之间的空行）。 */
const PEM_LINE_ANY = String.raw`(?:\r?\n[ \t>]{0,8}${PEM_ALT}?[ \t]{0,8})`;
/**
 * 有 END 收尾时的正文：**任意**行内容（有界长度），**贪婪**吃到最后一个可行的 END。
 *
 * 两个刻意的选择：
 *  - 不按「像不像 base64」筛行：只要有一行不合预设格式，行迭代就在那里停住，
 *    该行及其后全部内容（含密钥主体和 END）统统落在匹配之外、原样明文。而真实世界里
 *    body 被污染太常见——聊天/邮件引用的 `> ` 前缀、行尾空格、PGP 的 `=CRC` 行。
 *    既然「必须匹配到 END」本身就是边界，正文放开反而更安全也不会过头。
 *  - **贪婪而非惰性**：惰性会在正文里**提前出现的**任意一行合法 END 处收口
 *    （同一份 key 被粘了两次、或混进一行旧的 END 标记），把之后到真正 END 之间的内容
 *    留在匹配外明文残留。`(?!-----BEGIN)` 保证贪婪也不会越过下一个真实块的边界。
 */
const PEM_BODY_ANY = String.raw`(?:\r?\n(?!-----BEGIN)[^\n]{0,200}){0,300}`;
/**
 * 没有 END 收尾（被截断 / 只贴了半截）时的正文：只吃「像 PEM 正文」的行，保守以免吞掉后文。
 * **至少要吃到一行实质内容**——允许 0 行的话，「头 + 空正文」会变成上面说的那种假阳性。
 * 前面容许几行纯空行（头与正文之间常有空行）。每次迭代必吃一个换行 → 切分唯一。
 */
const PEM_BODY_MIN1 = String.raw`(?:\r?\n[ \t]{0,8}){0,5}${PEM_LINE_REAL}${PEM_LINE_ANY}{0,300}`;

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
  /**
   * PEM 块（私钥 / 证书 / OPENSSH / PGP…）——**必须整块脱**。
   *
   * 上下文赋值规则的 value 字符集不含空白（含真实换行），碰到多行值只能吃到第一个换行前，
   * 产出 `private_key: "[REDACTED-VAL] PRIVATE KEY-----\nMIIEvQIB…"` —— 密钥主体一字不落
   * 明文送出。而「把一段私钥贴给 AI 问为什么连不上」是日常操作，会话历史源装的正是这种原文。
   * 放在 HIGH 里先整块吞掉，后面的 CTX 规则再遇到就被 isAlreadyRedacted 挡住。
   *
   * 分「有 END」「无 END 兜底」两条，正文宽严不同——理由见 PEM_BODY_ANY / PEM_BODY_MIN1。
   * 无 END 那条要么吃到 inline 正文、要么至少吃到一行实质正文，两者都没有就整体不匹配：
   * 宁可让密钥连头带尾留在明文里（还能靠残留的 `-----BEGIN` 字样被二次发现），
   * 也不要产出「只脱了头、却回报已脱敏」的假阳性。
   */
  {
    kind: 'PEM-BLOCK',
    re: new RegExp(`${PEM_HEAD}${PEM_INLINE}${PEM_BODY_ANY}${PEM_END}`, 'g'),
  },
  {
    kind: 'PEM-BLOCK',
    re: new RegExp(
      `${PEM_HEAD}(?:[A-Za-z0-9+/=]{16,}${PEM_LINE_ANY}{0,300}|${PEM_BODY_MIN1})`,
      'g',
    ),
  },
];

/**
 * 上下文赋值的 value 字符集。
 *
 * 早先写成 `[A-Za-z0-9/+\-_.]{8,}`，把 `!@#$%^&*` 这类**密码里最常见的符号**排除在外 ——
 * 于是 `password: "Str0ng!Pass#2024"` 只匹配到 `Str0ng`，产出
 * `password: "[REDACTED-VAL]!Pass#2024"`：真密码的后半截**紧跟着脱敏标记明文送出去**，
 * 还顺带暴露了长度和结构。改成「一直吃到空白/引号/中英文断句标点为止」，整段值才被完整替换。
 */
/**
 * 赋值分隔符。含全角 `：`/`＝`：中文输入法下打英文变量名再顺手敲个冒号，
 * 出来的是全角（`api_key：sk-xxx`），只认半角就整条漏过。
 */
const SEP = String.raw`[:=：＝]`;

const CTX_VAL = String.raw`[^\s"'，、；。！？,;)\]}]{8,}`;

/**
 * 上下文赋值的 key 部分。
 *
 * 允许任意前缀（`WECOM_TOKEN` / `RELAY_TOKEN` / `SESSION_KEY` / `ENCRYPTION_KEY`…）——
 * 早先只认白名单里那几个固定写法（api_key / app_secret / auth_token…），
 * 贴一段 `.env` 求助时凡是没在白名单里的变量名，值就原样漏过去了。
 * 裸 `key` 故意**不**收（JSON 里 `"key": "name"` 满地都是，收了全是误伤），
 * 只收 `_key` / `-key` 后缀形式；裸 `token` 收（几乎不作他用）。
 */
const CTX_KEY = String.raw`[A-Za-z0-9_.-]{0,48}(?:pass(?:wd|word)?|pwd|secret[_-]?key|secret|credential|private[_-]?key|api[_-]?key|token|[_-]key|\bsk\b)`;

/**
 * 上下文赋值：`password: "x" / WECOM_TOKEN=x / sk = x`，只脱赋值右边的 value。
 * group1 = key + 分隔符（含可选引号），group2 = value。
 * 注：access_key / ak 关键字已按需求移除，不再脱 AK 类赋值（strict 模式除外，见 STRICT_*）。
 */
const CTX_RE = new RegExp(String.raw`((?:\b${CTX_KEY})\s*["']?\s*${SEP}\s*["']?)(${CTX_VAL})`, 'gi');

/**
 * 自然语言里的凭证交代：「生产库密码是 abc123!Q」「token 为 xxxx」。
 *
 * `CTX_RE` 要求一个 `:` 或 `=` 分隔符——代码和配置里有，**人说话时没有**。
 * 会话历史这个数据源装的正是人话（见 report/sessions.ts），所以这条必须单列。
 * 阈值放到 6（中文语境下的口令常比 env 值短）。
 */
const NL_RE = new RegExp(
  String.raw`((?:密码|口令|密钥|秘钥|密匙|凭证|令牌|token)\s*(?:是|为|${SEP})\s*["']?)([^\s"'，、；。！？,;)\]}]{6,})`,
  'gi',
);

/**
 * **strict 模式专用**的额外规则（AK 类）。
 *
 * 为什么单列而不是加回 HIGH_RULES：「AK 不自动脱敏」是用户明确要求的，那个决定成立于
 * 脱敏引擎只处理**终端回显**（多是命令和工具输出）的时期。`report/sessions.ts` 新开了一条
 * 「一整天的人类对话原文 → claude -p 合成 → 推飞书」的通路，同一条 AK 贴进聊天求助
 * （"帮我看下这个 AKIA... 为什么调不通"）就会明文流向两个外部服务。
 * 于是只给这条新通路加严，回显路径的行为**一个字节都不变**。
 */
const STRICT_RULES: HighRule[] = [
  { kind: 'AWS-AK', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}/g },
  { kind: 'ALIYUN-AK', re: /\bLTAI[0-9A-Za-z]{12,}/g },
  { kind: 'HUAWEI-AK', re: /\bHXWZ[0-9A-Za-z]{12,}/g },
];

/** strict 模式下额外脱的赋值 key（access_key / accessKeyId / ak / sk_secret…）。 */
const STRICT_CTX_RE = new RegExp(
  String.raw`((?:\b[A-Za-z0-9_.-]{0,48}(?:access[_-]?key(?:[_-]?id|[_-]?secret)?|\bak\b|secret[_-]?access[_-]?key))\s*["']?\s*${SEP}\s*["']?)(${CTX_VAL})`,
  'gi',
);

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
 * value 是否已经是本引擎产出的脱敏标记（不要二次脱）。
 *
 * 规则按「连接串 → 高置信度 → 上下文赋值」顺序跑，前一步会把
 * `RELAY_TOKEN=mrt_xxx` 变成 `RELAY_TOKEN=[REDACTED-RELAY-TOKEN]`；
 * value 字符集放宽到「吃到空白/引号为止」后，上下文规则会把那个**标记本身**
 * 当成值再脱一次，产出 `[REDACTED-VAL]]` 这种破损结果，还把更精确的
 * 类型标注（哪种 token）擦掉了。
 */
function isAlreadyRedacted(val: string): boolean {
  return /^\[?REDACTED-/i.test(val);
}

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

export interface RedactOptions {
  /**
   * 加严模式：在默认规则之外再脱 AK 类（前缀 + access_key 赋值）。
   * 给「把大段人类原文送出机器」的通路用——目前是报告的会话历史源。
   * 回显脱敏 / 历史文件 scrub **不要**开，那会推翻用户「AK 不自动脱」的明确要求。
   */
  strict?: boolean;
}

/**
 * 脱敏一段文本。返回脱敏后的文本 + 命中统计。无命中时 clean === input（不改）。
 * 顺序：连接串密码 → 高置信度（strict 再加 AK 类）→ 上下文赋值 → 自然语言交代。
 */
export function redact(input: string, opts: RedactOptions = {}): RedactResult {
  if (!input) return { clean: input, hits: [], redactedCount: 0 };
  const counts = new Map<string, number>();
  const bump = (k: string, n = 1) => counts.set(k, (counts.get(k) ?? 0) + n);

  let text = input;

  // 1) 连接串密码
  text = text.replace(CONN_RE, (_m, pre: string, _pass: string, at: string) => {
    bump('DBPASS');
    return `${pre}[REDACTED-DBPASS]${at}`;
  });

  // 2) 高置信度整体替换（strict 再叠加 AK 类）
  for (const rule of opts.strict ? [...HIGH_RULES, ...STRICT_RULES] : HIGH_RULES) {
    text = text.replace(rule.re, () => {
      bump(rule.kind);
      return `[REDACTED-${rule.kind}]`;
    });
  }

  // 3) 上下文赋值（排除占位符/停用词）
  text = text.replace(CTX_RE, (m: string, keyPart: string, val: string) => {
    if (isAlreadyRedacted(val) || isPlaceholderValue(val)) return m;
    bump('CTX');
    return `${keyPart}[REDACTED-VAL]`;
  });

  // 3b) strict：AK 类赋值（access_key / ak / secret_access_key）
  if (opts.strict) {
    text = text.replace(STRICT_CTX_RE, (m: string, keyPart: string, val: string) => {
      if (isAlreadyRedacted(val) || isPlaceholderValue(val)) return m;
      bump('AK-CTX');
      return `${keyPart}[REDACTED-VAL]`;
    });
  }

  // 4) 自然语言里的凭证交代（「密码是 x」「token 为 x」——人话里没有 : / =）
  text = text.replace(NL_RE, (m: string, keyPart: string, val: string) => {
    if (isAlreadyRedacted(val) || isPlaceholderValue(val)) return m;
    bump('NL');
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
export function redactText(input: string, opts?: RedactOptions): string {
  return redact(input, opts).clean;
}

/**
 * 便捷：加严脱敏（额外脱 AK 类）。
 * 只给「大段人类原文离开本机」的通路用——见 RedactOptions.strict 的说明。
 */
export function redactTextStrict(input: string): string {
  return redact(input, { strict: true }).clean;
}

/** 命中统计转成一行摘要，如 `OPENAI:1, DBPASS:2`（给日志/提示用）。 */
export function summarizeHits(hits: RedactHit[]): string {
  return hits.map((h) => `${h.kind}:${h.count}`).join(', ');
}
