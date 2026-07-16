import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { useCurrentBranch, type PrepareResult } from './git.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

/** 新任务目录的根：env TASK_WORKROOT，默认 ~/ihealth-work。展开开头的 ~。 */
export function taskWorkroot(): string {
  const raw = (process.env['TASK_WORKROOT'] ?? '~/ihealth-work').trim();
  return raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
}

export type TaskKind = 'fix' | 'feature' | 'indev';

/** 目录名：线上bug=fix_<id6>，新需求=feature_<id6>（用户 spec）。 */
export function taskDirName(kind: TaskKind, id6: string): string {
  return kind === 'feature' ? `feature_${id6}` : `fix_${id6}`;
}
/** 分支名：保留现有前缀 bug=fix_<id6>，需求=feat_<id6>。 */
export function taskBranchName(kind: TaskKind, id6: string): string {
  return kind === 'feature' ? `feat_${id6}` : `fix_${id6}`;
}

export interface TaskRepoPlan {
  name: string;              // repo 名（子目录名）
  sourcePath?: string;       // 本地已有的 repo 源（有则 worktree）
  gitUrl?: string;           // 本地无源时用于 clone（可空）
}

export interface TaskRepoResult {
  name: string;
  cwd: string;               // claude 实际工作目录
  ok: boolean;
  via: 'worktree' | 'clone' | 'in-place' | 'failed';
  reason?: string;
}

export interface TaskWorkspaceResult {
  ok: boolean;
  kind: TaskKind;
  taskDir?: string;          // fix/feature 时的任务目录；indev 无
  branch: string;
  repos: TaskRepoResult[];
}

/** 解析 base → 可切出的 ref：优先 origin/<base>（先 fetch），退回本地 <base>，再退回 HEAD。 */
async function resolveFrom(source: string, base?: string): Promise<string> {
  const b = (base ?? '').trim();
  if (!b || b === 'head' || b === 'current') {
    try { return await git(source, ['rev-parse', 'HEAD']); } catch { return 'HEAD'; }
  }
  try { await git(source, ['fetch', 'origin', b, '--quiet'], 90_000); } catch { /* 离线/无该分支，忽略 */ }
  for (const ref of [`origin/${b}`, b]) {
    try { await git(source, ['rev-parse', '--verify', '--quiet', ref]); return ref; } catch { /* try next */ }
  }
  return 'HEAD';
}

/** 在 targetPath 挂一个 source 仓库的 worktree（新分支 branch，从 base 切）。已存在则复用。 */
async function worktreeAt(source: string, targetPath: string, branch: string, base?: string): Promise<TaskRepoResult> {
  const name = targetPath.split('/').pop() || targetPath;
  if (existsSync(targetPath)) return { name, cwd: targetPath, ok: true, via: 'worktree', reason: '复用已存在目录' };
  try {
    await mkdir(dirname(targetPath), { recursive: true });
    let branchExists = false;
    try { await git(source, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); branchExists = true; } catch { /* no */ }
    if (branchExists) {
      await git(source, ['worktree', 'add', targetPath, branch]);
    } else {
      const from = await resolveFrom(source, base);
      await git(source, ['worktree', 'add', targetPath, '-b', branch, from]);
    }
    return { name, cwd: targetPath, ok: true, via: 'worktree' };
  } catch (e) {
    return { name, cwd: targetPath, ok: false, via: 'failed', reason: ((e as Error).message ?? String(e)).slice(0, 200) };
  }
}

/** 本地无源时 clone 到 targetPath 再切分支（慢，需网络）。 */
async function cloneAt(gitUrl: string, targetPath: string, branch: string, base?: string): Promise<TaskRepoResult> {
  const name = targetPath.split('/').pop() || targetPath;
  if (existsSync(targetPath)) return { name, cwd: targetPath, ok: true, via: 'clone', reason: '复用已存在目录' };
  try {
    await mkdir(dirname(targetPath), { recursive: true });
    const b = (base ?? '').trim();
    const cloneArgs = ['clone', gitUrl, targetPath];
    if (b && b !== 'head' && b !== 'current') cloneArgs.splice(1, 0, '--branch', b);
    await execFileAsync('git', cloneArgs, { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
    await git(targetPath, ['checkout', '-b', branch]);
    return { name, cwd: targetPath, ok: true, via: 'clone' };
  } catch (e) {
    return { name, cwd: targetPath, ok: false, via: 'failed', reason: ((e as Error).message ?? String(e)).slice(0, 200) };
  }
}

/**
 * 按任务类型准备工作目录：
 *  - fix / feature：在 <WORKROOT>/<dirName>/ 下为每个 repo 建 worktree（本地有源）或 clone（无源）。
 *  - indev：不新建，在各 repo 现有源的当前分支直接改（in-place）。
 * repos[].sourcePath 由调用方用 dir-index 解析 repo 名 → 本地路径。
 */
export async function prepareTaskWorkspace(opts: {
  kind: TaskKind;
  id6: string;
  repos: TaskRepoPlan[];
  base?: string;
}): Promise<TaskWorkspaceResult> {
  const branch = taskBranchName(opts.kind, opts.id6);

  if (opts.kind === 'indev') {
    const repos: TaskRepoResult[] = [];
    for (const r of opts.repos) {
      const src = r.sourcePath;
      if (!src || !existsSync(src)) { repos.push({ name: r.name, cwd: src ?? '', ok: false, via: 'failed', reason: '本地无该 repo 源' }); continue; }
      const pr: PrepareResult = await useCurrentBranch(src);
      repos.push({ name: r.name, cwd: pr.cwd, ok: pr.ok, via: 'in-place', ...(pr.reason ? { reason: pr.reason } : {}) });
    }
    return { ok: repos.some((r) => r.ok), kind: opts.kind, branch, repos };
  }

  const dir = join(taskWorkroot(), taskDirName(opts.kind, opts.id6));
  await mkdir(dir, { recursive: true });
  const repos: TaskRepoResult[] = [];
  for (const r of opts.repos) {
    const target = join(dir, r.name);
    if (r.sourcePath && existsSync(r.sourcePath)) {
      repos.push(await worktreeAt(r.sourcePath, target, branch, opts.base));
    } else if (r.gitUrl) {
      repos.push(await cloneAt(r.gitUrl, target, branch, opts.base));
    } else {
      repos.push({ name: r.name, cwd: target, ok: false, via: 'failed', reason: '本地无源且无 gitUrl，无法 worktree/clone' });
    }
  }
  return { ok: repos.some((r) => r.ok), kind: opts.kind, taskDir: dir, branch, repos };
}
