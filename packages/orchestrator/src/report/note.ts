import { memoryStore } from '../memory/store.js';
import { tokenize } from '../memory/recall.js';
import { redactText } from '../secrets/redactor.js';
import type { TaskMemory } from '../memory/types.js';

/**
 * 手动补记一条工作台账（source='note'）。
 *
 * 用途：非编码 / 未提交 / 线下类工作（开账号、配置对接、评审沟通…）既进不了 git，
 * 也不会被 watcher 采成 memory —— 日报因此漏掉。这条 CLI/命令让用户一句话补记，
 * note 条目是第一等公民：prompt 为真实描述，报告采集期的 TUI 噪音过滤永不剔除它。
 *
 * 落盘前过脱敏（memory 长期留存 + recall 会回显，明文凭证不能进）。
 */
export async function appendWorkNote(text: string, cwd?: string): Promise<string> {
  const clean = text.trim();
  if (!clean) throw new Error('note 文本为空');
  const now = Date.now();
  const safe = redactText(clean);
  const mem: TaskMemory = {
    id: `mem-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    chatId: '',
    tty: '',
    cwd: cwd ?? '',
    prompt: safe,
    summary: safe.slice(0, 800),
    outputPreview: safe.slice(0, 500),
    // 用脱敏后的 safe 分词：tokenize 会把凭证值切成字母数字 token，若用原文会把
    // 被 redact 掉的密钥碎片原样塞进 tags 落盘（且进 RAG 语料），绕过脱敏。
    tags: tokenize(safe).slice(0, 12),
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    source: 'note',
  };
  await memoryStore.append(mem);
  return mem.id;
}
