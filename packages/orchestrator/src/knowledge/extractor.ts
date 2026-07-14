import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { logger } from '../logger.js';
import { sanitize } from './sanitize.js';
import { extractCommands, extractFilePaths, shouldExtract } from './heuristics.js';
import { hasExtracted, nextKnowledgeId, saveEntry } from './store.js';
import type { KnowledgeEntry, KnowledgeKind, KnowledgeSource } from './types.js';

/**
 * ExtractRequest —— 上游（daemon watcher listener 或手动 CLI）扔进队列的 chunk。
 */
export interface ExtractRequest {
  chunk: string;                    // 原始（未 sanitize）
  origin: KnowledgeSource['origin'];
  originalPrompt?: string;
  tty?: string;
  cwd?: string;
}

/** 队列容量 —— 满了新请求直接 drop（避免堆积拖爆内存） */
const QUEUE_CAP = 30;
/** claude CLI 超时（单次提取）—— claude -p 冷启动实测 30-90s，给到 180s */
const CLAUDE_TIMEOUT_MS = 180_000;
/** chunk tail 上限（超过截断，避免 prompt 过大） */
const CHUNK_MAX_CHARS = 8000;

const EXTRACT_PROMPT_TEMPLATE = `你是"shell 会话知识提取器"。分析下面 sanitize 过的 shell 交互，从中提炼 0 到 3 条**真正有价值**的知识条目。

每条条目 JSON 结构（严格遵守）：
{
  "kind": "problem-solved" | "howto" | "decision" | "gotcha" | "reference",
  "title": "一行短标题（≤80 中文字符）",
  "body": "markdown 说明（≤500 字符）。建议结构：问题 / 尝试 / 解法 / 教训（或 howto 就写步骤）",
  "tags": ["3-8 个关键词，含项目名/技术 stack/领域"]
}

规则：
- 只提"能复用"的知识（问题被解决、总结了坑、做了决定、方法可复用）。**纯 build/install log 或没解决的报错**返回 []。
- 不要编造：body 只能基于输入里真实的信息。
- 输出**只包含**一个 JSON 数组（可空 []），前后不要任何解释、markdown fence、思考过程。

输入（sanitize 后）：
<<<CHUNK>>>
`;

class ExtractionQueue {
  private queue: ExtractRequest[] = [];
  private running = false;

  enqueue(req: ExtractRequest): { queued: boolean; reason?: string } {
    if (this.queue.length >= QUEUE_CAP) {
      logger.warn('knowledge queue full, dropping', { size: this.queue.length });
      return { queued: false, reason: 'queue-full' };
    }
    this.queue.push(req);
    void this.processLoop();
    return { queued: true };
  }

  size(): number {
    return this.queue.length;
  }

  private async processLoop(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const req = this.queue.shift();
        if (!req) break;
        try {
          await this.process(req);
        } catch (e) {
          logger.warn('knowledge process failed', { err: (e as Error).message });
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async process(req: ExtractRequest): Promise<void> {
    const chunk = req.chunk;
    const signal = shouldExtract(chunk);
    if (!signal.should) {
      logger.debug('knowledge skip (heuristic)', { reasons: signal.reasons, charLen: signal.charLen });
      return;
    }

    // sanitize
    const { clean, redactedCount, hits } = sanitize(chunk);
    if (redactedCount > 0) {
      logger.info('knowledge sanitize redacted', { count: redactedCount, hits });
    }

    // 去重：同 chunkHash 已提取过就不再跑
    const chunkHash = sha256Prefix(clean);
    if (await hasExtracted(chunkHash)) {
      logger.debug('knowledge already extracted, skip', { chunkHash });
      return;
    }

    // 截断防 prompt 过大
    const tailForPrompt =
      clean.length > CHUNK_MAX_CHARS
        ? '…(前面截断)…\n' + clean.slice(-CHUNK_MAX_CHARS)
        : clean;

    const prompt = EXTRACT_PROMPT_TEMPLATE.replace('<<<CHUNK>>>', tailForPrompt);

    let entries: Omit<KnowledgeEntry, 'id' | 'createdAt' | 'source' | 'chunkHash'>[];
    const startedAt = Date.now();
    logger.info('knowledge extract start', {
      chunkHash,
      inputBytes: tailForPrompt.length,
      cwd: req.cwd,
    });
    try {
      entries = await runClaudeExtract(prompt);
    } catch (e) {
      logger.warn('claude extract failed', {
        err: (e as Error).message,
        elapsedMs: Date.now() - startedAt,
      });
      return;
    }
    logger.info('knowledge extract done', {
      chunkHash,
      elapsedMs: Date.now() - startedAt,
      produced: entries.length,
    });
    if (entries.length === 0) {
      logger.debug('knowledge extractor returned empty', { chunkHash });
      return;
    }

    // 落盘
    const source: KnowledgeSource = {
      origin: req.origin,
      outputPreview: clean.slice(-500),
      commandsRun: extractCommands(clean),
      filesTouched: extractFilePaths(clean),
    };
    if (req.originalPrompt) source.originalPrompt = req.originalPrompt;
    if (req.tty) source.tty = req.tty;
    if (req.cwd) source.cwd = req.cwd;

    for (const partial of entries) {
      const entry: KnowledgeEntry = {
        id: nextKnowledgeId(),
        createdAt: Date.now(),
        kind: partial.kind,
        title: (partial.title ?? '').slice(0, 100),
        body: (partial.body ?? '').slice(0, 800),
        tags: Array.isArray(partial.tags) ? partial.tags.slice(0, 10).map(String) : [],
        source,
        chunkHash,
      };
      try {
        await saveEntry(entry);
      } catch (e) {
        logger.warn('knowledge save failed', { err: (e as Error).message });
      }
    }
  }
}

/**
 * spawn `claude -p <prompt>` 拿 JSON。allowedTools 只给 Read（不能改代码）。
 */
function runClaudeExtract(prompt: string): Promise<Omit<KnowledgeEntry, 'id' | 'createdAt' | 'source' | 'chunkHash'>[]> {
  return new Promise((resolveP, rejectP) => {
    // 不指定 --allowedTools（whitelist 会让 claude 加载 tools + skills，冷启动
    // 慢很多）；max-turns 1 强制只出答案不动作。
    const p = spawn(
      'claude',
      ['-p', prompt, '--max-turns', '1'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        // 标记内部会话：本 claude -p 触发的 Stop hook 会读到它并跳过推飞书，
        // 避免提炼器的 meta 输出泄漏到飞书（mchat-stop-hook isHeadlessSession）。
        env: { ...process.env, MCHAT_INTERNAL_SESSION: '1' },
      },
    );
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => {
      p.kill('SIGTERM');
      rejectP(new Error('claude timeout'));
    }, CLAUDE_TIMEOUT_MS);
    p.on('error', (e) => {
      clearTimeout(timer);
      rejectP(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectP(new Error(`claude exit ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      // 从 stdout 里 grep 出第一个 JSON 数组
      const arr = extractJsonArray(stdout);
      if (arr === null) {
        rejectP(new Error('no JSON array in claude stdout: ' + stdout.slice(0, 150)));
        return;
      }
      // 校验每项 kind 合法
      const VALID_KINDS: KnowledgeKind[] = ['problem-solved', 'howto', 'decision', 'gotcha', 'reference'];
      const clean = arr.filter((x): x is Omit<KnowledgeEntry, 'id' | 'createdAt' | 'source' | 'chunkHash'> => {
        return typeof x === 'object' && x !== null &&
          typeof (x as Record<string, unknown>).title === 'string' &&
          typeof (x as Record<string, unknown>).body === 'string' &&
          VALID_KINDS.includes(((x as Record<string, unknown>).kind as KnowledgeKind));
      });
      resolveP(clean);
    });
  });
}

function extractJsonArray(text: string): unknown[] | null {
  // 找最早的 '[' 到匹配的 ']'（简单栈，不处理转义边缘 case，够用）
  const start = text.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) {
        const json = text.slice(start, i + 1);
        try { return JSON.parse(json) as unknown[]; }
        catch { return null; }
      }
    }
  }
  return null;
}

function sha256Prefix(s: string, len = 16): string {
  return createHash('sha256').update(s, 'utf8').digest('hex').slice(0, len);
}

export const knowledgeQueue = new ExtractionQueue();
