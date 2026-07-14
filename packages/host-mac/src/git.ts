import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitBranchResult {
  ok: boolean;
  repo: string;
  branch: string;
  /** 'created' 新建 | 'checked-out' 分支已存在直接切 | 'failed' */
  action: 'created' | 'checked-out' | 'failed';
  base?: string;      // 从哪个分支切的（新建时）
  reason?: string;    // 失败原因
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], {
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

/** 当前分支名（detached 时返回空）。 */
export async function gitCurrentBranch(repo: string): Promise<string> {
  try {
    return await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    return '';
  }
}

export interface GitWorkingState {
  repo: string;
  isRepo: boolean;
  branch: string;      // 当前分支（detached 时空）
  dirty: boolean;      // 有未提交改动（含 untracked）
  changeCount: number; // 变更文件数
}

/** 切分支前的现状：当前分支 + 工作区是否有未提交改动（含 untracked）。 */
export async function gitWorkingState(repo: string): Promise<GitWorkingState> {
  try {
    const porcelain = await git(repo, ['status', '--porcelain', '--untracked-files=normal']);
    const lines = porcelain.split('\n').filter((l) => l.trim().length > 0);
    return {
      repo,
      isRepo: true,
      branch: await gitCurrentBranch(repo),
      dirty: lines.length > 0,
      changeCount: lines.length,
    };
  } catch (e) {
    return { repo, isRepo: false, branch: '', dirty: false, changeCount: 0 };
  }
}

/**
 * 在 repo 里切到 branch：
 *  - 分支已存在 → checkout（'checked-out'）
 *  - 不存在 → 从 base（默认当前 HEAD）新建并切（'created'）
 * 先 `git fetch`（best-effort，失败忽略）。工作区不干净不阻止（claude 会处理）。
 */
export async function gitCheckoutBranch(
  repo: string,
  branch: string,
  base?: string,
): Promise<GitBranchResult> {
  try {
    // best-effort fetch
    await git(repo, ['fetch', '--quiet']).catch(() => undefined);

    // 分支是否已存在（本地）
    let exists = false;
    try {
      await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      exists = true;
    } catch {
      exists = false;
    }

    if (exists) {
      await git(repo, ['checkout', branch]);
      return { ok: true, repo, branch, action: 'checked-out' };
    }

    const from = base && base.trim() ? base.trim() : await gitCurrentBranch(repo);
    const args = ['checkout', '-b', branch];
    if (from) args.push(from);
    await git(repo, args);
    return { ok: true, repo, branch, action: 'created', base: from || undefined };
  } catch (e) {
    return {
      ok: false,
      repo,
      branch,
      action: 'failed',
      reason: ((e as Error).message ?? String(e)).slice(0, 200),
    };
  }
}

/** git stash（含 untracked）。只在已知脏时调。 */
export async function gitStashPush(repo: string, msg: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    await git(repo, ['stash', 'push', '-u', '-m', msg]);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: ((e as Error).message ?? String(e)).slice(0, 150) };
  }
}

/**
 * 为 branch 建 worktree（当前工作区完全不动）。路径 = `<repo>-<branch>` 同级目录。
 * 已存在同名分支 → worktree add <path> <branch>；否则 -b 新建。path 已存在 → 视为复用。
 */
export async function gitAddWorktree(
  repo: string,
  branch: string,
  base?: string,
): Promise<{ ok: boolean; path?: string; reason?: string }> {
  const path = `${repo}-${branch}`;
  try {
    if (existsSync(path)) return { ok: true, path }; // 复用已有 worktree
    let exists = false;
    try {
      await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      exists = true;
    } catch { exists = false; }
    if (exists) {
      await git(repo, ['worktree', 'add', path, branch]);
    } else {
      const from = base && base.trim() ? base.trim() : await gitCurrentBranch(repo);
      const args = ['worktree', 'add', path, '-b', branch];
      if (from) args.push(from);
      await git(repo, args);
    }
    return { ok: true, path };
  } catch (e) {
    return { ok: false, reason: ((e as Error).message ?? String(e)).slice(0, 200) };
  }
}

export type DirtyStrategy = 'normal' | 'stash' | 'worktree' | 'carry' | 'skip';

export interface PrepareResult {
  ok: boolean;
  repo: string;
  /** claude 实际工作目录（worktree 时 != repo）。 */
  cwd: string;
  branch: string;
  action: 'created' | 'checked-out' | 'worktree' | 'skipped' | 'failed';
  note?: string;
  reason?: string;
}

/**
 * 按脏工作区策略为 repo 准备好 branch。干净 / carry / normal → 原地 checkout -b；
 * 脏 + stash → 先 stash 再切；脏 + worktree → 建 worktree（不动当前）；脏 + skip → 跳过。
 */
export async function prepareBugBranch(
  repo: string,
  branch: string,
  strategy: DirtyStrategy,
  base?: string,
): Promise<PrepareResult> {
  const st = await gitWorkingState(repo);
  if (!st.isRepo) {
    return { ok: false, repo, cwd: repo, branch, action: 'failed', reason: '非 git 仓库' };
  }
  if (!st.dirty || strategy === 'carry' || strategy === 'normal') {
    const r = await gitCheckoutBranch(repo, branch, base);
    const out: PrepareResult = { ok: r.ok, repo, cwd: repo, branch, action: r.ok ? r.action : 'failed' };
    if (r.reason) out.reason = r.reason;
    if (st.dirty && strategy === 'carry') out.note = 'WIP 已带到分支';
    return out;
  }
  if (strategy === 'skip') {
    return { ok: false, repo, cwd: repo, branch, action: 'skipped', note: `脏(${st.changeCount}处)已跳过` };
  }
  if (strategy === 'stash') {
    const s = await gitStashPush(repo, `auto before ${branch}`);
    if (!s.ok) return { ok: false, repo, cwd: repo, branch, action: 'failed', reason: `stash 失败: ${s.reason}` };
    const r = await gitCheckoutBranch(repo, branch, base);
    const out: PrepareResult = { ok: r.ok, repo, cwd: repo, branch, action: r.ok ? r.action : 'failed', note: `已 stash ${st.changeCount} 处(git stash pop 恢复)` };
    if (r.reason) out.reason = r.reason;
    return out;
  }
  // worktree
  const w = await gitAddWorktree(repo, branch, base);
  if (!w.ok) return { ok: false, repo, cwd: repo, branch, action: 'failed', reason: `worktree 失败: ${w.reason}` };
  return { ok: true, repo, cwd: w.path!, branch, action: 'worktree', note: `worktree: ${w.path}（当前工作区未动）` };
}
