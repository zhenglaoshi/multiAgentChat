import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../logger.js';
import { redactTextStrict } from '../secrets/redactor.js';

/**
 * Claude Code 会话历史（`~/.claude/projects/<slug>/<sessionId>.jsonl`）作为报告数据源。
 *
 * 为什么需要这个源：报告原本只看 ① git 提交 ② 未提交改动 ③ memoryStore 任务记忆。
 * 三者都有盲区——
 *   - ①② 只覆盖「有代码落盘的 git 仓库」：当天新建、尚未进 dir-index 的项目，
 *     以及非 git 目录里的产出（导出的表、图、脚本）全看不见。
 *   - ③ 只在 watcher 认出任务 / Stop hook 成功留底时才写：实测某天 476 个会话文件
 *     只落了 11 条 memory。纯讨论、只读排查、在外部平台（TAPD / 云控制台）点配置的活，
 *     报告里等于没发生。
 * 会话 jsonl 恰好补上这块：每条真人输入都带 `cwd` + `timestamp` + 原话，
 * 既能给出「那天我在哪些目录干活」（→ 并进报告候选仓库集），
 * 也能给出「我让 AI 做了什么」（→ 并进报告正文，比 commit message 更说明意图）。
 */

/** 一条真人发起的会话输入。 */
export interface SessionPrompt {
  cwd: string;
  text: string;      // 已脱敏、已截断
  at: number;        // epoch ms
  branch?: string;   // 会话记录的 gitBranch（有则带上，便于归到具体分支的活）
}

export interface SessionActivity {
  /** 窗口内有真人会话活动的工作目录（绝对路径，去重，按活跃度降序）。 */
  cwds: string[];
  /** 窗口内的真人输入（按时间升序，已脱敏）。 */
  prompts: SessionPrompt[];
}

const PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/** 单个 jsonl 读取上限：超大文件（长会话 + 大量工具输出）直接跳过，避免把报告拖死。 */
const MAX_SESSION_FILE_BYTES = 32 * 1024 * 1024;
/** 并发读取的会话文件数（IO 密集，控 fd 用量）。 */
const READ_CONCURRENCY = 8;
/**
 * 单个文件 IO 的硬超时。
 *
 * 外层的墙钟预算只在**调度下一个文件前**检查，抢占不了已经发出去的 `stat`/`readFile` ——
 * 一个失联的网络挂载点就能让那一批（最多 READ_CONCURRENCY 个）永远不 resolve，
 * 整份报告跟着挂住。给每次 IO 挂 AbortSignal，超时按「跳过这个文件」处理。
 */
const FILE_IO_TIMEOUT_MS = 5_000;
/** 单条输入保留的字符数（喂给合成模型，过长无益）。 */
const MAX_PROMPT_CHARS = 300;
/** 全窗口保留的输入条数上限（防止长周期报告把 prompt 撑爆）。 */
const MAX_PROMPTS = 400;
/**
 * 一次采集的**墙钟**预算。
 *
 * 单文件上限拦不住长周期窗口：`/report month` 的 since 在 30 天前，几乎每个会话文件的
 * mtime 都 >= since —— 实测一次月报要读 5108 个文件、465MB（语料 705MB 且只增不减，
 * 没有任何清理），而 `report-scheduler` 还会定时自动跑月报。
 *
 * 用时间而不是字节数封顶：内容是**流式**读的（读一个丢一个，峰值驻留只有
 * `READ_CONCURRENCY × MAX_SESSION_FILE_BYTES`，本来就有界），465MB 也只花 1.85s ——
 * 真正要防的是语料病理性膨胀 / 慢盘让报告卡住，不是日常读取量。
 * 先按字节卡过 192MB，结果本机日常量就被卡爆（一次日报 399 个文件被跳过、
 * 会话源直接产出 0 条），把功能打没了 —— 阈值必须离日常量足够远才是安全网。
 */
const MAX_SCAN_MS = 20_000;
/** 字节上限只作二次兜底（防单次把内存打爆），离日常量足够远。 */
const MAX_TOTAL_READ_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * 本数据源的开关（默认开）。设 `REPORT_SESSION_SOURCE=0`（或 off/false）关掉。
 *
 * 采集范围是 `~/.claude/projects/*` 全部工程，不限于当前仓库——这是刻意的
 * （"那天我在哪些目录干活"本来就跨项目），但也意味着本机所有项目的对话内容
 * （已脱敏）都会进到报告推送的那个飞书会话里。给需要收窄的场景留个总开关。
 */
function sessionSourceEnabled(): boolean {
  const v = (process.env.REPORT_SESSION_SOURCE ?? '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

/** 会话 jsonl 里一条 user 记录的（我们用到的）形状。 */
export interface RawUserEntry {
  type?: string;
  cwd?: string;
  timestamp?: string;
  gitBranch?: string;
  promptSource?: string;
  origin?: { kind?: string };
  message?: { role?: string; content?: unknown };
}

/**
 * 是否为「真人在终端里打进去的一句话」。
 *
 * 排除的两类噪音（实测都会落进同一批 jsonl）：
 *   - 本项目自己 spawn 的 `claude -p`（报告合成、自审、知识提炼…）：`promptSource: 'sdk'`、
 *     `entrypoint: 'sdk-cli'`、**没有 `origin`**。不排除的话报告里会出现「你是我的工作总结助手…」。
 *   - 工具结果回灌的 user 记录：`message.content` 是数组（tool_result 块）而非字符串。
 */
export function isHumanPrompt(e: RawUserEntry): boolean {
  if (e.type !== 'user') return false;
  if (typeof e.message?.content !== 'string') return false;
  return e.origin?.kind === 'human' || e.promptSource === 'typed';
}

/**
 * 无实质内容的输入（不值得进报告）：斜杠命令、单字确认、纯符号。
 * 注意别把短但真实的指令误杀——阈值取 4 个字符，「重启一下」这种保留。
 */
export function isTrivialPrompt(text: string): boolean {
  const t = text.trim();
  if (t.length < 4) return true;
  // 纯斜杠命令（/report、/clear、/reload…）：是操作本工具，不是当天的工作内容。
  // 带参数的斜杠命令（/tapd 建需求 xxx）保留——那是真在干活。
  if (/^\/[a-z-]+$/i.test(t)) return true;
  if (/^(继续|好的?|嗯+|ok|yes|no|是|对|行|可以|谢谢|辛苦了?)[。.!！~]*$/i.test(t)) return true;
  return false;
}

/**
 * 归一化用于去重：压空白，比**完整**文本（已截到 MAX_PROMPT_CHARS）。
 *
 * 别用「前 N 字」——脱敏之后多条不同的提问很容易撞成同一个开头
 * （「帮我看下 [REDACTED-VAL] …」），那会把真实的不同工作误合并掉。
 * 分隔符用 U+0000：正常文本里不会出现，不像空格那样可能与内容边界混淆。
 */
function dedupeKey(p: SessionPrompt): string {
  return `${p.cwd}\u0000${p.text.replace(/\s+/g, ' ').trim()}`;
}

/**
 * 给一次 IO 套硬超时。
 * `readFile` 支持 `signal` 可以真正中断，`stat` 不支持——对它只能靠这层 race 让**调用方**
 * 不再等下去（底层句柄仍挂着，但不会拖住整份报告）。超时按失败处理，调用方跳过该文件。
 */
function withIoTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('session file IO timeout')), FILE_IO_TIMEOUT_MS).unref(),
    ),
  ]);
}

/** 有并发上限地跑（同 collect.ts 的 mapLimit，避免 fd/内存一次性爆量）。 */
async function forEachLimit<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map((it) => fn(it)));
  }
}

/** 列出所有会话 jsonl 的路径 + mtime（用于按时间窗粗筛）。 */
async function listSessionFiles(): Promise<{ path: string; mtimeMs: number }[]> {
  const out: { path: string; mtimeMs: number }[] = [];
  let slugs: string[];
  try {
    slugs = (await readdir(PROJECTS_DIR, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out; // 没装 Claude Code / 目录不可读：本源静默为空，报告照常出
  }
  await forEachLimit(slugs, READ_CONCURRENCY, async (slug) => {
    const dir = join(PROJECTS_DIR, slug);
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl'));
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      try {
        const st = await withIoTimeout(stat(p));
        if (st.isFile()) out.push({ path: p, mtimeMs: st.mtimeMs });
      } catch { /* 会话文件可能正被轮转/删除，或 IO 超时，跳过 */ }
    }
  });
  return out;
}

/**
 * 一次报告生成里会问两遍同一个窗口（`activeReportRepos` 要 cwds、`collectWorkData` 要 prompts），
 * 全量扫会话文件一次不便宜 —— 用短 TTL 缓存把它压成一次 IO。TTL 取 2min：足够覆盖一次报告
 * 的采集阶段，又短到不会让「先跑报告、再跑一次」拿到过期数据。
 */
const CACHE_TTL_MS = 2 * 60_000;
let cache: { key: string; at: number; value: SessionActivity } | null = null;

/**
 * 采集时间窗内的真人会话活动。
 *
 * 粗筛用文件 mtime：`mtime < since` 的文件最后一次写入早于窗口起点，窗内不可能有记录，直接跳过。
 * **不能**用 `mtime > until` 反向排除——同一个会话可能跨天继续写，那样会漏掉窗内的前半段。
 * 逐行只 JSON.parse 含 `"type":"user"` 的行（一个长会话里绝大多数行是 assistant / tool 结果）。
 */
export async function collectSessionActivity(since: Date, until: Date): Promise<SessionActivity> {
  if (!sessionSourceEnabled()) return { cwds: [], prompts: [] };
  const key = `${since.getTime()}:${until.getTime()}`;
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  const value = await scanSessionActivity(since, until);
  cache = { key, at: Date.now(), value };
  return value;
}

async function scanSessionActivity(since: Date, until: Date): Promise<SessionActivity> {
  const sinceMs = since.getTime();
  const untilMs = until.getTime();
  // 读取顺序 = 与窗口的相关性，预算耗尽时丢掉的才是最不相关的。
  // **不能**简单按 mtime 降序：补历史报告（anchor 指过去某天）时排在最前的会是**今天**
  // 还在写的大文件——它们 mtime 最新，内容却整个落在窗口外，白白吃光预算，
  // 真正属于那天的旧文件反而被跳过（实测昨天的日报因此丢了 3 条）。
  // 故先按「是否在窗口结束前就写完了」分档，档内再按 mtime 降序。
  const files = (await listSessionFiles())
    .filter((f) => f.mtimeMs >= sinceMs)
    .sort((a, b) => {
      const rank = (m: number) => (m <= untilMs ? 0 : 1); // 0 = 窗内收尾，1 = 窗后仍在写
      return rank(a.mtimeMs) - rank(b.mtimeMs) || b.mtimeMs - a.mtimeMs;
    });
  if (files.length === 0) return { cwds: [], prompts: [] };

  const prompts: SessionPrompt[] = [];
  const cwdHits = new Map<string, number>();
  let skippedTooBig = 0;
  let skippedOverBudget = 0;
  let budgetLeft = MAX_TOTAL_READ_BYTES;
  const deadline = Date.now() + MAX_SCAN_MS;

  await forEachLimit(files, READ_CONCURRENCY, async (f) => {
    if (budgetLeft <= 0 || Date.now() > deadline) { skippedOverBudget++; return; }
    let raw: string;
    try {
      const st = await withIoTimeout(stat(f.path));
      if (st.size > MAX_SESSION_FILE_BYTES) { skippedTooBig++; return; }
      // 先扣再读：本文件已计入预算、照读；预算见底后**后续**文件在入口处被跳过。
      // 并发下最多超出 READ_CONCURRENCY 个文件的量（≤ 8×32MB），可以接受。
      budgetLeft -= st.size;
      raw = await withIoTimeout(readFile(f.path, { encoding: 'utf8', signal: AbortSignal.timeout(FILE_IO_TIMEOUT_MS) }));
    } catch {
      return;
    }
    for (const line of raw.split('\n')) {
      // 先做廉价子串判定，避免对海量 assistant/tool 行做 JSON.parse
      if (!line || !line.includes('"type":"user"')) continue;
      let e: RawUserEntry;
      try { e = JSON.parse(line) as RawUserEntry; } catch { continue; }
      if (!isHumanPrompt(e)) continue;
      const at = e.timestamp ? Date.parse(e.timestamp) : NaN;
      if (!Number.isFinite(at) || at < sinceMs || at > untilMs) continue;
      const cwd = typeof e.cwd === 'string' ? e.cwd : '';
      if (!cwd.startsWith('/')) continue;
      // strict：这条通路把一整天的人类原文送出本机（claude -p 合成 → 飞书），
      // 比回显脱敏更该防 AK 类。见 secrets/redactor.ts RedactOptions.strict。
      const text = redactTextStrict(String(e.message?.content ?? '')).trim();
      if (!text || isTrivialPrompt(text)) continue;
      cwdHits.set(cwd, (cwdHits.get(cwd) ?? 0) + 1);
      const p: SessionPrompt = { cwd, text: text.slice(0, MAX_PROMPT_CHARS), at };
      // 分支名也过一遍脱敏：它是自由文本（本地 git 状态，理论上可以是任意字符串），
      // 和 content 一样会进报告正文送出本机。cwd 不脱——「那天在哪些目录干活」正是要报的信息。
      if (typeof e.gitBranch === 'string' && e.gitBranch) {
        const b = redactTextStrict(e.gitBranch).trim();
        if (b) p.branch = b;
      }
      prompts.push(p);
    }
  });

  // 同一句话可能在一个会话里被重发（打断重来 / 复制粘贴），按 cwd+文本去重
  const seen = new Set<string>();
  const deduped = prompts
    .sort((a, b) => a.at - b.at)
    .filter((p) => {
      const k = dedupeKey(p);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  // 超上限时保留**最近**的（长周期报告里近期的活更值得写）
  const kept = deduped.length > MAX_PROMPTS ? deduped.slice(-MAX_PROMPTS) : deduped;
  const cwds = [...cwdHits.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);

  logger.info('report session activity', {
    // 带上窗口 key：一次报告里若出现两条不同 key 的日志，说明两个调用方没同窗、
    // 缓存白设（见 collectWorkData 的 window_ 参数）
    win: `${sinceMs}:${untilMs}`,
    scanned: files.length,
    prompts: kept.length,
    cwds: cwds.length,
    ...(skippedTooBig ? { skippedTooBig } : {}),
    // 超预算（时间/字节）被跳过的文件数：非 0 说明语料已大到该清理，或盘太慢。
    // 排序保证被跳过的是相关性最低的那批，但持续非 0 就该处理了。
    ...(skippedOverBudget ? { skippedOverBudget } : {}),
  });
  return { cwds, prompts: kept };
}
