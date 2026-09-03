/**
 * Stop hook 干净回答文本的 per-tty 短期缓存。
 *
 * 背景：本地 claude 任务跑在 alt-screen TUI 里，watcher 读不到 assistant 的真实回复，
 * persistTaskMemory 只能从 scrollback 尾巴截一段 —— 结果 memory.summary 常是
 * 「6. Chat about this / Enter to select」这类 TUI 菜单噪音，日/周报根本总结不出内容。
 *
 * 但 Claude Code 的 Stop hook（bin/mchat-stop-hook）拿得到干净的 last_assistant_message，
 * 它经 `agent lark send-text --auto` 打到 daemon。本模块把这段文本按 tty 缓存起来，
 * 供 persistTaskMemory 落 memory 时优先取用（替代噪音尾巴）。
 *
 * 为什么放 orchestrator（叶子）：写入方在 framework/control/server（handleLarkSendText），
 * 读取方在 im-lark（persistTaskMemory）——两包都依赖 orchestrator，放这里避免跨层耦合。
 * 进程内存态即可：hook→persist 间隔仅数秒；重启丢失只影响那一次 summary 质量，无副作用。
 */

interface HookEntry {
  text: string;
  at: number;
}

const DEFAULT_TTL_MS = 15 * 60_000;
const MAX_ENTRIES = 200;
const cache = new Map<string, HookEntry>();

function normTty(tty: string): string {
  return tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
}

/** Stop hook 推送时记录该 tab 最新一条 assistant 回答（覆盖旧的）。 */
export function recordHookSummary(tty: string, text: string): void {
  const t = text.trim();
  if (!tty || !t) return;
  // 容量闸门：超上限先淘汰最旧一条，防长时间运行内存无界增长
  if (cache.size >= MAX_ENTRIES && !cache.has(normTty(tty))) {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [k, v] of cache) {
      if (v.at < oldestAt) {
        oldestAt = v.at;
        oldestKey = k;
      }
    }
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(normTty(tty), { text: t, at: Date.now() });
}

/**
 * 取该 tty 的 hook 回答文本。默认按 TTL 判活。
 *
 * 关键：hook 缓存只按 tty 存，同一 tty 上跑完任务 A 再跑任务 B，若不加约束，B 落 memory 时
 * 会把 A 的回答误当成自己的产出（张冠李戴）。两道闸门防串台：
 *  - `since`：只接受在此时刻**之后**产生的 hook（传 pending.sentAt，即任务开始时间）——
 *    早于任务开始的回答一定是上一个任务的残留，拒绝。
 *  - `consume`：读到即从缓存删除，杜绝被同 tty 后续任务二次取用。
 */
export function getHookSummary(
  tty: string,
  opts: { since?: number; maxAgeMs?: number; consume?: boolean } = {},
): string | undefined {
  if (!tty) return undefined;
  const key = normTty(tty);
  const e = cache.get(key);
  if (!e) return undefined;
  const maxAge = opts.maxAgeMs ?? DEFAULT_TTL_MS;
  if (Date.now() - e.at > maxAge) {
    cache.delete(key);
    return undefined;
  }
  // 时间窗：hook 必须在任务开始(since)之后产生，否则是同 tty 上一个任务的残留回答
  if (opts.since !== undefined && e.at < opts.since) return undefined;
  if (opts.consume) cache.delete(key);
  return e.text;
}
