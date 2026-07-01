/**
 * Stage memory：每个 SOP stage 完成时持久化一条，用于跨任务召回
 * "这个 stage 上次在类似 cwd / 关键词下产出过什么"。
 */
export interface StageMemory {
  id: string;
  taskId: string;
  /** subagent_type 例如 'architect' / 'coder' */
  stageName: string;
  cwd: string;
  /** 任务的原始 userPrompt（不是 stage 内部 subagent prompt） */
  userPrompt: string;
  /** stage --end 上报的一句话 summary */
  summary: string;
  /** 上报的 artifact 文件路径（如有） */
  artifactPath?: string;
  /** task.presetName，方便按模板维度 recall */
  presetName?: string;
  startedAt: number;
  endedAt: number;
}
