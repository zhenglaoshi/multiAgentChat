/**
 * 跨任务记忆 — 每完成一个任务存一条。
 * 系统在用户发新任务时按 cwd + keywords 搜索，注入到 prompt 头部作 context。
 */

export interface TaskMemory {
  id: string;
  chatId: string;
  tty: string;
  cwd: string;
  prompt: string;             // 原始 prompt（飞书发的）
  summary?: string;           // 输出摘要（启发式提取，可能为空）
  outputPreview: string;      // 输出 tail 500 字（启发式截取）
  filesProduced?: string[];   // 输出涉及的文件路径
  tags: string[];             // 从 prompt 提取的关键词
  startedAt: number;
  endedAt: number;
  durationMs: number;
  source: 'feishu' | 'local' | 'wecom';
}
