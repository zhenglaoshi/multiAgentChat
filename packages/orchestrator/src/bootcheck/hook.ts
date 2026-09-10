/**
 * 全局 git hook：装一次，管所有仓库（不用每个仓库塞一份 .git/hooks）。
 *
 * 机制是 `git config --global core.hooksPath <dir>`。两个必须处理的坑：
 *
 * 1. **hooksPath 一开就接管所有 hook 类型**：设了之后，各仓库 `.git/hooks/` 里原有的
 *    pre-commit / commit-msg 等等会被**整体忽略**。所以这里给标准 hook 名各装一份同样的
 *    dispatch 脚本，脚本第一件事就是**把仓库自己的同名 hook 链起来跑**，避免悄悄废掉
 *    别人已有的本地 hook。（husky 那类设的是**本地** core.hooksPath，本地配置优先，
 *    不受这里影响。）
 * 2. **不能覆盖已有的全局 hooksPath**：如果你早就设过别的目录，install 直接拒绝并说明，
 *    而不是把人家的配置顶掉。
 *
 * 只有 pre-push 会额外跑 `agent bootcheck`，且仅对白名单里的仓库（见 allowlist.ts）。
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * git 的**完整** hook 名单（`git help hooks` 那一套）。
 *
 * 为什么必须是完整名单而不是「我们关心的几个」：`core.hooksPath` 一设，git 就**只**看这个
 * 目录，仓库自己 `.git/hooks/` 里的同名 hook 一律失效。本机实测 blog-backend 和 pigeon
 * 各有一整套 hook（husky 老版本会把所有名字都装进 .git/hooks），少列一个名字就等于
 * 悄悄废掉人家一个 hook —— 这种「静默失效」正是本模块要防的那类问题，别自己犯。
 *
 * 每个名字装的都是同一份 dispatch：先原样转交给仓库自己的同名 hook（含参数与 stdin），
 * 只有 pre-push 额外跑 bootcheck。
 */
export const HOOK_NAMES = [
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'pre-rebase',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-receive',
  'update',
  'proc-receive',
  'post-receive',
  'post-update',
  'reference-transaction',
  'push-to-checkout',
  'pre-auto-gc',
  'post-rewrite',
  'sendemail-validate',
  'fsmonitor-watchman',
  'p4-changelist',
  'p4-prepare-changelist',
  'p4-post-changelist',
  'p4-pre-submit',
  'post-index-change',
] as const;

export function hookDir(): string {
  return join(homedir(), '.multiagent-chat', 'git-hooks');
}

const MARKER = '# multiagent-chat:bootcheck-hook';

/**
 * dispatch 脚本（所有 hook 名共用一份，靠 `basename $0` 区分）。纯函数，便于单测。
 *
 * 注意几个细节：
 *  - 用 `git rev-parse --git-common-dir` 而不是 `--git-path hooks/x`：后者**会**受
 *    core.hooksPath 影响，链回来就是自己 → 无限递归。common-dir 还能兼容 worktree。
 *  - 链本地 hook 时把 stdin 透传（pre-push 的 refs 从 stdin 来），本地 hook 失败即整体失败。
 *  - `agent` 不在 PATH（daemon 没装过 symlink）→ 放行，别把 push 堵死在工具缺失上。
 *  - 逃生开关 SKIP_BOOTCHECK=1。
 */
export function hookScript(): string {
  return `#!/bin/sh
${MARKER} —— 由 \`agent bootcheck install-hook\` 生成，别手改（会被覆盖）。
# 全局 core.hooksPath 会让仓库自己的 .git/hooks/* 失效，所以这里先把同名本地 hook 链起来。
# 只有 pre-push 额外跑 bootcheck，且仅对 ~/.multiagent-chat/bootcheck.json 白名单里的仓库。

hook_name=$(basename "$0")
[ "$SKIP_BOOTCHECK" = "1" ] && exit 0

# 便宜路径优先：git 跑 hook 时 cwd 基本都是工作树根，.git 是目录 —— 直接用，省一次 fork。
# 这对 fsmonitor-watchman（配了 core.fsmonitor 时几乎每次 git status 都调，要求近乎零延迟）
# 和 reference-transaction（一次 push/fetch 可能按 ref 触发多次）很重要。
# 只有 worktree / submodule（.git 是文件）才退回问 git，那时才多一次 fork。
if [ -d .git ]; then
  common_dir=.git
else
  common_dir=$(git rev-parse --git-common-dir 2>/dev/null)
fi
if [ -n "$common_dir" ]; then
  local_hook="$common_dir/hooks/$hook_name"
  # 别把自己当本地 hook 再跑一遍（用 marker 认自己，比比路径稳）
  if [ -x "$local_hook" ] && ! grep -q '${MARKER}' "$local_hook" 2>/dev/null; then
    "$local_hook" "$@" || exit $?
  fi
fi

[ "$hook_name" = "pre-push" ] || exit 0
if ! command -v agent >/dev/null 2>&1; then
  # 放行，但别完全静默：否则你会以为「装了 hook 所以每次 push 都验过了」，其实从没跑过
  echo "bootcheck: agent 不在 PATH，跳过检查（agent install-skill / 看 daemon 是否装过 symlink）" >&2
  exit 0
fi

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
agent bootcheck --hook --cwd "$root"
`;
}

export interface HookStatus {
  dir: string;
  /** 全局 core.hooksPath 当前值（未设为 null） */
  globalHooksPath: string | null;
  /** 全局 hooksPath 是否指向我们 */
  installed: boolean;
  /** 我们的目录里是否已写齐脚本 */
  scriptsPresent: boolean;
}

/** 跑 git 的方式可注入 —— install/remove 会改**全局** git 配置，测试里绝不能真跑。 */
export type GitRunner = (args: string[]) => { status: number | null; stdout: string; stderr: string };

const realGit: GitRunner = (args) => {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

function gitGlobalHooksPath(git: GitRunner): string | null {
  const r = git(['config', '--global', '--get', 'core.hooksPath']);
  const v = r.stdout.trim();
  return v === '' ? null : v;
}

export function hookStatus(opts?: { dir?: string; git?: GitRunner }): HookStatus {
  const dir = opts?.dir ?? hookDir();
  const globalHooksPath = gitGlobalHooksPath(opts?.git ?? realGit);
  const scriptsPresent = HOOK_NAMES.every((n) => existsSync(join(dir, n)));
  return { dir, globalHooksPath, installed: globalHooksPath === dir, scriptsPresent };
}

export type HookActionResult = { ok: boolean; message: string };

export function installGlobalHook(opts?: { dir?: string; git?: GitRunner }): HookActionResult {
  const dir = opts?.dir ?? hookDir();
  const git = opts?.git ?? realGit;
  const existing = gitGlobalHooksPath(git);
  if (existing && existing !== dir) {
    return {
      ok: false,
      message:
        `拒绝安装：全局 core.hooksPath 已经指向 ${existing}（不是我们的目录），` +
        `顶掉它会废掉你已有的 hook。要么先自己合并，要么 git config --global --unset core.hooksPath 再来。`,
    };
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir 的 mode 对**已存在**的目录是 no-op（可能是更早、更松权限的版本留下的）→ 补一次 chmod。
  // 与 allowlist.writeConfig 对称，别让这处不一致长期潜伏。
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* 权限收紧是纵深防御，失败不影响功能 */
  }
  const script = hookScript();
  for (const name of HOOK_NAMES) {
    const p = join(dir, name);
    writeFileSync(p, script, 'utf8');
    chmodSync(p, 0o755);
  }
  if (!existing) {
    const r = git(['config', '--global', 'core.hooksPath', dir]);
    if (r.status !== 0) {
      return { ok: false, message: `写 git 全局配置失败：${r.stderr.trim() || `exit ${r.status}`}` };
    }
  }
  return {
    ok: true,
    message:
      `✓ 全局 hook 已装：${dir}（core.hooksPath 已指向它）\n` +
      `  ${HOOK_NAMES.length} 个标准 hook 名都装了 dispatch：先跑仓库自己的同名 hook，再（仅 pre-push）跑 bootcheck。\n` +
      `  还要对想启用的仓库执行一次 agent bootcheck allow —— 默认谁都不自动跑（避免自动执行不明脚本）。`,
  };
}

export function removeGlobalHook(opts?: { dir?: string; git?: GitRunner }): HookActionResult {
  const dir = opts?.dir ?? hookDir();
  const git = opts?.git ?? realGit;
  const existing = gitGlobalHooksPath(git);
  if (existing && existing !== dir) {
    return { ok: false, message: `全局 core.hooksPath 指向 ${existing}，不是我们装的，不动它。` };
  }
  if (existing === dir) {
    const r = git(['config', '--global', '--unset', 'core.hooksPath']);
    if (r.status !== 0) {
      // 必须在这里就返回：一旦 core.hooksPath 还指着这个目录，而我们又把脚本删了，
      // git **不会**回退去看 .git/hooks —— 全机所有 hook（含用户自己的本地 hook）
      // 会静默失效，而工具还报「已恢复生效」。宁可维持「仍然装着」的可用状态。
      return {
        ok: false,
        message:
          `取消 git 全局 core.hooksPath 失败：${r.stderr.trim() || `exit ${r.status}`}\n` +
          `  **没有删除任何脚本**（否则会变成「配置指向空目录」= 全机 hook 静默失效）。\n` +
          `  手动处理：git config --global --unset core.hooksPath，然后再跑一次本命令。`,
      };
    }
  }
  let removed = 0;
  for (const name of HOOK_NAMES) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    // 只删我们自己写的（认 marker），别误删用户手放进来的东西
    try {
      if (readFileSync(p, 'utf8').includes(MARKER)) {
        rmSync(p);
        removed++;
      }
    } catch {
      /* 读不了就不动 */
    }
  }
  return {
    ok: true,
    message: `✓ 已卸载：core.hooksPath 已取消，删掉 ${removed} 个脚本。仓库自己的 .git/hooks 立即恢复生效。`,
  };
}
