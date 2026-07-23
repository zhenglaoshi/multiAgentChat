/**
 * 跨会话 RAG 召回 —— RAG-lite（零依赖：不引嵌入/向量库/API key）。
 *
 * 升级原 recall() 的三点：
 *  ① 语料：不只 task memories(data/memories)，也纳入 knowledge(data/knowledge，claude 提炼的
 *     problem-solved/howto/gotcha —— 最高信号)。
 *  ② 打分：BM25（rare 词 idf 加权 + 文档长度归一），比原来的朴素子串计数准得多。
 *  ③ 分词：中文 **bigram**（原 tokenize 按单字切，"数据库"→数/据/库 召回弱；改成 数据/据库）。
 *  再叠 cwd 加权 + 时间衰减（沿用原 recall 的"同 repo、近期优先"）。
 *
 * 纯逻辑 tokenizeRag / rankBm25 与 IO(buildCorpus) 分离，便于单测。
 */
import { memoryStore } from './store.js';
import { listEntries } from '../knowledge/index.js';

export type RagDocKind = 'memory' | 'knowledge';

export interface RagDoc {
  id: string;
  kind: RagDocKind;
  title: string; // 短标签（展示用）
  text: string; // 全文（检索用）
  cwd?: string;
  at: number; // 时间戳（时间衰减用）
  tags: string[];
}

export interface RagResult {
  doc: RagDoc;
  score: number;
}

/**
 * RAG 分词：英文/数字按词（≥2 字符），中文按 **bigram**（连续汉字生成重叠二元组；
 * 单个汉字保留）。比"中文按单字"召回强很多，且零依赖、无需分词词典。
 */
export function tokenizeRag(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    if (m[0].length >= 2) out.push(m[0]);
  }
  for (const m of text.matchAll(/[一-龥]+/g)) {
    const run = m[0];
    if (run.length === 1) out.push(run);
    else for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

export interface Scorable {
  id: string;
  tokens: string[];
  cwd?: string;
  at: number;
}

export interface RankOptions {
  cwd?: string;
  now: number;
  k1?: number;
  b?: number;
  /** 时间衰减窗口(ms)，默认 90 天 */
  recencyMs?: number;
}

/**
 * BM25 排序（+ cwd 加权 + 时间衰减）。纯函数：入 docs(带分好的 tokens) + 查询 tokens，
 * 出按分降序的 {id, score>0}。docs 少(数百)时全量算完全够，无需向量库。
 */
export function rankBm25(
  docs: Scorable[],
  queryTokens: string[],
  opts: RankOptions,
): { id: string; score: number }[] {
  const k1 = opts.k1 ?? 1.5;
  const b = opts.b ?? 0.75;
  const recencyMs = opts.recencyMs ?? 90 * 86_400_000;
  const q = [...new Set(queryTokens)];
  if (docs.length === 0 || q.length === 0) return [];

  const N = docs.length;
  // 每文档 tf map + df
  const tfs = docs.map((d) => {
    const m = new Map<string, number>();
    for (const t of d.tokens) m.set(t, (m.get(t) ?? 0) + 1);
    return m;
  });
  const avgdl = docs.reduce((s, d) => s + d.tokens.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const term of q) {
    let c = 0;
    for (const m of tfs) if (m.has(term)) c++;
    df.set(term, c);
  }

  const scored: { id: string; score: number }[] = [];
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i]!;
    const tf = tfs[i]!;
    const dl = d.tokens.length || 1;
    let s = 0;
    for (const term of q) {
      const n = df.get(term)!;
      const f = tf.get(term) ?? 0;
      if (n === 0 || f === 0) continue;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * dl) / avgdl)));
    }
    if (s <= 0) continue;
    if (opts.cwd && d.cwd) {
      if (d.cwd === opts.cwd) s *= 1.6;
      else if (d.cwd.startsWith(opts.cwd) || opts.cwd.startsWith(d.cwd)) s *= 1.25;
    }
    const recency = Math.max(0.3, 1 - (opts.now - d.at) / recencyMs);
    s *= recency;
    scored.push({ id: d.id, score: s });
  }
  scored.sort((a, b2) => b2.score - a.score);
  return scored;
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

/** 汇总 memories + knowledge 成统一语料。 */
export async function buildCorpus(): Promise<RagDoc[]> {
  const docs: RagDoc[] = [];
  try {
    const mems = await memoryStore.all();
    for (const m of mems) {
      docs.push({
        id: `mem:${m.id}`,
        kind: 'memory',
        title: truncate(m.prompt, 60),
        text: [m.prompt, m.summary ?? '', m.outputPreview, (m.tags ?? []).join(' ')].join(' '),
        ...(m.cwd ? { cwd: m.cwd } : {}),
        at: m.endedAt || m.startedAt || 0,
        tags: m.tags ?? [],
      });
    }
  } catch {
    /* memory 读失败 → 跳过 */
  }
  try {
    const ks = await listEntries({});
    for (const k of ks) {
      docs.push({
        id: `kb:${k.id}`,
        kind: 'knowledge',
        title: truncate(k.title, 60),
        text: [k.title, k.body, (k.tags ?? []).join(' ')].join(' '),
        ...(k.source?.cwd ? { cwd: k.source.cwd } : {}),
        at: k.createdAt || 0,
        tags: k.tags ?? [],
      });
    }
  } catch {
    /* knowledge 读失败 → 跳过 */
  }
  return docs;
}

export interface RagRecallOptions {
  query: string;
  cwd?: string;
  limit?: number;
  now?: number;
}

/** 跨会话 RAG 召回：查 memories+knowledge，BM25+cwd+时间衰减排序，返回 Top-N。 */
export async function ragRecall(opts: RagRecallOptions): Promise<RagResult[]> {
  const corpus = await buildCorpus();
  if (corpus.length === 0) return [];
  const now = opts.now ?? Date.now();
  const scorables: Scorable[] = corpus.map((d) => ({
    id: d.id,
    tokens: tokenizeRag(d.text),
    ...(d.cwd ? { cwd: d.cwd } : {}),
    at: d.at,
  }));
  const ranked = rankBm25(scorables, tokenizeRag(opts.query), {
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    now,
  });
  const byId = new Map(corpus.map((d) => [d.id, d]));
  const limit = opts.limit ?? 5;
  const out: RagResult[] = [];
  for (const r of ranked.slice(0, limit)) {
    const doc = byId.get(r.id);
    if (doc) out.push({ doc, score: r.score });
  }
  return out;
}

const KIND_TAG: Record<RagDocKind, string> = { memory: '📋 记忆', knowledge: '💡 知识' };

function agoLabel(at: number, now: number): string {
  const d = Math.floor((now - at) / 86_400_000);
  if (d <= 0) return '今天';
  if (d === 1) return '昨天';
  if (d < 30) return `${d} 天前`;
  return `${Math.floor(d / 30)} 个月前`;
}

/** 渲染成注入 prompt / 飞书 /recall 的中文前缀。空结果返回 ''。 */
export function formatRagPrefix(results: RagResult[], now = Date.now()): string {
  if (results.length === 0) return '';
  const lines = ['[跨会话 RAG 召回 — 可能相关的历史]'];
  for (const r of results) {
    const cwdTail = r.doc.cwd ? r.doc.cwd.replace(/\/+$/, '').split('/').pop() : '';
    lines.push(
      `- ${KIND_TAG[r.doc.kind]} · ${agoLabel(r.doc.at, now)}${cwdTail ? ` · ${cwdTail}` : ''}：${r.doc.title}`,
    );
  }
  lines.push('（以上为历史检索，未必适用，仅供参考）');
  return lines.join('\n') + '\n\n';
}
