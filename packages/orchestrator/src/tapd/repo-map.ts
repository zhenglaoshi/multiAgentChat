import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const DATA_DIR = resolve('./data/tapd');
const FILE = join(DATA_DIR, 'repo-map.json');

/** 一个 TAPD 项目上次认领用的 repo/基准/模式 —— 下次认领自动预选（B 一键认领）。 */
export interface RepoMapEntry {
  repos: string[];
  base: 'current' | 'head' | 'master' | 'develop';
  sop: boolean;
  updatedAt: number;
}
type RepoMap = Record<string, RepoMapEntry>; // key = workspaceId

async function load(): Promise<RepoMap> {
  try {
    return JSON.parse(await readFile(FILE, 'utf8')) as RepoMap;
  } catch {
    return {};
  }
}

async function save(map: RepoMap): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(map, null, 2), 'utf8');
  await rename(tmp, FILE);
}

/** 取某项目上次的认领配置（无则 null）。 */
export async function getRepoMap(workspaceId: number): Promise<RepoMapEntry | null> {
  const m = await load();
  return m[String(workspaceId)] ?? null;
}

/** 认领成功后记住该项目的 repo/基准/模式，供下次预选。 */
export async function saveRepoMap(
  workspaceId: number,
  entry: { repos: string[]; base: RepoMapEntry['base']; sop: boolean },
): Promise<void> {
  if (!Number.isFinite(workspaceId) || entry.repos.length === 0) return;
  const m = await load();
  m[String(workspaceId)] = { ...entry, updatedAt: Date.now() };
  await save(m);
}
