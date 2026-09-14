import type { AgentAdapter, AgentKind } from './types.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';

/** 已知 agent adapter。顺序 = 识别优先级（claude 先）。 */
const ADAPTERS: AgentAdapter[] = [claudeAdapter, codexAdapter];

export function listAgentAdapters(): AgentAdapter[] {
  return ADAPTERS;
}

export function getAgentAdapter(kind: AgentKind): AgentAdapter | undefined {
  return ADAPTERS.find((a) => a.kind === kind);
}

/**
 * 从进程名列表（原始，未小写）识别 tab 在跑哪个 agent。返回第一个匹配的 adapter，无则 null。
 * 替代 status.ts 里散落的 `hasClaude` 判断。
 */
export function detectAgentFromProcs(procs: string[]): AgentAdapter | null {
  const lower = procs.map((p) => p.toLowerCase());
  for (const a of ADAPTERS) {
    if (lower.some((p) => a.detect(p))) return a;
  }
  return null;
}

/**
 * 发完文本后要不要再补一个单独的回车。
 *
 * 判据是「这个 tab 里跑着 agent TUI 吗」，与具体是哪个 agent 无关：`do script X` 往 pty 写的是
 * `X + "\r"` 整块，任何 TUI 都把整块当**粘贴**处理（块内 `\r` 只算换行）→ 文本进去了但不提交，
 * 必须再单独送一个 `\r`。裸 shell 不需要（`do script` 自带的 `\r` 就是执行）。
 * 见 CLAUDE.md「claude TUI / alt-screen 模式」。
 */
export function shouldSubmitPromptAfterSend(procs: string[]): boolean {
  return detectAgentFromProcs(procs) !== null;
}

/**
 * 新开 tab 时默认起哪个 agent（公函开工 / TAPD 认领 / perf 认领 / `/new` 都走它）。
 * `MCHAT_DEFAULT_AGENT=codex` 可切；值非法或未设 → claude（保持历史行为）。
 */
export function resolveDefaultAgentKind(env: NodeJS.ProcessEnv = process.env): AgentKind {
  const raw = (env['MCHAT_DEFAULT_AGENT'] ?? '').trim().toLowerCase();
  const hit = ADAPTERS.find((a) => a.kind === raw);
  return hit ? hit.kind : 'claude';
}
