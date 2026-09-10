/**
 * 找 git 仓库根。放在这里而不是 cli.ts：cli.ts 底部就调 `main()`，测试 import 它会真的跑起来，
 * 于是这个本来最好测的纯函数反而没法测（code-reviewer 点的）。
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export type GitRootRunner = (dir: string) => { status: number | null; stdout: string };

const realGitRoot: GitRootRunner = (dir) => {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '' };
};

/** 不是 git 仓库（或没装 git）就退回把输入路径转绝对路径。 */
export function repoRootOf(dir: string, git: GitRootRunner = realGitRoot): string {
  const r = git(dir);
  const out = r.stdout.trim();
  return r.status === 0 && out ? out : resolve(dir);
}
