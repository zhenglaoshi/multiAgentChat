import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { logger } from '../logger.js';
import type { StageRecord, TaskLoopRule, TaskState } from './types.js';
import type { LoopRule } from '../presets/store.js';

const DATA_DIR = resolve('./data/tasks');

function pathFor(id: string): string {
  return join(DATA_DIR, `${id}.json`);
}

/** task id 风格保持跟 memory 一致：task-<base36 时间>-<rand4> */
export function generateTaskId(now = Date.now()): string {
  return `task-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

interface TaskEvents {
  'task:start': (task: TaskState) => void;
  'stage:start': (payload: { task: TaskState; stage: StageRecord; stageIdx: number }) => void;
  'stage:end': (payload: { task: TaskState; stage: StageRecord; stageIdx: number }) => void;
  'gate:wait': (payload: { task: TaskState; gateName: string }) => void;
  'gate:resolve': (payload: { task: TaskState; gateName: string; approved: boolean }) => void;
  'stage:retry': (payload: {
    task: TaskState;
    failedStage: string;
    retryFrom: string;
    retryCount: number;
    maxRetries: number;
  }) => void;
  'stage:skipped': (payload: { task: TaskState; stage: StageRecord; stageIdx: number; reason: string }) => void;
  'task:done': (task: TaskState) => void;
  'task:failed': (payload: { task: TaskState; reason: string }) => void;
  'task:aborted': (payload: { task: TaskState; reason: string; hard: boolean }) => void;
}

class TypedEmitter extends EventEmitter {
  override emit<E extends keyof TaskEvents>(
    event: E,
    ...args: Parameters<TaskEvents[E]>
  ): boolean {
    return super.emit(event, ...args);
  }
  override on<E extends keyof TaskEvents>(event: E, listener: TaskEvents[E]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override off<E extends keyof TaskEvents>(event: E, listener: TaskEvents[E]): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}

export const taskEvents = new TypedEmitter();

async function writeAtomic(task: TaskState): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const filePath = pathFor(task.taskId);
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(task, null, 2), 'utf8');
  await rename(tmp, filePath);
}

export async function getTask(id: string): Promise<TaskState | null> {
  const p = pathFor(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, 'utf8')) as TaskState;
  } catch (e) {
    logger.warn('task load failed', { id, err: (e as Error).message });
    return null;
  }
}

export async function listTasks(filter?: {
  status?: TaskState['status'];
  tty?: string;
  chatId?: string;
}): Promise<TaskState[]> {
  if (!existsSync(DATA_DIR)) return [];
  const files = await readdir(DATA_DIR);
  const out: TaskState[] = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.endsWith('.tmp')) continue;
    try {
      const t = JSON.parse(await readFile(join(DATA_DIR, f), 'utf8')) as TaskState;
      if (filter?.status && t.status !== filter.status) continue;
      if (filter?.tty && t.tty !== filter.tty) continue;
      if (filter?.chatId && t.chatId !== filter.chatId) continue;
      out.push(t);
    } catch (e) {
      logger.warn('task list skip', { file: f, err: (e as Error).message });
    }
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out;
}

export interface CreateTaskInput {
  tty: string;
  cwd: string;
  chatId: string;
  stages: string[];
  gates: string[];
  loops?: LoopRule[];
  artifactDir: string;
  userPrompt: string;
  presetName?: string;
  taskId?: string; // 允许调用方预先生成 id
  now?: number;
}

export async function createTask(input: CreateTaskInput): Promise<TaskState> {
  const now = input.now ?? Date.now();
  const taskId = input.taskId ?? generateTaskId(now);
  const stageHistory: StageRecord[] = input.stages.map((name) => ({
    name,
    status: 'pending',
  }));
  const resolvedLoops: TaskLoopRule[] = (input.loops ?? []).map((l) => ({
    on: l.on,
    retryFrom: l.retryFrom,
    maxRetries: l.maxRetries ?? 2,
  }));
  const task: TaskState = {
    taskId,
    tty: input.tty,
    cwd: input.cwd,
    chatId: input.chatId,
    stages: [...input.stages],
    gates: [...input.gates],
    loops: resolvedLoops,
    stageRetries: {},
    artifactDir: input.artifactDir,
    currentStageIdx: -1,
    stageHistory,
    status: 'running',
    startedAt: now,
    userPrompt: input.userPrompt,
    ...(input.presetName ? { presetName: input.presetName } : {}),
  };
  await writeAtomic(task);
  logger.info('task created', {
    taskId,
    tty: input.tty,
    stages: input.stages.length,
    loops: resolvedLoops.length,
  });
  taskEvents.emit('task:start', task);
  return task;
}

/** 找当前 task 的下一个 stage（按 currentStageIdx + 名字匹配做防呆） */
function findStageIdx(task: TaskState, name: string): number {
  return task.stageHistory.findIndex((s) => s.name === name && s.status !== 'done');
}

export async function markStageStart(taskId: string, stageName: string): Promise<TaskState | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  const idx = findStageIdx(task, stageName);
  if (idx === -1) {
    logger.warn('markStageStart: stage not found or already done', { taskId, stageName });
    return task;
  }

  // 隐式收尾兜底：顺序 SOP 中「新 stage 开始」= 上一个已结束。若有更早的 stage 仍 running
  //（主 agent 忘了显式 --end）：非 gate stage → 自动标 done 补同步；gate stage → 只告警不动
  //（不偷跳 gate，让卡上可见地卡住暴露问题）。correct 流程里上一个已是 done，此循环不触发。
  const implicitlyEnded: { stage: StageRecord; stageIdx: number }[] = [];
  for (let i = 0; i < task.stageHistory.length; i++) {
    const prev = task.stageHistory[i]!;
    if (i !== idx && prev.status === 'running') {
      if (task.gates.includes(`after-${prev.name}`)) {
        logger.warn('markStageStart: 上一 gate stage 仍 running，未自动收尾（疑似跳过 gate）', { taskId, prev: prev.name, next: stageName });
      } else {
        prev.status = 'done';
        prev.endedAt = Date.now();
        if (!prev.summary) prev.summary = '(自动收尾：下一 stage 开始，主 agent 未显式 --end)';
        implicitlyEnded.push({ stage: prev, stageIdx: i });
      }
    }
  }

  const stage = task.stageHistory[idx]!;
  stage.status = 'running';
  stage.startedAt = Date.now();
  task.currentStageIdx = idx;
  await writeAtomic(task);
  for (const e of implicitlyEnded) taskEvents.emit('stage:end', { task, stage: e.stage, stageIdx: e.stageIdx });
  taskEvents.emit('stage:start', { task, stage, stageIdx: idx });
  return task;
}

export async function markStageEnd(
  taskId: string,
  stageName: string,
  patch: { summary?: string; artifactPath?: string; status?: 'done' | 'failed'; note?: string } = {},
): Promise<TaskState | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  const idx = task.stageHistory.findIndex((s) => s.name === stageName && s.status === 'running');
  if (idx === -1) {
    logger.warn('markStageEnd: no running stage with that name', { taskId, stageName });
    return task;
  }
  const stage = task.stageHistory[idx]!;
  stage.status = patch.status ?? 'done';
  stage.endedAt = Date.now();
  if (patch.summary !== undefined) stage.summary = patch.summary.slice(0, 500);
  if (patch.artifactPath !== undefined) stage.artifactPath = patch.artifactPath;
  if (patch.note !== undefined) stage.note = patch.note;

  // 推进 currentStageIdx 到下一个 pending（让 dashboard / 显示语义正确）
  if (stage.status === 'done') {
    const nextPending = task.stageHistory.findIndex(
      (s, i) => i > idx && s.status === 'pending',
    );
    task.currentStageIdx = nextPending === -1 ? task.stages.length : nextPending;
  }

  await writeAtomic(task);
  taskEvents.emit('stage:end', { task, stage, stageIdx: idx });

  // 全部 stage 完成 → 任务收尾
  const lastIdx = task.stageHistory.length - 1;
  if (idx === lastIdx && stage.status === 'done') {
    return markTaskDone(taskId);
  }
  // 当前 stage 失败 → 任务整体失败
  if (stage.status === 'failed') {
    return markTaskFailed(taskId, stage.note ?? `stage "${stageName}" failed`);
  }
  return task;
}

/**
 * 失败回环：把从 retryFrom 到 failedStage（含）所有 stage 重置为 pending、清掉
 * summary/artifact，stage 计数器 stageRetries[failedStage] +1，状态回 running。
 * 调用方（server）需先检查 task.loops + retryCount 才决定要不要调本函数。
 */
export async function markStageRetry(
  taskId: string,
  failedStage: string,
  retryFrom: string,
  note?: string,
): Promise<{ task: TaskState; retryCount: number; maxRetries: number } | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  const rule = task.loops.find((l) => l.on === failedStage && l.retryFrom === retryFrom);
  if (!rule) {
    logger.warn('markStageRetry: no matching loop rule', { taskId, failedStage, retryFrom });
    return null;
  }
  const prev = task.stageRetries[failedStage] ?? 0;
  const retryCount = prev + 1;
  if (retryCount > rule.maxRetries) {
    logger.warn('markStageRetry: exhausted', { taskId, failedStage, retryCount, max: rule.maxRetries });
    return null;
  }
  const fromIdx = task.stageHistory.findIndex((s) => s.name === retryFrom);
  const toIdx = task.stageHistory.findIndex((s) => s.name === failedStage);
  if (fromIdx === -1 || toIdx === -1 || fromIdx > toIdx) {
    logger.warn('markStageRetry: bad index', { fromIdx, toIdx });
    return null;
  }
  for (let i = fromIdx; i <= toIdx; i++) {
    const s = task.stageHistory[i]!;
    s.status = 'pending';
    delete s.startedAt;
    delete s.endedAt;
    delete s.summary;
    delete s.artifactPath;
    delete s.note;
  }
  task.stageRetries[failedStage] = retryCount;
  task.currentStageIdx = fromIdx;
  task.status = 'running';
  delete task.failReason;
  delete task.endedAt;
  // 留个面包屑在 retryFrom stage 的 note 里
  task.stageHistory[fromIdx]!.note = note
    ? `回环重试 ${retryCount}/${rule.maxRetries}：${note}`
    : `回环重试 ${retryCount}/${rule.maxRetries}`;
  await writeAtomic(task);
  logger.info('stage retry', {
    taskId,
    failedStage,
    retryFrom,
    retryCount,
    max: rule.maxRetries,
  });
  taskEvents.emit('stage:retry', {
    task,
    failedStage,
    retryFrom,
    retryCount,
    maxRetries: rule.maxRetries,
  });
  return { task, retryCount, maxRetries: rule.maxRetries };
}

export async function markGateWait(taskId: string, gateName: string): Promise<TaskState | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  task.status = 'awaiting-gate';
  task.awaitingGate = gateName;
  await writeAtomic(task);
  taskEvents.emit('gate:wait', { task, gateName });
  return task;
}

export async function markGateResolve(
  taskId: string,
  gateName: string,
  approved: boolean,
): Promise<TaskState | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  if (task.awaitingGate !== gateName) {
    logger.warn('markGateResolve: not waiting on this gate', {
      taskId,
      gateName,
      awaiting: task.awaitingGate,
    });
  }
  task.status = approved ? 'running' : 'failed';
  delete task.awaitingGate;
  if (!approved) {
    task.endedAt = Date.now();
    task.failReason = `gate "${gateName}" rejected`;
  }
  await writeAtomic(task);
  taskEvents.emit('gate:resolve', { task, gateName, approved });
  if (!approved) taskEvents.emit('task:failed', { task, reason: task.failReason! });
  return task;
}

export async function markTaskDone(taskId: string): Promise<TaskState | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  task.status = 'done';
  task.endedAt = Date.now();
  task.currentStageIdx = task.stages.length;
  await writeAtomic(task);
  taskEvents.emit('task:done', task);
  return task;
}

export async function setTaskProgressMessageId(
  taskId: string,
  messageId: string,
): Promise<TaskState | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  task.progressMessageId = messageId;
  await writeAtomic(task);
  return task;
}

export async function markTaskFailed(taskId: string, reason: string): Promise<TaskState | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  task.status = 'failed';
  task.endedAt = Date.now();
  task.failReason = reason;
  await writeAtomic(task);
  taskEvents.emit('task:failed', { task, reason });
  return task;
}

/**
 * 用户主动中止 task。
 * - 标 task.status='failed'，failReason='aborted:soft|hard:<reason>'
 * - 当前 running 的 stage 也标 'failed'（带 note 解释）
 * - emit task:aborted + task:failed
 * - 不会自己投递 🛑 到 tab，调用方（server / handler）负责
 *
 * hard=true：表示"硬中止"（claude 应停手不写收尾）；soft：保留已完成 stage 产出，可写收尾
 */
export async function markTaskAborted(
  taskId: string,
  reason: string,
  hard: boolean = false,
): Promise<TaskState | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  if (task.status === 'done' || task.status === 'failed') {
    logger.warn('cannot abort: task already ended', { taskId, status: task.status });
    return task;
  }
  const cur =
    task.currentStageIdx >= 0 && task.currentStageIdx < task.stageHistory.length
      ? task.stageHistory[task.currentStageIdx]
      : undefined;
  if (cur && cur.status === 'running') {
    cur.status = 'failed';
    cur.endedAt = Date.now();
    cur.note = `aborted${hard ? ':hard' : ':soft'}: ${reason}`;
  }
  task.status = 'failed';
  task.endedAt = Date.now();
  task.failReason = `aborted:${hard ? 'hard' : 'soft'}: ${reason}`;
  delete task.awaitingGate;
  await writeAtomic(task);
  taskEvents.emit('task:aborted', { task, reason, hard });
  taskEvents.emit('task:failed', { task, reason: task.failReason });
  return task;
}

/**
 * 跳过指定 stage（status='skipped'）。不算失败，不触发 loops。
 * 主 agent 用 `agent task stage --skip --reason "..."` 调，对不必要的 stage 一步标过去。
 */
export async function markStageSkipped(
  taskId: string,
  stageName: string,
  reason: string,
): Promise<TaskState | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  if (task.status !== 'running') {
    logger.warn('markStageSkipped: task not running', { taskId, status: task.status });
    return task;
  }
  const idx = task.stageHistory.findIndex((s) => s.name === stageName && s.status === 'pending');
  if (idx === -1) {
    logger.warn('markStageSkipped: stage not found or not pending', { taskId, stageName });
    return task;
  }
  const stage = task.stageHistory[idx]!;
  stage.status = 'skipped';
  stage.startedAt = Date.now();
  stage.endedAt = Date.now();
  stage.note = `skipped: ${reason}`;

  // 推进 currentStageIdx 到下一个 pending
  const nextPending = task.stageHistory.findIndex(
    (s, i) => i > idx && s.status === 'pending',
  );
  task.currentStageIdx = nextPending === -1 ? task.stages.length : nextPending;

  await writeAtomic(task);
  taskEvents.emit('stage:skipped', { task, stage, stageIdx: idx, reason });

  // 若是最后一个 pending stage 被 skip 而其它都已 done/skipped → 任务收尾
  const allDone = task.stageHistory.every(
    (s) => s.status === 'done' || s.status === 'skipped',
  );
  if (allDone) return markTaskDone(taskId);
  return task;
}
