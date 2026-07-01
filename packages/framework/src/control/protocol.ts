import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ApprovalRequest, ApprovalStatus } from 'multiagent-orchestrator';
import type { ChatState } from 'multiagent-im-lark';
import type { LoopRule } from 'multiagent-orchestrator';
import type { TaskState, TaskStatus } from 'multiagent-orchestrator';
import type { SendResult, TerminalTab } from 'multiagent-host-mac';

export const SOCKET_PATH =
  process.env['AGENT_SOCKET'] ?? join(homedir(), '.multiagent-chat', 'agent.sock');

// ---- Tab ops ----

export interface TabListRequest {
  op: 'tab.list';
}

export interface TabGetRequest {
  op: 'tab.get';
  tty: string;
}

export interface TabHistoryRequest {
  op: 'tab.history';
  tty: string;
  lines?: number;            // tail N
}

export interface TabSendRequest {
  op: 'tab.send';
  tty: string;
  text: string;
  waitForOutput?: boolean;   // 阻塞等 diff
  timeoutMs?: number;
}

export interface TabNewRequest {
  op: 'tab.new';
  cwd?: string;
  mode?: 'new-tab' | 'new-window';
}

export interface TabCloseRequest {
  op: 'tab.close';
  tty: string;
}

export interface TabRecentCwdsRequest {
  op: 'tab.recent-cwds';
}

// ---- Chat ops ----

export interface ChatGetRequest {
  op: 'chat.get';
  chatId: string;
}

export interface ChatSetActiveRequest {
  op: 'chat.set-active';
  chatId: string;
  tty: string;
}

// ---- Approval ops (复用之前的) ----

// ---- Lark outbound ops (供 shell 内的 agent 调用) ----

export interface LarkSendTextOp {
  op: 'lark.send-text';
  chatId: string;
  text: string;
}

export interface LarkSendCardOp {
  op: 'lark.send-card';
  chatId: string;
  card: unknown;
}

export interface LarkSendFileOp {
  op: 'lark.send-file';
  chatId: string;
  path: string;
  name?: string;
}

export interface LarkSendImageOp {
  op: 'lark.send-image';
  chatId: string;
  path: string;
}

export interface LarkResolveChatOp {
  op: 'lark.resolve-chat';
  tty?: string;
}

export interface LarkSendData {
  details: Record<string, unknown>;
}

export interface LarkResolveChatData {
  chatId: string | null;
  source: 'pending' | 'most-recent-chat' | 'none';
}

// ---- Approval ops ----

export interface ApprovalRequestOp {
  op: 'approval.request';
  title: string;
  body: string;
  taskId?: string;
  chatId?: string;
  timeoutMs?: number;
}

export interface ApprovalListOp {
  op: 'approval.list';
  limit?: number;
}

export interface ApprovalResolveOp {
  op: 'approval.resolve';
  id: string;
  decision: Exclude<ApprovalStatus, 'pending'>;
  resolvedBy?: string;
}

// ---- Task ops (SOP) ----

export interface TaskCreateOp {
  op: 'task.create';
  tty: string;
  cwd: string;
  chatId: string;
  stages: string[];
  gates: string[];
  loops?: LoopRule[];
  artifactDir: string;
  userPrompt: string;
  presetName?: string;
  taskId?: string;
}

export interface TaskGetOp {
  op: 'task.get';
  taskId: string;
}

export interface TaskListOp {
  op: 'task.list';
  status?: TaskStatus;
  tty?: string;
  chatId?: string;
  limit?: number;
}

export interface TaskStageOp {
  op: 'task.stage';
  taskId: string;
  name: string;
  action: 'start' | 'end' | 'fail' | 'skip';
  summary?: string;
  artifactPath?: string;
  note?: string;
  reason?: string;       // for action='skip'
  /** 用于 action='end' 后触发 gate 时的等待超时；默认 30 分钟 */
  gateTimeoutMs?: number;
}

export interface TaskAbortOp {
  op: 'task.abort';
  taskId: string;
  reason?: string;
  /** hard 中止：主 claude 应立刻停手不写收尾；默认 soft（保留已完成 stage 产出，可写收尾） */
  hard?: boolean;
}

export interface StageRecallOp {
  op: 'stage.recall';
  stage?: string;
  cwd?: string;
  keywords?: string[];
  limit?: number;
  minScore?: number;
}

// ---- Subagent registry ops ----

export interface SubagentListOp {
  op: 'subagent.list';
  projectRoot?: string;
}

export interface SubagentShowOp {
  op: 'subagent.show';
  name: string;
  projectRoot?: string;
}

export interface SubagentAddOp {
  op: 'subagent.add';
  name: string;
  description?: string;
  tools?: string[];
  model?: string;
  color?: string;
  body: string;
  location?: 'user' | 'project';
  projectRoot?: string;
  /** 已存在同名 subagent 时是否覆盖；默认 false，返回 error */
  overwrite?: boolean;
}

export interface SubagentDeleteOp {
  op: 'subagent.delete';
  name: string;
  projectRoot?: string;
}

/**
 * 主 claude 生成完 subagent JSON 后调这个 op 落盘。
 * framework 会：解析 → 校验 → writeSubagent 每个（skip 冲突）→ savePreset（如有 template）→ agent lark send-text 回 chat。
 */

export interface SubagentGenSubmitOp {
  op: 'subagent.gen-submit';
  sessionId: string;
  chatId: string;
  /** 由主 claude 产出的 JSON 字符串，schema：
   *   { subagents: [{name, description?, tools?, model?, color?, body}], template?: {name, prompt, stages?, gates?} }
   */
  json: string;
  location?: 'user' | 'project';
  projectRoot?: string;
}

export type Request =
  | TabListRequest
  | TabGetRequest
  | TabHistoryRequest
  | TabSendRequest
  | TabNewRequest
  | TabCloseRequest
  | TabRecentCwdsRequest
  | ChatGetRequest
  | ChatSetActiveRequest
  | LarkSendTextOp
  | LarkSendCardOp
  | LarkSendFileOp
  | LarkSendImageOp
  | LarkResolveChatOp
  | ApprovalRequestOp
  | ApprovalListOp
  | ApprovalResolveOp
  | TaskCreateOp
  | TaskGetOp
  | TaskListOp
  | TaskStageOp
  | TaskAbortOp
  | StageRecallOp
  | SubagentListOp
  | SubagentShowOp
  | SubagentAddOp
  | SubagentDeleteOp
  | SubagentGenSubmitOp

export type Response<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ---- Response data shapes ----

export interface TabListData {
  tabs: TerminalTab[];
}

export interface TabGetData {
  tab: TerminalTab | null;
}

export interface TabHistoryData {
  tty: string;
  text: string;             // tail
  totalLines: number;
}

export interface TabSendData {
  tty: string;
  result: SendResult;
}

export interface TabNewData {
  tty: string;
}

export interface TabCloseData {
  closed: boolean;
}

export interface TabRecentCwdsData {
  cwds: string[];
}

export interface ChatGetData {
  chat: ChatState;
  activeTab: TerminalTab | null;
}

export interface ChatSetActiveData {
  chat: ChatState;
  tab: TerminalTab | null;
}

export interface ApprovalRequestData {
  request: ApprovalRequest;
}

export interface ApprovalListData {
  active: ApprovalRequest[];
  recent: ApprovalRequest[];
}

export interface ApprovalResolveData {
  request: ApprovalRequest | null;
}

// ---- Task response data ----

export interface TaskCreateData {
  task: TaskState;
}

export interface TaskGetData {
  task: TaskState | null;
}

export interface TaskListData {
  tasks: TaskState[];
}

export interface StageRecallData {
  results: Array<{
    score: number;
    id: string;
    taskId: string;
    stageName: string;
    cwd: string;
    userPrompt: string;
    summary: string;
    artifactPath?: string;
    presetName?: string;
    startedAt: number;
    endedAt: number;
  }>;
}

export interface TaskStageData {
  task: TaskState;
  /** 若 action='end' 触发了 gate，这里带回审批结果（approved=false 时附 reason） */
  gateResolved?: { gateName: string; approved: boolean; reason?: string };
  /** 若 action='fail' 命中失败回环规则，server 已 reset stages 等待主 claude 重跑 */
  loopback?: {
    failedStage: string;
    retryFrom: string;
    retryCount: number;
    maxRetries: number;
  };
}

export interface TaskAbortData {
  task: TaskState | null;
}

// ---- Subagent response shapes ----

export interface SubagentSummary {
  name: string;
  description?: string;
  tools?: string[];
  model?: string;
  color?: string;
  location: 'user' | 'project';
  filePath: string;
}

export interface SubagentListData {
  subagents: SubagentSummary[];
}

export interface SubagentShowData {
  subagent: (SubagentSummary & { body: string }) | null;
}

export interface SubagentAddData {
  subagent: SubagentSummary;
}

export interface SubagentDeleteData {
  deleted: boolean;
}

export interface SubagentGenSubmitData {
  sessionId: string;
  added: SubagentSummary[];      // 成功落盘的
  skipped: Array<{ name: string; reason: string }>;  // 因冲突或校验失败被跳
  templateSaved?: { name: string; stages?: string[]; gates?: string[] };
}

