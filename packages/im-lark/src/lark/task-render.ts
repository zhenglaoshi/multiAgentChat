import {
  stageProgressCard,
  type StageProgressCardData,
  type StageProgressRow,
} from './cards.js';
import type { TaskState } from 'multiagent-orchestrator';

/**
 * 把 TaskState 渲染成 stageProgressCard 的飞书卡片 JSON。
 * 公共工具，handlers（初始卡）和 notifier（事件 patch）共用，避免逻辑两份。
 */
export function buildStageProgressCardFromTask(task: TaskState, home: string): unknown {
  const stageRows: StageProgressRow[] = task.stageHistory.map((s) => {
    const row: StageProgressRow = { name: s.name, status: s.status };
    if (s.startedAt !== undefined) row.startedAt = s.startedAt;
    if (s.endedAt !== undefined) row.endedAt = s.endedAt;
    if (s.summary !== undefined) row.summary = s.summary;
    if (s.artifactPath !== undefined) row.artifactPath = s.artifactPath;
    if (s.note !== undefined) row.note = s.note;
    return row;
  });
  const data: StageProgressCardData = {
    taskId: task.taskId,
    tty: task.tty,
    cwd: task.cwd,
    artifactDir: task.artifactDir,
    status: task.status,
    currentStageIdx: task.currentStageIdx,
    stages: stageRows,
    startedAt: task.startedAt,
    home,
  };
  if (task.presetName) data.presetName = task.presetName;
  if (task.awaitingGate) data.awaitingGate = task.awaitingGate;
  if (task.failReason) data.failReason = task.failReason;
  if (task.endedAt !== undefined) data.endedAt = task.endedAt;
  return stageProgressCard(data);
}
