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
