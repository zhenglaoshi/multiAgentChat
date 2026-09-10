/**
 * 执行层：读 package.json → planBootCheck → 依次跑，第一个失败即停。
 * 不依赖 daemon（git hook 场景 daemon 可能没起），也不走 socket。
 *
 * spawn 可注入（`spawnFn`）——这个文件里最容易出错的就是超时/进程树语义，
 * 必须能用假 spawn 覆盖病态场景，见 tests/bootcheck.test.ts。
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planBootCheck } from './plan.js';
import type {
  BootCheckReport,
  BootCheckStep,
  BootCheckStepResult,
  PackageManager,
} from './types.js';

/** 输出尾部保留多少字符——够定位报错，又不至于把飞书/报告刷爆。 */
const OUTPUT_TAIL_LIMIT = 4000;
const DEFAULT_TIMEOUT_MS = 180_000;
/** SIGKILL 之后再等这么久：孙进程可能还攥着管道写端让 close 迟迟不来，到点强制收工。 */
const KILL_GRACE_MS = 2000;

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe']; detached: boolean },
) => ChildProcess;

export function detectPackageManager(cwd: string): PackageManager {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function readScripts(cwd: string): Record<string, string> | undefined {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    return parsed.scripts ?? {};
  } catch {
    // package.json 存在但坏了：当没有 scripts 处理，note 里会如实说没得跑
    return {};
  }
}

/** 杀整个进程组；拿不到 pid 或组杀失败就退回杀直接子进程。 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (typeof pid === 'number') {
    try {
      // detached: true 让子进程自成进程组，负号 = 杀整组（npm → sh → 真命令 三级都在组里）
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      /* 组不存在/权限问题 → 退回下面 */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* 已经死了 */
  }
}

/**
 * 当前在跑的子进程 —— 给信号处理用。
 *
 * 为什么需要它：`detached: true`（为了能杀整个进程组）把子进程放进了**独立进程组**，
 * 于是终端的 Ctrl-C 只打到父进程（`agent bootcheck` / 整条 hook 链），不再自动传给
 * `npm run typecheck`。而 pre-push 慢的时候用户按 Ctrl-C 是很常见的操作 —— 不处理的话
 * 被 spawn 的进程会变孤儿继续跑（watch 类脚本会一直吃 CPU）。这条是 code-reviewer 实测出来的
 * 「修永挂引入的新回归」。
 */
/**
 * 用 Set 而不是单值：现在的唯一调用路径是「一次 CLI 进程内顺序跑」，单值够用；但 `runStep`/
 * `runBootCheck` 是导出的公共 API，将来若被拿去并行跑多个仓库，单值会被后一个覆盖、前一个的
 * 子进程在信号到达时被静默漏杀 —— 正是这次修的那类 bug 换条路重现。用 Set 成本几乎为零。
 */
const liveChildren = new Set<ChildProcess>();

export function runStep(
  step: BootCheckStep,
  cwd: string,
  timeoutMs: number,
  spawnFn: SpawnFn = nodeSpawn as unknown as SpawnFn,
): Promise<BootCheckStepResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const [bin, ...args] = step.command.split(' ');
    // command 只由 plan.ts 里的**固定常量**拼成（不含空格，有单测钉住这条不变量），
    // 所以按空格切是安全的；真要放开脚本名到「可含空格」，这里必须换成不依赖 split 的方式。
    const child = spawnFn(bin!, args, {
      cwd,
      // 继承环境：项目自己的冒烟脚本负责短路外部连接（见 types.ts 的分工说明），
      // 这里不去猜哪些变量该删——删错了会把「本来能跑的检查」变成假失败（比漏检更伤信任）。
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // 为了能杀整个进程组，见 killTree
    });

    liveChildren.add(child);

    let out = '';
    const append = (chunk: Buffer) => {
      out += chunk.toString('utf8');
      // 只保尾部：极端情况下真正的报错行若在大段 summary 之前，可能被切掉——
      // 排障时若发现失败输出对不上，先怀疑这里。
      if (out.length > OUTPUT_TAIL_LIMIT * 2) out = out.slice(-OUTPUT_TAIL_LIMIT);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    let settled = false;
    let timedOut = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      liveChildren.delete(child);
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({
        ...step,
        status: !timedOut && code === 0 ? 'pass' : 'fail',
        exitCode: code,
        durationMs: Date.now() - started,
        outputTail: out.slice(-OUTPUT_TAIL_LIMIT).trim(),
        timedOut,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // 关键：**不能只等 close**。SIGKILL 只保证直接子进程死，孙进程若还持有 stdout/stderr
      // 管道写端，Node 的 'close' 可能永远不来 → 这个 Promise 永挂 → 挂在 pre-push 上就是
      // 把用户的 git push 卡死（比没有超时更糟：用户看不到任何提示）。所以到点强制收工。
      graceTimer = setTimeout(() => finish(null), KILL_GRACE_MS);
      graceTimer.unref?.();
    }, timeoutMs);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      liveChildren.delete(child);
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({
        ...step,
        status: 'fail',
        exitCode: null,
        durationMs: Date.now() - started,
        outputTail: `无法执行 ${step.command}：${err.message}`,
        timedOut: false,
      });
    });
    child.on('close', finish);
  });
}

/**
 * 信号到达时该做什么：把在跑的子进程整组带走，返回该用的退出码（128 + 信号号，shell 约定）。
 * **不含 `process.exit`** —— 抽出来是为了能单测（在测试进程里真 exit 会把测试自己杀掉）。
 */
export function handleSignal(sig: NodeJS.Signals): number {
  for (const child of liveChildren) killTree(child);
  liveChildren.clear();
  return sig === 'SIGINT' ? 130 : 143;
}

/** 测试用：当前在跑的子进程数。 */
export function liveChildCount(): number {
  return liveChildren.size;
}

/**
 * 装一次性信号处理：收到 Ctrl-C / SIGTERM 时把正在跑的子进程整组带走，再照默认语义退出。
 * 返回卸载函数（跑完要卸，别给长驻进程留 listener）。
 *
 * ⚠ 隐性前提：报告是在 `runBootCheck` resolve **之后**才一次性 `stdout.write` 的，
 * 所以信号处理器存活的那段时间里本进程没有大块 stdout 写入，`process.exit` 不会截断输出。
 * 将来若改成「逐步骤流式打印进度」，这个前提就没了，得先 flush 再 exit。
 */
export function installSignalCleanup(): () => void {
  const handlers: Array<[NodeJS.Signals, () => void]> = [
    ['SIGINT', () => process.exit(handleSignal('SIGINT'))],
    ['SIGTERM', () => process.exit(handleSignal('SIGTERM'))],
  ];
  for (const [sig, h] of handlers) process.on(sig, h);
  return () => {
    for (const [sig, h] of handlers) process.off(sig, h);
  };
}

export async function runBootCheck(opts?: {
  cwd?: string;
  timeoutMs?: number;
  spawnFn?: SpawnFn;
}): Promise<BootCheckReport> {
  const cwd = opts?.cwd ?? process.cwd();
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pm = detectPackageManager(cwd);
  const scripts = readScripts(cwd);

  if (scripts === undefined) {
    return {
      cwd,
      status: 'skipped',
      hasBootSmoke: false,
      note: '未做机器验证：这个目录下没有 package.json（非 Node 项目 / 不是仓库根）。交付时如实写明。',
      steps: [],
      packageManager: pm,
    };
  }

  const plan = planBootCheck(scripts, pm);
  const results: BootCheckStepResult[] = [];
  const uninstall = installSignalCleanup();
  try {
    for (const step of plan.steps) {
      const r = await runStep(step, cwd, timeoutMs, opts?.spawnFn);
      results.push(r);
      if (r.status === 'fail') break; // 第一个失败即停：后面的信息量低，且省时间
    }
  } finally {
    uninstall();
  }

  const status = results.some((r) => r.status === 'fail')
    ? 'fail'
    : results.length
      ? 'pass'
      : 'skipped';
  return { cwd, status, hasBootSmoke: plan.hasBootSmoke, note: plan.note, steps: results, packageManager: pm };
}

/** 给人看的报告（CLI 默认输出；也是 reviewer 贴进审查报告的那段）。 */
export function formatBootCheckReport(r: BootCheckReport): string {
  const icon = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '—';
  const lines: string[] = [];
  lines.push(`${icon} bootcheck ${r.status.toUpperCase()}  (${r.cwd})`);
  for (const s of r.steps) {
    const mark = s.status === 'pass' ? '✓' : '✗';
    const kind = s.kind === 'boot-smoke' ? '加载期冒烟' : '静态';
    const to = s.timedOut ? ' 超时被杀' : '';
    lines.push(`  ${mark} [${kind}] ${s.command} → exit ${s.exitCode}${to} (${s.durationMs}ms)`);
  }
  lines.push(`  ${r.note}`);
  const failed = r.steps.find((s) => s.status === 'fail');
  if (failed?.outputTail) {
    lines.push('', '--- 失败输出尾部 ---', failed.outputTail);
  }
  return lines.join('\n');
}
