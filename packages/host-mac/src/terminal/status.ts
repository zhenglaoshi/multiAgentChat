/**
 * macOS 宿主的 tab 状态推断 —— **只做适配，分类逻辑在 orchestrator**。
 *
 * 判据（进程名 + busy + 屏幕尾巴）宿主无关，已提到 `orchestrator/agents/tab-status.ts`，
 * 好让 host-tmux 等第二个宿主共用同一份，不再各抄一份分类规则。
 */

import type { TerminalTab } from './types.js';
import { inferTabStatusFrom } from 'multiagent-orchestrator';

// 类型定义在 multiagent-host-api（它再从 orchestrator 导出），这里 re-export 保持老调用点可用。
export type { TabStatusInfo, TabStatusKind } from 'multiagent-host-api';
import type { TabStatusInfo } from 'multiagent-host-api';

export function inferTabStatus(
  tab: TerminalTab,
  historyTail?: string,
): TabStatusInfo {
  return inferTabStatusFrom({ processes: tab.processes, busy: tab.busy }, historyTail);
}
