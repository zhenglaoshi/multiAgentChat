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

/**
 * 北京时区时间窗。
 *  - prev=false（默认）：当前周期起点 → 现在（day=今天0点 / week=本周一 / month=本月1号 / year=今年1月1号）
 *  - prev=true：上一个**完整**周期（定时周报/月报用：周一报上周、月初报上月）
 */
export function reportWindow(kind: ReportWindow, prev = false): { since: Date; until: Date; sinceLabel: string; untilLabel: string } {
  const fmt = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d);
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const y = Number(g('year')); const m = Number(g('month')); const d = Number(g('day'));
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[g('weekday')] ?? 1;
  // 北京 00:00 = UTC 前一天 16:00 → Date.UTC(y,m-1,d,-8)
  const bj = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm - 1, dd, -8, 0, 0));

  // 当前周期起点
  let curStart: Date;
  if (kind === 'day') curStart = bj(y, m, d);
  else if (kind === 'week') curStart = new Date(bj(y, m, d).getTime() - ((dow + 6) % 7) * 86400_000);
  else if (kind === 'month') curStart = bj(y, m, 1);
  else curStart = bj(y, 1, 1);

  if (!prev) return { since: curStart, until: now, sinceLabel: fmt(curStart), untilLabel: fmt(now) };

  // 上一个完整周期：[prevStart, curStart)
  let prevStart: Date;
  if (kind === 'day') prevStart = new Date(curStart.getTime() - 86400_000);
  else if (kind === 'week') prevStart = new Date(curStart.getTime() - 7 * 86400_000);
  else if (kind === 'month') prevStart = m === 1 ? bj(y - 1, 12, 1) : bj(y, m - 1, 1);
  else prevStart = bj(y - 1, 1, 1);
  // untilLabel 用 curStart 前一天更直观（区间是左闭右开到 curStart）
  const untilLbl = fmt(new Date(curStart.getTime() - 86400_000));
  return { since: prevStart, until: curStart, sinceLabel: fmt(prevStart), untilLabel: untilLbl };
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
  /** true → 采上一个完整周期（定时周报/月报用）。 */
  prev?: boolean;
}): Promise<CollectedWork> {
  const { since, until, sinceLabel, untilLabel } = reportWindow(opts.window, opts.prev ?? false);
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
