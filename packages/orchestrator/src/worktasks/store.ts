import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const DATA_DIR = resolve('./data');
const FILE = join(DATA_DIR, 'worktasks.json');

/** 一次任务分发创建的工作目录记录（目录↔需求摘要映射，支持搜索）。 */
export interface WorkTask {
  id: string;            // TAPD/perf 原始 id（全）
  id6: string;           // 后六位
  kind: 'fix' | 'feature' | 'indev';
  title: string;         // 需求/bug 摘要
  taskDir?: string;      // fix/feature 的任务目录（indev 无）
  branch: string;
  repos: string[];       // 涉及的 repo 名 / 工作目录
  base?: string;
  source?: 'tapd' | 'perf';
  tapdUrl?: string;
  createdAt: number;
}

async function load(): Promise<WorkTask[]> {
  try { return JSON.parse(await readFile(FILE, 'utf8')) as WorkTask[]; } catch { return []; }
}
async function save(list: WorkTask[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(list, null, 2), 'utf8');
  await rename(tmp, FILE);
}

/** upsert（按 id 去重，同 id 覆盖）。 */
export async function saveWorkTask(t: WorkTask): Promise<void> {
  const list = await load();
  const i = list.findIndex((x) => x.id === t.id);
  if (i >= 0) list[i] = t; else list.unshift(t);
  await save(list);
}

export async function listWorkTasks(limit = 50): Promise<WorkTask[]> {
  return (await load()).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export async function getWorkTask(id: string): Promise<WorkTask | undefined> {
  return (await load()).find((x) => x.id === id || x.id6 === id);
}

/** 关键词搜索：匹配 title / id / id6 / branch / repos / taskDir（大小写不敏感）。 */
export async function searchWorkTasks(query: string, limit = 30): Promise<WorkTask[]> {
  const q = query.trim().toLowerCase();
  if (!q) return listWorkTasks(limit);
  const hay = (t: WorkTask) => [t.title, t.id, t.id6, t.branch, t.taskDir ?? '', ...t.repos].join(' ').toLowerCase();
  return (await load())
    .filter((t) => hay(t).includes(q))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}
