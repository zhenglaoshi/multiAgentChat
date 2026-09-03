import type { HandoffStatus, HandoffTask } from 'multiagent-orchestrator';

/**
 * 桥接：im-lark 的卡片按钮点击需要「发状态信封 + 更新 store」，但 relay 客户端在 framework
 * （DAG 上 im-lark 够不到 framework）。故由 daemon 启动时把实现注入进来。
 */
export type HandoffStatusSender = (
  taskId: string,
  status: HandoffStatus,
  note?: string,
) => Promise<{ ok: boolean; task?: HandoffTask; error?: string }>;

let sender: HandoffStatusSender | null = null;

export function setHandoffStatusSender(fn: HandoffStatusSender): void {
  sender = fn;
}

export function getHandoffStatusSender(): HandoffStatusSender | null {
  return sender;
}
