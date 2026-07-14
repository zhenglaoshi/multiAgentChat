import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ApprovalRequest, ApprovalStatus, AskRequest, AskType, KnowledgeEntry } from 'multiagent-orchestrator';
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

export interface TabRestartClaudeRequest {
  op: 'tab.restart-claude';
  /** 要排除的 tty 列表（如发起命令的那个 tab）。 */
  except?: string[];
  /** true → 重启后 `claude --continue`；false → 全新 `claude`。默认 true。 */
  continueSession?: boolean;
  /** true → 只返回将要重启的目标，不实际执行。 */
  dryRun?: boolean;
}

export interface TabRecentCwdsRequest {
  op: 'tab.recent-cwds';
}

export interface TabScreenRequest {
  op: 'tab.screen';
  tty: string;
  /** 可选：截完自动推到该 chat 的飞书 */
  pushToChatId?: string;
}

export interface TabKeysRequest {
  op: 'tab.keys';
  tty: string;
  /** 按键序列，如 "2d . ctrl+c ⏎" */
  sequence: string;
  intervalMs?: number;
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
  /** true → 强制走 msg_type:text 纯文本；默认 auto-detect markdown */
  plain?: boolean;
  /**
   * true → 「自动推送」标记（如 Claude Code Stop hook 触发的）。
   * daemon 会 gate：若 chat.watchAllTabs !== true，静默丢弃并在 response 里回 gated=true。
   * 手工 `agent lark send-text` 不带此 flag，任何时候都会正常发送。
   */
  auto?: boolean;
  /**
   * 触发本次推送的 Claude Code 进程 PID（一般是 hook 里的 process.ppid）。
   * daemon 用 `ps -o tty=` 反查该 PID 的 ctty → 对应到 shell tab。
   */
  originPid?: number;
  /** 触发本次推送时 Claude Code 的 cwd；若 ppid 反查失败，daemon 用 cwd 匹配 claude tab */
  originCwd?: string;
  /**
   * true → 本次推送包含"需要用户回答的问题"（PreToolUse AskUserQuestion 会置 true）。
   * daemon 会记 chat.pendingAnswerTty = 反查到的 origin tty，下次飞书无 @target 回复
   * one-shot 路由到该 tab 而非 chat.activeTty。TTL 10 min。
   */
  question?: boolean;
  /**
   * AskUserQuestion 的选项 label 列表（PreToolUse hook 拆 tool_input.questions[0].options 传入）。
   * daemon 在 originShellPushCard 里把每个 label 变成一个 send-to-tab 按钮，一 tap 直答。
   * 只在单问题、options 数 ≤ 4 时给；多问题场景 hook 不传，落回纯 body 显示。
   */
  quickAnswerOptions?: string[];
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

// ---- WeCom ops（企微对齐飞书能力） ----

export interface WeComSendTextOp {
  op: 'wecom.send-text';
  chatId?: string;    // 空 → 走 WECOM_DEFAULT_TO_USER
  text: string;
}

export interface WeComSendFileOp {
  op: 'wecom.send-file';
  chatId?: string;
  path: string;
  name?: string;
}

export interface WeComSendImageOp {
  op: 'wecom.send-image';
  chatId?: string;
  path: string;
}

export interface WeComResolveChatOp {
  op: 'wecom.resolve-chat';
  tty?: string;
}

export interface WeComAskOp {
  op: 'wecom.ask';
  chatId?: string;
  type: AskType;
  title: string;
  options?: string[];
  timeoutMs?: number;
}

export interface WeComSendData {
  messageId: string;
  details?: Record<string, unknown>;
}

export interface WeComResolveChatData {
  chatId: string | null;
  source: 'default-user' | 'none';
}

export interface WeComAskData {
  request: AskRequest;
}

// ---- Knowledge extraction ops ----

export interface KnowledgeStatsOp {
  op: 'knowledge.stats';
}

export interface KnowledgeListOp {
  op: 'knowledge.list';
  limit?: number;
  cwd?: string;
  tag?: string;
  kind?: string;
}

export interface KnowledgeExtractLastOp {
  op: 'knowledge.extract-last';
  tty: string;
  lines?: number;
}

export interface KnowledgeStatsData {
  total: number;
  byKind: Record<string, number>;
  latestAt: number | null;
  queueSize: number;
  enabled: boolean;
}

export interface KnowledgeListData {
  entries: KnowledgeEntry[];
}

export interface KnowledgeExtractLastData {
  queued: boolean;
  reason?: string;
  chunkLen: number;
}

// ---- Ask op（弹飞书交互卡片，阻塞式拿答案） ----

export interface LarkAskOp {
  op: 'lark.ask';
  chatId?: string;               // 空 → daemon 自动反查
  type: AskType;                 // 'single' | 'multi' | 'input'
  title: string;
  options?: string[];            // single/multi 用
  timeoutMs?: number;            // 默认 5min
}

export interface LarkAskData {
  request: AskRequest;
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
  /** 是否覆盖已有同名 subagent（tweak 场景=true，gen 场景=false） */
  overwrite?: boolean;
}

export type Request =
  | TabListRequest
  | TabGetRequest
  | TabHistoryRequest
  | TabSendRequest
  | TabNewRequest
  | TabCloseRequest
  | TabRestartClaudeRequest
  | TabRecentCwdsRequest
  | TabScreenRequest
  | TabKeysRequest
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
  | LarkAskOp
  | WeComSendTextOp
  | WeComSendFileOp
  | WeComSendImageOp
  | WeComResolveChatOp
  | WeComAskOp
  | KnowledgeStatsOp
  | KnowledgeListOp
  | KnowledgeExtractLastOp
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

export interface TabRestartClaudeData {
  dryRun: boolean;
  /** dryRun 时是"将要重启"的目标；非 dryRun 时是执行结果（ok 字段区分成功/失败）。 */
  targets: Array<{
    tty: string;
    cwd?: string;
    ok?: boolean;        // 非 dryRun 才有
    reason?: string;     // 失败原因 / 跳过原因
    command?: string;    // 实际重启命令
  }>;
  /** 被 except 排除的 tty。 */
  excluded: string[];
}

export interface TabRecentCwdsData {
  cwds: string[];
}

export interface TabScreenData {
  tty: string;
  path: string;
  pushed?: { chatId: string; imageKey?: string };
}

export interface TabKeysData {
  tty: string;
  steps: number;
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

