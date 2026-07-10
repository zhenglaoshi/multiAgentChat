import { basename } from 'node:path';
import { homedir } from 'node:os';
import * as Lark from '@larksuiteoapi/node-sdk';
import { approvals, asks } from 'multiagent-orchestrator';
import type { ApprovalRequest, AskRequest } from 'multiagent-orchestrator';
import { listAllChats, loadChat } from '../chats/store.js';
import { patchCard, sendCardMessage, sendCardReturnId } from '../lark/api.js';
import {
  approvalCard,
  askCard,
  batchProgressCard,
  chainProgressCard,
  progressCard,
  stageGateCard,
  waitingInputCard,
  type BatchTaskItem,
  type ChainStepItem,
  type StageGateCardData,
} from '../lark/cards.js';
import { dispatchChainStep } from '../lark/handlers.js';
import { logger } from 'multiagent-orchestrator';
import { memoryStore } from 'multiagent-orchestrator';
import { tokenize } from 'multiagent-orchestrator';
import type { TaskMemory } from 'multiagent-orchestrator';
import type { TerminalTab } from 'multiagent-host-mac';
import { chainManager, type ChainState } from './chains.js';
import { pendingTracker, type PendingOutput } from './pending.js';
import { sanitizeTerminalOutput } from './sanitize.js';
import { watcher } from './watcher.js';
import { taskEvents } from 'multiagent-orchestrator';
import type { StageRecord, TaskState } from 'multiagent-orchestrator';
import { buildStageProgressCardFromTask } from '../lark/task-render.js';

// 单卡输出预览的"行/字符"上限——避免卡片占满半屏
// 净化后（ANSI/TUI 重绘剥离）冗余内容少了很多，因此可以给更宽的窗口
const CARD_TAIL_MAX_LINES = 30;
const CARD_TAIL_MAX_CHARS = 3000;

/**
 * 把任务输出截到适合卡片显示的尺寸：
 *   1. 先跑 ANSI/TUI 净化（去转义、\r 折叠、同行去重）
 *   2. 再按行/字符双重 cap 截尾
 *   3. 空时返回等待提示
 */
function trimTailForCard(s: string): string {
  const clean = sanitizeTerminalOutput(s ?? '').trimEnd();
  if (!clean) return '(等待输出…)';
  const lines = clean.split('\n');
  const tailLines =
    lines.length > CARD_TAIL_MAX_LINES
      ? lines.slice(-CARD_TAIL_MAX_LINES)
      : lines;
  let out = tailLines.join('\n');
  if (out.length > CARD_TAIL_MAX_CHARS) {
    out = '…' + out.slice(-CARD_TAIL_MAX_CHARS);
  }
  return out;
}

// Batch 聚合卡 patch 节流：每个 batch 最少间隔 N ms
// 800ms 让 batch 卡也跟得上 1s poll 的节奏；final 状态无视节流强制 patch
const BATCH_PATCH_THROTTLE_MS = 800;
const lastBatchPatchAt = new Map<string, number>();
const batchItemsState = new Map<string, BatchTaskItem[]>(); // batchId → 已记录的所有 task items

/**
 * 聚合渲染一个 batch 的所有 task → patch 同一张 batchProgressCard。
 * 节流避免 N 个 task 每秒 emit 多次时刷飞书 patch API。
 */
async function maybePatchBatchCard(
  pending: PendingOutput,
  status: BatchTaskItem['status'],
  outputTailShort: string,
): Promise<void> {
  if (!client || !pending.batchId || !pending.batchMessageId) return;
  const batchId = pending.batchId;
  const now = Date.now();
  const lastAt = lastBatchPatchAt.get(batchId) ?? 0;

  // 更新该 batch 内此 task 的最新状态
  const items = batchItemsState.get(batchId) ?? [];
  const existIdx = items.findIndex((i) => i.tty === pending.tty);
  const updatedItem: BatchTaskItem = {
    target: pending.targetLabel ?? pending.tty.replace('/dev/', ''),
    tty: pending.tty,
    taskDescription: pending.taskDescription,
    status,
    outputTailShort: outputTailShort.split('\n').slice(-6).join('\n'),
    startedAt: pending.sentAt,
    ...(status === 'done' || status === 'failed' || status === 'cancelled'
      ? { endedAt: now }
      : {}),
  };
  if (existIdx >= 0) items[existIdx] = updatedItem;
  else items.push(updatedItem);
  batchItemsState.set(batchId, items);

  // 节流：刚 patch 过的话跳过本次（但 final 状态强制 patch）
  const isFinal =
    status === 'done' || status === 'failed' || status === 'cancelled';
  if (!isFinal && now - lastAt < BATCH_PATCH_THROTTLE_MS) {
    return;
  }
  lastBatchPatchAt.set(batchId, now);

  const startedAt = Math.min(...items.map((i) => i.startedAt ?? now));
  try {
    await patchCard(
      client,
      pending.batchMessageId,
      batchProgressCard({
        batchId,
        items,
        startedAt,
        updatedAt: now,
        home: homedir(),
      }),
    );
  } catch (e) {
    logger.warn('batch card patch failed', {
      batchId,
      err: (e as Error).message,
    });
  }
}

/**
 * 把 chainManager.ChainState patch 回飞书 chain 卡。
 * 在 chainManager.events 'updated' 触发时一次性 patch（已是离散事件，无需节流）。
 */
async function patchChainCardFor(chain: ChainState): Promise<void> {
  if (!client || !chain.messageId) return;
  const items = chain.steps.map<ChainStepItem>((s) => {
    const item: ChainStepItem = {
      target: s.target,
      prompt: s.prompt,
      status: s.status,
    };
    if (s.tty) item.tty = s.tty;
    if (s.startedAt) item.startedAt = s.startedAt;
    if (s.endedAt) item.endedAt = s.endedAt;
    if (s.outputTailShort) item.outputTailShort = s.outputTailShort;
    if (s.failureReason) item.failureReason = s.failureReason;
    return item;
  });
  try {
    await patchCard(
      client,
      chain.messageId,
      chainProgressCard({
        chainId: chain.id,
        steps: items,
        status: chain.status,
        createdAt: chain.createdAt,
        updatedAt: Date.now(),
        ...(chain.endedAt ? { endedAt: chain.endedAt } : {}),
      }),
    );
  } catch (e) {
    logger.warn('chain card patch failed', {
      chainId: chain.id,
      err: (e as Error).message,
    });
  }
}

/** 从输出 tail 启发式提取文件路径（含 / 的看起来像路径的 token） */
function extractFilesFromOutput(text: string): string[] {
  const found = new Set<string>();
  // 匹配类似 /Users/.../foo.xlsx, data/foo.xlsx, ./out.txt
  const re = /(?<![a-zA-Z0-9_/])((?:~?\/|\.\/)?(?:[\w.-]+\/)+[\w.-]+\.[a-zA-Z0-9]{1,8})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    found.add(m[1]!);
    if (found.size >= 5) break;
  }
  return Array.from(found);
}

async function persistTaskMemory(
  pending: PendingOutput,
  tab: TerminalTab,
  taskOnlyTail: string,
): Promise<void> {
  const prompt = pending.originalPrompt ?? pending.taskDescription;
  // 用 taskOnlyTail（仅本任务新增）抓文件，避免抓到历史 scrollback 里的 noise
  // 先净化 ANSI/TUI 再抽路径 & 存 preview，否则 memory recall 出来一堆转义字符
  const cleanTail = sanitizeTerminalOutput(taskOnlyTail);
  const filesProduced = extractFilesFromOutput(cleanTail);
  const tags = tokenize(prompt).slice(0, 12);
  const id = `mem-${pending.sentAt.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  // 优先用 pending.cwd（任务发起时记录）；缺省 fallback tab.cwd（watcher 可能没拿到）
  const cwd = pending.cwd ?? tab.cwd ?? '';
  const memory: TaskMemory = {
    id,
    chatId: pending.chatId,
    tty: tab.tty,
    cwd,
    prompt,
    outputPreview: cleanTail.slice(-500),
    ...(filesProduced.length ? { filesProduced } : {}),
    tags,
    startedAt: pending.sentAt,
    endedAt: Date.now(),
    durationMs: Date.now() - pending.sentAt,
    source: pending.source ?? 'feishu',
  };
  try {
    await memoryStore.append(memory);
    logger.info('memory persisted', {
      id: memory.id,
      tty: memory.tty,
      tags: memory.tags.slice(0, 5),
      files: memory.filesProduced?.length ?? 0,
    });
  } catch (e) {
    logger.warn('memory persist failed', { err: (e as Error).message });
  }
}

let client: Lark.Client | null = null;

async function pushCardToAllChats(card: unknown): Promise<void> {
  if (!client) return;
  const chats = await listAllChats();
  if (chats.length === 0) {
    logger.warn('watcher: no chats to notify');
    return;
  }
  for (const c of chats) {
    try {
      await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: c.chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
    } catch (e) {
      logger.warn('notify failed', { chatId: c.chatId, err: (e as Error).message });
    }
  }
}

export function attachWatcherToLark(larkClient: Lark.Client): void {
  client = larkClient;
  watcher.events.on(
    'needsInput',
    ({ tab, promptSnippet }: { tab: TerminalTab; promptSnippet: string }) => {
      const card = waitingInputCard({
        tty: tab.tty,
        title: tab.title ?? '',
        cwd: tab.cwd ?? '?',
        promptSnippet,
        home: homedir(),
      });
      void pushCardToAllChats(card);
    },
  );
  watcher.events.on('resolved', ({ tty }: { tty: string }) => {
    logger.info('tab resolved', { tty });
  });

  // chain 状态变化 → patch 整张 chain 卡
  chainManager.events.on('updated', (chain: ChainState) => {
    void patchChainCardFor(chain);
  });
  watcher.events.on(
    'taskOutput',
    async ({
      pending,
      tab,
      outputTail,
      taskOnlyTail,
      isFinal,
    }: {
      pending: PendingOutput;
      tab: TerminalTab;
      output: string;
      outputTail: string;
      taskOnlyTail: string;
      isFinal: boolean;
    }) => {
      if (!client) return;

      // chain 路径：在 isFinal 时把当前 step 标 done → 触发下一步 dispatch；
      // patch chain 卡的工作交给 chainManager.events 'updated' 监听
      if (pending.chainId !== undefined && pending.chainStepIndex !== undefined) {
        if (isFinal) {
          const { next, chainDone } = chainManager.markStepDone(
            pending.chainId,
            pending.chainStepIndex,
            sanitizeTerminalOutput(taskOnlyTail || outputTail || ''),
          );
          if (next && !chainDone) {
            logger.info('chain advance', {
              chainId: pending.chainId,
              nextIndex: next.index,
              nextTarget: next.target,
            });
            void dispatchChainStep(
              client,
              { messageId: 'chain-advance', chatId: pending.chatId },
              pending.chainId,
              next.index,
            ).catch((e) => {
              logger.error('dispatchChainStep failed', e);
              chainManager.markStepFailed(
                pending.chainId!,
                next.index,
                `dispatch failed: ${(e as Error).message}`,
              );
            });
          }
        }
        // chain step 运行中也不 patch 单卡（chainManager 'updated' 会触发整卡 patch）
      } else if (pending.batchId && pending.batchMessageId) {
        // 批量任务路径：patch 共享聚合卡（节流），不走独立卡逻辑
        // 用 taskOnlyTail（只本任务新增）避免在卡片里展示之前 scrollback 的历史
        // 静默模式下也跳中途 patch，只在 isFinal 更新聚合卡
        let quietMode = false;
        try {
          const chatState = await loadChat(pending.chatId);
          quietMode = chatState.quietMode === true;
        } catch { /* ignore */ }
        if (quietMode && !isFinal) return;
        const batchStatus = isFinal ? 'done' : 'running';
        await maybePatchBatchCard(
          pending,
          batchStatus,
          sanitizeTerminalOutput(taskOnlyTail || ''),
        );
      } else {
        // 单任务/独立卡路径
        let isActiveForChat = false;
        let quietMode = false;
        try {
          const chatState = await loadChat(pending.chatId);
          isActiveForChat = chatState.activeTty === tab.tty;
          quietMode = chatState.quietMode === true;
        } catch {
          /* ignore */
        }
        // 静默模式（全局 chat.quietMode 或 单卡 pending.quietUntilDone）：
        // 中途 patch 全跳过，只保留 isFinal 的收尾卡
        if ((quietMode || pending.quietUntilDone) && !isFinal) {
          return;
        }
        // 卡片只展示「本次任务新增」的输出，不含历史 scrollback
        let tailForCard = trimTailForCard(taskOnlyTail || '');
        // claude TUI alt-screen 模式下 watcher 看不全屏幕；提示完整回复看 claude 主动推
        const isClaudeTab = tab.processes.some((p) =>
          /(^|\/)claude(-code)?$/i.test(p) || p.toLowerCase().includes('claude'),
        );
        if (isClaudeTab) {
          tailForCard +=
            '\n\n— TUI 屏幕飞书不可见；完整回复见 claude 主动 send-text 推送 —';
        }
        const card = progressCard({
          state: isFinal ? 'done' : 'running',
          tty: tab.tty,
          taskDescription: pending.taskDescription,
          ...(tab.cwd ? { cwd: tab.cwd } : {}),
          outputTail: tailForCard,
          startedAt: pending.sentAt,
          updatedAt: Date.now(),
          isActiveForChat,
          sentAt: pending.sentAt,
          quietUntilDone: pending.quietUntilDone === true,
          ...(pending.originalPrompt ? { rerunPrompt: pending.originalPrompt } : {}),
          ...(pending.targetLabel ? { rerunTargetLabel: pending.targetLabel } : {}),
          ...(pending.source ? { source: pending.source } : {}),
        });
        try {
          if (pending.progressMessageId) {
            await patchCard(client, pending.progressMessageId, card);
          } else {
            await sendCardMessage(client, pending.chatId, card);
          }
        } catch (e) {
          logger.warn('taskOutput patch/send failed', {
            err: (e as Error).message,
            chatId: pending.chatId,
          });
        }
      }
      // isFinal=true 时写入 memory（任务真正完成才记录）
      if (isFinal) {
        void persistTaskMemory(pending, tab, taskOnlyTail || outputTail);
      }
    },
  );
  watcher.events.on(
    'localTaskDetected',
    async ({
      tab,
      beforeLen,
      currentLen,
      outputTail,
    }: {
      tab: TerminalTab;
      beforeLen: number;
      currentLen: number;
      outputTail: string;
    }) => {
      if (!client) return;
      // 找所有开启了 watchAllTabs 的 chat
      const chats = await listAllChats();
      const watchers = chats.filter((c) => c.watchAllTabs === true);
      if (watchers.length === 0) return;

      const dirName = tab.cwd ? basename(tab.cwd) : '';
      const taskDescription = `🏠 本地${dirName ? ` @${dirName}` : ''}`;
      const home = homedir();

      const cleanTail = sanitizeTerminalOutput(outputTail);
      for (const chat of watchers) {
        try {
          const isActiveForChat = chat.activeTty === tab.tty;
          const now = Date.now();
          const cardData: Parameters<typeof progressCard>[0] = {
            state: 'running',
            tty: tab.tty,
            taskDescription,
            outputTail: cleanTail,
            startedAt: now,
            updatedAt: now,
            isActiveForChat,
            source: 'local',
            sentAt: now,
          };
          if (tab.cwd) cardData.cwd = tab.cwd;
          const card = progressCard(cardData);
          const messageId = await sendCardReturnId(client, chat.chatId, card);
          pendingTracker.add({
            tty: tab.tty,
            ...(tab.cwd ? { cwd: tab.cwd } : {}),
            chatId: chat.chatId,
            sentAt: Date.now(),
            beforeLen,
            lastPushedLen: beforeLen,
            beforeCharLen: outputTail.length,
            lastSeenCharLen: outputTail.length,
            taskDescription,
            source: 'local',
            progressMessageId: messageId,
          });
          logger.info('local task → pending created', {
            tty: tab.tty,
            chatId: chat.chatId,
            messageId,
          });
        } catch (e) {
          logger.warn('localTaskDetected push failed', {
            chatId: chat.chatId,
            err: (e as Error).message,
          });
        }
      }
      void home;
    },
  );
  watcher.events.on('error', (err: Error) => {
    logger.warn('watcher error', { err: err.message });
  });

  // ---- 审批生命周期：created → 发卡片 + 存 messageId；resolved → patch 卡片 ----
  // gate-context 走专属 stageGateCard，否则通用 approvalCard
  const buildApprovalCardForReq = (req: ApprovalRequest): unknown => {
    if (req.gateContext) {
      const data: StageGateCardData = {
        approvalId: req.id,
        taskId: req.gateContext.taskId,
        stageName: req.gateContext.stageName,
        gateName: req.gateContext.gateName,
        status: req.status,
        createdAt: req.createdAt,
      };
      if (req.gateContext.presetName) data.presetName = req.gateContext.presetName;
      if (req.gateContext.stageSummary) data.stageSummary = req.gateContext.stageSummary;
      if (req.gateContext.artifactPath) data.artifactPath = req.gateContext.artifactPath;
      if (req.gateContext.artifactPreview) data.artifactPreview = req.gateContext.artifactPreview;
      if (req.gateContext.allStages) data.allStages = req.gateContext.allStages;
      if (typeof req.gateContext.currentStageIdx === 'number') {
        data.currentStageIdx = req.gateContext.currentStageIdx;
      }
      if (req.resolvedBy) data.resolvedBy = req.resolvedBy;
      if (req.resolvedAt) data.resolvedAt = req.resolvedAt;
      return stageGateCard(data);
    }
    return approvalCard(req);
  };

  approvals.events.on('created', async (req: ApprovalRequest) => {
    if (!client) return;
    if (!req.chatId) {
      logger.warn('approval has no chatId, skipping push', { id: req.id });
      return;
    }
    try {
      const messageId = await sendCardReturnId(
        client,
        req.chatId,
        buildApprovalCardForReq(req),
      );
      approvals.setCardMessageId(req.id, messageId);
      logger.info('approval card sent', {
        id: req.id,
        messageId,
        gate: req.gateContext ? req.gateContext.gateName : undefined,
      });
    } catch (e) {
      logger.warn('approval card send failed', {
        id: req.id,
        chatId: req.chatId,
        err: (e as Error).message,
      });
    }
  });

  approvals.events.on('resolved', async (req: ApprovalRequest) => {
    if (!client) return;
    if (!req.cardMessageId) {
      logger.warn('approval resolved but no cardMessageId', { id: req.id });
      return;
    }
    try {
      await patchCard(client, req.cardMessageId, buildApprovalCardForReq(req));
      logger.info('approval card patched (resolved)', {
        id: req.id,
        status: req.status,
      });
    } catch (e) {
      logger.warn('approval card patch failed', {
        id: req.id,
        err: (e as Error).message,
      });
    }
  });

  // ---- Ask 生命周期：created → 发交互卡片；resolved → patch（兜底 timeout 场景） ----
  asks.events.on('created', async (req: AskRequest) => {
    if (!client) return;
    try {
      const messageId = await sendCardReturnId(client, req.chatId, askCard(req));
      asks.setCardMessageId(req.id, messageId);
      logger.info('ask card sent', { id: req.id, type: req.type, messageId });
    } catch (e) {
      logger.warn('ask card send failed', {
        id: req.id,
        chatId: req.chatId,
        err: (e as Error).message,
      });
    }
  });

  asks.events.on('resolved', async (req: AskRequest) => {
    if (!client) return;
    if (!req.cardMessageId) return;   // 已在 handleCardAction 里 patch 过或超时前根本没发出去
    try {
      await patchCard(client, req.cardMessageId, askCard(req));
    } catch (e) {
      logger.warn('ask card patch (resolved) failed', {
        id: req.id,
        err: (e as Error).message,
      });
    }
  });

  // ---- SOP task events → 实时 patch stageProgressCard ----
  const patchProgressCard = async (task: TaskState, reason: string): Promise<void> => {
    if (!client) return;
    if (!task.progressMessageId) {
      logger.warn('task event without progressMessageId', { taskId: task.taskId, reason });
      return;
    }
    try {
      await patchCard(
        client,
        task.progressMessageId,
        buildStageProgressCardFromTask(task, homedir()),
      );
    } catch (e) {
      logger.warn('stage progress card patch failed', {
        taskId: task.taskId,
        reason,
        err: (e as Error).message,
      });
    }
  };

  taskEvents.on('stage:start', ({ task, stage }: { task: TaskState; stage: StageRecord }) => {
    void patchProgressCard(task, `stage:start ${stage.name}`);
  });
  taskEvents.on('stage:end', ({ task, stage }: { task: TaskState; stage: StageRecord }) => {
    void patchProgressCard(task, `stage:end ${stage.name}`);
  });
  taskEvents.on('gate:wait', ({ task, gateName }: { task: TaskState; gateName: string }) => {
    void patchProgressCard(task, `gate:wait ${gateName}`);
  });
  taskEvents.on(
    'gate:resolve',
    ({ task, gateName, approved }: { task: TaskState; gateName: string; approved: boolean }) => {
      void patchProgressCard(task, `gate:resolve ${gateName} ${approved}`);
    },
  );
  taskEvents.on('stage:retry', ({ task, failedStage, retryFrom, retryCount, maxRetries }) => {
    void patchProgressCard(task, `stage:retry ${failedStage}→${retryFrom} ${retryCount}/${maxRetries}`);
  });
  taskEvents.on('stage:skipped', ({ task, stage, reason }) => {
    void patchProgressCard(task, `stage:skipped ${stage.name} reason=${reason}`);
  });
  taskEvents.on('task:done', (task: TaskState) => {
    void patchProgressCard(task, 'task:done');
  });
  taskEvents.on('task:failed', ({ task, reason }: { task: TaskState; reason: string }) => {
    void patchProgressCard(task, `task:failed ${reason}`);
  });
  taskEvents.on('task:aborted', ({ task, reason, hard }) => {
    void patchProgressCard(task, `task:aborted ${hard ? 'hard' : 'soft'} ${reason}`);
  });

  watcher.start();
}
