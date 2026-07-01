export type TaskStatus = 'running' | 'awaiting-gate' | 'done' | 'failed';

export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface StageRecord {
  /** subagent_type，例如 'Explore' / 'requirement-analyzer' / 'architect' / ... */
  name: string;
  status: StageStatus;
  startedAt?: number;
  endedAt?: number;
  /** stage 产出的文件路径（主 claude 上报） */
  artifactPath?: string;
  /** 主 claude 上报的 stage 摘要（最多 500 字符） */
  summary?: string;
  /** 失败原因或备注 */
  note?: string;
}

export interface TaskLoopRule {
  on: string;
  retryFrom: string;
  maxRetries: number;
}

export interface TaskState {
  taskId: string;
  /** 任务所在 Terminal tab 的 tty，例如 /dev/ttys003 */
  tty: string;
  /** 任务工作目录 — 通常是 task tab 的 cwd */
  cwd: string;
  /** 飞书 chat id（结果回传渠道） */
  chatId: string;
  /** 触发的 preset 名（如果有） */
  presetName?: string;
  /** SOP stage 有序列表（subagent_type） */
  stages: string[];
  /** gate 名列表，例如 ['after-architect'] */
  gates: string[];
  /** 失败回环规则（已 resolve，maxRetries 默认填好） */
  loops: TaskLoopRule[];
  /** 每个 stage 已经触发回环重试的次数 */
  stageRetries: Record<string, number>;
  /** artifact 目录，相对 task cwd 或绝对路径 */
  artifactDir: string;
  /** 当前正在跑的 stage index；-1 = 未开始；stages.length = 全部完成 */
  currentStageIdx: number;
  /** stage 历史，index 对齐 stages */
  stageHistory: StageRecord[];
  status: TaskStatus;
  startedAt: number;
  endedAt?: number;
  /** 原始用户 prompt（不含 SOP 包装） */
  userPrompt: string;
  /** 当前等待的 gate 名（status === 'awaiting-gate' 时填） */
  awaitingGate?: string;
  /** 失败原因 */
  failReason?: string;
  /** 实时进度卡的飞书 message_id，notifier 拿这个 patch */
  progressMessageId?: string;
}
