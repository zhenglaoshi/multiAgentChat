import { execFile } from 'node:child_process';
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
