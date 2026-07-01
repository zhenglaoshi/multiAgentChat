import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { logger } from '../logger.js';
import { taskEvents } from '../tasks/store.js';
import type { StageRecord, TaskState } from '../tasks/types.js';
import { tokenize } from './recall.js';
import type { StageMemory } from './stage-types.js';

const DATA_DIR = resolve('./data/stage-memories');
const RECENT_DAYS = 30;
const RECENT_MS = RECENT_DAYS * 24 * 60 * 60 * 1000;

function pathFor(id: string): string {
  return join(DATA_DIR, `${id}.json`);
}

function generateId(now = Date.now()): string {
  return `stage-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function persist(mem: StageMemory): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const file = pathFor(mem.id);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(mem, null, 2), 'utf8');
  await rename(tmp, file);
}

export async function appendStageMemory(input: {
  task: TaskState;
  stage: StageRecord;
}): Promise<StageMemory | null> {
  const { task, stage } = input;
  if (stage.status !== 'done') return null;
  if (!stage.startedAt || !stage.endedAt) return null;
  const mem: StageMemory = {
    id: generateId(stage.endedAt),
    taskId: task.taskId,
    stageName: stage.name,
    cwd: task.cwd,
    userPrompt: task.userPrompt,
    summary: stage.summary ?? '',
    startedAt: stage.startedAt,
    endedAt: stage.endedAt,
  };
  if (stage.artifactPath) mem.artifactPath = stage.artifactPath;
  if (task.presetName) mem.presetName = task.presetName;
  try {
    await persist(mem);
    logger.info('stage memory written', { id: mem.id, stage: mem.stageName });
  } catch (e) {
    logger.warn('stage memory persist failed', { err: (e as Error).message });
    return null;
  }
  return mem;
}

export async function listStageMemories(filter?: {
  stage?: string;
  cwd?: string;
  limit?: number;
}): Promise<StageMemory[]> {
  if (!existsSync(DATA_DIR)) return [];
  const files = await readdir(DATA_DIR);
  const out: StageMemory[] = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
    try {
      const raw = await readFile(join(DATA_DIR, f), 'utf8');
      const m = JSON.parse(raw) as StageMemory;
      if (filter?.stage && m.stageName !== filter.stage) continue;
      if (filter?.cwd && m.cwd !== filter.cwd && !m.cwd.startsWith(filter.cwd)) continue;
      out.push(m);
    } catch (e) {
      logger.warn('stage memory load skip', { file: f, err: (e as Error).message });
    }
  }
  out.sort((a, b) => b.endedAt - a.endedAt);
  if (filter?.limit) return out.slice(0, filter.limit);
  return out;
}

export interface StageRecallOptions {
  stage?: string;             // 限定 stage
  cwd?: string;               // 偏好 cwd
  keywords?: string[];         // tokenize 过的关键词
  limit?: number;              // 默认 5
  minScore?: number;           // 默认 0.5
}

export interface StageRecallResult {
  memory: StageMemory;
  score: number;
}

function scoreStageMemory(
  m: StageMemory,
  keywords: string[],
  cwd: string | undefined,
): number {
  let score = 0;
  const ageMs = Date.now() - m.endedAt;
  if (ageMs > RECENT_MS) score -= 0.5;
  const ageWeight = Math.max(0.1, 1 - ageMs / RECENT_MS);

  if (cwd && m.cwd === cwd) score += 2 * ageWeight;
  else if (cwd && m.cwd.startsWith(cwd)) score += 1 * ageWeight;
  else if (cwd && cwd.startsWith(m.cwd)) score += 0.5 * ageWeight;

  const haystack = (
    m.userPrompt +
    ' ' +
    (m.summary ?? '') +
    ' ' +
    (m.artifactPath ?? '')
  ).toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (haystack.includes(kw.toLowerCase())) hits++;
  }
  if (keywords.length > 0) {
    score += (hits / keywords.length) * 2 * ageWeight;
  }
  return score;
}

export async function recallStageMemories(
  opts: StageRecallOptions,
): Promise<StageRecallResult[]> {
  const list = await listStageMemories(opts.stage ? { stage: opts.stage } : {});
  const keywords = opts.keywords ?? [];
  const limit = opts.limit ?? 5;
  const minScore = opts.minScore ?? 0.5;
  const scored: StageRecallResult[] = [];
  for (const m of list) {
    const s = scoreStageMemory(m, keywords, opts.cwd);
    if (s < minScore) continue;
    scored.push({ memory: m, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** 在 startup 时调一次，注册 stage:end 监听，自动持久化 */
let attached = false;
export function attachStageMemoryListener(): void {
  if (attached) return;
  attached = true;
  taskEvents.on('stage:end', ({ task, stage }) => {
    void appendStageMemory({ task, stage });
  });
  logger.info('stage memory listener attached');
}

/** 测试方便：用 tokenize 重新导出 */
export { tokenize };
