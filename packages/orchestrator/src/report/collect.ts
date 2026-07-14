import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logger.js';
import { memoryStore } from '../memory/store.js';

const execFileAsync = promisify(execFile);

export type ReportWindow = 'day' | 'week' | 'month' | 'year';

export interface GitCommit {
  repo: string;      // repo basename
  hash: string;
  date: string;      // YYYY-MM-DD
  subject: string;
}

export interface CollectedWork {
  window: ReportWindow;
  sinceLabel: string;   // 'YYYY-MM-DD'
  untilLabel: string;
  gitAuthors: string[];
  commits: GitCommit[];
  /** 任务记忆（本工具跑过的任务）：prompt + 摘要 */
  tasks: { prompt: string; summary?: string; cwd: string; endedAt: number }[];
}

/** 北京时区窗口起点（day=今天0点 / week=本周一 / month=本月1号 / year=今年1月1号）。 */
export function reportWindow(kind: ReportWindow): { since: Date; until: Date; sinceLabel: string; untilLabel: string } {
  const fmt = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d);
  const now = new Date();
  // 北京当前 y/m/d/dow
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const y = Number(g('year')); const m = Number(g('month')); const d = Number(g('day'));
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[g('weekday')] ?? 1;
  // 用 UTC 构造北京 0 点（北京 = UTC+8 → 北京 00:00 = 前一天 UTC 16:00）
  const bjMidnightUTC = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm - 1, dd, -8, 0, 0));
  let since: Date;
  if (kind === 'day') since = bjMidnightUTC(y, m, d);
  else if (kind === 'week') since = new Date(bjMidnightUTC(y, m, d).getTime() - ((dow + 6) % 7) * 86400_000);
  else if (kind === 'month') since = bjMidnightUTC(y, m, 1);
  else since = bjMidnightUTC(y, 1, 1);
  return { since, until: now, sinceLabel: fmt(since), untilLabel: fmt(now) };
}

/** 从全局 git config 拿身份（name + email），用于跨 repo 过滤"我的"提交。 */
async function detectGitAuthors(): Promise<string[]> {
  const out: string[] = [];
  for (const key of ['user.name', 'user.email']) {
    try {
      const v = (await execFileAsync('git', ['config', '--global', key], { timeout: 5000 })).stdout.trim();
      if (v) out.push(v);
    } catch { /* ignore */ }
  }
  return out;
}

/** 该 repo 的 local git 身份（用户常按 repo 设不同 name/email）。 */
async function repoLocalAuthors(repo: string): Promise<string[]> {
  const out: string[] = [];
  for (const key of ['user.name', 'user.email']) {
    try {
      const v = (await execFileAsync('git', ['-C', repo, 'config', key], { timeout: 5000 })).stdout.trim();
      if (v) out.push(v);
    } catch { /* ignore */ }
  }
  return out;
}

async function gitLog(repo: string, since: Date, until: Date, authors: string[]): Promise<GitCommit[]> {
  // 全局身份 ∪ 本 repo local 身份（多身份场景：全局 A、某 repo local B）
  const local = await repoLocalAuthors(repo);
  const allAuthors = [...new Set([...authors, ...local])];
  const args = [
    '-C', repo, 'log', '--no-merges',
    `--since=${since.toISOString()}`, `--until=${until.toISOString()}`,
    '--pretty=format:%h\x1f%ad\x1f%s', '--date=short',
    ...allAuthors.map((a) => `--author=${a}`),
  ];
  try {
    const { stdout } = await execFileAsync('git', args, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
    const base = repo.split('/').pop() || repo;
    return stdout.split('\n').filter((l) => l.trim()).map((l) => {
      const [hash, date, subject] = l.split('\x1f');
      return { repo: base, hash: hash ?? '', date: date ?? '', subject: subject ?? '' };
    });
  } catch (e) {
    logger.warn('report gitLog failed', { repo, err: (e as Error).message });
    return [];
  }
}

/** 采集一个时间窗内我的工作数据：git 提交（跨 repo）+ 任务记忆。 */
export async function collectWorkData(opts: {
  window: ReportWindow;
  repos: string[];
  gitAuthors?: string[];
}): Promise<CollectedWork> {
  const { since, until, sinceLabel, untilLabel } = reportWindow(opts.window);
  const gitAuthors = opts.gitAuthors && opts.gitAuthors.length ? opts.gitAuthors : await detectGitAuthors();

  const commitLists = await Promise.all(opts.repos.map((r) => gitLog(r, since, until, gitAuthors)));
  const commits = commitLists.flat();

  const sinceMs = since.getTime();
  const all = await memoryStore.all().catch(() => []);
  const tasks = all
    .filter((mem) => mem.endedAt >= sinceMs && mem.endedAt <= until.getTime())
    .map((mem) => ({ prompt: mem.prompt, summary: mem.summary, cwd: mem.cwd, endedAt: mem.endedAt }));

  return { window: opts.window, sinceLabel, untilLabel, gitAuthors, commits, tasks };
}
