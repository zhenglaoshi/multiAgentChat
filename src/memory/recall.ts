/**
 * Memory search & recall：按 cwd + 关键词模糊匹配，按时间衰减 + 内容相关性打分。
 */

import { memoryStore } from './store.js';
import type { TaskMemory } from './types.js';

const RECENT_DAYS = 30;
const RECENT_MS = RECENT_DAYS * 24 * 60 * 60 * 1000;

export interface RecallOptions {
  cwd?: string;        // 限定 cwd（精确匹配优先，否则全局）
  keywords?: string[]; // 关键词数组（已过 tokenize）
  limit?: number;      // 默认 5
  minScore?: number;   // 默认 0.5
}

export interface RecallResult {
  memory: TaskMemory;
  score: number;
}

/**
 * 简单中文 + 英文 tokenize：按非字母数字字符切分；中文按字切分。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const matches = text.match(/[a-zA-Z0-9]+|[一-龥]/g) ?? [];
  for (const m of matches) {
    if (m.length < 1) continue;
    if (/^[a-zA-Z0-9]+$/.test(m) && m.length < 2) continue;
    tokens.push(m.toLowerCase());
  }
  // dedup
  return Array.from(new Set(tokens));
}

function scoreMemory(
  m: TaskMemory,
  keywords: string[],
  cwd: string | undefined,
): number {
  let score = 0;
  const now = Date.now();
  const ageMs = now - m.endedAt;
  if (ageMs > RECENT_MS) score -= 0.5;

  // 时间衰减（最近 24h = 1.0，1 周 = 0.5，1 月 = 0.1）
  const ageWeight = Math.max(0.1, 1 - ageMs / RECENT_MS);

  // cwd 精确匹配权重最高
  if (cwd && m.cwd === cwd) score += 2 * ageWeight;
  else if (cwd && m.cwd.startsWith(cwd)) score += 1 * ageWeight;
  else if (cwd && cwd.startsWith(m.cwd)) score += 0.5 * ageWeight;

  // 关键词匹配
  const haystack = (
    m.prompt +
    ' ' +
    (m.summary ?? '') +
    ' ' +
    m.tags.join(' ')
  ).toLowerCase();
  let kwHits = 0;
  for (const kw of keywords) {
    if (haystack.includes(kw.toLowerCase())) kwHits++;
  }
  if (keywords.length > 0) {
    score += (kwHits / keywords.length) * 2 * ageWeight;
  }

  return score;
}

export async function recall(opts: RecallOptions): Promise<RecallResult[]> {
  const all = await memoryStore.all();
  const keywords = opts.keywords ?? [];
  const limit = opts.limit ?? 5;
  const minScore = opts.minScore ?? 0.5;

  const scored: RecallResult[] = [];
  for (const m of all) {
    const s = scoreMemory(m, keywords, opts.cwd);
    if (s < minScore) continue;
    scored.push({ memory: m, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * 把 recall 结果格式化为可以注入到 prompt 头部的 markdown 段落。
 */
export function formatRecallPrefix(results: RecallResult[]): string {
  if (results.length === 0) return '';
  const lines: string[] = ['[上次相关历史 — 系统自动注入]'];
  for (const r of results) {
    const m = r.memory;
    const ago = humanAgo(m.endedAt);
    const filesNote =
      m.filesProduced && m.filesProduced.length
        ? `\n  • 涉及文件：${m.filesProduced.slice(0, 3).join('  ')}`
        : '';
    lines.push(`- ${ago}: "${m.prompt.slice(0, 80)}${m.prompt.length > 80 ? '…' : ''}"${filesNote}`);
  }
  return lines.join('\n') + '\n\n[本次任务]\n';
}

function humanAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)} 天前`;
  return `${Math.floor(d / (7 * 86_400_000))} 周前`;
}
