export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timeout';

/**
 * 当审批属于 SOP gate 时，额外携带任务上下文 — notifier 会渲染专属 stageGateCard。
 */
export interface ApprovalGateContext {
  taskId: string;
  stageName: string;            // 刚结束的 stage 名（如 'architect'）
  gateName: string;             // gate 名（如 'after-architect'）
  presetName?: string;
  stageSummary?: string;
  artifactPath?: string;
  /** artifact 文件 head N 行（已截）；用于卡片预览 */
  artifactPreview?: string;
  /** 任务里全部 stage 序，给卡片画进度条用 */
  allStages?: string[];
  currentStageIdx?: number;
}

export interface ApprovalRequest {
  id: string;
  title: string;
  body: string;
  taskId?: string;
  chatId?: string;
  createdAt: number;
  status: ApprovalStatus;
  resolvedAt?: number;
  resolvedBy?: string;
  cardMessageId?: string;
  gateContext?: ApprovalGateContext;
}
