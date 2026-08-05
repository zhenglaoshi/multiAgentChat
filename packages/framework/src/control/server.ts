import { createServer, type Socket } from 'node:net';
import { execFile } from 'node:child_process';
import { mkdir, unlink } from 'node:fs/promises';
import { existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import * as Lark from '@larksuiteoapi/node-sdk';
import { approvals, asks, knowledgeQueue, listEntries, statsSummary } from 'multiagent-orchestrator';
import { isHighRiskCommand, isLearnedAllowed, learnedProgress, recordDecision } from 'multiagent-orchestrator';
import { shouldGate, getPermLevel, PERM_LEVEL_LABELS } from 'multiagent-orchestrator';
import { listAllChats, loadChat, saveChat } from 'multiagent-im-lark';
import { originShellPushCard, sendCardMessage, sendFile, sendImage, sendTextMessage, patchCard, tapdClaimCard } from 'multiagent-im-lark';
import { loadClaim, saveClaim, TAPD_STAGE_LABEL, type TapdStage } from 'multiagent-orchestrator';
import { logger } from 'multiagent-orchestrator';
import { pendingTracker } from 'multiagent-im-lark';
import { captureScreen, listRecentCwds, recordCwd, sendKeys } from 'multiagent-host-mac';
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
  checkArtifact,
  eqStage,
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
  closeTabGracefully,
  getHistory,
  isClaudeTab,
  listTabs,
  newTab,
  restartClaudeInPlace,
  send,
  waitForOutput,
} from 'multiagent-host-mac';
import type {
  ApprovalListData,
  ApprovalRequestData,
  ApprovalResolveData,
  LarkAskData,
  ChatGetData,
  ChatSetActiveData,
  LarkResolveChatData,
  LarkSendData,
  PermissionGateData,
  Request,
  Response,
  TabCloseData,
  TabRestartClaudeData,
  TapdStageData,
  TabGetData,
  TabHistoryData,
  TabListData,
  TabNewData,
  TabRecentCwdsData,
  TabScreenData,
  TabKeysData,
  TabSendData,
  StageRecallData,
  TaskAbortData,
  TaskCreateData,
  TaskGetData,
  TaskListData,
  TaskStageData,
  TaskStageAutoData,
  TaskPlanReviewData,
  SubagentAddData,
  SubagentDeleteData,
  SubagentListData,
  SubagentShowData,
  SubagentGenSubmitData,
  SubagentSummary,
} from './protocol.js';
import { SOCKET_PATH } from './protocol.js';
import type { IMTransport } from '../im/index.js';

const ABS_SOCKET = resolve(SOCKET_PATH);

let larkClient: Lark.Client | null = null;
// 企微 transport 由 daemon 传入（用抽象 IMTransport 接口避免循环 project reference）。
// 缺 WECOM_* env 时为 null，所有 wecom.* op 会 error 提示。
let wecomTransport: IMTransport | null = null;

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
    // 优雅关：先退出 agent(claude/codex) 省 CPU/内存，再关单个 tab；拒绝关 daemon 自己。
    const r = await closeTabGracefully(req.tty);
    sendOk<TabCloseData>(sock, {
      closed: r.closed,
      hadAgent: r.hadAgent,
      agentExited: r.agentExited,
      ...(r.agentKind ? { agentKind: r.agentKind } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
    });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

async function handleTabRestartClaude(
  sock: Socket,
  req: Extract<Request, { op: 'tab.restart-claude' }>,
) {
  try {
    const except = new Set(req.except ?? []);
    const dryRun = req.dryRun ?? false;
    const continueSession = req.continueSession ?? true;

    const tabs = await listTabs();
    const claudeTabs = tabs.filter(isClaudeTab);
    const targetsTabs = claudeTabs.filter((t) => !except.has(t.tty));
    const excluded = claudeTabs.filter((t) => except.has(t.tty)).map((t) => t.tty);

    if (dryRun) {
      sendOk<TabRestartClaudeData>(sock, {
        dryRun: true,
        targets: targetsTabs.map((t) => ({ tty: t.tty, cwd: t.cwd })),
        excluded,
      });
      sock.end();
      return;
    }

    // 串行重启：每个都会把 Terminal 拉到 frontmost，并行会互相抢焦点。
    const results: TabRestartClaudeData['targets'] = [];
    for (const t of targetsTabs) {
      const r = await restartClaudeInPlace(t.tty, { continueSession });
      const entry: TabRestartClaudeData['targets'][number] = { tty: r.tty, ok: r.ok };
      if (r.cwd !== undefined) entry.cwd = r.cwd;
      if (r.reason !== undefined) entry.reason = r.reason;
      if (r.command !== undefined) entry.command = r.command;
      results.push(entry);
      logger.info('restart-claude tab', {
        tty: r.tty,
        ok: r.ok,
        reason: r.reason,
      });
    }
    sendOk<TabRestartClaudeData>(sock, { dryRun: false, targets: results, excluded });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

async function handleTapdStage(sock: Socket, req: Extract<Request, { op: 'tapd.stage' }>) {
  try {
    const claim = await loadClaim(req.claimId);
    if (!claim) {
      sendErr(sock, `TAPD claim ${req.claimId} 不存在`);
      sock.end();
      return;
    }
    claim.stage = req.stage as TapdStage;
    if (req.note) claim.stageNote = req.note;
    await saveClaim(claim);
    const label = TAPD_STAGE_LABEL[claim.stage] ?? claim.stage;
    // 企微不能 patch → sendText 进度；飞书 patch 生命周期卡
    if (claim.chatId?.startsWith('wecom:') && wecomTransport) {
      await wecomTransport
        .sendText(claim.chatId, `🌿 [TAPD #${claim.id}] ${label}${req.note ? `：${req.note}` : ''}`)
        .catch(() => {});
    } else if (larkClient && claim.cardMessageId) {
      await patchCard(larkClient, claim.cardMessageId, tapdClaimCard(claim)).catch((e) =>
        logger.warn('tapd stage patch failed', { err: (e as Error).message }),
      );
    }
    sendOk<TapdStageData>(sock, { updated: true, stage: claim.stage });
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

async function handleTabScreen(
  sock: Socket,
  req: Extract<Request, { op: 'tab.screen' }>,
) {
  try {
    const path = await captureScreen(req.tty);
    const data: TabScreenData = { tty: req.tty, path };
    if (req.pushToChatId && larkClient) {
      try {
        const r = await sendImage(larkClient, req.pushToChatId, path);
        data.pushed = { chatId: req.pushToChatId, imageKey: r.imageKey };
      } catch (e) {
        logger.warn('screen auto-push failed', {
          chatId: req.pushToChatId,
          err: (e as Error).message,
        });
      }
    }
    sendOk<TabScreenData>(sock, data);
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

async function handleTabKeys(
  sock: Socket,
  req: Extract<Request, { op: 'tab.keys' }>,
) {
  try {
    const opts: Parameters<typeof sendKeys>[2] = {};
    if (typeof req.intervalMs === 'number') opts.intervalMs = req.intervalMs;
    await sendKeys(req.tty, req.sequence, opts);
    // steps 数从 tokenize+expand 之后能拿到，但服务器不再复算一次；返回一个近似值
    const approx = req.sequence.trim().split(/\s+/).length;
    sendOk<TabKeysData>(sock, { tty: req.tty, steps: approx });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
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

const execFileAsync = promisify(execFile);

/**
 * 反查触发本次自动推送的 shell tab：
 *  1. 优先用 originPid（hook 的 process.ppid = Claude Code 进程）跑 `ps -o tty=`。
 *     macOS 会回 "ttys004"（无 /dev/ 前缀），补上后跟 listTabs 的 tty 匹配。
 *  2. 兜底：按 originCwd 匹配跑 claude 的 tab；多个匹配时挑第一个。
 * 返回 null 时 daemon 不加前缀、也不记 pendingAnswerTty，退化成原来的 --auto 行为。
 */
async function resolveOriginTab(
  originPid?: number,
  originCwd?: string,
): Promise<{ tty: string; cwd?: string } | null> {
  const tabs = await listTabs();
  if (originPid && Number.isFinite(originPid)) {
    try {
      const { stdout } = await execFileAsync('ps', ['-o', 'tty=', '-p', String(originPid)]);
      const raw = stdout.trim();
      if (raw && raw !== '?' && raw !== '??') {
        const normalized = raw.startsWith('/dev/') ? raw : `/dev/${raw}`;
        const hit = tabs.find((t) => t.tty === normalized);
        if (hit) return { tty: hit.tty, ...(hit.cwd ? { cwd: hit.cwd } : {}) };
      }
    } catch {
      /* ps 找不到进程 —— 落到 cwd 兜底 */
    }
  }
  if (originCwd) {
    const candidates = tabs.filter(
      (t) =>
        t.cwd === originCwd &&
        t.processes.some((p) => p.toLowerCase().includes('claude')),
    );
    if (candidates.length >= 1) {
      const hit = candidates[0]!;
      return { tty: hit.tty, ...(hit.cwd ? { cwd: hit.cwd } : {}) };
    }
  }
  return null;
}

/**
 * 拼「[ttys004 · project-name]\n」前缀。cwd 空则只显示 tty。
 * home 目录会替换成 `~/…`。tty 去掉 /dev/ 前缀更省字符。
 */
function formatOriginPrefix(origin: { tty: string; cwd?: string }): string {
  const shortTty = origin.tty.startsWith('/dev/') ? origin.tty.slice(5) : origin.tty;
  const label = origin.cwd ? `${shortTty} · ${basename(origin.cwd)}` : shortTty;
  return `🖥 ${label}\n`;
}

async function handleLarkSendText(
  sock: Socket,
  req: Extract<Request, { op: 'lark.send-text' }>,
) {
  // chatId 前缀 wecom: 时路由到企微 transport（Stop hook 用 op=lark.send-text，
  // 但目标 chatId 可能是 wecom:user:xxx —— 由 pendingTracker 的 wecom 任务反查得来）
  if (req.chatId.startsWith('wecom:')) {
    if (!wecomTransport) {
      sendErr(sock, 'chatId 前缀是 wecom: 但 wecom transport 未 attach（缺 WECOM_* env）');
      sock.end();
      return;
    }
    try {
      const chat = await loadChat(req.chatId);
      // --auto 也 gate（跟飞书对齐）；用户 --plain 视作强制发（复用 lark 语义）
      if (req.auto && !chat.watchAllTabs) {
        logger.info('wecom auto-push gated', {
          chatId: req.chatId,
          reason: 'watchAllTabs !== true',
          textLen: req.text.length,
        });
        sendOk<LarkSendData>(sock, { details: { gated: true } });
        sock.end();
        return;
      }
      await wecomTransport.sendText(req.chatId, req.text);
      sendOk<LarkSendData>(sock, { details: { via: 'wecom' } });
    } catch (e) {
      sendErr(sock, `wecom send-text failed: ${(e as Error).message}`);
    }
    sock.end();
    return;
  }

  const client = requireLark(sock);
  if (!client) return;
  try {
    const chat = await loadChat(req.chatId);

    // --auto 推送（如 Claude Code Stop hook 触发）：仅当目标 chat 的 watchAllTabs=true 才放行
    if (req.auto) {
      if (!chat.watchAllTabs) {
        logger.info('auto-push gated', {
          chatId: req.chatId,
          reason: 'watchAllTabs !== true',
          textLen: req.text.length,
        });
        sendOk<LarkSendData>(sock, { details: { gated: true } });
        sock.end();
        return;
      }
    }

    // origin tab 反查。仅当有 originPid 或 originCwd 时才尝试；反查失败静默降级。
    let origin: Awaited<ReturnType<typeof resolveOriginTab>> = null;
    if (req.originPid !== undefined || req.originCwd !== undefined) {
      origin = await resolveOriginTab(req.originPid, req.originCwd);
      if (!origin) {
        logger.info('origin tab unresolved', {
          originPid: req.originPid,
          originCwd: req.originCwd,
        });
      }
    }

    // 路径分叉：
    //  - origin 反查到 + 非 activeTty + 非 plain → 用 originShellPushCard 发交互卡片
    //    （带 [option 快答] [⭐ 切到此 shell] [📜 shell history] 按钮）
    //  - 其他情况（含 origin === activeTty、反查失败、--plain） → 走文本，
    //    有 origin 时前面加 `🖥 ttys004 · project` identifier 前缀
    const isActive = origin ? chat.activeTty === origin.tty : false;
    const hasQuickAnswer = !!(
      req.question &&
      req.quickAnswerOptions &&
      req.quickAnswerOptions.length > 0
    );
    // 普通推送：只有非 activeTty 才用卡片（activeTty 自己走文本，避免每条 Stop hook 变卡）。
    // 例外：AskUserQuestion 带选项时，即使是 activeTty 也用卡片 —— 否则选项只能纯文本显示，
    // 手机端点不了、方向键也驱动不了（本次修复的核心场景）。
    const useCard = !!origin && !req.plain && (!isActive || hasQuickAnswer);

    if (useCard && origin) {
      // 卡片路径：originShellPushCard 卡里本就显示了 cwd → 页脚不再传 cwd（只加时间，不重复路径）
      const card = originShellPushCard({
        tty: origin.tty,
        ...(origin.cwd ? { cwd: origin.cwd } : {}),
        home: homedir(),
        body: req.text,
        question: !!req.question,
        ...(req.quickAnswerOptions && req.quickAnswerOptions.length > 0
          ? { quickAnswerOptions: req.quickAnswerOptions }
          : {}),
      });
      await sendCardMessage(client, req.chatId, card);
    } else {
      let finalText = req.text;
      if (origin) finalText = formatOriginPrefix(origin) + finalText;
      // 文本回传里只带了 tty 前缀、没显示 cwd → 页脚补上 origin.cwd（有就显示路径）
      await sendTextMessage(client, req.chatId, finalText, {
        ...(req.plain ? { plain: true } : {}),
        ...(origin?.cwd ? { cwd: origin.cwd } : {}),
      });
    }

    // AskUserQuestion 带选项 → arm askArm：飞书点选项 / 裸数字回复走"方向键驱动本地原生
    // 选择菜单"（handlers 里 ask-select / dispatchSendToTab 拦截消费）。无论 active 与否都 arm。
    if (hasQuickAnswer && origin) {
      chat.askArm = { tty: origin.tty, options: req.quickAnswerOptions!, at: Date.now() };
    }
    // question=true + 反查到 tty + 与 activeTty 不同 → 记 pendingAnswerTty
    // （与 activeTty 相同时，sendToActiveTab 会自然走 activeTty，不需要 override）
    if (req.question && origin && !isActive) {
      chat.pendingAnswerTty = origin.tty;
      chat.pendingAnswerAt = Date.now();
    }
    if ((hasQuickAnswer || (req.question && !isActive)) && origin) {
      await saveChat(chat);
      logger.info('askArm/pendingAnswerTty set', {
        chatId: req.chatId,
        tty: origin.tty,
        hasQuickAnswer,
      });
    }

    sendOk<LarkSendData>(sock, {
      details: origin
        ? { originTty: origin.tty, ...(useCard ? { renderedAs: 'card' } : { renderedAs: 'text' }) }
        : {},
    });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

/**
 * PostToolUse(AskUserQuestion) hook → 本地作答后关卡：反查 origin tty，清掉所有 chat 里
 * 指向该 tty 的 askArm（+ pendingAnswerTty）。防止用户之后误点已作答菜单的卡片，把方向键
 * 注进已经不是菜单的终端（"本地 PC 别受影响"的安全网）。不 gate（清状态永远安全）。
 */
async function handleAskDisarm(
  sock: Socket,
  req: Extract<Request, { op: 'ask.disarm' }>,
) {
  try {
    let tty: string | undefined;
    if (req.originPid !== undefined || req.originCwd !== undefined) {
      const origin = await resolveOriginTab(req.originPid, req.originCwd);
      tty = origin?.tty;
    }
    if (!tty) {
      sendOk<LarkSendData>(sock, { details: { disarmed: 0 } });
      sock.end();
      return;
    }
    const chats = await listAllChats();
    let n = 0;
    for (const chat of chats) {
      if (chat.askArm && chat.askArm.tty === tty) {
        delete chat.askArm;
        if (chat.pendingAnswerTty === tty) {
          delete chat.pendingAnswerTty;
          delete chat.pendingAnswerAt;
        }
        await saveChat(chat);
        n++;
      }
    }
    logger.info('ask.disarm', { tty, disarmed: n });
    sendOk<LarkSendData>(sock, { details: { disarmed: n } });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

/** tty → chatId（复用 resolve-chat 逻辑：pending tty → 该 chat；否则最近活跃 chat）。 */
async function resolveChatIdForTty(tty?: string): Promise<string | null> {
  if (tty) {
    const pendings = pendingTracker.forTty(tty);
    if (pendings.length > 0) {
      return pendings.reduce((a, b) => (a.sentAt > b.sentAt ? a : b)).chatId;
    }
  }
  const chats = await listAllChats();
  if (chats.length === 0) return null;
  return [...chats].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]!.chatId;
}

/**
 * PreToolUse(Bash) 权限 gate：命令高危 → 推飞书审批卡阻塞等结果 → allow/deny；
 * 非高危 / 反查不到 chat / 超时 → passthrough（回退 claude 原生权限提示，fail-safe，绝不自动放行）。
 */
async function handlePermissionGate(
  sock: Socket,
  req: Extract<Request, { op: 'permission.gate' }>,
) {
  try {
    // 按当前授权等级(0-4)判是否要拦（tier: catastrophic/high/medium/none）
    const level = getPermLevel();
    const { gate, tier } = shouldGate(req.command, level);
    if (!gate) {
      sendOk<PermissionGateData>(sock, { decision: 'passthrough' });
      sock.end();
      return;
    }
    const verdict = isHighRiskCommand(req.command);
    // 学习型放行：这条命令已被你批准够多次（近似精确、灾难命令除外）→ 直接放行不再弹卡。
    if (isLearnedAllowed(req.command)) {
      logger.info('permission gate: learned auto-allow', { reason: verdict.reason });
      sendOk<PermissionGateData>(sock, {
        decision: 'allow',
        ...(verdict.reason ? { reason: `${verdict.reason}（已学习放行）` } : {}),
      });
      sock.end();
      return;
    }
    let tty: string | undefined;
    if (req.originPid !== undefined || req.originCwd !== undefined) {
      const origin = await resolveOriginTab(req.originPid, req.originCwd);
      tty = origin?.tty;
    }
    const chatId = await resolveChatIdForTty(tty);
    if (!chatId) {
      // 远程无处可问 → 回退本地原生提示
      sendOk<PermissionGateData>(sock, { decision: 'passthrough' });
      sock.end();
      return;
    }
    const tierLabel =
      tier === 'catastrophic' ? '致命命令' : tier === 'high' ? '高危命令' : tier === 'medium' ? '中危命令' : '命令';
    const reasonLabel = verdict.reason ?? tierLabel;
    const shortTty = tty ? (tty.startsWith('/dev/') ? tty.slice(5) : tty) : '?';
    const cwdShown = req.originCwd ? req.originCwd.replace(homedir(), '~') : '?';
    const cmd = req.command.length > 800 ? req.command.slice(0, 800) + ' …' : req.command;
    const prog = learnedProgress(req.command);
    const learnLine = prog
      ? `<font color='grey'>已批准 ${prog.approvals} 次；再批准 ${prog.remaining} 次将自动放行此命令（/perm-reset 可清空学习）</font>`
      : `<font color='grey'>此命令属最灾难类，不学习放行、每次都会问</font>`;
    const body = [
      `🚨 **${tierLabel}** · ${reasonLabel}`,
      `📁 \`${cwdShown}\`  ·  🏷 \`${shortTty}\``,
      '```bash',
      cmd,
      '```',
      `<font color='grey'>批准 = 执行；拒绝 = 拦下（claude 收到"用户拒绝"）；不响应 → 回退本地提示</font>`,
      learnLine,
      `<font color='grey'>当前授权等级 L${level}（${PERM_LEVEL_LABELS[level]}）— /perm-level 调</font>`,
    ].join('\n');
    const { result } = await approvals.create({
      title: `🚨 ${tierLabel}待批 · ${reasonLabel}`,
      body,
      chatId,
    });
    const final = await result;
    const decision =
      final.status === 'approved' ? 'allow' : final.status === 'rejected' ? 'deny' : 'passthrough';
    // 记学习：批准 → 计数+1；拒绝 → 永不再自动放行该命令；超时不记（未表态）。
    if (final.status === 'approved') recordDecision(req.command, true);
    else if (final.status === 'rejected') recordDecision(req.command, false);
    logger.info('permission gate resolved', { decision, tier, level, tty });
    sendOk<PermissionGateData>(sock, {
      decision,
      reason: reasonLabel,
    });
  } catch (e) {
    // 出错 → passthrough（fail-safe，不自动放行也不误拦）
    logger.warn('permission gate error → passthrough', { err: (e as Error).message });
    try {
      sendOk<PermissionGateData>(sock, { decision: 'passthrough' });
    } catch {
      sendErr(sock, (e as Error).message);
    }
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

// ---- WeCom ops ----

function requireWeCom(): NonNullable<typeof wecomTransport> {
  if (!wecomTransport) {
    throw new Error('企微 transport 未 attach —— 检查 .env 里的 WECOM_* 5 项，然后重启 dev');
  }
  return wecomTransport;
}

function resolveWeComTarget(reqChatId: string | undefined): string {
  // 简单反查：显式给了就用；否则依赖 WECOM_DEFAULT_TO_USER 兜底（transport 内部处理）
  if (reqChatId) return reqChatId;
  const def = process.env['WECOM_DEFAULT_TO_USER'];
  if (def) return `wecom:user:${def}`;
  throw new Error('无法反查企微 chat —— 明示 --chat 或设置 WECOM_DEFAULT_TO_USER');
}

async function handleWeComSendText(
  sock: Socket,
  req: Extract<Request, { op: 'wecom.send-text' }>,
) {
  try {
    const wecom = requireWeCom();
    const target = resolveWeComTarget(req.chatId);
    const r = await wecom.sendText(target, req.text);
    sendOk<import('./protocol.js').WeComSendData>(sock, {
      messageId: r.messageId,
      details: { target },
    });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

async function handleWeComSendFile(
  sock: Socket,
  req: Extract<Request, { op: 'wecom.send-file' }>,
) {
  try {
    const wecom = requireWeCom();
    const target = resolveWeComTarget(req.chatId);
    const opts: Parameters<typeof wecom.sendFile>[2] = {};
    if (req.name) opts.name = req.name;
    const r = await wecom.sendFile(target, req.path, opts);
    sendOk<import('./protocol.js').WeComSendData>(sock, {
      messageId: r.messageId,
      details: { target, path: req.path },
    });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

async function handleWeComSendImage(
  sock: Socket,
  req: Extract<Request, { op: 'wecom.send-image' }>,
) {
  try {
    const wecom = requireWeCom();
    const target = resolveWeComTarget(req.chatId);
    const r = await wecom.sendImage(target, req.path);
    sendOk<import('./protocol.js').WeComSendData>(sock, {
      messageId: r.messageId,
      details: { target, path: req.path },
    });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

async function handleWeComResolveChat(
  sock: Socket,
  _req: Extract<Request, { op: 'wecom.resolve-chat' }>,
) {
  const def = process.env['WECOM_DEFAULT_TO_USER'];
  if (def) {
    sendOk<import('./protocol.js').WeComResolveChatData>(sock, {
      chatId: `wecom:user:${def}`,
      source: 'default-user',
    });
  } else {
    sendOk<import('./protocol.js').WeComResolveChatData>(sock, {
      chatId: null,
      source: 'none',
    });
  }
  sock.end();
}

// ---- Ask op（阻塞式弹飞书交互卡片） ----

async function resolveChatIdFallback(tty?: string): Promise<string | null> {
  if (tty) {
    const pendings = pendingTracker.forTty(tty);
    if (pendings.length > 0) {
      const latest = pendings.reduce((a, b) => (a.sentAt > b.sentAt ? a : b));
      return latest.chatId;
    }
  }
  const chats = await listAllChats();
  if (chats.length === 0) return null;
  const top = [...chats].sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0]!;
  return top.chatId;
}

async function handleLarkAsk(
  sock: Socket,
  req: Extract<Request, { op: 'lark.ask' }>,
) {
  try {
    let chatId = req.chatId;
    if (!chatId) {
      const guess = await resolveChatIdFallback();
      if (!guess) {
        sendErr(sock, '无法反查目标 chat（无 pending 也无 recent chat）');
        sock.end();
        return;
      }
      chatId = guess;
    }
    const createInput: Parameters<typeof asks.create>[0] = {
      chatId,
      type: req.type,
      title: req.title,
      options: req.options ?? [],
    };
    if (req.type === 'form' && req.questions) createInput.questions = req.questions;
    if (typeof req.timeoutMs === 'number') createInput.timeoutMs = req.timeoutMs;
    const { result } = await asks.create(createInput);
    const final = await result;
    sendOk<LarkAskData>(sock, { request: final });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

// ---- Knowledge ops ----

async function handleKnowledgeStats(sock: Socket) {
  const s = await statsSummary();
  sendOk<import('./protocol.js').KnowledgeStatsData>(sock, {
    total: s.total,
    byKind: s.byKind,
    latestAt: s.latestAt,
    queueSize: knowledgeQueue.size(),
    enabled: process.env['KNOWLEDGE_EXTRACT_ENABLED'] === '1',
  });
  sock.end();
}

async function handleKnowledgeList(
  sock: Socket,
  req: Extract<Request, { op: 'knowledge.list' }>,
) {
  const opts: Parameters<typeof listEntries>[0] = { limit: req.limit ?? 20 };
  if (req.cwd) opts.cwd = req.cwd;
  if (req.tag) opts.tag = req.tag;
  if (req.kind) opts.kind = req.kind;
  const entries = await listEntries(opts);
  sendOk<import('./protocol.js').KnowledgeListData>(sock, { entries });
  sock.end();
}

async function handleKnowledgeExtractLast(
  sock: Socket,
  req: Extract<Request, { op: 'knowledge.extract-last' }>,
) {
  try {
    const lines = req.lines ?? 200;
    const full = await getHistory(req.tty);
    const arr = full.split('\n');
    const tail = arr.slice(-lines).join('\n');
    const r = knowledgeQueue.enqueue({ chunk: tail, origin: 'local', tty: req.tty });
    sendOk<import('./protocol.js').KnowledgeExtractLastData>(sock, {
      queued: r.queued,
      reason: r.reason,
      chunkLen: tail.length,
    });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

async function handleWeComAsk(
  sock: Socket,
  req: Extract<Request, { op: 'wecom.ask' }>,
) {
  try {
    if (!wecomTransport) {
      sendErr(sock, '企微 transport 未 attach —— 检查 .env 里的 WECOM_* 5 项');
      sock.end();
      return;
    }
    let chatId = req.chatId;
    if (!chatId) {
      const def = process.env['WECOM_DEFAULT_TO_USER'];
      if (!def) {
        sendErr(sock, '无法反查企微 chat（缺 WECOM_DEFAULT_TO_USER 或 --chat）');
        sock.end();
        return;
      }
      chatId = `wecom:user:${def}`;
    }
    const createInput: Parameters<typeof asks.create>[0] = {
      chatId,
      type: req.type,
      title: req.title,
      options: req.options ?? [],
    };
    if (typeof req.timeoutMs === 'number') createInput.timeoutMs = req.timeoutMs;
    const { result } = await asks.create(createInput);
    const final = await result;
    // 复用 LarkAskData 结构（只是 typed differently in protocol）
    sendOk<import('./protocol.js').WeComAskData>(sock, { request: final });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
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
      const loopRule = existing.loops.find((l) => eqStage(l.on, req.name));
      if (loopRule) {
        const tried = existing.stageRetries[req.name] ?? 0;
        if (tried < loopRule.maxRetries) {
          // 常规回环：带上失败诊断（req.note）让主 claude 针对性修，不盲重试
          const ret = await markStageRetry(req.taskId, req.name, loopRule.retryFrom, req.note);
          if (ret) {
            sendOk<TaskStageData>(sock, {
              task: ret.task,
              loopback: {
                failedStage: req.name,
                retryFrom: loopRule.retryFrom,
                retryCount: ret.retryCount,
                maxRetries: ret.maxRetries,
                ...(req.note ? { diagnosis: req.note } : {}),
              },
            });
            sock.end();
            return;
          }
        } else {
          // 不收敛保护：重试耗尽 → 转 gate 交人（再试一次 / 放弃），而非静默 fail
          const { result } = await approvals.create({
            title: `SOP loop 卡住 · ${existing.taskId}`,
            body: [
              `stage "${req.name}" 连续 ${loopRule.maxRetries} 次失败（每次回环到 ${loopRule.retryFrom} 都没修好）。`,
              `最后一次诊断：${req.note ?? '(无)'}`,
              '',
              '✅ 批准 = 再回环试一次（你也可以先在 tab 里手动看看）；❌ 拒绝/超时 = 放弃，任务标失败',
            ].join('\n'),
            taskId: req.taskId,
            chatId: existing.chatId,
          });
          const final = await result;
          if (final.status === 'approved') {
            const ret = await markStageRetry(req.taskId, req.name, loopRule.retryFrom, req.note, true);
            if (ret) {
              sendOk<TaskStageData>(sock, {
                task: ret.task,
                loopback: {
                  failedStage: req.name,
                  retryFrom: loopRule.retryFrom,
                  retryCount: ret.retryCount,
                  maxRetries: ret.maxRetries,
                  forced: true,
                  ...(req.note ? { diagnosis: req.note } : {}),
                },
              });
              sock.end();
              return;
            }
          }
          logger.info('SOP loop 不收敛 gate：放弃', { taskId: req.taskId, stage: req.name, status: final.status });
        }
      }
      // 没命中 / 已耗尽且人工放弃：走原路径标 failed
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

    // artifact schema 轻校验（带了 artifact 且该 stage 有 schema）：缺 section 只 surface 不 block
    let artifactCheck: TaskStageData['artifactCheck'];
    let artifactContent: string | undefined;
    if (req.artifactPath) {
      try {
        const { readFile } = await import('node:fs/promises');
        const { resolve: resolvePath } = await import('node:path');
        const abs = resolvePath(taskAfter.cwd, req.artifactPath);
        artifactContent = await readFile(abs, 'utf8');
        const chk = checkArtifact(req.name, artifactContent);
        if (chk.schemaKnown) {
          artifactCheck = { ok: chk.ok, missing: chk.missing };
          if (!chk.ok) logger.warn('artifact schema：缺 section', { taskId: req.taskId, stage: req.name, missing: chk.missing });
        }
      } catch (e) {
        logger.warn('artifact 读取失败（校验跳过）', { path: req.artifactPath, err: (e as Error).message });
      }
    }
    const stageData = (extra?: Partial<TaskStageData>): TaskStageData => ({ task: taskAfter, ...(artifactCheck ? { artifactCheck } : {}), ...extra });

    // task 已 done / failed → 没有 gate 要触发
    if (taskAfter.status !== 'running') {
      sendOk<TaskStageData>(sock, stageData());
      sock.end();
      return;
    }

    // 检查是否有 after-<stage> gate
    const gateName = `after-${req.name}`;
    if (!taskAfter.gates.includes(gateName)) {
      sendOk<TaskStageData>(sock, stageData());
      sock.end();
      return;
    }

    // gate 触发：标记 awaiting-gate + 创建 approval，等用户响应
    await markGateWait(taskAfter.taskId, gateName);
    const lastStage = taskAfter.stageHistory.find((s) => eqStage(s.name, req.name));
    const summaryText = lastStage?.summary ?? '(无 stage 摘要)';
    const artifactLine = lastStage?.artifactPath ? `\n📄 产出：${lastStage.artifactPath}` : '';

    // artifact 预览（前 40 行 / 2000 字）给 gate 卡 —— 复用上面已读的内容
    let artifactPreview: string | undefined;
    if (artifactContent !== undefined) {
      const lines = artifactContent.split('\n').slice(0, 40);
      let preview = lines.join('\n');
      if (preview.length > 2000) preview = preview.slice(0, 2000) + '\n…';
      artifactPreview = preview;
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
    gateContext.currentStageIdx = taskAfter.stageHistory.findIndex((s) => eqStage(s.name, req.name));

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
    sendOk<TaskStageData>(sock, { task: finalTask, ...(artifactCheck ? { artifactCheck } : {}), gateResolved });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

/**
 * Task 工具 PreToolUse hook 触发的自动 --start：反查本 tab 的 active SOP task，
 * 若 subagent 是它的 pending stage 则 markStageStart（框架强制打点，不靠主 agent 自觉）。
 * 幂等 + 静默：非 SOP tab / subagent 非 pending stage / 反查失败 → 直接 no-op 返回 ok。
 */
async function handleTaskStageAuto(
  sock: Socket,
  req: Extract<Request, { op: 'task.stageAuto' }>,
) {
  try {
    const tab = await resolveOriginTab(req.originPid, req.originCwd);
    if (!tab) { sendOk<TaskStageAutoData>(sock, { matched: false }); sock.end(); return; }
    const tasks = await listTasks({ tty: tab.tty });
    const active = tasks.find((t) => t.status !== 'done' && t.status !== 'failed');
    if (!active) { sendOk<TaskStageAutoData>(sock, { matched: false }); sock.end(); return; }
    // subagent 必须是本 task 的一个 pending stage（已 start/done/skipped 的不重复；非 stage 的 ad-hoc Task 忽略）
    const stage = active.stageHistory.find((s) => eqStage(s.name, req.subagent) && s.status === "pending");
    if (!stage) { sendOk<TaskStageAutoData>(sock, { matched: false }); sock.end(); return; }
    const task = await markStageStart(active.taskId, req.subagent);
    logger.info('task stage auto-started (Task hook)', { taskId: active.taskId, stage: req.subagent, tty: tab.tty });
    sendOk<TaskStageAutoData>(sock, { matched: true, ...(task ? { task } : {}) });
  } catch (e) {
    sendErr(sock, (e as Error).message);
  }
  sock.end();
}

/**
 * SOP 计划确认：主 claude 定完 skip 后调，把"将跑/跳过（含原因）"自动从 task 状态生成 → 推飞书
 * 审批卡，短超时（默认 45s）可否决。批准/超时 → proceed；拒绝 → adjust（主 agent 重规划）。
 * 复用 approval 机制（timeout=neutral，不算拒绝）。
 */
async function handleTaskPlanReview(
  sock: Socket,
  req: Extract<Request, { op: 'task.planReview' }>,
) {
  try {
    const task = await getTask(req.taskId);
    if (!task) { sendErr(sock, `task 不存在：${req.taskId}`); sock.end(); return; }
    const willRun = task.stageHistory.filter((s) => s.status !== 'skipped').map((s) => s.name);
    const skipped = task.stageHistory.filter((s) => s.status === 'skipped');
    const body = [
      `将跑（${willRun.length}）：${willRun.join(' → ') || '(无)'}`,
      skipped.length
        ? `跳过（${skipped.length}）：\n${skipped.map((s) => `  • ${s.name} — ${s.note ?? s.summary ?? '主 agent 判断不必要'}`).join('\n')}`
        : '跳过：无',
      '',
      '✅ 批准 / 超时 → 开工；❌ 拒绝 → 让主 agent 重新规划要跑哪些 stage',
    ].join('\n');
    const { result } = await approvals.create({
      title: `SOP 计划确认 · ${task.taskId}`,
      body,
      taskId: req.taskId,
      chatId: task.chatId,
      timeoutMs: req.timeoutMs ?? 45_000,
    });
    const final = await result;
    const approvalStatus = (final.status === 'approved' || final.status === 'rejected' || final.status === 'timeout')
      ? final.status : 'timeout';
    const decision: 'proceed' | 'adjust' = approvalStatus === 'rejected' ? 'adjust' : 'proceed';
    sendOk<TaskPlanReviewData>(sock, { decision, approvalStatus });
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
    // fire-and-forget refresh
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
      // 检查冲突（overwrite=true 时跳过检查）
      if (!req.overwrite) {
        const existing = await getSubagent(s.name, opts);
        if (existing) {
          skipped.push({ name: s.name, reason: `已存在于 ${existing.location}: ${existing.filePath}` });
          continue;
        }
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
    // 若有真新增，刷新一次 claude tab 的 subagent 缓存
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
    case 'tab.restart-claude':
      return handleTabRestartClaude(sock, req);
    case 'tapd.stage':
      return handleTapdStage(sock, req);
    case 'tab.recent-cwds':
      return handleTabRecentCwds(sock);
    case 'tab.screen':
      return handleTabScreen(sock, req);
    case 'tab.keys':
      return handleTabKeys(sock, req);
    case 'chat.get':
      return handleChatGet(sock, req);
    case 'chat.set-active':
      return handleChatSetActive(sock, req);
    case 'lark.send-text':
      return handleLarkSendText(sock, req);
    case 'ask.disarm':
      return handleAskDisarm(sock, req);
    case 'permission.gate':
      return handlePermissionGate(sock, req);
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
    case 'lark.ask':
      return handleLarkAsk(sock, req);
    case 'wecom.send-text':
      return handleWeComSendText(sock, req);
    case 'wecom.send-file':
      return handleWeComSendFile(sock, req);
    case 'wecom.send-image':
      return handleWeComSendImage(sock, req);
    case 'wecom.resolve-chat':
      return handleWeComResolveChat(sock, req);
    case 'wecom.ask':
      return handleWeComAsk(sock, req);
    case 'knowledge.stats':
      return handleKnowledgeStats(sock);
    case 'knowledge.list':
      return handleKnowledgeList(sock, req);
    case 'knowledge.extract-last':
      return handleKnowledgeExtractLast(sock, req);
    case 'task.create':
      return handleTaskCreate(sock, req);
    case 'task.get':
      return handleTaskGet(sock, req);
    case 'task.list':
      return handleTaskList(sock, req);
    case 'task.stage':
      return handleTaskStage(sock, req);
    case 'task.stageAuto':
      return handleTaskStageAuto(sock, req);
    case 'task.planReview':
      return handleTaskPlanReview(sock, req);
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

export async function startControlServer(
  client?: Lark.Client,
  wecom?: IMTransport,
): Promise<void> {
  if (client) larkClient = client;
  if (wecom) wecomTransport = wecom;
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

