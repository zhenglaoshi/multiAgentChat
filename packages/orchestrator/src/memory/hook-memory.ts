import { memoryStore } from './store.js';
import { tokenize } from './recall.js';
import { redactText } from '../secrets/redactor.js';
import type { TaskMemory } from './types.js';

/**
 * Stop hook 留底：把一次 assistant 完成的干净回答按 tty upsert 成一条 memory。
 *
 * 为什么需要：报告数据源只在 watcher 活着、并在 2s tick 里盯到 pending 走到 isFinal 时才落盘。
 * 用户「任务做完随手关窗口 / 杀进程」时，watcher 来不及看到结束 → pending 永不 isFinal →
 * memory 从没写盘 → 报告漏掉这条今天真做完的活。Stop hook 是「assistant 响应完成」的可靠信号
 * （每次响应都触发，且早于窗口关闭），在这里直接落底，窗口关不关都留得住。
 *
 * 按 tty upsert（一个 tab 一条、每次响应覆盖成最新）：避免多轮响应把 data/memories 堆爆；
 * 一个 tab 里做完 A 又做 B 时，A 通常已被 watcher 正常落盘，hook 只兜「当前最后一条可能没被盯到」的。
 * source='hook'、prompt 留空（hook 拿不到用户 prompt，内容靠 summary 承载）；与 watcher 落的
 * 同源条目（summary 同为这段 hook 文本）在报告采集期去重（见 report/collect dedupeReportTasks）。
 *
 * 落盘前 redactText 脱敏（memory 长期留存 + recall 回显，明文凭证不能进）。
 */
export async function persistHookMemory(args: { tty: string; cwd?: string; text: string }): Promise<void> {
  const clean = args.text.trim();
  if (!clean) return;
  const safe = redactText(clean);
  const now = Date.now();
  // tty 归一成文件名安全的稳定 key（/dev/ttys014 → devttys014），作 upsert 主键。
  const ttyKey = args.tty.replace(/[^a-zA-Z0-9]/g, '') || 'unknown';
  const mem: TaskMemory = {
    id: `mem-hook-${ttyKey}`,
    chatId: '',
    tty: args.tty,
    cwd: args.cwd ?? '',
    prompt: '',
    summary: safe.slice(0, 600),
    outputPreview: safe.slice(0, 500),
    // 用脱敏后的 safe 分词（原文可能含被 redact 的凭证碎片，不能进 tags/RAG 语料）。
    tags: tokenize(safe).slice(0, 12),
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    source: 'hook',
  };
  await memoryStore.upsert(mem);
}
