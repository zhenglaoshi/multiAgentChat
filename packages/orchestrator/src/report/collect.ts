import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger.js';
import { memoryStore } from '../memory/store.js';
import type { TaskMemory } from '../memory/types.js';
import { beijingDateOf, beijingPartsOf, parseYmd, type DateParts } from './args.js';
import { collectSessionActivity, type SessionPrompt } from './sessions.js';
import type { ReportWindow } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * 有并发上限地 map（按批次跑）。报告候选仓库可能上百个，每个仓库还要跑数次 git 子进程，
 * 无上限的 Promise.all 会一次 fan-out 出几百个进程，冲击系统 fd/进程数。限流到 concurrency。
 */
async function mapLimit<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const res = await Promise.all(batch.map((it) => fn(it)));
    for (let j = 0; j < res.length; j++) out[i + j] = res[j]!;
  }
  return out;
}

/** 报告采集扫仓库的并发上限（每仓库还会派生数次 git 子进程，控总量）。 */
const REPO_SCAN_CONCURRENCY = 16;

// 类型定义在 ./types.js（见那里的注释）；这里 re-export 保持既有 import 路径不变
export type { ReportWindow } from './types.js';

export interface GitCommit {
  repo: string;      // repo basename
  hash: string;
  date: string;      // YYYY-MM-DD
  subject: string;
}

/** 一个仓库的未提交改动快照（工作台里没 commit 的活）。 */
export interface UncommittedRepo {
  repo: string;      // repo basename
  branch: string;
  count: number;     // 改动条目数（时间窗内、按 mtime 过滤后；非 porcelain 原始行数）
  files: string[];   // 采样文件路径（最多 12 条）
}

export interface CollectedWork {
  window: ReportWindow;
  sinceLabel: string;   // 'YYYY-MM-DD'
  untilLabel: string;
  gitAuthors: string[];
  commits: GitCommit[];
  /** 任务记忆（本工具跑过的任务）：prompt + 摘要 */
  tasks: { prompt: string; summary?: string; cwd: string; endedAt: number }[];
  /** 未提交改动（prev=false 时采集，按 mtime 限定在时间窗内；prev=true 为空数组）。 */
  uncommitted: UncommittedRepo[];
  /**
   * 窗口内我在各目录发起的会话输入（Claude Code 会话历史，已脱敏）。
   * 覆盖前三个源都看不见的活：纯讨论 / 只读排查 / 在外部平台点配置 / 非 git 目录里的产出。
   */
  sessions: SessionPrompt[];
}

/**
 * TUI 噪音 / 占位判定。
 * 本地 claude 任务在没拿到 Stop hook 干净回答时，summary 会是一段 claude 菜单/spinner
 * 尾巴（"Enter to select" / "Type something" / box-drawing 字符…），喂给报告只会污染。
 * 判为噪音的返回 true。
 */
export function isNoiseText(s: string | undefined): boolean {
  if (!s) return true;
  const t = s.trim();
  if (!t) return true;
  // Claude Code TUI chrome / 菜单 / 状态栏签名——正常 assistant 摘要绝不会出现这些，命中即噪音：
  //   菜单："Enter to select" / "↑/↓ to navigate" / "Type something" / "Chat about this"
  //   状态栏："⏵⏵ auto mode on (shift+tab to cycle)" / "⧉ <file>" / "? for shortcuts"
  //   shell 噪音："compaudit" / "insecure directories"
  if (/Enter to select|↑\/↓ to navigate|to navigate|Type something|esc to (cancel|interrupt|clear)|Chat about this|Press up|Cogitat|auto mode on|shift\+tab|to cycle\)|for shortcuts|Bypassing Permissions|compaudit|insecure director|⏵⏵|⧉|⎿/i.test(t)) {
    return true;
  }
  // 去掉 box-drawing / 空白 / 项目符号后，实际文字≤1 → 基本是空/纯符号，视为噪音。
  // 阈值取 2（而非早期的 8）：短但真实的确认（如「已完成」「改完了」）不该被误杀漏进报告。
  const wordish = t.replace(/[\s─-╿•·]+/g, '');
  return wordish.length < 2;
}

const PLACEHOLDER_PROMPT = /^\s*(🏠\s*本地|$)/;

/**
 * 该 memory 条目是否值得进报告。
 * - 有真实 prompt（飞书 / note / 手写描述）→ 一律保留。
 * - 占位 prompt（🏠 本地）→ 只有当 summary 是真内容（Stop hook 抓到的回答）才保留，
 *   否则是一条纯 TUI 噪音，剔除，避免报告合成时被误导编造。
 */
export function isReportableTask(mem: TaskMemory): boolean {
  const promptReal = !!mem.prompt && !PLACEHOLDER_PROMPT.test(mem.prompt);
  if (promptReal) return true;
  return !isNoiseText(mem.summary);
}

/** hook 与 watcher 落盘的时间差窗口（同一任务通常在一个 watcher tick~分钟级内）。 */
const HOOK_DEDUP_WINDOW_MS = 15 * 60_000;

/**
 * 报告任务去重：Stop hook 留底的 memory（source='hook'）可能和 watcher 正常落的 memory 指同一任务
 * ——watcher 的 persistTaskMemory 对本地任务会 consume 同一段 hook 文本作 summary，两条 summary 同源。
 * 策略（只删冗余 hook、绝不删真实任务，宁可轻微重复也不漏活）：非 hook 条目全部保留、彼此从不合并；
 * 一条 hook 仅当有「同 tty + summary 归一化相等(非空) + 落盘时间相近」的非 hook 条目时才丢弃。
 * 三重约束避免早期「同 cwd + 通用开头」把两条不同 tab 的 hook 误合并丢真任务；feishu 任务 watcher 无
 * summary 对不上 → hook 保留（该任务报告里可能一行问一行答，可接受的轻微重复）。
 */
export function dedupeReportTasks(mems: TaskMemory[]): TaskMemory[] {
  const norm = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const nonHook = mems.filter((m) => m.source !== 'hook');
  const hooks = mems.filter((m) => m.source === 'hook');
  // 一条 hook 仅当有「同 tty + summary 归一化相等(非空) + 落盘时间相近」的非 hook 条目时才丢弃。
  const coveredByWatcher = (h: TaskMemory): boolean => {
    const hs = norm(h.summary);
    if (!hs) return false;
    return nonHook.some(
      (w) => w.tty === h.tty && norm(w.summary) === hs && Math.abs(w.endedAt - h.endedAt) <= HOOK_DEDUP_WINDOW_MS,
    );
  };
  return [...nonHook, ...hooks.filter((h) => !coveredByWatcher(h))];
}

/**
 * 北京时区时间窗。
 *  - prev=false（默认）：锚点所在周期的起点 → 现在（周期未结束时）或周期末（补历史时）
 *  - prev=true：锚点所在周期的**上一个完整**周期（定时周报/月报用：周一报上周、月初报上月）
 *  - anchor：'YYYY-MM-DD'（北京时区日历日），缺省 = 今天 → 与历史行为完全一致。
 *    给了历史日期就出那一天/那一周/那个月的报告（补日报用）；格式不合法则回退到今天并 warn。
 *    **调用约定**：anchor 必须先过 `parseReportArgs`/`parseYmd` 校验，不要把未校验的用户原文
 *    直接塞进来——非法分支会把它原样写进日志。
 */
export function reportWindow(
  kind: ReportWindow,
  prev = false,
  anchor?: string,
  now: Date = new Date(),
): { since: Date; until: Date; sinceLabel: string; untilLabel: string } {
  let base = beijingPartsOf(now);
  if (anchor) {
    const p = parseYmd(anchor);
    if (p) base = p;
    else logger.warn('reportWindow: 锚点日期不合法，回退到今天', { anchor: anchor.slice(0, 40) });
  }

  // 锚点所在周期 [start, end)，再按 prev 回退一个周期
  let span = spanOf(kind, base);
  if (prev) span = spanOf(kind, beijingPartsOf(new Date(span.start.getTime() - 86400_000)));

  // 锚点在未来：算得出窗口但必然是空报告。调用方（飞书 /report）已用 parseReportArgs.future
  // 提前拒绝；这里补一条不阻断的 warn，防止将来新入口漏了那道校验、静默产出误导性空报告。
  if (span.start.getTime() > now.getTime()) {
    logger.warn('reportWindow: 锚点落在未来，报告将为空', { kind, anchor, sinceLabel: beijingDateOf(span.start) });
  }

  // 周期未结束（含"当期"）→ 收到 now；已结束（补历史）→ 收到周期末
  // 起点用 >=：恰好在北京 00:00:00.000 调用时也算"当期"，不会把 untilLabel 显示成未来日期
  const openEnded = now.getTime() >= span.start.getTime() && now.getTime() < span.end.getTime();
  const until = openEnded ? now : span.end;
  // 区间左闭右开：已结束周期的 untilLabel 用周期末前一天，读起来才是"到那天为止"
  const untilLabel = openEnded ? beijingDateOf(until) : beijingDateOf(new Date(span.end.getTime() - 86400_000));
  return { since: span.start, until, sinceLabel: beijingDateOf(span.start), untilLabel };
}

/** 北京 00:00 = UTC 前一天 16:00 → Date.UTC(y, m-1, d, -8) */
function bjMidnight(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d, -8, 0, 0));
}

/** 含 base 这一天的 kind 周期区间 [start, end)（end 为下一周期起点，左闭右开）。 */
function spanOf(kind: ReportWindow, base: DateParts): { start: Date; end: Date } {
  const { y, m, d } = base;
  if (kind === 'day') {
    const start = bjMidnight(y, m, d);
    return { start, end: new Date(start.getTime() + 86400_000) };
  }
  if (kind === 'week') {
    // 周一为起点；getUTCDay 对"纯日历日"载体即该日星期（0=周日）
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const start = new Date(bjMidnight(y, m, d).getTime() - ((dow + 6) % 7) * 86400_000);
    return { start, end: new Date(start.getTime() + 7 * 86400_000) };
  }
  if (kind === 'month') {
    return { start: bjMidnight(y, m, 1), end: m === 12 ? bjMidnight(y + 1, 1, 1) : bjMidnight(y, m + 1, 1) };
  }
  return { start: bjMidnight(y, 1, 1), end: bjMidnight(y + 1, 1, 1) };
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
      const v = (await execFileAsync('git', ['-C', repo, 'config', key], { timeout: 5000, env: GIT_ENV })).stdout.trim();
      if (v) out.push(v);
    } catch { /* ignore */ }
  }
  return out;
}

/**
 * 「仓库正常，只是还没有任何提交」——`git log` 对空仓库退非 0，但这不是故障：
 * 刚 `git init`、活儿全在工作区的新项目就是这样（正是报告最该关心的一类）。
 * 静默返回空即可，否则每出一次报告就刷一串误导性 WARN。
 * git 子进程统一带 `LC_ALL=C`，错误文案不随系统语言变，这里才能稳定识别。
 */
function isEmptyRepoError(msg: string): boolean {
  return /does not have any commits yet|unknown revision or path not in the working tree/i.test(msg);
}

/** git 子进程统一环境：锁英文输出，便于稳定识别错误类型。 */
const GIT_ENV = { ...process.env, LC_ALL: 'C' };

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
    const { stdout } = await execFileAsync('git', args, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024, env: GIT_ENV });
    const base = repo.split('/').pop() || repo;
    return stdout.split('\n').filter((l) => l.trim()).map((l) => {
      const [hash, date, subject] = l.split('\x1f');
      return { repo: base, hash: hash ?? '', date: date ?? '', subject: subject ?? '' };
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (!isEmptyRepoError(msg)) logger.warn('report gitLog failed', { repo, err: msg });
    return [];
  }
}

/**
 * 解析 `git status --porcelain -z` 输出 → 改动文件相对路径数组。
 *
 * 为什么用 `-z` 而非普通 porcelain：普通 porcelain 默认 `core.quotePath=true`，会把中文 /
 * 含特殊字符（引号、反斜杠、换行）的文件名做 C-style octal 转义并加引号（如
 * `截屏2026-09-03.png` → `"\346\210\252..."`）→ 直接 stat 该字面串必 ENOENT 被静默丢弃，
 * 中文文件名 / macOS 中文截图全进不了报告。`-z` 用 NUL 分隔、路径原样不转义，根治此问题，
 * 且 rename/copy 不再用 ` -> ` 拼接（消除箭头误判），改为紧跟一个「旧路径」NUL 字段。
 *
 * -z 每条：`XY<空格>路径\0`；rename/copy（状态码首列 R/C）额外紧跟 `旧路径\0`，需消费掉、只取新路径。
 */
export function parsePorcelainZ(stdout: string): string[] {
  const tokens = stdout.split('\0');
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;              // 末尾空串 / 空 token
    const code = tok.slice(0, 2);    // XY 状态码
    const rel = tok.slice(3);        // 跳过 "XY "（第 3 位为空格）
    // rename/copy 会紧跟一个「旧路径」NUL 字段，消费掉、只取新路径。
    // R/C 主要出现在 X(index) 列，但 status.renames 下 Y(worktree) 列也可能出现，两列都查。
    if (code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C') i++;
    if (rel) out.push(rel);
  }
  return out;
}

// 病态 repo（海量 untracked，如未 ignore 的 node_modules/dist）可能有上万条 porcelain，
// 全 stat 会拖慢报告 —— 封顶只看前 N 条（超限会 warn，便于排查报告不全）。
const MAX_STAT_PER_REPO = 4000;

/**
 * 一个仓库在 [since, until] 时间窗内**真正改动过**的未提交文件（按文件 mtime 过滤）。
 *
 * 不加时间窗时，`git status` 会把几周前积压、从没 commit 的文件也当「今天进行中」全倒进
 * 报告——这是日报「很多都不是今天的」的主因。只保留 mtime 落在报告窗内的文件；
 * 窗内无改动的仓库返回 null（不进报告）。
 * 已删除 / rename 源等 lstat 不到日期的条目跳过（宁可漏，不误报陈年货）。
 */
async function gitUncommitted(repo: string, since: Date, until: Date): Promise<UncommittedRepo | null> {
  try {
    const [statusRes, branch] = await Promise.all([
      execFileAsync('git', ['-C', repo, 'status', '--porcelain', '-z'], {
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
        env: GIT_ENV,
      }),
      // `branch --show-current` 而非 `rev-parse --abbrev-ref HEAD`：后者在**尚无任何提交**的
      // 新仓库上直接失败（分支名只好留空），而新建项目正是报告最该报的一类活。
      execFileAsync('git', ['-C', repo, 'branch', '--show-current'], { timeout: 5000, env: GIT_ENV })
        .then((r) => r.stdout.trim())
        .catch(() => ''),
    ]);
    const paths = parsePorcelainZ(statusRes.stdout);
    if (paths.length === 0) return null;
    if (paths.length > MAX_STAT_PER_REPO) {
      logger.warn('report gitUncommitted: porcelain 超上限，已截断', { repo, total: paths.length, cap: MAX_STAT_PER_REPO });
    }
    const sinceMs = since.getTime();
    const untilMs = until.getTime();
    // 逐条 lstat 判 mtime；repo 间已在 collectWorkData 里并发，此处顺序执行以免 fd 爆量。
    // 用 lstat（不跟随软链）：既语义正确（改动的是软链自身，非目标），又避免跟进失联挂载点
    // 的目标把整批报告挂死；软链条目直接跳过（软链自身改动罕见，不值得为它冒挂起风险）。
    const recent: string[] = [];
    for (const rel of paths.slice(0, MAX_STAT_PER_REPO)) {
      try {
        const st = await lstat(join(repo, rel));
        if (st.isSymbolicLink()) continue;
        if (st.mtimeMs >= sinceMs && st.mtimeMs <= untilMs) recent.push(rel);
      } catch { /* 删除/rename 源/lstat 失败：无法定日期，跳过 */ }
    }
    if (recent.length === 0) return null;
    const base = repo.split('/').pop() || repo;
    return { repo: base, branch, count: recent.length, files: recent.slice(0, 12) };
  } catch (e) {
    logger.warn('report gitUncommitted failed', { repo, err: (e as Error).message });
    return null;
  }
}

/** 采集一个时间窗内我的工作数据：git 提交（跨 repo）+ 任务记忆 + 未提交改动。 */
export async function collectWorkData(opts: {
  window: ReportWindow;
  repos: string[];
  gitAuthors?: string[];
  /** true → 采上一个完整周期（定时周报/月报用）。 */
  prev?: boolean;
  /** 'YYYY-MM-DD' 日期锚点（北京时区）；缺省 = 当天/当期。补历史日报用。 */
  anchor?: string;
  /**
   * 调用方已经算好的时间窗，直接复用（不再内部重算）。
   *
   * 为什么需要：当期报告（无 anchor、非 prev）的 `until` 就是 `new Date()`——调用方先算一次
   * 窗口去挑候选仓库，几百毫秒到数秒后这里再算一次，两个 `until` 必然差几毫秒。
   * 于是 `collectSessionActivity` 的窗口缓存 key 对不上、**永远不命中**，
   * 「一次报告只扫一遍会话语料」的设计被架空，默认 `/report` 和每日定时报告都白扫两遍。
   * 传了就用调用方那个，两边严格同窗。
   */
  window_?: { since: Date; until: Date; sinceLabel: string; untilLabel: string };
}): Promise<CollectedWork> {
  const { since, until, sinceLabel, untilLabel } =
    opts.window_ ?? reportWindow(opts.window, opts.prev ?? false, opts.anchor);
  const gitAuthors = opts.gitAuthors && opts.gitAuthors.length ? opts.gitAuthors : await detectGitAuthors();

  const commitLists = await mapLimit(opts.repos, REPO_SCAN_CONCURRENCY, (r) => gitLog(r, since, until, gitAuthors));
  const commits = commitLists.flat();

  const sinceMs = since.getTime();
  const all = await memoryStore.all().catch(() => []);
  const inWindow = all
    .filter((mem) => mem.endedAt >= sinceMs && mem.endedAt <= until.getTime())
    .filter(isReportableTask);
  const tasks = dedupeReportTasks(inWindow)
    .sort((a, b) => a.endedAt - b.endedAt)
    .map((mem) => ({ prompt: mem.prompt, summary: mem.summary, cwd: mem.cwd, endedAt: mem.endedAt }));

  // 未提交改动是 now 的快照，但已按文件 mtime 落在 [since, until] 内过滤 →
  // 补历史日报（anchor 指过去某天）时同样有效：那天动过、至今仍没 commit 的活算进行中。
  // 定时上周期报告（prev=true）沿用旧行为不采（那批活多半早已 commit，快照对不上）。
  let uncommitted: UncommittedRepo[] = [];
  if (!(opts.prev ?? false)) {
    const lists = await mapLimit(opts.repos, REPO_SCAN_CONCURRENCY, (r) => gitUncommitted(r, since, until));
    uncommitted = lists.filter((u): u is UncommittedRepo => u !== null);
  }

  // 会话历史：前三个源的盲区兜底（见 sessions.ts 顶部注释）。采集失败不阻断报告。
  const sessions = await collectSessionActivity(since, until)
    .then((a) => a.prompts)
    .catch((e) => {
      logger.warn('report 会话历史采集失败', { err: (e as Error).message });
      return [] as SessionPrompt[];
    });

  return { window: opts.window, sinceLabel, untilLabel, gitAuthors, commits, tasks, uncommitted, sessions };
}
