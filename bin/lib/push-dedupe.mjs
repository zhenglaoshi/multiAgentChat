/*
 * multiAgentChat — 回传去重（跨进程）
 *
 * 要解决的问题：codex 侧有**两条**把「turn 最后一条 assistant 消息」送回飞书的通道 ——
 *   1. `~/.codex/config.toml` 的 legacy `notify`（bin/mchat-codex-notify）
 *   2. codex 0.154+ 的 `Stop` hook（bin/mchat-stop-hook，与 claude 同一个脚本）
 * 两条都保留是有意的：hook 首次要用户批准信任，没批准前只有 notify 能用；
 * 批准之后两条都会触发 → 同一段文本推两次。
 *
 * ── 判据为什么是「哪条通道推的」，而不是纯内容 ──────────────────────────────
 * 纯内容去重（哪怕加上 ppid）有个躲不掉的漏判：`ppid` 是**会话级**的，同一个 agent 进程
 * 整个生命周期不变。于是同一个 tab 里两次**不同的 turn** 只要吐出逐字相同的文本
 * （"测试全绿，已推送" 这类模板化收尾在本项目里并不罕见），第二条就会被当成
 * 「同一 turn 的另一条通道」**静默丢弃** —— 而「所有 substantive 回复都要推飞书」是硬约定，
 * 静默吞消息比重复推严重得多。
 *
 * 所以标记里记下**是哪条通道推的**：
 *   - 已有标记且来自**另一条**通道 → 同一个 turn 的重复投递 → 跳过
 *   - 已有标记且来自**同一条**通道 → 见下面的时间分界
 *
 * ── 同通道重复：靠时间分界，而不是假设「一条通道一个 turn 只触发一次」 ──────────
 * ⚠ 这条不变式**不是本模块能保证的**，它依赖两处别的代码持续有效：
 *   - `orchestrator/agents/hook-install.ts` 的 `applyClaudeHooks`：装之前先 strip 掉所有
 *     指向 `mchat-*` 的旧条目再追加，claude 侧从结构上防止同一个脚本被注册两遍；
 *   - 同文件的 `upsertCodexHooksBlock`：哨兵残缺时 fail loud，防止 codex 侧挂两份托管区块。
 * 这两道防线若被绕过（用户手工在 settings.json 里加了第二条指向同一脚本的 Stop hook 等），
 * 同通道就会对一个 turn 触发两次。所以这里再加一道**与那两处无关**的保险：
 *   同一通道在 `MIN_GAP_MS`（默认 2s）内对同一 key 再次出现 → 判为误触发，跳过。
 *   一轮真实的 agent 工作（模型延迟 + 工具调用）远超 2s，不会误伤「新的一轮恰好文本相同」。
 * 推论：claude 只有 Stop 一条通道，超过 2s 的重复一律放行 —— 不会因为两轮文本相同被吞。
 *
 * 失败一律 fail-open（放行照推）—— 去重坏掉的代价是重复一条消息，
 * fail-closed 的代价是**结果彻底丢失**，后者严重得多。
 *
 * ⚠ 边界：只负责**跨通道/误触发去重**，不防御同机恶意进程主动"种"标记
 * （提前写一个 owner=另一通道名的标记，能让那一条消息在 TTL 窗口内被跳过）。
 * 要做到这点，攻击者得先能预测回复原文 + ppid，即已具备同用户任意代码执行 ——
 * 那个前提下他直接改 hook 脚本本身更省事。本项目是单用户本地工具，按此信任模型接受。
 */
import {
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 标记目录。`MCHAT_PUSH_DEDUPE_DIR` 可覆盖 —— 测试用，避免往开发者真实 home 里写东西。 */
function markDir() {
  return process.env['MCHAT_PUSH_DEDUPE_DIR'] || join(homedir(), '.multiagent-chat', 'push-dedupe');
}

/** 同一个 turn 的两条通道基本同时触发；45s 足够宽，又不至于跨到下一轮对话。 */
const DEFAULT_TTL_MS = 45000;
/** 同通道重复的误触发窗口（见文件头）。一轮真实 agent 工作远超这个量级。 */
const DEFAULT_MIN_GAP_MS = 2000;
/** 标记文件超过这个年龄就清掉，避免目录无限增长。 */
const SWEEP_AGE_MS = 10 * 60 * 1000;

function envMs(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
const ttlMs = () => envMs('MCHAT_PUSH_DEDUPE_TTL_MS', DEFAULT_TTL_MS);
const minGapMs = () => envMs('MCHAT_PUSH_DEDUPE_MIN_GAP_MS', DEFAULT_MIN_GAP_MS);

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

/**
 * 顺手清掉老标记（廉价：目录里本来就只有几条）。任何失败都忽略。
 * 一律用 `lstat` 而非 `stat`：`stat` 会跟随符号链接，于是一个被塞进来的
 * `<hash>.mark -> ~/某个真文件` 会让 unlink 打到链接目标上。
 * 非普通文件直接删掉链接本身（`unlink` 不跟随），不去碰目标。
 */
function sweep(now) {
  try {
    const dir = markDir();
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        const st = lstatSync(p);
        if (!st.isFile() || now - st.mtimeMs > SWEEP_AGE_MS) unlinkSync(p);
      } catch { /* 并发删/竞态 → 忽略 */ }
    }
  } catch { /* 目录不存在等 → 忽略 */ }
}

/**
 * 原子地「创建一个内容已经写全的标记」。
 *
 * 不用 `open(path,'wx')` + `write`：那两步之间有个窗口，另一个进程此刻打到 EEXIST
 * 会读到**空内容**、判不出所有者。而这份设计的典型场景恰恰就是「两条通道几乎同时触发」，
 * 这个窗口与主场景高度重叠，不是纯理论 edge case。
 * 改成「先把完整内容写进临时文件，再 `link` 到目标名」：`link` 对已存在的目标返回 EEXIST，
 * 且目标一旦出现，内容从第一刻起就是完整的。
 *
 * @returns {'created'|'exists'|'error'}
 */
function createMarkAtomic(dir, path, channel) {
  const tmp = join(dir, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, channel); } finally { closeSync(fd); }
  } catch {
    return 'error';
  }
  try {
    linkSync(tmp, path);
    return 'created';
  } catch (e) {
    return e && e.code === 'EEXIST' ? 'exists' : 'error';
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/** 覆写标记内容（同时刷新 mtime）。失败忽略 —— 下一次会当作过期，方向安全。 */
function writeMark(path, channel) {
  try { writeFileSync(path, channel); } catch { /* ignore */ }
}

/**
 * 这段文本现在该不该推？
 *
 * @param {string} text 要推送的正文
 * @param {string} channel 哪条通道在推（如 'stop-hook' / 'codex-notify'）。
 *        判据靠它区分「另一条通道的重复投递」与「同一通道的新一轮」，见文件头注释。
 * @param {string} [session] 会话维度（调用方传 ppid），避免不同 tab 的相同文本互相干扰
 * @returns {boolean} true = 放行（并已登记）；false = 判定为同一个 turn 的重复投递，跳过
 */
export function shouldPush(text, channel = 'default', session = '') {
  const ttl = ttlMs();
  if (ttl === 0) return true; // 显式关掉去重
  try {
    const dir = markDir();
    // 显式 0o700 而不是听凭 umask —— 用户把 umask 设成 002 之类时，默认会落成组可写目录。
    // （对已存在的目录 mode 是 no-op，这里只保证首次创建时收紧。）
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // 两段各自 hash 再拼，避免 `${session} ${text}` 那种拼法的分隔歧义
    // （session="1 2"/text="abc" 与 session="1"/text="2 abc" 会算出同一个 key）。
    const path = join(dir, `${sha1(`${sha1(session)}:${sha1(text)}`)}.mark`);
    const now = Date.now();
    sweep(now);

    const outcome = createMarkAtomic(dir, path, channel);
    if (outcome === 'created') return true;
    if (outcome === 'error') return true; // 建不出标记 → fail-open

    let st;
    try {
      st = lstatSync(path);
      // 不是普通文件（被换成了符号链接 / 目录）→ 不认这条标记，也不去写它的目标
      if (!st.isFile()) return true;
    } catch {
      return true; // 刚被 sweep 掉 → 当作首次
    }
    // 夹到 >= 0：`now` 是**建标记之前**取的，而 mtime 是之后写的，两者可能反序
    // （同一次调用内就会发生，跟系统时钟回拨无关）→ ageMs 变负数。
    // 不夹的话 `ageMs < minGapMs()` 恒真，会把一条正常消息误判成误触发**丢掉** ——
    // 正是这套机制最不该出现的方向。
    const ageMs = Math.max(0, now - st.mtimeMs);
    if (ageMs > ttl) {
      // 过期：同一段文本隔了很久又出现 → 照推，并把标记归到本通道名下
      writeMark(path, channel);
      return true;
    }
    let owner;
    try { owner = readFileSync(path, 'utf8').trim(); } catch { return true; }
    if (owner && owner !== channel) {
      return false; // 另一条通道刚推过同一个 turn → 跳过
    }
    if (owner === channel && ageMs < minGapMs()) {
      // 同一条通道在极短时间内又来一遍：一轮真实 agent 工作不可能这么快，
      // 判为同一个 turn 被触发了两次（hook 被重复注册之类）→ 跳过。
      return false;
    }
    // owner 为空（老版本标记 / 外部篡改）→ 判不出归属，fail-open 放行。
    // owner 相同且已过误触发窗口 → 是**新的一轮**恰好文本相同，必须放行。
    writeMark(path, channel);
    return true;
  } catch {
    return true; // fail-open
  }
}
