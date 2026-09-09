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
/**
 * 从**扫描根**往下的最大深度。
 *
 * 取 6 而非 5：根去重（`topScanRoots`）后 `~/ihealth-work` 这些子根不再各自单独扫，
 * 统一从 `~` 起算，等于给它们的子树少了一层预算（`~/ihealth-work/fixes/<name>/.git`
 * 从 home 数已经是第 4 层）。提一档把这层还回去，实测耗时无明显变化。
 * 改动这个值请同时看 `tests/report-sessions.test.ts` 里 `dedupeContainedRoots` 的断言。
 */
const SCAN_MAXDEPTH = 6;
/**
 * 扫描根。`~/ihealth-work` 是 worktree / 临时工作目录的主力根（`prepareTaskWorkspace` 的
 * `taskWorkroot` 也落这里），虽然 `~` + maxdepth 5 名义上已覆盖，但显式列出可以让
 * `scanTopLevelContainers` 也收录它的子目录（`~` 因为太大被跳过了容器扫描）。
 */
const SCAN_ROOTS = ['~', '~/ihealth-project', '~/ihealth-work', '~/code', '~/Projects', '~/projects'];
/**
 * 扫描时**整棵剪掉**的目录名。
 *
 * 早先写成 `-not -path` 加 node_modules 通配（形如 星/node_modules/星）—— 那只过滤 find 的
 * **输出**，find 照样递归下降进 node_modules / Library 把每个 inode 都 stat 一遍。
 * 实测 `~/ihealth-project` 单个根
 * 16.0s → 换成 `-prune` 后 0.68s（命中数完全一致），全盘扫从分钟级掉到秒级。
 * 这也是「dir-index 一刷就要几分钟、于是只好挂 24h TTL、于是当天新建的仓库当天进不了报告」
 * 的根源。加目录时留意：这里是**目录名**匹配（任意层级同名目录都会被剪）。
 */
const EXCLUDE_DIR_NAMES = [
  'node_modules', '.Trash', 'Library', '.npm', '.cache', '.yarn', '.vscode', 'dist', '.next',
  // 包管理器 / 运行时缓存：体量大且不可能有我的工作仓库
  '.nvm', '.pnpm-store', '.gradle', '.m2', '.rustup', '.cargo', '.docker', '.orbstack',
  '.npminstall_tarball', '.cursor',
  // 媒体库（Photos / Music 的 .photoslibrary 内部有海量文件）
  'Pictures', 'Music', 'Movies', 'Applications',
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
 * `.git` 匹配式。
 *
 * **必须同时收 `-type d` 和 `-type f`**：普通仓库的 `.git` 是目录，但 **git worktree 的
 * `.git` 是一个文件**（内容形如 `gitdir: /path/to/main/.git/worktrees/xxx`）。早先只写
 * `-type d`，导致所有 worktree 对索引完全不可见——实测 `~/ihealth-work` 下 34 个 worktree
 * 一个都没进索引，只收到 6 个普通 clone。而 worktree 正是本项目 `task-workspace.ts`
 * 主推的任务隔离方式，于是「在 worktree 里干的活」全被工作报告漏掉。
 */
const GIT_MATCH = `-name .git '(' -type d -o -type f ')'`;

/** 剪枝表达式（EXCLUDE_DIR_NAMES 是模块内常量，非用户输入）。 */
function pruneExpr(): string {
  const names = [...new Set(EXCLUDE_DIR_NAMES)].map((n) => `-name '${n}'`).join(' -o ');
  return `'(' ${names} ')' -prune -o`;
}

/**
 * 单个根的扫描超时。报告路径上会**同步**等这个扫描，没有上限的话一个病态目录
 * （网络挂载失联、海量小文件）就能把整份报告卡死。超时后 exec 抛错，走下面的
 * 「用已产出的部分 stdout」分支，宁可少几个仓库也不阻塞。
 */
const SCAN_TIMEOUT_MS = 60_000;

/**
 * 跑一条 find，返回命中的 `.git` 路径的父目录（= 仓库根）。
 * find 只要有一个 perm-denied 就退 1，但 stdout 可能已经产出很多 —— 捕获后用 err.stdout。
 * 参数刻意只收 `abs`（模块内常量派生）：这里是拼 shell 字符串交给 `exec`，
 * 多一个能从外部灌入的拼接参数就是一个命令注入面。要加过滤条件请改成 execFile + 数组参数。
 *
 * 命中的 `.git` 自身也 `-prune`：找到就不必再下降进它内部（子模块在 `.git/modules` 下的
 * 嵌套 `.git` 只会造出指向同一仓库的重复根）。
 */
async function findRepoRoots(abs: string): Promise<string[]> {
  let stdout = '';
  try {
    const r = await execP(
      `find "${abs}" -maxdepth ${SCAN_MAXDEPTH} ${pruneExpr()} ${GIT_MATCH} -print -prune 2>/dev/null`,
      { maxBuffer: 4 * 1024 * 1024, timeout: SCAN_TIMEOUT_MS },
    );
    stdout = r.stdout;
  } catch (e) {
    const err = e as Error & { stdout?: string };
    stdout = err.stdout ?? '';
    // 部分结果也用；只有完全没结果才 warn
    if (!stdout) {
      logger.warn('dir-index scan failed for root', { root: abs, err: err.message });
    }
  }
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(dirname(trimmed));
  }
  return out;
}

/**
 * 去掉被别的路径包含的那些（纯逻辑，可测）。
 * `SCAN_ROOTS` 里 `~` 已覆盖 `~/ihealth-project`、`~/ihealth-work`… 不去重就是把同一批目录
 * 遍历好几遍（全量扫时间成倍上涨）。
 * 按路径**分段**判断而非裸前缀：`/a/bc` 不该被 `/a/b` 吃掉。
 */
export function dedupeContainedRoots(paths: string[]): string[] {
  const uniq = [...new Set(paths)];
  return uniq.filter((r) => !uniq.some((o) => o !== r && r.startsWith(o.endsWith('/') ? o : `${o}/`)));
}

/** 存在的扫描根，去掉被别的根包含的那些。容器扫描仍用完整 SCAN_ROOTS——它要的正是这些子根。 */
function topScanRoots(): string[] {
  return dedupeContainedRoots(SCAN_ROOTS.map(expandHome).filter((p) => existsSync(p)));
}

/**
 * 扫全机 git 仓库 —— 用 find 命令一把梭，比递归 readdir 快。
 * 排除 node_modules / Library 等噪音目录（`-prune`，见 EXCLUDE_DIR_NAMES）。
 */
async function scanGitRepos(): Promise<string[]> {
  const results = new Set<string>();
  for (const abs of topScanRoots()) {
    for (const repo of await findRepoRoots(abs)) results.add(repo);
  }
  return [...results];
}

/**
 * 保证索引「不比 `since` 旧」，需要时同步做一次全量刷新。
 *
 * 报告专用。默认 24h TTL 意味着**当天新建的仓库当天进不了报告**——实测新建的项目
 * （几十个文件已 `git add`）就因此整个从日报里消失，而日报最该关心的恰恰是今天新开的活。
 * 以前不敢在报告路径上同步刷新是因为全量扫要分钟级；改用 `-prune` + 根去重后全量约 7s，
 * 直接刷全量比「只找窗口内动过 .git 的增量扫」更简单也更准（后者漏掉纯编辑没跑过 git 的目录）。
 */
export async function ensureDirIndexFresh(since: Date): Promise<DirIndexState> {
  const cur = cache ?? (await loadFromDisk());
  if (cur) {
    cache = cur;
    if (cur.updatedAt >= since.getTime()) return cur;
  }
  logger.info('dir-index 早于报告窗口，强制刷新', {
    updatedAt: cur ? new Date(cur.updatedAt).toISOString() : null,
    since: since.toISOString(),
  });
  return refreshDirIndex(true);
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
