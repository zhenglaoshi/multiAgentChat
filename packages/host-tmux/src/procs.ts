/**
 * 进程探测 —— tmux 只给 pane 的「前台命令名」一个字段，不够判 agent，所以自己读一次 `ps`。
 *
 * 关键性能约定：**一次 `ps -e` 拿全机再按 tty 分组**，不是每个 pane 跑一次 ps。
 * `listTabsRaw()` 是 watcher 每 2s 的热路径，N 个 pane 就 N 次 spawn 的话，
 * 十几个 pane 时光 spawn 就能把这个 tick 吃满。
 */

import { execFile, spawnSync } from 'node:child_process';

/** 被当成「pane 的壳」的进程名 —— 只剩这些 = 这个 pane 闲着。 */
// 查表前已用 procBasename 同款归一（剥掉 login shell 的前导 `-`、去路径），所以这里**不要**再写 '-zsh' 这类
// 带前缀的条目——那是永远命中不了的死键，只会误导下一个读代码的人。
const SHELL_PROCS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'login', 'tmux']);

/** 解释器名：argv[0] 是这些的话，真正的程序在 argv[1]（`node /usr/local/bin/claude` 这种）。 */
const RUNTIMES = new Set(['node', 'nodejs', 'deno', 'bun', 'python', 'python3', 'ruby', 'perl']);

/**
 * 从 `ps -o args=` 的一整行里取出「进程名」。
 *
 * 为什么不用 `ps -o comm=`：Linux 的 comm 只有 basename 且截断到 15 字符，而 AgentAdapter 的判据是
 * `p === 'claude' || p.endsWith('/claude')` —— 带路径的形式必须保住。
 * 更要紧的是 **`node /path/bin/claude` 这种包装形式**：argv[0] 是 `node`，直接取首 token 就永远认不出 agent
 * （codex 的 headless 判定踩过同一个坑，见 bin/lib/headless.mjs）。所以解释器名要往后再取一个。
 *
 * 纯函数，便于单测。
 */
export function parseProcName(argsLine: string): string {
  const tokens = argsLine.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  const first = tokens[0]!;
  const base = first.replace(/^-/, '').split('/').pop() ?? first;
  if (RUNTIMES.has(base) && tokens.length > 1) {
    const second = tokens[1]!;
    // 跳过 `node --flag script` 里的 flag
    if (!second.startsWith('-')) return second;
    const third = tokens[2];
    if (third && !third.startsWith('-')) return third;
  }
  return first;
}

/** `ps` 的一行 → [tty, 进程名]；解析不出返回 null。纯函数。 */
export function parsePsLine(line: string): [string, string] | null {
  const m = /^\s*(\S+)\s+(.+)$/.exec(line);
  if (!m) return null;
  const tty = m[1]!;
  if (tty === '?' || tty === '??' || tty === '-') return null;
  const name = parseProcName(m[2]!);
  if (!name) return null;
  return [tty.startsWith('/dev/') ? tty : `/dev/${tty}`, name];
}

/** 把 `ps -e -o tty=,args=` 的整段输出按 tty 分组。纯函数。 */
export function groupProcsByTty(psOut: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const line of psOut.split('\n')) {
    const parsed = parsePsLine(line);
    if (!parsed) continue;
    const [tty, name] = parsed;
    const arr = map.get(tty);
    if (arr) arr.push(name);
    else map.set(tty, [name]);
  }
  return map;
}

/** 一次 ps 拿全机进程，按 tty 分组。失败返回空 Map（调用方降级成「进程列表为空」）。 */
export function snapshotProcsByTty(timeoutMs = 4000): Promise<Map<string, string[]>> {
  return new Promise((resolve) => {
    execFile('ps', ['-e', '-o', 'tty=,args='], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? new Map() : groupProcsByTty(String(stdout ?? '')));
    });
  });
}

/**
 * pane 是不是「忙」—— 除了壳以外还有别的进程在跑。
 * tmux 没有 Terminal.app 那个 busy 属性，只能这么推。纯函数。
 */
export function inferBusy(processes: string[]): boolean {
  return processes.some((p) => {
    const base = p.replace(/^-/, '').split('/').pop() ?? p;
    return !SHELL_PROCS.has(base.toLowerCase());
  });
}

/**
 * daemon 自己所在的 tty（沿父进程链往上找）—— 与 host-mac 同款实现（都是 POSIX `ps`）。
 * 用途：拒绝关掉自己那个 pane，否则把整套服务关了。
 */
export function detectSelfTty(): string | undefined {
  let pid: number | undefined = process.pid;
  for (let i = 0; i < 12 && pid && pid > 1; i++) {
    try {
      const r = spawnSync('ps', ['-o', 'tty=,ppid=', '-p', String(pid)], { encoding: 'utf8' });
      const line = r.stdout.trim();
      const m = /^(\S+)\s+(\d+)$/.exec(line);
      if (!m) break;
      const tty = m[1]!;
      if (tty !== '??' && tty !== '?' && tty !== '-') {
        return tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
      }
      pid = Number(m[2]);
    } catch {
      break;
    }
  }
  return undefined;
}
