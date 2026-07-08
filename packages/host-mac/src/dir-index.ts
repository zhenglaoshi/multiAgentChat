import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { homedir } from 'node:os';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from 'multiagent-orchestrator';

const execP = promisify(exec);

const FILE = resolve('./data/dir-index.json');
const REFRESH_TTL_MS = 24 * 60 * 60 * 1000;
const SCAN_MAXDEPTH = 5;
const SCAN_ROOTS = ['~', '~/ihealth-project', '~/code', '~/Projects', '~/projects'];
const EXCLUDE_PATTERNS = [
  '*/node_modules/*',
  '*/.Trash/*',
  '*/Library/*',
  '*/.npm/*',
  '*/.cache/*',
  '*/.yarn/*',
  '*/.vscode/*',
  '*/dist/*',
  '*/.next/*',
];

export interface DirEntry {
  path: string;      // 绝对路径
  name: string;      // basename
  isGitRepo: boolean;
}

interface DirIndexState {
  dirs: DirEntry[];
  updatedAt: number;
}

let cache: DirIndexState | null = null;
let refreshing: Promise<void> | null = null;

function expandHome(p: string): string {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (p === '~') return homedir();
  return p;
}

async function loadFromDisk(): Promise<DirIndexState | null> {
  if (!existsSync(FILE)) return null;
  try {
    return JSON.parse(await readFile(FILE, 'utf8')) as DirIndexState;
  } catch (e) {
    logger.warn('dir-index parse failed', { err: (e as Error).message });
    return null;
  }
}

async function flushToDisk(state: DirIndexState): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await rename(tmp, FILE);
}

/**
 * 扫全机 git 仓库 —— 用 find 命令一把梭，比递归 readdir 快。
 * 排除 node_modules / Library 等噪音目录。
 */
async function scanGitRepos(): Promise<string[]> {
  const results = new Set<string>();
  const excludeArgs = EXCLUDE_PATTERNS.flatMap((p) => ['-not', '-path', p]);

  for (const root of SCAN_ROOTS) {
    const abs = expandHome(root);
    if (!existsSync(abs)) continue;
    // find 只要有一个 perm-denied 就退 1，但 stdout 可能已经产出很多 —— 捕获后用 err.stdout
    let stdout = '';
    try {
      const r = await execP(
        `find "${abs}" -maxdepth ${SCAN_MAXDEPTH} -name .git -type d ${excludeArgs.map((a) => (a.startsWith('-') ? a : `'${a}'`)).join(' ')} 2>/dev/null`,
        { maxBuffer: 4 * 1024 * 1024 },
      );
      stdout = r.stdout;
    } catch (e) {
      const err = e as Error & { stdout?: string };
      stdout = err.stdout ?? '';
      // 部分结果也用；只有完全没结果才 warn
      if (!stdout) {
        logger.warn('dir-index scan failed for root', {
          root: abs,
          err: err.message,
        });
      }
    }
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const repo = dirname(trimmed);
      results.add(repo);
    }
  }
  return [...results];
}

/**
 * 扫一层「顶层容器目录」—— ~/ihealth-project 这样的，即使里面不是 git 也列进去，
 * 用户可能在里面手动 cd 到子目录（非 git）。
 */
async function scanTopLevelContainers(): Promise<string[]> {
  const results = new Set<string>();
  for (const root of SCAN_ROOTS) {
    const abs = expandHome(root);
    if (!existsSync(abs)) continue;
    if (abs === homedir()) continue; // ~ 太多不扫，只加自己
    try {
      const entries = await readdir(abs, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith('.')) continue;
        results.add(join(abs, e.name));
      }
    } catch {
      /* ignore */
    }
  }
  return [...results];
}

export async function refreshDirIndex(force = false): Promise<DirIndexState> {
  if (refreshing) {
    await refreshing;
    return cache ?? { dirs: [], updatedAt: 0 };
  }
  // 内存 cache 命中 → 跳过
  if (!force && cache && Date.now() - cache.updatedAt < REFRESH_TTL_MS) {
    return cache;
  }
  // 内存 cache 空 → 先看磁盘（避免每次 daemon 重启就 8min 全盘扫）
  // tsx watch 反复重载时，模块级 cache/refreshing 都会重置，如果不读盘就会重复扫
  if (!force && !cache) {
    const disk = await loadFromDisk();
    if (disk) {
      cache = disk;
      if (Date.now() - disk.updatedAt < REFRESH_TTL_MS) {
        return disk;
      }
      // 磁盘过期 → 继续走扫描
    }
  }
  refreshing = (async () => {
    logger.info('dir-index refresh start');
    const t0 = Date.now();
    const gitRepos = await scanGitRepos();
    const containers = await scanTopLevelContainers();
    const all = new Map<string, DirEntry>();
    for (const p of gitRepos) {
      all.set(p, { path: p, name: basename(p), isGitRepo: true });
    }
    for (const p of containers) {
      if (all.has(p)) continue;
      all.set(p, { path: p, name: basename(p), isGitRepo: false });
    }
    // 加常见顶层目录
    for (const t of ['~/Desktop', '~/Downloads', '~/Documents', '~']) {
      const abs = expandHome(t);
      if (!existsSync(abs)) continue;
      if (all.has(abs)) continue;
      all.set(abs, { path: abs, name: basename(abs) || abs, isGitRepo: false });
    }
    const state: DirIndexState = {
      dirs: [...all.values()].sort((a, b) => a.path.localeCompare(b.path)),
      updatedAt: Date.now(),
    };
    cache = state;
    await flushToDisk(state);
    logger.info('dir-index refresh done', {
      count: state.dirs.length,
      elapsedMs: Date.now() - t0,
    });
  })();
  try {
    await refreshing;
  } finally {
    refreshing = null;
  }
  return cache ?? { dirs: [], updatedAt: 0 };
}

export async function getDirIndex(): Promise<DirIndexState> {
  if (cache) {
    // 后台刷新（不阻塞）
    if (Date.now() - cache.updatedAt > REFRESH_TTL_MS) {
      void refreshDirIndex().catch(() => {});
    }
    return cache;
  }
  const disk = await loadFromDisk();
  if (disk) {
    cache = disk;
    // 太老就后台刷新
    if (Date.now() - disk.updatedAt > REFRESH_TTL_MS) {
      void refreshDirIndex().catch(() => {});
    }
    return disk;
  }
  return refreshDirIndex(true);
}

/**
 * 模糊搜目录：
 *   - 完全匹配 name 优先
 *   - name 前缀匹配次之
 *   - name 子串匹配再次
 *   - 全路径子串最次
 * 返回按 score 降序，前 limit 条。
 */
export function scoreDir(query: string, entry: DirEntry): number {
  const q = query.toLowerCase();
  const name = entry.name.toLowerCase();
  const path = entry.path.toLowerCase();

  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (name.includes(q)) return 60 - Math.max(0, name.indexOf(q));
  if (path.includes(q)) return 30;
  return 0;
}

export async function searchDirs(query: string, limit = 20): Promise<DirEntry[]> {
  const idx = await getDirIndex();
  if (!query.trim()) return idx.dirs.slice(0, limit);
  const scored = idx.dirs
    .map((d) => ({ d, s: scoreDir(query, d) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.d.name.length - b.d.name.length);
  return scored.slice(0, limit).map((x) => x.d);
}
