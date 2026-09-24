/**
 * tmux 宿主的 tab 状态推断 —— 只做适配，分类逻辑与 macOS 宿主共用
 * （`orchestrator/agents/tab-status.ts`），保证同一个 tab 在两个宿主上显示一致。
 */

import type { TabStatusInfo, TerminalTab } from 'multiagent-host-api';
import { inferTabStatusFrom } from 'multiagent-orchestrator';

export function inferTabStatus(tab: TerminalTab, historyTail?: string): TabStatusInfo {
  return inferTabStatusFrom({ processes: tab.processes, busy: tab.busy, title: tab.title }, historyTail);
}
