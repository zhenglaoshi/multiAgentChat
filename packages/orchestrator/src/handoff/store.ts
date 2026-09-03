import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { canTransition, isTerminal } from './state.js';
import type { HandoffEnvelope, HandoffStatus, HandoffTask } from './types.js';

// 数据目录惰性求值（测试可用 HANDOFF_DATA_DIR 覆盖到临时目录，避免污染真实 ./data）
function dataDir(): string {
  return resolve(process.env['HANDOFF_DATA_DIR'] ?? './data/handoff');
}
function tasksFile(): string {
  return join(dataDir(), 'tasks.json');
}
function processedFile(): string {
  return join(dataDir(), 'processed.json');
}
const PROCESSED_CAP = 2000;

// ---- 进程内串行锁：包住所有 load→mutate→save 临界区，防丢更新竞态 ----
// （低频操作，一把全局锁足够；relay 侧同思路见 multiagent-relay/src/store.ts withLock）
let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function loadTasks(): Promise<HandoffTask[]> {
  try {
    return JSON.parse(await readFile(tasksFile(), 'utf8')) as HandoffTask[];
  } catch {
    return [];
  }
}

async function saveTasks(list: HandoffTask[]): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  const tmp = `${tasksFile()}.tmp`;
  await writeFile(tmp, JSON.stringify(list, null, 2), 'utf8');
  await rename(tmp, tasksFile());
}

/** upsert（按 id 覆盖）。用于本地新建 requester 任务（fresh id，无并发覆盖风险）。 */
export async function saveHandoffTask(t: HandoffTask): Promise<void> {
  await withLock(async () => {
    const list = await loadTasks();
    const i = list.findIndex((x) => x.id === t.id);
    if (i >= 0) list[i] = t;
    else list.unshift(t);
    await saveTasks(list);
  });
}

/**
 * 锁内「重读 → mutate → 写回」。用于 send 之后回写状态——避免读出旧快照、
 * 经历一次网络往返、再整条覆盖掉这期间对端落盘的更新。mutator 返回 false = 不写。
 */
export async function updateHandoffTask(
  id: string,
  mutator: (t: HandoffTask) => boolean,
): Promise<HandoffTask | null> {
  return withLock(async () => {
    const list = await loadTasks();
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return null;
    const t = list[i]!;
    const changed = mutator(t);
    if (changed) {
      t.updatedAt = Date.now();
      await saveTasks(list);
    }
    return t;
  });
}

export async function getHandoffTask(id: string): Promise<HandoffTask | undefined> {
  return (await loadTasks()).find((x) => x.id === id);
}

export async function listHandoffTasks(limit = 50): Promise<HandoffTask[]> {
  return (await loadTasks()).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

// ---- 已处理 msgId 去重（at-least-once 投递 + 客户端幂等）----

async function loadProcessed(): Promise<string[]> {
  try {
    return JSON.parse(await readFile(processedFile(), 'utf8')) as string[];
  } catch {
    return [];
  }
}

/** 若之前没见过该 msgId → 记下并返回 true；已见过 → false。 */
export async function markProcessed(msgId: string): Promise<boolean> {
  return withLock(async () => {
    const list = await loadProcessed();
    if (list.includes(msgId)) return false;
    list.push(msgId);
    const trimmed = list.length > PROCESSED_CAP ? list.slice(list.length - PROCESSED_CAP) : list;
    await mkdir(dataDir(), { recursive: true });
    const tmp = `${processedFile()}.tmp`;
    await writeFile(tmp, JSON.stringify(trimmed), 'utf8');
    await rename(tmp, processedFile());
    return true;
  });
}

// ---- 收到 envelope → 更新本地 task ----

export interface ApplyResult {
  task: HandoffTask | null;
  kind: 'created' | 'status' | 'reply' | 'ignored';
  changed: boolean;
  reason?: string;
}

/**
 * 把收到的 envelope 落到本地 task。self = 本人身份（= env.to）。
 * 全程在锁内，与 saveHandoffTask/updateHandoffTask 互斥。
 * - create：建/更新 assignee 视角的 task
 * - status：按 id 找 task，校验发件人是 task.peer + 合法跃迁 → 更新（幂等）
 * - reply：校验发件人是 task.peer → 追加留言
 */
export async function applyIncoming(env: HandoffEnvelope, self: string): Promise<ApplyResult> {
  return withLock(async () => {
    const now = Date.now();
    const list = await loadTasks();
    const idx = list.findIndex((x) => x.id === env.id);

    if (env.kind === 'create') {
      if (idx >= 0) {
        return { task: list[idx]!, kind: 'ignored', changed: false, reason: 'duplicate create' };
      }
      const task: HandoffTask = {
        id: env.id,
        role: 'assignee',
        self,
        peer: env.from,
        title: env.title ?? '(无标题)',
        status: 'sent',
        statusHistory: [{ status: 'sent', at: env.createdAt, by: env.from }],
        attachments: env.attachments ?? [],
        createdAt: env.createdAt,
        updatedAt: now,
      };
      if (env.summaryMd) task.summaryMd = env.summaryMd;
      if (env.context) task.context = env.context;
      list.unshift(task);
      await saveTasks(list);
      return { task, kind: 'created', changed: true };
    }

    if (env.kind === 'status') {
      if (idx < 0) return { task: null, kind: 'ignored', changed: false, reason: 'unknown task' };
      const task = list[idx]!;
      // 只有任务对端能改状态（纵深防御：即便 relay 白名单放行，也不许操作别人的任务）
      if (env.from !== task.peer) {
        return { task, kind: 'ignored', changed: false, reason: 'from is not task peer' };
      }
      const to = env.status as HandoffStatus;
      if (!canTransition(task.status, to)) {
        return { task, kind: 'ignored', changed: false, reason: `illegal ${task.status}→${to}` };
      }
      if (task.status === to) {
        return { task, kind: 'ignored', changed: false, reason: 'same status' };
      }
      task.status = to;
      const entry: { status: HandoffStatus; at: number; by: string; note?: string } = {
        status: to,
        at: env.createdAt,
        by: env.from,
      };
      if (env.note) entry.note = env.note;
      task.statusHistory.push(entry);
      task.updatedAt = now;
      await saveTasks(list);
      return { task, kind: 'status', changed: true };
    }

    // reply
    if (idx < 0) return { task: null, kind: 'ignored', changed: false, reason: 'unknown task' };
    const task = list[idx]!;
    if (env.from !== task.peer) {
      return { task, kind: 'ignored', changed: false, reason: 'from is not task peer' };
    }
    if (isTerminal(task.status)) {
      return { task, kind: 'ignored', changed: false, reason: 'task terminal' }; // 终态不再收留言
    }
    if (env.replyText) {
      task.statusHistory.push({ status: task.status, at: env.createdAt, by: env.from, note: env.replyText });
      task.updatedAt = now;
      await saveTasks(list);
      return { task, kind: 'reply', changed: true };
    }
    return { task, kind: 'reply', changed: false };
  });
}
