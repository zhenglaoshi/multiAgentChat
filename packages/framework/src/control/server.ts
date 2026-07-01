import { createServer, type Socket } from 'node:net';
import { mkdir, unlink } from 'node:fs/promises';
import { existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import { approvals } from 'multiagent-orchestrator';
import { listAllChats, loadChat, saveChat } from 'multiagent-im-lark';
import { sendCardMessage, sendFile, sendImage, sendTextMessage } from 'multiagent-im-lark';
import { logger } from 'multiagent-orchestrator';
import { pendingTracker } from 'multiagent-im-lark';
import { listRecentCwds, recordCwd } from 'multiagent-host-mac';
import {
  createTask,
  getTask,
  listTasks,
  markGateResolve,
  markGateWait,
  markStageEnd,
  markStageRetry,
  markStageSkipped,
  markStageStart,
  markTaskAborted,
} from 'multiagent-orchestrator';
import { send as terminalSend } from 'multiagent-host-mac';
import { recallStageMemories } from 'multiagent-orchestrator';
import {
  listSubagents,
  getSubagent,
  writeSubagent,
  deleteSubagent,
  type SubagentDef,
} from 'multiagent-orchestrator';
import {
  closeTab,
  getHistory,
  listTabs,
  newTab,
  send,
  waitForOutput,
} from 'multiagent-host-mac';
import type {
  ApprovalListData,
  ApprovalRequestData,
  ApprovalResolveData,
  ChatGetData,
  ChatSetActiveData,
  LarkResolveChatData,
  LarkSendData,
  Request,
  Response,
  TabCloseData,
  TabGetData,
  TabHistoryData,
  TabListData,
  TabNewData,
  TabRecentCwdsData,
  TabSendData,
  StageRecallData,
  TaskAbortData,
  TaskCreateData,
  TaskGetData,
  TaskListData,
  TaskStageData,
  SubagentAddData,
  SubagentDeleteData,
  SubagentListData,
  SubagentShowData,
  SubagentGenSubmitData,
  SubagentSummary,
} from './protocol.js';
import { SOCKET_PATH } from './protocol.js';

const ABS_SOCKET = resolve(SOCKET_PATH);

let larkClient: Lark.Client | null = null;

function writeLine(sock: Socket, obj: unknown): void {
  if (sock.destroyed || !sock.writable) return;
  sock.write(`${JSON.stringify(obj)}\n`);
}
function sendOk<T>(sock: Socket, data: T): void {
  writeLine(sock, { ok: true, data } satisfies Response<T>);
}
function sendErr(sock: Socket, error: string): void {
  writeLine(sock, { ok: false, error } satisfies Response);
}

// ---- Tab ops ----

async function handleTabList(sock: Socket) {
  const tabs = await listTabs();
  sendOk<TabListData>(sock, { tabs });
  sock.end();
}

async function handleTabGet(sock: Socket, req: Extract<Request, { op: 'tab.get' }>) {
  const tabs = await listTabs();
  const tab = tabs.find((t) => t.tty === req.tty) ?? null;
  sendOk<TabGetData>(sock, { tab });
  sock.end();
}

async function handleTabHistory(
  sock: Socket,
  req: Extract<Request, { op: 'tab.history' }>,
) {
  const lines = req.lines ?? 80;
  const full = await getHistory(req.tty);
  const arr = full.split('\n');
  const text = arr.slice(-lines).join('\n');
  sendOk<TabHistoryData>(sock, { tty: req.tty, text, totalLines: arr.length });
  sock.end();
}

async function handleTabSend(sock: Socket, req: Extract<Request, { op: 'tab.send' }>) {
  const res = await send(req.tty, req.text);
  if (res.ok && req.waitForOutput && res.before !== undefined) {
    const diff = await waitForOutput(req.tty, res.before, {
      timeoutMs: req.timeoutMs,
    });
    res.diff = diff;
    res.after = res.before + diff.split('\n').length;
  }
  sendOk<TabSendData>(sock, { tty: req.tty, result: res });
  sock.end();
}

async function handleTabNew(sock: Socket, req: Extract<Request, { op: 'tab.new' }>) {
  try {
    const opts: Parameters<typeof newTab>[0] = {};
    if (req.cwd) opts.cwd = req.cwd;
    if (req.mode) opts.mode = req.mode;
    const tty = await newTab(opts);
    if (req.cwd) void recordCwd(req.cwd);
    sendOk<TabNewData>(sock, { tty });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

async function handleTabClose(sock: Socket, req: Extract<Request, { op: 'tab.close' }>) {
  try {
    const closed = await closeTab(req.tty);
    sendOk<TabCloseData>(sock, { closed });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

async function handleTabRecentCwds(sock: Socket) {
  const cwds = await listRecentCwds();
  sendOk<TabRecentCwdsData>(sock, { cwds });
  sock.end();
}

// ---- Chat ops ----

async function handleChatGet(sock: Socket, req: Extract<Request, { op: 'chat.get' }>) {
  const c = await loadChat(req.chatId);
  let activeTab = null;
  if (c.activeTty) {
    const all = await listTabs();
    activeTab = all.find((t) => t.tty === c.activeTty) ?? null;
  }
  sendOk<ChatGetData>(sock, { chat: c, activeTab });
  sock.end();
}

async function handleChatSetActive(
  sock: Socket,
  req: Extract<Request, { op: 'chat.set-active' }>,
) {
  const all = await listTabs();
  const tab = all.find((t) => t.tty === req.tty);
  if (!tab) {
    sendErr(sock, `tab 不存在：${req.tty}`);
    sock.end();
    return;
  }
  const c = await loadChat(req.chatId);
  c.activeTty = tab.tty;
  c.lastActiveAt = Date.now();
  await saveChat(c);
  if (tab.cwd) void recordCwd(tab.cwd);
  sendOk<ChatSetActiveData>(sock, { chat: c, tab });
  sock.end();
}

// ---- Lark outbound ops ----

function requireLark(sock: Socket): Lark.Client | null {
  if (!larkClient) {
    sendErr(sock, 'lark client 未初始化 (dev 服务可能没正确启动 lark bot)');
    sock.end();
    return null;
  }
  return larkClient;
}

async function handleLarkSendText(
  sock: Socket,
  req: Extract<Request, { op: 'lark.send-text' }>,
) {
  const client = requireLark(sock);
  if (!client) return;
  try {
    await sendTextMessage(client, req.chatId, req.text);
    sendOk<LarkSendData>(sock, { details: {} });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

async function handleLarkSendCard(
  sock: Socket,
  req: Extract<Request, { op: 'lark.send-card' }>,
) {
  const client = requireLark(sock);
  if (!client) return;
  try {
    await sendCardMessage(client, req.chatId, req.card);
    sendOk<LarkSendData>(sock, { details: {} });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

async function handleLarkSendFile(
  sock: Socket,
  req: Extract<Request, { op: 'lark.send-file' }>,
) {
  const client = requireLark(sock);
  if (!client) return;
  try {
    const opts: { name?: string } = {};
    if (req.name) opts.name = req.name;
    const result = await sendFile(client, req.chatId, req.path, opts);
    sendOk<LarkSendData>(sock, { details: { ...result } });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

async function handleLarkSendImage(
  sock: Socket,
  req: Extract<Request, { op: 'lark.send-image' }>,
) {
  const client = requireLark(sock);
  if (!client) return;
  try {
    const result = await sendImage(client, req.chatId, req.path);
    sendOk<LarkSendData>(sock, { details: { ...result } });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

async function handleLarkResolveChat(
  sock: Socket,
  req: Extract<Request, { op: 'lark.resolve-chat' }>,
) {
  if (req.tty) {
    const pendings = pendingTracker.forTty(req.tty);
    if (pendings.length > 0) {
      const latest = pendings.reduce((a, b) => (a.sentAt > b.sentAt ? a : b));
      sendOk<LarkResolveChatData>(sock, {
        chatId: latest.chatId,
        source: 'pending',
      });
      sock.end();
      return;
    }
  }
  const chats = await listAllChats();
  if (chats.length === 0) {
    sendOk<LarkResolveChatData>(sock, { chatId: null, source: 'none' });
    sock.end();
    return;
  }
  const sorted = [...chats].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  const top = sorted[0]!;
  sendOk<LarkResolveChatData>(sock, {
    chatId: top.chatId,
    source: 'most-recent-chat',
  });
  sock.end();
}

// ---- Approval ops ----

async function handleApprovalRequest(
  sock: Socket,
  req: Extract<Request, { op: 'approval.request' }>,
) {
  try {
    const { result } = await approvals.create({
      title: req.title,
      body: req.body,
      taskId: req.taskId,
      chatId: req.chatId,
      timeoutMs: req.timeoutMs,
    });
    const final = await result;
    sendOk<ApprovalRequestData>(sock, { request: final });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

async function handleApprovalList(
  sock: Socket,
  req: Extract<Request, { op: 'approval.list' }>,
) {
  const active = approvals.listActive();
  const recent = await approvals.listRecent(req.limit ?? 20);
  const recentSansActive = recent.filter((r) => r.status !== 'pending');
  sendOk<ApprovalListData>(sock, { active, recent: recentSansActive });
  sock.end();
}

async function handleApprovalResolve(
  sock: Socket,
  req: Extract<Request, { op: 'approval.resolve' }>,
) {
  const finished = await approvals.resolve(
    req.id,
    req.decision,
    req.resolvedBy ?? 'cli:unknown',
  );
  sendOk<ApprovalResolveData>(sock, { request: finished ?? null });
  sock.end();
}

// ---- Task ops (SOP) ----

const DEFAULT_GATE_TIMEOUT_MS = 30 * 60 * 1000;

async function handleTaskCreate(
  sock: Socket,
  req: Extract<Request, { op: 'task.create' }>,
) {
  try {
    const input: Parameters<typeof createTask>[0] = {
      tty: req.tty,
      cwd: req.cwd,
      chatId: req.chatId,
      stages: req.stages,
      gates: req.gates,
      artifactDir: req.artifactDir,
      userPrompt: req.userPrompt,
    };
    if (req.loops) input.loops = req.loops;
    if (req.presetName) input.presetName = req.presetName;
    if (req.taskId) input.taskId = req.taskId;
    const task = await createTask(input);
    sendOk<TaskCreateData>(sock, { task });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

async function handleTaskGet(sock: Socket, req: Extract<Request, { op: 'task.get' }>) {
  const task = await getTask(req.taskId);
  sendOk<TaskGetData>(sock, { task });
  sock.end();
}

async function handleTaskList(sock: Socket, req: Extract<Request, { op: 'task.list' }>) {
  const filter: Parameters<typeof listTasks>[0] = {};
  if (req.status) filter.status = req.status;
  if (req.tty) filter.tty = req.tty;
  if (req.chatId) filter.chatId = req.chatId;
  let tasks = await listTasks(filter);
  if (typeof req.limit === 'number' && req.limit > 0) tasks = tasks.slice(0, req.limit);
  sendOk<TaskListData>(sock, { tasks });
  sock.end();
}

async function handleTaskStage(
  sock: Socket,
  req: Extract<Request, { op: 'task.stage' }>,
) {
  try {
    // guard：task 已结束 → 拒绝所有 stage 操作
    const guardTask = await getTask(req.taskId);
    if (!guardTask) {
      sendErr(sock, `task 不存在：${req.taskId}`);
      sock.end();
      return;
    }
    if (guardTask.status === 'done' || guardTask.status === 'failed') {
      const reasonHint = guardTask.failReason ? `（${guardTask.failReason}）` : '';
      sendErr(sock, `task ${req.taskId} 已结束(${guardTask.status})${reasonHint}，stage 操作被拒绝`);
      sock.end();
      return;
    }

    if (req.action === 'skip') {
      const reason = req.reason ?? req.note ?? 'main agent decided unnecessary';
      const task = await markStageSkipped(req.taskId, req.name, reason);
      if (!task) {
        sendErr(sock, `task 不存在：${req.taskId}`);
      } else {
        sendOk<TaskStageData>(sock, { task });
      }
      sock.end();
      return;
    }

    if (req.action === 'start') {
      const task = await markStageStart(req.taskId, req.name);
      if (!task) {
        sendErr(sock, `task 不存在：${req.taskId}`);
      } else {
        sendOk<TaskStageData>(sock, { task });
      }
      sock.end();
      return;
    }

    if (req.action === 'fail') {
      // 先看是否命中失败回环规则
      const existing = await getTask(req.taskId);
      if (!existing) {
        sendErr(sock, `task 不存在：${req.taskId}`);
        sock.end();
        return;
      }
      const loopRule = existing.loops.find((l) => l.on === req.name);
      if (loopRule) {
        const tried = existing.stageRetries[req.name] ?? 0;
        if (tried < loopRule.maxRetries) {
          const ret = await markStageRetry(req.taskId, req.name, loopRule.retryFrom, req.note);
          if (ret) {
            sendOk<TaskStageData>(sock, {
              task: ret.task,
              loopback: {
                failedStage: req.name,
                retryFrom: loopRule.retryFrom,
                retryCount: ret.retryCount,
                maxRetries: ret.maxRetries,
              },
            });
            sock.end();
            return;
          }
        }
      }
      // 没命中 / 已耗尽：走原路径标 failed
      const patch: Parameters<typeof markStageEnd>[2] = { status: 'failed' };
      if (req.note !== undefined) patch.note = req.note;
      const task = await markStageEnd(req.taskId, req.name, patch);
      if (!task) {
        sendErr(sock, `task 不存在：${req.taskId}`);
      } else {
        sendOk<TaskStageData>(sock, { task });
      }
      sock.end();
      return;
    }

    // action === 'end'
    const patch: Parameters<typeof markStageEnd>[2] = { status: 'done' };
    if (req.summary !== undefined) patch.summary = req.summary;
    if (req.artifactPath !== undefined) patch.artifactPath = req.artifactPath;
    const taskAfter = await markStageEnd(req.taskId, req.name, patch);
    if (!taskAfter) {
      sendErr(sock, `task 不存在：${req.taskId}`);
      sock.end();
      return;
    }

    // task 已 done / failed → 没有 gate 要触发
    if (taskAfter.status !== 'running') {
      sendOk<TaskStageData>(sock, { task: taskAfter });
      sock.end();
      return;
    }

    // 检查是否有 after-<stage> gate
    const gateName = `after-${req.name}`;
    if (!taskAfter.gates.includes(gateName)) {
      sendOk<TaskStageData>(sock, { task: taskAfter });
      sock.end();
      return;
    }

    // gate 触发：标记 awaiting-gate + 创建 approval，等用户响应
    await markGateWait(taskAfter.taskId, gateName);
    const lastStage = taskAfter.stageHistory.find((s) => s.name === req.name);
    const summaryText = lastStage?.summary ?? '(无 stage 摘要)';
    const artifactLine = lastStage?.artifactPath ? `\n📄 产出：${lastStage.artifactPath}` : '';

    // 读 artifact 文件预览（前 40 行 / 2000 字）给 gate 卡
    let artifactPreview: string | undefined;
    if (lastStage?.artifactPath) {
      try {
        const { readFile } = await import('node:fs/promises');
        const { resolve: resolvePath } = await import('node:path');
        const abs = resolvePath(taskAfter.cwd, lastStage.artifactPath);
        const raw = await readFile(abs, 'utf8');
        const lines = raw.split('\n').slice(0, 40);
        let preview = lines.join('\n');
        if (preview.length > 2000) preview = preview.slice(0, 2000) + '\n…';
        artifactPreview = preview;
      } catch (e) {
        logger.warn('artifact preview failed', {
          path: lastStage.artifactPath,
          err: (e as Error).message,
        });
      }
    }

    const gateContext: import('multiagent-orchestrator').ApprovalGateContext = {
      taskId: taskAfter.taskId,
      stageName: req.name,
      gateName,
    };
    if (taskAfter.presetName) gateContext.presetName = taskAfter.presetName;
    if (lastStage?.summary) gateContext.stageSummary = lastStage.summary;
    if (lastStage?.artifactPath) gateContext.artifactPath = lastStage.artifactPath;
    if (artifactPreview) gateContext.artifactPreview = artifactPreview;
    gateContext.allStages = taskAfter.stages;
    gateContext.currentStageIdx = taskAfter.stageHistory.findIndex((s) => s.name === req.name);

    const { result } = await approvals.create({
      title: `[Gate ${gateName}] ${taskAfter.presetName ?? taskAfter.taskId}`,
      body:
        `Stage \`${req.name}\` 已完成，等待人工审批后进入下一 stage。\n\n` +
        `摘要：${summaryText}${artifactLine}\n\n` +
        `task: ${taskAfter.taskId}`,
      taskId: taskAfter.taskId,
      chatId: taskAfter.chatId,
      timeoutMs: req.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
      gateContext,
    });
    const approval = await result;
    const approved = approval.status === 'approved';
    const updated = await markGateResolve(taskAfter.taskId, gateName, approved);
    const finalTask = updated ?? taskAfter;
    const gateResolved: TaskStageData['gateResolved'] = {
      gateName,
      approved,
    };
    if (!approved) gateResolved.reason = approval.status;
    sendOk<TaskStageData>(sock, { task: finalTask, gateResolved });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

async function handleTaskAbort(
  sock: Socket,
  req: Extract<Request, { op: 'task.abort' }>,
) {
  try {
    const reason = req.reason ?? 'user request';
    const hard = req.hard ?? false;
    const task = await markTaskAborted(req.taskId, reason, hard);
    if (!task) {
      sendErr(sock, `task 不存在：${req.taskId}`);
      sock.end();
      return;
    }
    // 投递 🛑 到 task.tty 的 claude TUI（best-effort，不阻塞响应）
    if (task.tty) {
      const banner = [
        '',
        '',
        `🛑 [SOP 中止] task-id ${req.taskId} 已被中止${hard ? '（hard）' : '（soft）'}`,
        `原因: ${reason}`,
        hard
          ? '请立刻停手，**不要**继续 stage 协议、**不要**写收尾摘要'
          : '请停止后续 stage 调用；如有已完成 stage 的 artifact 可以 `agent lark send-text` 简短总结后结束',
        '',
      ].join('\n');
      void terminalSend(task.tty, banner).catch((e) => {
        logger.warn('abort banner injection failed', {
          tty: task.tty,
          err: (e as Error).message,
        });
      });
    }
    sendOk<TaskAbortData>(sock, { task });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

async function handleStageRecall(
  sock: Socket,
  req: Extract<Request, { op: 'stage.recall' }>,
) {
  // 没 cwd 也没 keywords → 退化成按 stage 列最近 N 条
  const noQuery = !req.cwd && (!req.keywords || req.keywords.length === 0);
  let results: Awaited<ReturnType<typeof recallStageMemories>>;
  if (noQuery) {
    const { listStageMemories } = await import('multiagent-orchestrator');
    const filter: Parameters<typeof listStageMemories>[0] = {};
    if (req.stage) filter.stage = req.stage;
    filter.limit = req.limit ?? 5;
    const list = await listStageMemories(filter);
    results = list.map((m) => ({ memory: m, score: 0 }));
  } else {
    const opts: Parameters<typeof recallStageMemories>[0] = {};
    if (req.stage) opts.stage = req.stage;
    if (req.cwd) opts.cwd = req.cwd;
    if (req.keywords) opts.keywords = req.keywords;
    if (typeof req.limit === 'number') opts.limit = req.limit;
    if (typeof req.minScore === 'number') opts.minScore = req.minScore;
    results = await recallStageMemories(opts);
  }
  sendOk<StageRecallData>(sock, {
    results: results.map((r) => {
      const out: StageRecallData['results'][number] = {
        score: Number(r.score.toFixed(2)),
        id: r.memory.id,
        taskId: r.memory.taskId,
        stageName: r.memory.stageName,
        cwd: r.memory.cwd,
        userPrompt: r.memory.userPrompt,
        summary: r.memory.summary,
        startedAt: r.memory.startedAt,
        endedAt: r.memory.endedAt,
      };
      if (r.memory.artifactPath) out.artifactPath = r.memory.artifactPath;
      if (r.memory.presetName) out.presetName = r.memory.presetName;
      return out;
    }),
  });
  sock.end();
}

// ---- Subagent ops ----

function toSubagentSummary(d: SubagentDef) {
  const s: SubagentAddData['subagent'] = {
    name: d.name,
    location: d.location,
    filePath: d.filePath,
  };
  if (d.description !== undefined) s.description = d.description;
  if (d.tools !== undefined) s.tools = d.tools;
  if (d.model !== undefined) s.model = d.model;
  if (d.color !== undefined) s.color = d.color;
  return s;
}

async function handleSubagentList(
  sock: Socket,
  req: Extract<Request, { op: 'subagent.list' }>,
) {
  const opts = req.projectRoot ? { projectRoot: req.projectRoot } : {};
  const defs = await listSubagents(opts);
  sendOk<SubagentListData>(sock, { subagents: defs.map(toSubagentSummary) });
  sock.end();
}

async function handleSubagentShow(
  sock: Socket,
  req: Extract<Request, { op: 'subagent.show' }>,
) {
  const opts = req.projectRoot ? { projectRoot: req.projectRoot } : {};
  const def = await getSubagent(req.name, opts);
  if (!def) {
    sendOk<SubagentShowData>(sock, { subagent: null });
  } else {
    sendOk<SubagentShowData>(sock, {
      subagent: { ...toSubagentSummary(def), body: def.body },
    });
  }
  sock.end();
}

async function handleSubagentAdd(
  sock: Socket,
  req: Extract<Request, { op: 'subagent.add' }>,
) {
  try {
    if (!req.overwrite) {
      const opts = req.projectRoot ? { projectRoot: req.projectRoot } : {};
      const existing = await getSubagent(req.name, opts);
      if (existing) {
        sendErr(sock, `subagent "${req.name}" 已存在（${existing.location}），用 --overwrite 覆盖`);
        sock.end();
        return;
      }
    }
    const input: Parameters<typeof writeSubagent>[0] = {
      name: req.name,
      body: req.body,
    };
    if (req.description !== undefined) input.description = req.description;
    if (req.tools !== undefined) input.tools = req.tools;
    if (req.model !== undefined) input.model = req.model;
    if (req.color !== undefined) input.color = req.color;
    if (req.location !== undefined) input.location = req.location;
    const opts = req.projectRoot ? { projectRoot: req.projectRoot } : {};
    const def = await writeSubagent(input, opts);
    sendOk<SubagentAddData>(sock, { subagent: toSubagentSummary(def) });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

async function handleSubagentDelete(
  sock: Socket,
  req: Extract<Request, { op: 'subagent.delete' }>,
) {
  try {
    const opts = req.projectRoot ? { projectRoot: req.projectRoot } : {};
    const deleted = await deleteSubagent(req.name, opts);
    sendOk<SubagentDeleteData>(sock, { deleted });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

// ---- Subagent gen submit ----

const VALID_TOOLS = new Set([
  'Read', 'Edit', 'Write', 'NotebookEdit', 'NotebookRead',
  'Bash', 'Glob', 'Grep', 'LS',
  'WebFetch', 'WebSearch', 'Task', 'TodoWrite',
]);
const VALID_MODELS = new Set(['sonnet', 'haiku', 'opus', 'inherit']);
const VALID_COLORS = new Set([
  'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'cyan', 'grey',
]);
const SUBAGENT_NAME_RE = /^[a-z][a-z0-9-]{1,62}$/;

interface ParsedGenPayload {
  subagents: Array<{
    name: string;
    description?: string;
    tools?: string[];
    model?: string;
    color?: string;
    body: string;
  }>;
  template?: {
    name: string;
    prompt: string;
    stages?: string[];
    gates?: string[];
    artifactDir?: string;
  };
}

function validateAndParseGenJson(raw: string): ParsedGenPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`JSON 解析失败：${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('JSON 顶层必须是对象');
  const p = parsed as Record<string, unknown>;
  if (!Array.isArray(p['subagents'])) throw new Error('缺 subagents 数组');
  const subagents: ParsedGenPayload['subagents'] = [];
  for (const item of p['subagents']) {
    if (!item || typeof item !== 'object') throw new Error('每个 subagent 必须是对象');
    const s = item as Record<string, unknown>;
    if (typeof s['name'] !== 'string' || !SUBAGENT_NAME_RE.test(s['name'])) {
      throw new Error(`subagent name 非法："${s['name']}"（要 [a-z][a-z0-9-]{1,62}）`);
    }
    if (typeof s['body'] !== 'string' || s['body'].trim().length < 10) {
      throw new Error(`subagent "${s['name']}" body 太短或缺失`);
    }
    const clean: ParsedGenPayload['subagents'][number] = {
      name: s['name'] as string,
      body: (s['body'] as string).trim(),
    };
    if (typeof s['description'] === 'string') clean.description = s['description'];
    if (Array.isArray(s['tools'])) {
      const tools = (s['tools'] as unknown[]).filter((t) => typeof t === 'string') as string[];
      const invalid = tools.filter((t) => !VALID_TOOLS.has(t));
      if (invalid.length > 0) {
        logger.warn('subagent gen: unknown tools, dropping', { invalid, name: clean.name });
      }
      clean.tools = tools.filter((t) => VALID_TOOLS.has(t));
    }
    if (typeof s['model'] === 'string' && VALID_MODELS.has(s['model'])) clean.model = s['model'];
    if (typeof s['color'] === 'string' && VALID_COLORS.has(s['color'])) clean.color = s['color'];
    subagents.push(clean);
  }
  if (subagents.length === 0) throw new Error('subagents 空');
  if (subagents.length > 10) throw new Error('subagents 数量 > 10，太多');

  const out: ParsedGenPayload = { subagents };
  if (p['template'] && typeof p['template'] === 'object') {
    const t = p['template'] as Record<string, unknown>;
    if (typeof t['name'] === 'string' && typeof t['prompt'] === 'string') {
      const tpl: NonNullable<ParsedGenPayload['template']> = {
        name: t['name'] as string,
        prompt: t['prompt'] as string,
      };
      if (Array.isArray(t['stages'])) {
        tpl.stages = (t['stages'] as unknown[]).filter((s) => typeof s === 'string') as string[];
      }
      if (Array.isArray(t['gates'])) {
        tpl.gates = (t['gates'] as unknown[]).filter((s) => typeof s === 'string') as string[];
      }
      if (typeof t['artifactDir'] === 'string') tpl.artifactDir = t['artifactDir'];
      out.template = tpl;
    }
  }
  return out;
}

async function handleSubagentGenSubmit(
  sock: Socket,
  req: Extract<Request, { op: 'subagent.gen-submit' }>,
) {
  try {
    const parsed = validateAndParseGenJson(req.json);
    const opts = req.projectRoot ? { projectRoot: req.projectRoot } : {};

    const added: SubagentSummary[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];

    for (const s of parsed.subagents) {
      // 检查冲突
      const existing = await getSubagent(s.name, opts);
      if (existing) {
        skipped.push({ name: s.name, reason: `已存在于 ${existing.location}: ${existing.filePath}` });
        continue;
      }
      try {
        const input: Parameters<typeof writeSubagent>[0] = {
          name: s.name,
          body: s.body,
        };
        if (s.description) input.description = s.description;
        if (s.tools) input.tools = s.tools;
        if (s.model) input.model = s.model;
        if (s.color) input.color = s.color;
        if (req.location) input.location = req.location;
        const def = await writeSubagent(input, opts);
        added.push(toSubagentSummary(def));
      } catch (e) {
        skipped.push({ name: s.name, reason: (e as Error).message });
      }
    }

    // template 落盘（复用 orchestrator/presets）
    let templateSaved: SubagentGenSubmitData['templateSaved'] | undefined;
    if (parsed.template) {
      try {
        const { savePreset } = await import('multiagent-orchestrator');
        const preset: Parameters<typeof savePreset>[0] = {
          name: parsed.template.name,
          prompt: parsed.template.prompt,
        };
        if (parsed.template.stages) preset.stages = parsed.template.stages;
        if (parsed.template.gates) preset.gates = parsed.template.gates;
        if (parsed.template.artifactDir) preset.artifactDir = parsed.template.artifactDir;
        const saved = await savePreset(preset);
        templateSaved = { name: saved.name };
        if (saved.stages) templateSaved.stages = saved.stages;
        if (saved.gates) templateSaved.gates = saved.gates;
      } catch (e) {
        logger.warn('subagent gen: template save failed', { err: (e as Error).message });
      }
    }

    // 推结果到 chat
    try {
      if (larkClient && req.chatId) {
        const lines = [`🎨 Subagent 生成完成（session ${req.sessionId}）`, ''];
        if (added.length > 0) {
          lines.push(`✅ 新增 ${added.length} 个：`);
          for (const s of added) {
            lines.push(`  • **${s.name}**${s.description ? ` — ${s.description.slice(0, 60)}` : ''}`);
            if (s.tools?.length) lines.push(`    tools: \`${s.tools.join(', ')}\``);
          }
          lines.push('');
        }
        if (skipped.length > 0) {
          lines.push(`⊘ 跳过 ${skipped.length} 个：`);
          for (const s of skipped) lines.push(`  • ${s.name} — ${s.reason}`);
          lines.push('');
        }
        if (templateSaved) {
          lines.push(`📦 模板：**${templateSaved.name}**`);
          if (templateSaved.stages?.length) lines.push(`   stages: ${templateSaged(templateSaved.stages)}`);
          if (templateSaved.gates?.length) lines.push(`   gates: ${templateSaved.gates.join(', ')}`);
          lines.push(`   触发：\`/run ${templateSaved.name}\``);
          lines.push('');
        }
        lines.push('后续：');
        lines.push(`  \`/subagent <name>\` 看详情`);
        lines.push(`  \`/subagent delete <name>\` 删掉不满意的`);
        if (templateSaved) lines.push(`  \`/run ${templateSaved.name}\` 试跑`);
        await sendTextMessage(larkClient, req.chatId, lines.join('\n'));
      }
    } catch (e) {
      logger.warn('subagent gen: lark reply failed', { err: (e as Error).message });
    }

    const data: SubagentGenSubmitData = {
      sessionId: req.sessionId,
      added,
      skipped,
    };
    if (templateSaved) data.templateSaved = templateSaved;
    sendOk<SubagentGenSubmitData>(sock, data);
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

function templateSaged(arr: string[]): string {
  return arr.join(' → ');
}

// ---- dispatch ----

async function dispatch(sock: Socket, req: Request): Promise<void> {
  switch (req.op) {
    case 'tab.list':
      return handleTabList(sock);
    case 'tab.get':
      return handleTabGet(sock, req);
    case 'tab.history':
      return handleTabHistory(sock, req);
    case 'tab.send':
      return handleTabSend(sock, req);
    case 'tab.new':
      return handleTabNew(sock, req);
    case 'tab.close':
      return handleTabClose(sock, req);
    case 'tab.recent-cwds':
      return handleTabRecentCwds(sock);
    case 'chat.get':
      return handleChatGet(sock, req);
    case 'chat.set-active':
      return handleChatSetActive(sock, req);
    case 'lark.send-text':
      return handleLarkSendText(sock, req);
    case 'lark.send-card':
      return handleLarkSendCard(sock, req);
    case 'lark.send-file':
      return handleLarkSendFile(sock, req);
    case 'lark.send-image':
      return handleLarkSendImage(sock, req);
    case 'lark.resolve-chat':
      return handleLarkResolveChat(sock, req);
    case 'approval.request':
      return handleApprovalRequest(sock, req);
    case 'approval.list':
      return handleApprovalList(sock, req);
    case 'approval.resolve':
      return handleApprovalResolve(sock, req);
    case 'task.create':
      return handleTaskCreate(sock, req);
    case 'task.get':
      return handleTaskGet(sock, req);
    case 'task.list':
      return handleTaskList(sock, req);
    case 'task.stage':
      return handleTaskStage(sock, req);
    case 'task.abort':
      return handleTaskAbort(sock, req);
    case 'stage.recall':
      return handleStageRecall(sock, req);
    case 'subagent.list':
      return handleSubagentList(sock, req);
    case 'subagent.show':
      return handleSubagentShow(sock, req);
    case 'subagent.add':
      return handleSubagentAdd(sock, req);
    case 'subagent.delete':
      return handleSubagentDelete(sock, req);
    case 'subagent.gen-submit':
      return handleSubagentGenSubmit(sock, req);
    default: {
      const exhaustive: never = req;
      sendErr(sock, `unknown op: ${JSON.stringify(exhaustive)}`);
      sock.end();
    }
  }
}

function onConnection(sock: Socket): void {
  let buffer = '';
  let handled = false;
  sock.on('data', (chunk) => {
    if (handled) return;
    buffer += chunk.toString('utf8');
    const nl = buffer.indexOf('\n');
    if (nl < 0) return;
    handled = true;
    const line = buffer.slice(0, nl).trim();
    if (!line) {
      sendErr(sock, 'empty request');
      sock.end();
      return;
    }
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch (e) {
      sendErr(sock, `invalid json: ${(e as Error).message}`);
      sock.end();
      return;
    }
    dispatch(sock, req).catch((e) => {
      logger.error('control dispatch failed', e);
      sendErr(sock, (e as Error).message);
      sock.end();
    });
  });
  sock.on('error', (err) => {
    logger.warn('control socket error', { err: err.message });
  });
}

export async function startControlServer(client?: Lark.Client): Promise<void> {
  if (client) larkClient = client;
  await mkdir(dirname(ABS_SOCKET), { recursive: true });
  if (existsSync(ABS_SOCKET)) {
    try {
      await unlink(ABS_SOCKET);
    } catch (e) {
      logger.warn('failed to remove stale socket', { err: (e as Error).message });
    }
  }
  const server = createServer(onConnection);
  await new Promise<void>((resolveP, rejectP) => {
    server.once('error', rejectP);
    server.listen(ABS_SOCKET, () => {
      server.off('error', rejectP);
      resolveP();
    });
  });
  logger.info('control server listening', { socket: ABS_SOCKET });

  const cleanup = () => {
    server.close();
    if (existsSync(ABS_SOCKET)) {
      try {
        unlinkSync(ABS_SOCKET);
      } catch {
        /* ignore */
      }
    }
  };
  process.once('exit', cleanup);
}

