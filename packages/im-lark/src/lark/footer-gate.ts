import { homedir } from 'node:os';
import { redactMaybe } from './redact-gate.js';

/**
 * 出站消息统一页脚闸门 —— 仿 redact-gate：所有推给飞书的消息在发送层集中追加
 * 「🕐 时间 + 可选 📁 路径」，一眼看清是哪个目录、什么时候的。
 *
 * - 时间普适：每条消息都加（时间是发送时刻，北京时间 MM-DD HH:MM）。
 * - 路径按需：只有调用点能拿到 tab cwd、且卡片里还没显示路径时才传 cwd（避免重复）。
 * - `LARK_MSG_FOOTER=0` 关闭。
 */
/** 每次调用读 env（对齐 redact-gate 的做法，避免 import 顺序 / dotenv 加载时机的脆弱）。 */
function footerEnabled(): boolean {
  return process.env['LARK_MSG_FOOTER'] !== '0';
}

/** 北京时间 MM-DD HH:MM。显式时区（跨机器稳定）；daemon 运行时 new Date() 正常可用。 */
export function beijingStamp(d: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const g = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

function homeify(p: string): string {
  const h = homedir();
  return h && p.startsWith(h) ? '~' + p.slice(h.length) : p;
}

/**
 * lark_md 里路径可能含 [ ] ` < * _ 等字符，转义防注入/排版错乱（* _ 是斜体标记，
 * 目录名常带下划线如 fix_005808）。footer 独立，不引 cards.ts 避免环。
 */
function escapeMd(s: string): string {
  return s.replace(/[`\\[\]*_]/g, '\\$&').replace(/</g, '&lt;');
}

/**
 * 页脚正文（不含颜色标签）：🕐 时间（· 📁 路径）。cwd 为空或 '?' 时不显示路径。
 * 路径同样过 redactMaybe —— 不给 footer 开脱敏特例（目录名万一含凭证片段也不外露），
 * 保持「发送前统一脱敏」的单点不变式。
 */
function footerBody(cwd?: string, forCard = false): string {
  const showPath = cwd && cwd !== '?';
  let path = '';
  if (showPath) {
    const shown = redactMaybe(homeify(cwd));
    path = ` · 📁 ${forCard ? escapeMd(shown) : shown}`;
  }
  return `🕐 ${beijingStamp()}${path}`;
}

/**
 * 给纯文本消息末尾追加一行页脚（明文——text 消息不渲染 `<font>`）。
 * 调用点：只对最终确定走**纯文本**的消息用（markdown 会转成卡片，走 appendFooterCard）。
 */
export function appendFooterText(text: string, cwd?: string): string {
  if (!footerEnabled()) return text;
  return `${text}\n${footerBody(cwd, false)}`;
}

/**
 * 给卡片末尾追加一个 note 灰字页脚（时间 + 可选路径）。
 * 返回**新卡对象**（浅拷贝 + 新 elements 数组），绝不改原对象——防同一张卡发多个 chat
 * 时页脚累加。兼容两种卡：schema 1.x 顶层 `elements`、schema 2.0 `body.elements`（表单卡）。
 * 两种都没有则原样返回（非标准卡不动）。
 */
export function appendFooterCard<T>(card: T, cwd?: string): T {
  if (!footerEnabled()) return card;
  if (!card || typeof card !== 'object') return card;
  const c = card as Record<string, unknown>;
  const note = {
    tag: 'note',
    elements: [{ tag: 'lark_md', content: `<font color='grey'>${footerBody(cwd, true)}</font>` }],
  };
  // schema 1.x：顶层 elements
  if (Array.isArray(c['elements'])) {
    return { ...c, elements: [...(c['elements'] as unknown[]), note] } as T;
  }
  // schema 2.0：body.elements（连 body 一起浅拷贝，不改原对象）
  const body = c['body'];
  if (body && typeof body === 'object' && Array.isArray((body as Record<string, unknown>)['elements'])) {
    const b = body as Record<string, unknown>;
    return { ...c, body: { ...b, elements: [...(b['elements'] as unknown[]), note] } } as T;
  }
  return card;
}
