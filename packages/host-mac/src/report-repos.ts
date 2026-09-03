import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger, listWorkTasks } from 'multiagent-orchestrator';
import { listTabs } from './terminal/tabs.js';
import { listRecentCwds } from './recent-cwds.js';
import { getDirIndex, type DirEntry } from './dir-index.js';

const execFileAsync = promisify(execFile);

/** 把一个目录解析到它所属的 git 仓库根；非 git 目录返回 null。 */
async function gitRoot(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { timeout: 5000 });
    const p = stdout.trim();
    return p || null;
  } catch {
    return null;
  }
}

/**
 * 报告要采集的**候选仓库集合**（用户选定「今天有活动 ∪ 有 tab ∪ worktasks，覆盖最全」）。
 *
 * = dir-index 全部 git 仓库（覆盖「今天有活动」——今天有提交/改动的仓库无论是否在 tab/最近用过里都不漏）
 *   ∪ 当前 tab 的 cwd ∪ recent-cwds ∪ worktasks 目录（兜 dir-index 可能没收录的工作目录，如新 worktree）。
 *
 * 为什么直接纳入全部 git 仓库而非只挑「在弄的」几个：报告的干净由**下游** collectWorkData 的两层过滤
 * 保证——git 提交按「我的身份 + 时间窗」、未提交按「今天 mtime」——没今天活动的仓库自然一条不产出。
 * 早先只按 tab/最近/worktasks 收窄，会把「今天真改了、但没开着 tab 也没 cd 记录」的仓库
 * （如 performance-platform-web）漏在集合外 → 今天的活进不了报告。纳入全部 + 下游过滤 = 不漏又不脏。
 * .nvm / 插件市场 / 上家老代码这类没今天活动的仓库，扫到了也被过滤掉，不进报告。
 */
export async function activeReportRepos(): Promise<string[]> {
  const roots = new Set<string>();

  // 1) dir-index 全部 git 仓库 —— 覆盖「今天有活动」全量。dir-index 的 path 本身就是仓库根，
  //    直接纳入，无需再 rev-parse（省掉上百次 git 调用）。
  const index = await getDirIndex().catch(() => ({ dirs: [] as DirEntry[] }));
  for (const d of index.dirs) if (d.isGitRepo) roots.add(d.path);

  // 2) tab / recent-cwds / worktasks 里的目录可能是仓库**子目录**或 dir-index 未收录的新 worktree，
  //    只对「不是已知仓库根」的那些跑 rev-parse 解析到根。
  const extras = new Set<string>();
  const [tabs, recents, tasks] = await Promise.all([
    listTabs().catch(() => []),
    listRecentCwds().catch(() => [] as string[]),
    listWorkTasks(40).catch(() => []),
  ]);
  for (const t of tabs) if (t.cwd) extras.add(t.cwd);
  for (const c of recents) if (c) extras.add(c);
  for (const t of tasks) {
    if (t.taskDir) extras.add(t.taskDir);
    // t.repos 混了 repo 名与工作目录，只收绝对路径的，避免把裸名字拼错。
    for (const r of t.repos ?? []) if (r.startsWith('/')) extras.add(r);
  }

  // 有并发上限地解析 extras（避免一次 spawn 上百个 git 子进程）。
  const toResolve = [...extras].filter((d) => !roots.has(d));
  const CONCURRENCY = 16;
  for (let i = 0; i < toResolve.length; i += CONCURRENCY) {
    await Promise.all(
      toResolve.slice(i, i + CONCURRENCY).map(async (dir) => {
        const root = await gitRoot(dir);
        if (root) roots.add(root);
      }),
    );
  }

  logger.info('report activeReportRepos', { indexRepos: index.dirs.length, resolved: toResolve.length, repos: roots.size });
  return [...roots];
}
