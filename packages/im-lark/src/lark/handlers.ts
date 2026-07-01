import * as Lark from '@larksuiteoapi/node-sdk';
import { approvals } from 'multiagent-orchestrator';
import { loadChat, saveChat } from '../chats/store.js';
import { logger } from 'multiagent-orchestrator';
import { recordCwd } from 'multiagent-host-mac';
import { formatRecallPrefix, recall, tokenize } from 'multiagent-orchestrator';
import { pendingTracker } from '../monitor/pending.js';
import { recordInbound } from '../monitor/ws-watchdog.js';
import { forceEnter, getHistory, listTabs, newTab, send, sendKeysRaw } from 'multiagent-host-mac';

// SYSTEM_GUIDANCE 的去重 — per-tab，每 tty 6h 内最多注入一次
// 这是 module-level 内存状态，dev 重启会清空（重启后第一次注入是合理的）
const SYSTEM_GUIDANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const systemGuidanceShownAt = new Map<string, number>();

const SYSTEM_GUIDANCE = [
  '[系统提示 - 自动注入]',
  '本对话来自飞书机器人 multiAgentChat。飞书侧通过 AppleScript 观测此 tab 的输出，但 **alt-screen TUI 模式下飞书看不见你的实时屏幕**。',
  '所以：',
  '- 任务完成时**必须**调用 `agent lark send-text "结果摘要..."` 主动推送到飞书',
  '- 长任务请每完成一步用 `agent lark send-text` 推送进度',
  '- 文件产出用 `agent lark send-file <path>` 推送文件本体',
  '- 高风险操作（写数据库 / git push --force / rm -rf / 改 .env）先 `agent request-approval --title --body` 等批准',
  '- 不要直接调任何 webhook（功能弱、不支持文件）',
  '',
].join('\n');

// 短提醒：claude TUI tab 每条消息末尾都注入（防止 6h 间隔的 SYSTEM_GUIDANCE 过期遗忘）
const CLAUDE_TUI_REMINDER = [
  '',
  '---',
  '⚠ 回到飞书 — 飞书看不见你的 TUI 屏幕。完成后必须 `agent lark send-text "<回复全文>"` 推送，否则用户看到的卡片只是 watcher 抓的残片。',
].join('\n');
import { sendCardReturnId } from './api.js';
import { ackCard, batchProgressCard, chainProgressCard, progressCard, type BatchTaskItem, type ChainStepItem } from './cards.js';
import { parseMessage, resolveTarget } from './target.js';
import { chainManager } from '../monitor/chains.js';

interface BatchInfo {
  batchId: string;
  batchMessageId: string;
  total: number;
}

interface ChainInfo {
  chainId: string;
  chainStepIndex: number;
}
import { handleCommand, isCommand, type ReplyAction, type SopActionData } from './commands.js';
import { replyText, sendText } from './reply.js';
import { createTask, generateTaskId, listTasks, markTaskAborted, setTaskProgressMessageId } from 'multiagent-orchestrator';
import { buildSopWrapperPrompt } from 'multiagent-orchestrator';
import { buildStageProgressCardFromTask } from './task-render.js';
import { homedir } from 'node:os';

interface MessageReceiveEvent {
  message: {
    message_id: string;
    chat_id: string;
    message_type: string;
    content: string;
  };
  sender: { sender_id?: { open_id?: string } };
}

interface CardActionEvent {
  schema?: string;
  action?: {
    value?: Record<string, unknown>;
    option?: string;       // select_static 选中的 option value
    tag?: string;
  };
  // schema 1.x（旧）：顶层
  open_chat_id?: string;
  open_message_id?: string;
  // schema 2.0：放在 context 里
  context?: {
    open_chat_id?: string;
    open_message_id?: string;
  };
  operator?: { open_id?: string };
}

function getChatId(data: CardActionEvent): string | undefined {
  return data.context?.open_chat_id ?? data.open_chat_id;
}

/**
 * 提取 prompt 的"标题"作为任务描述：
 *  - 如果第一行短且单独（≤ 80 字），用第一行
 *  - 否则前 80 字
 */
function extractTaskTitle(prompt: string): string {
  const trimmed = prompt.trim();
  const newline = trimmed.indexOf('\n');
  if (newline > 0 && newline <= 80) {
    const first = trimmed.slice(0, newline).trim();
    if (first.length >= 3) return first;
  }
  if (trimmed.length <= 80) return trimmed;
  return trimmed.slice(0, 79) + '…';
}

function extractText(rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent) as { text?: string };
    return (parsed.text ?? '').replace(/@_user_\d+\s*/g, '').trim();
  } catch {
    return '';
  }
}

async function sendCard(
  client: Lark.Client,
  chatId: string,
  card: unknown,
): Promise<void> {
  await client.im.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    },
  });
}

async function executeReply(
  client: Lark.Client,
  ctx: { messageId: string; chatId: string },
  action: ReplyAction,
): Promise<void> {
  if (action.kind === 'text') {
    await replyText(client, ctx, action.text);
  } else if (action.kind === 'card') {
    await sendCard(client, ctx.chatId, action.card);
  } else if (action.kind === 'execute') {
    if (action.sop) {
      await dispatchSopExecute(client, ctx, action.text, action.sop);
      return;
    }
    // 把展开后的文本当作"用户刚发的消息"重新处理
    await replyText(client, ctx, `🚀 执行：\n${action.text.slice(0, 200)}${action.text.length > 200 ? '…' : ''}`);
    const parsed = parseMessage(action.text);
    if (parsed.targeted.length > 0) {
      for (const t of parsed.targeted) {
        void sendToNamedTarget(client, ctx, t.target, t.text).catch((e) => {
          logger.error('preset @target failed', e);
          void sendText(client, ctx.chatId, `❌ @${t.target} 失败：${(e as Error).message}`);
        });
      }
    } else {
      void sendToActiveTab(client, ctx, parsed.fallback ?? action.text).catch((e) => {
        logger.error('preset active failed', e);
        void sendText(client, ctx.chatId, `❌ 失败：${(e as Error).message}`);
      });
    }
  } else if (action.kind === 'gen-subagent') {
    await dispatchGenSubagent(client, ctx, action.desc);
  }
}

/**
 * /subagent gen <desc> 触发的分派：
 * 派一段特殊 prompt 给 active tab 的主 claude，让它输出结构化 JSON 后调
 * `agent subagent gen-submit` 交回框架落盘。
 */
async function dispatchGenSubagent(
  client: Lark.Client,
  ctx: { messageId: string; chatId: string },
  desc: string,
): Promise<void> {
  const chat = await loadChat(ctx.chatId);
  if (!chat.activeTty) {
    await replyText(
      client,
      ctx,
      '❌ 本会话没有 active tab 可派发。\n先 `/shells` 选一个或 `/use ttysXXX`。',
    );
    return;
  }
  const tabs = await listTabs();
  const tab = tabs.find((t) => t.tty === chat.activeTty);
  if (!tab) {
    await replyText(client, ctx, `❌ ★ ${chat.activeTty} 在 Terminal 已不存在`);
    return;
  }
  const sessionId = `sagen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const prompt = [
    `🛠 [Subagent 生成任务]`,
    `session: ${sessionId}`,
    `chat-id: ${ctx.chatId}`,
    ``,
    `用户想为下面这个域自动创建一套 subagent：`,
    ``,
    `**${desc}**`,
    ``,
    `请分析这个域，产出结构化 JSON（建议 2-5 个 subagent，可选一个组合 template）：`,
    ``,
    '```json',
    `{`,
    `  "subagents": [`,
    `    {`,
    `      "name": "kebab-case-name",           // [a-z][a-z0-9-]{1,62}`,
    `      "description": "一句话职责（≤80字）",`,
    `      "tools": ["Bash", "Read"],            // 见下面白名单`,
    `      "model": "sonnet",                    // sonnet / haiku / opus`,
    `      "color": "purple",                    // red/orange/yellow/green/blue/purple/pink/cyan/grey`,
    `      "body": "You are ..."                 // 完整 system prompt，可多行`,
    `    }`,
    `  ],`,
    `  "template": {                             // 可选`,
    `    "name": "workflow-name",                // 同 subagent 命名规则`,
    `    "prompt": "帮我处理 {task}",             // 支持 {var} 占位符`,
    `    "stages": ["subagent1", "subagent2"],   // 必须指向刚定义的 subagent`,
    `    "gates": ["after-subagent1"]             // 可选，after-<stage>`,
    `  }`,
    `}`,
    '```',
    ``,
    `**工具白名单**：Read, Edit, Write, NotebookEdit, NotebookRead, Bash, Glob, Grep, LS, WebFetch, WebSearch, Task, TodoWrite`,
    ``,
    `**约束**：`,
    `- 每个 subagent 的 body 必须 ≥ 10 字符（真实的 system prompt，不是占位）`,
    `- 不要重复现有 subagent 名（先用 \`agent subagent list\` 看一眼）`,
    `- tools 只放真需要的（写代码给 Edit+Write+Bash；只查询给 Read+Grep+Glob；等等）`,
    `- template 是可选的；若域适合工作流才产`,
    ``,
    `**输出方式**（务必按这个走，别自己写 .md 文件）：`,
    ``,
    `\`\`\`bash`,
    `agent subagent gen-submit \\`,
    `  --task-id ${sessionId} \\`,
    `  --chat ${ctx.chatId} \\`,
    `  --body '<把上面 JSON 压成单行贴这里>'`,
    `\`\`\``,
    ``,
    `framework 会解析、校验、逐个落盘到 \`~/.claude/agents/\`（冲突会跳过），并推消息到飞书告诉用户结果。你完成 gen-submit 后**不用**再发飞书消息，framework 会推送。`,
  ].join('\n');

  await replyText(
    client,
    ctx,
    `🎨 派发 subagent 生成任务到 ${tab.tty}\nsession: \`${sessionId}\`\n等主 claude 完成 gen-submit...`,
  );

  await dispatchSendToTab(client, ctx, tab, prompt);
}

/**
 * SOP 模式分发：
 *   1. 解析 @target（单 target 或 fallback active；不支持 chain/多 target）
 *   2. createTask 落盘
 *   3. 把 SOP 编排 wrapper 拼到 prompt 前面
 *   4. dispatchSendToTab 发到 tab
 */
async function dispatchSopExecute(
  client: Lark.Client,
  ctx: { messageId: string; chatId: string },
  text: string,
  sop: SopActionData,
): Promise<void> {
  const parsed = parseMessage(text);
  if (parsed.chain) {
    await replyText(client, ctx, '❌ SOP 模式不支持 chain (`>>`)，请单 target 触发');
    return;
  }
  if (parsed.targeted.length > 1) {
    await replyText(client, ctx, '❌ SOP 模式不支持多 @target，请单 target 触发');
    return;
  }

  let tab: Awaited<ReturnType<typeof listTabs>>[number] | undefined;
  let targetLabel: string | undefined;
  let promptForTab: string;

  if (parsed.targeted.length === 1) {
    const t0 = parsed.targeted[0]!;
    const tabs = await listTabs();
    const resolved = resolveTarget(tabs, t0.target);
    if (!resolved) {
      await replyText(client, ctx, `❌ 找不到 @${t0.target} 对应的 tab`);
      return;
    }
    tab = resolved.tab;
    targetLabel = t0.target;
    promptForTab = t0.text;
  } else {
    const chat = await loadChat(ctx.chatId);
    if (!chat.activeTty) {
      await replyText(
        client,
        ctx,
        '本会话还没有 active tab，SOP 任务无法派发。\n用 `/shells` 选一个或 `@<target>` 指定。',
      );
      return;
    }
    const tabs = await listTabs();
    tab = tabs.find((t) => t.tty === chat.activeTty);
    if (!tab) {
      await replyText(client, ctx, `★ ${chat.activeTty} 在 Terminal 已不存在`);
      return;
    }
    promptForTab = parsed.fallback ?? text;
  }

  // precheck：目标 tab 已有未结束 SOP → 拒绝派发
  const [runningOnTab, gatedOnTab] = await Promise.all([
    listTasks({ status: 'running', tty: tab.tty }),
    listTasks({ status: 'awaiting-gate', tty: tab.tty }),
  ]);
  const conflicts = [...gatedOnTab, ...runningOnTab];
  if (conflicts.length > 0) {
    const lines = [`❌ ${tab.tty} 已经在跑 SOP：`];
    for (const t of conflicts) {
      const stageLabel =
        t.currentStageIdx < 0
          ? '(未开始)'
          : t.currentStageIdx >= t.stages.length
            ? '(全部完成)'
            : `stage ${t.currentStageIdx + 1}/${t.stages.length} ${t.stages[t.currentStageIdx]}`;
      lines.push(`  ${t.taskId} (${t.presetName ?? 'ad-hoc'}, ${stageLabel})`);
    }
    lines.push('');
    lines.push('中止后再发：');
    lines.push(`  /task abort ${conflicts[0]!.taskId}`);
    lines.push('或派别的 tab：');
    lines.push('  /run --sop @<其他 tty> ...');
    await replyText(client, ctx, lines.join('\n'));
    return;
  }

  // 1. 预生成 task-id（这样 artifactDir 能用上）
  const taskId = generateTaskId();
  const artifactDir = sop.artifactDir
    ? sop.artifactDir.replace('{task-id}', taskId)
    : `./docs/tasks/${taskId}`;

  // 2. 建 task 记录
  const task = await createTask({
    taskId,
    tty: tab.tty,
    cwd: tab.cwd ?? '',
    chatId: ctx.chatId,
    stages: sop.stages,
    gates: sop.gates,
    loops: sop.loops,
    artifactDir,
    userPrompt: sop.userPrompt,
    presetName: sop.presetName,
  });

  // 3. 发一张实时进度卡（后续 notifier 会监听 taskEvents patch 这张卡）
  try {
    const initialCard = buildStageProgressCardFromTask(task, homedir());
    const messageId = await sendCardReturnId(client, ctx.chatId, initialCard);
    if (messageId) {
      await setTaskProgressMessageId(task.taskId, messageId);
    }
  } catch (e) {
    logger.warn('SOP progress card send failed', { err: (e as Error).message });
    // 降级：发文本提示
    await replyText(
      client,
      ctx,
      `🎯 SOP 任务已派发 → ${tab.tty}\ntask-id: \`${task.taskId}\``,
    );
  }

  // 4. 包 SOP wrapper 发到 tab
  const wrapped = buildSopWrapperPrompt(task, promptForTab);
  await dispatchSendToTab(client, ctx, tab, wrapped, targetLabel);
}

async function sendToActiveTab(
  client: Lark.Client,
  ctx: { messageId: string; chatId: string },
  text: string,
): Promise<void> {
  logger.info('sendToActiveTab start', { chatId: ctx.chatId, textLen: text.length });
  const chat = await loadChat(ctx.chatId);
  if (!chat.activeTty) {
    logger.info('sendToActiveTab: no active tty');
    await replyText(
      client,
      ctx,
      '本会话还没有 active tab。\n发送 `/shells` 选一个，或 `/new` 开新的，\n或者用 `@<tty|name>` 直接发到任意 tab（不切 active）。',
    );
    return;
  }
  const tabs = await listTabs();
  const tab = tabs.find((t) => t.tty === chat.activeTty);
  if (!tab) {
    logger.info('sendToActiveTab: tab gone', { tty: chat.activeTty });
    await replyText(
      client,
      ctx,
      `★ ${chat.activeTty} 在 Terminal 已经不存在了。\n发送 \`/shells\` 重新选。`,
    );
    return;
  }
  await dispatchSendToTab(client, ctx, tab, text);
}

/**
 * 通过 @target 显式发到某个 tab（不改 active）。
 */
async function sendToNamedTarget(
  client: Lark.Client,
  ctx: { messageId: string; chatId: string },
  target: string,
  text: string,
  batchInfo?: BatchInfo,
): Promise<void> {
  const tabs = await listTabs();
  const resolved = resolveTarget(tabs, target);
  if (!resolved) {
    await replyText(
      client,
      ctx,
      `❌ 找不到 @${target} 对应的 tab\n发 \`/s\` 看所有 tab；目标可以是 \`ttys001\` / \`title\` / cwd 末尾的目录名`,
    );
    return;
  }
  await dispatchSendToTab(client, ctx, resolved.tab, text, target, batchInfo);
}

/**
 * 批量任务：发一张聚合卡占位 + 所有 task pending 共享 batchMessageId。
 */
async function handleBatch(
  client: Lark.Client,
  ctx: { messageId: string; chatId: string },
  targeted: Array<{ target: string; text: string }>,
): Promise<void> {
  const batchId = `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
  const now = Date.now();
  // 占位卡片
  const items: BatchTaskItem[] = targeted.map((t) => ({
    target: t.target,
    taskDescription: t.text.slice(0, 80),
    status: 'pending' as const,
  }));
  let batchMessageId: string;
  try {
    batchMessageId = await sendCardReturnId(
      client,
      ctx.chatId,
      batchProgressCard({
        batchId,
        items,
        startedAt: now,
        updatedAt: now,
        home: process.env['HOME'] ?? '',
      }),
    );
    logger.info('batch progress card sent', { batchId, batchMessageId, count: targeted.length });
  } catch (e) {
    logger.warn('batch card send failed', { err: (e as Error).message });
    // fallback: 逐个发独立卡（退化为非批量行为）
    for (const t of targeted) {
      void sendToNamedTarget(client, ctx, t.target, t.text);
    }
    return;
  }
  const batchInfo: BatchInfo = { batchId, batchMessageId, total: targeted.length };
  for (const t of targeted) {
    void sendToNamedTarget(client, ctx, t.target, t.text, batchInfo).catch((e) => {
      logger.error('batch sendToNamedTarget failed', { target: t.target, err: (e as Error).message });
    });
  }
}

/**
 * 链式任务：`@a X >> @b Y >> @c Z` → A 完成才触发 B。
 * 在 chainManager 里登记整链 state，发一张共享 chain 卡，dispatch 第 1 步。
 * 后续步骤由 watcher/notifier 在 isFinal 时调用 dispatchChainStep 推进。
 */
export async function handleChain(
  client: Lark.Client,
  ctx: { messageId: string; chatId: string },
  chainSteps: { target: string; prompt: string }[],
): Promise<void> {
  const chain = chainManager.create({ chatId: ctx.chatId, steps: chainSteps });
  const now = Date.now();

  // 发占位 chain 进度卡
  try {
    const messageId = await sendCardReturnId(
      client,
      ctx.chatId,
      chainProgressCard({
        chainId: chain.id,
        steps: chain.steps.map<ChainStepItem>((s) => ({
          target: s.target,
          prompt: s.prompt,
          status: s.status,
        })),
        status: 'running',
        createdAt: chain.createdAt,
        updatedAt: now,
      }),
    );
    chainManager.setMessageId(chain.id, messageId);
    logger.info('chain card sent', { chainId: chain.id, messageId, steps: chain.steps.length });
  } catch (e) {
    logger.warn('chain card send failed', { err: (e as Error).message });
    void sendText(client, ctx.chatId, `❌ chain 启动失败：${(e as Error).message}`);
    return;
  }

  // dispatch 第 1 步
  await dispatchChainStep(client, ctx, chain.id, 0);
}

/**
 * 推进 chain 的第 N 步。
 * 解析 target → dispatchSendToTab；解析失败 → markStepFailed（终止链）。
 */
export async function dispatchChainStep(
  client: Lark.Client,
  ctx: { messageId: string; chatId: string },
  chainId: string,
  stepIndex: number,
): Promise<void> {
  const chain = chainManager.get(chainId);
  if (!chain) {
    logger.warn('dispatchChainStep: chain not found', { chainId });
    return;
  }
  if (chain.status !== 'running') {
    logger.info('dispatchChainStep: chain not running, skip', { chainId, status: chain.status });
    return;
  }
  const step = chain.steps[stepIndex];
  if (!step) {
    logger.warn('dispatchChainStep: step out of range', { chainId, stepIndex });
    return;
  }

  // resolveTarget
  const tabs = await listTabs();
  const resolved = resolveTarget(tabs, step.target);
  if (!resolved) {
    const reason = `找不到 @${step.target} 对应的 tab`;
    logger.warn('chain step target unresolved', { chainId, stepIndex, target: step.target });
    chainManager.markStepFailed(chainId, stepIndex, reason);
    return;
  }

  await dispatchSendToTab(
    client,
    ctx,
    resolved.tab,
    step.prompt,
    step.target,
    undefined,
    { chainId, chainStepIndex: stepIndex },
  );
}

async function dispatchSendToTab(
  client: Lark.Client,
  ctx: { messageId: string; chatId: string },
  tab: NonNullable<Awaited<ReturnType<typeof listTabs>>[number]>,
  text: string,
  targetLabel?: string,
  batchInfo?: BatchInfo,
  chainInfo?: ChainInfo,
): Promise<void> {
  logger.info('dispatchSendToTab', {
    tty: tab.tty,
    busy: tab.busy,
    hasTUI: tab.hasTUI,
    targetLabel,
    batchId: batchInfo?.batchId,
  });

  // 1. 系统指令前缀：仅每个 tab 首次 / 6h 一次（避免每条消息都 250 字头）
  const now = Date.now();
  const lastShownAt = systemGuidanceShownAt.get(tab.tty);
  const shouldInjectGuidance =
    lastShownAt === undefined || now - lastShownAt >= SYSTEM_GUIDANCE_INTERVAL_MS;
  const guidance = shouldInjectGuidance ? SYSTEM_GUIDANCE : '';
  if (shouldInjectGuidance) {
    systemGuidanceShownAt.set(tab.tty, now);
    logger.info('system guidance injected (first time / 6h+)', { tty: tab.tty });
  }

  // 2. 检索相关历史 → 注入
  let recallPrefix = '';
  try {
    const keywords = tokenize(text);
    const results = await recall({
      ...(tab.cwd ? { cwd: tab.cwd } : {}),
      keywords,
      limit: 3,
      minScore: 1.5,           // 提高门槛，避免跨任务噪音
    });
    recallPrefix = formatRecallPrefix(results);
    if (recallPrefix) {
      logger.info('context injected', {
        tty: tab.tty,
        hits: results.length,
        scores: results.map((r) => r.score.toFixed(2)),
      });
    }
  } catch (e) {
    logger.warn('recall failed', { err: (e as Error).message });
  }

  // claude TUI 检测前置 — 决定是否在 prompt 末尾追加短提醒
  const isClaudeTab = tab.processes.some((p) =>
    /(^|\/)claude(-code)?$/i.test(p) || p.toLowerCase().includes('claude'),
  );

  const finalText =
    guidance +
    (recallPrefix || (guidance ? '[本次任务]\n' : '')) +
    text +
    (isClaudeTab ? CLAUDE_TUI_REMINDER : '');

  const result = await send(tab.tty, finalText);
  logger.info('dispatchSendToTab: send result', { ok: result.ok, reason: result.reason, before: result.before });

  // 对 claude TUI tab 显式发 Return key 触发提交（do script 的 \n 在 claude prompt 里
  // 是 multi-line 换行，不是 Enter event，需要补发键盘事件）
  if (result.ok && isClaudeTab) {
    // do script 已经把字符送进去，等 0.4s 让字符进 claude 输入缓冲再补 Enter
    await new Promise((r) => setTimeout(r, 400));
    try {
      await forceEnter(tab.tty);
      logger.info('forceEnter sent', { tty: tab.tty });
    } catch (e) {
      logger.warn('forceEnter failed', { err: (e as Error).message });
    }
  }

  // 拿 send 后的初始 char len 作 baseline（用于 TUI 重绘变化检测）
  let beforeCharLen: number | undefined;
  try {
    const h = await getHistory(tab.tty);
    beforeCharLen = h.length;
  } catch {
    /* ignore */
  }
  if (!result.ok) {
    await sendText(client, ctx.chatId, `❌ ${result.reason}`);
    return;
  }

  // 不阻塞等输出 — 先发一张进度卡片，存 messageId；watcher 后续 patch 它
  if (result.before !== undefined) {
    const now = Date.now();
    const descPrefix = targetLabel ? `[@${targetLabel}] ` : '';
    const taskDescription = descPrefix + extractTaskTitle(text);
    let progressMessageId: string | undefined;
    // 批量或 chain：不发独立 progress card，共享聚合卡
    if (!batchInfo && !chainInfo) {
      try {
        let isActiveForChat = false;
        try {
          const chatState = await loadChat(ctx.chatId);
          isActiveForChat = chatState.activeTty === tab.tty;
        } catch {
          /* ignore */
        }
        const card = progressCard({
          state: 'running',
          tty: tab.tty,
          taskDescription,
          ...(tab.cwd ? { cwd: tab.cwd } : {}),
          outputTail: '(等待输出…)',
          startedAt: now,
          updatedAt: now,
          isActiveForChat,
        });
        progressMessageId = await sendCardReturnId(client, ctx.chatId, card);
        logger.info('progress card sent', {
          tty: tab.tty,
          messageId: progressMessageId,
        });
      } catch (e) {
        logger.warn('progress card send failed', { err: (e as Error).message });
      }
    }

    pendingTracker.add({
      tty: tab.tty,
      ...(tab.cwd ? { cwd: tab.cwd } : {}),
      chatId: ctx.chatId,
      sentAt: now,
      beforeLen: result.before,
      lastPushedLen: result.before,
      taskDescription,
      originalPrompt: text,
      source: 'feishu',
      ...(beforeCharLen !== undefined ? { beforeCharLen, lastSeenCharLen: beforeCharLen } : {}),
      ...(targetLabel ? { targetLabel } : {}),
      ...(progressMessageId ? { progressMessageId } : {}),
      ...(batchInfo
        ? { batchId: batchInfo.batchId, batchMessageId: batchInfo.batchMessageId }
        : {}),
      ...(chainInfo
        ? { chainId: chainInfo.chainId, chainStepIndex: chainInfo.chainStepIndex }
        : {}),
    });
    logger.info('dispatchSendToTab: added to pending', {
      tty: tab.tty,
      ...(chainInfo ? { chainId: chainInfo.chainId, step: chainInfo.chainStepIndex } : {}),
    });
    // 如果是 chain step：标记 running（patch chain 卡）
    if (chainInfo) {
      chainManager.markStepRunning(chainInfo.chainId, chainInfo.chainStepIndex, tab.tty);
    }
  }
}

async function handleCardAction(
  client: Lark.Client,
  data: CardActionEvent,
): Promise<{ toast?: { type: string; content: string }; card?: unknown } | undefined> {
  const value = data.action?.value ?? {};
  const action = value['action'] as string | undefined;
  logger.info('card action', { action, hasValue: Object.keys(value).length > 0 });
  logger.debug('card action full payload', data);
  const chatId = getChatId(data);
  if (!chatId) {
    logger.warn('card action: no open_chat_id', { keys: Object.keys(data) });
    return undefined;
  }

  if (action === 'use-tab') {
    const tty = value['tty'] as string | undefined;
    if (!tty) return { toast: { type: 'error', content: '缺 tty' } };
    const tabs = await listTabs();
    const tab = tabs.find((t) => t.tty === tty);
    if (!tab) return { toast: { type: 'error', content: 'tab 不存在了' } };
    const chat = await loadChat(chatId);
    chat.activeTty = tab.tty;
    chat.lastActiveAt = Date.now();
    await saveChat(chat);
    if (tab.cwd) void recordCwd(tab.cwd);
    return {
      toast: { type: 'success', content: `★ 切到 ${tab.tty}` },
      card: ackCard({
        title: `★ 已切到 ${tab.tty}`,
        body: `cwd: \`${tab.cwd ?? '?'}\`\n${tab.title ? `title: ${tab.title}\n` : ''}\n现在普通文本会进入这个 tab。`,
      }),
    };
  }

  if (action === 'create-tab') {
    const cwd = value['cwd'] as string | undefined;
    if (!cwd) return { toast: { type: 'error', content: '缺 cwd' } };
    try {
      const tty = await newTab({ cwd });
      const chat = await loadChat(chatId);
      chat.activeTty = tty;
      chat.lastActiveAt = Date.now();
      await saveChat(chat);
      void recordCwd(cwd);
      return {
        toast: { type: 'success', content: `🆕 ${tty}` },
        card: ackCard({
          title: `🆕 ${tty}`,
          body: `cwd: \`${cwd}\`\n\n★ 已设为当前 active。`,
        }),
      };
    } catch (e) {
      return {
        toast: { type: 'error', content: (e as Error).message },
      };
    }
  }

  if (action === 'create-tab-via-select') {
    // select_static 的 option 值是 "create-tab|<cwd>"
    const option = data.action?.option;
    if (!option || !option.startsWith('create-tab|')) {
      return { toast: { type: 'error', content: '无效选项' } };
    }
    const cwd = option.slice('create-tab|'.length);
    try {
      const tty = await newTab({ cwd });
      const chat = await loadChat(chatId);
      chat.activeTty = tty;
      chat.lastActiveAt = Date.now();
      await saveChat(chat);
      void recordCwd(cwd);
      return {
        toast: { type: 'success', content: `🆕 ${tty}` },
        card: ackCard({
          title: `🆕 ${tty}`,
          body: `cwd: \`${cwd}\`\n\n★ 已设为当前 active。`,
        }),
      };
    } catch (e) {
      return { toast: { type: 'error', content: (e as Error).message } };
    }
  }

  if (action === 'choose-dir') {
    return {
      toast: { type: 'info', content: '请发送 /new 看选目录卡片' },
    };
  }

  if (action === 'send-to-tab') {
    const tty = value['tty'] as string | undefined;
    const text = (value['text'] as string | undefined) ?? '';
    if (!tty) return { toast: { type: 'error', content: '缺 tty' } };
    try {
      const sent = await sendKeysRaw(tty, text);
      if (!sent) {
        return {
          toast: { type: 'error', content: `tab ${tty} 不存在了` },
          card: ackCard({
            title: '❌ 发送失败',
            body: `tab \`${tty}\` 已经不在了`,
            template: 'red',
          }),
        };
      }
      const shown = text === '' ? '⏎ Enter' : text;
      return {
        toast: { type: 'success', content: `→ 已发送到 ${tty}` },
        card: ackCard({
          title: `→ 已发送到 ${tty}`,
          body: `\`${shown}\``,
        }),
      };
    } catch (e) {
      return {
        toast: { type: 'error', content: (e as Error).message },
        card: ackCard({
          title: '❌ 发送失败',
          body: `${(e as Error).message}`,
          template: 'red',
        }),
      };
    }
  }

  if (action === 'rerun-task') {
    const tty = value['tty'] as string | undefined;
    const prompt = value['prompt'] as string | undefined;
    const targetLabel = value['targetLabel'] as string | undefined;
    if (!tty || !prompt) return { toast: { type: 'error', content: '缺 tty 或 prompt' } };
    const tabs = await listTabs();
    const tab = tabs.find((t) => t.tty === tty);
    if (!tab) {
      return {
        toast: { type: 'error', content: `tab ${tty} 不存在` },
        card: ackCard({
          title: '❌ 重发失败',
          body: `tab \`${tty}\` 已经不在了`,
          template: 'red',
        }),
      };
    }
    // 异步重发：复用 dispatchSendToTab
    const ctx = {
      messageId: data.context?.open_message_id ?? '',
      chatId,
    };
    void dispatchSendToTab(client, ctx, tab, prompt, targetLabel).catch((e) => {
      logger.error('rerun failed', e);
      void sendText(client, chatId, `❌ 重发失败：${(e as Error).message}`);
    });
    return {
      toast: {
        type: 'success',
        content: `↻ 已重发到 ${tty}`,
      },
    };
  }

  if (action === 'cancel-all-pending') {
    const allPending = pendingTracker.all();
    if (allPending.length === 0) {
      return { toast: { type: 'info', content: '没有 pending 任务' } };
    }
    const { runScriptOrThrow } = await import('multiagent-host-mac');
    const script = `
on run argv
  set targetTty to item 1 of argv
  tell application "Terminal"
    activate
    repeat with w in windows
      try
        repeat with t in tabs of w
          if (tty of t) is equal to targetTty then
            set frontmost of w to true
            set selected tab of w to t
            tell application "System Events"
              keystroke "c" using {control down}
            end tell
            return "ok"
          end if
        end repeat
      end try
    end repeat
  end tell
  return "not-found"
end run
`;
    let count = 0;
    for (const p of allPending) {
      try {
        const out = await runScriptOrThrow(script, [p.tty]);
        if (out.trim() === 'ok') count++;
      } catch (e) {
        logger.warn('cancel-all: ctrl-c failed', { tty: p.tty, err: (e as Error).message });
      }
    }
    return {
      toast: {
        type: 'success',
        content: `⊘ 已对 ${count}/${allPending.length} 个 tab 发送 Ctrl-C`,
      },
    };
  }

  if (action === 'cancel-task') {
    const tty = value['tty'] as string | undefined;
    if (!tty) return { toast: { type: 'error', content: '缺 tty' } };
    try {
      // 发 Ctrl-C 字符（\x03）到 tab — 用 do script 限制：do script 总是带 \n
      // 实际 macOS Terminal 的 do script 不能发裸控制字符。绕开方式：先 send raw 控制符
      // 但 sendKeysRaw 本质是 do script —— 它会把字符当成 shell 命令
      // 飞书侧 cancel 实际有意义的做法：发一个 `kill -INT $(pgrep -P <shellPid> ...)` ?
      // 更简单：通过 AppleScript System Events keystroke
      const { runScriptOrThrow } = await import('multiagent-host-mac');
      const script = `
on run argv
  set targetTty to item 1 of argv
  tell application "Terminal"
    activate
    repeat with w in windows
      try
        repeat with t in tabs of w
          if (tty of t) is equal to targetTty then
            set frontmost of w to true
            set selected tab of w to t
            tell application "System Events"
              keystroke "c" using {control down}
            end tell
            return "ok"
          end if
        end repeat
      end try
    end repeat
  end tell
  return "not-found"
end run
`;
      const out = await runScriptOrThrow(script, [tty]);
      const ok = out.trim() === 'ok';
      return {
        toast: {
          type: ok ? 'success' : 'error',
          content: ok ? `⊘ 已对 ${tty} 发送 Ctrl-C` : `tab ${tty} 没找到`,
        },
      };
    } catch (e) {
      return { toast: { type: 'error', content: (e as Error).message } };
    }
  }

  if (action === 'show-shells') {
    // 触发 /shells 等价：发一张 tabs 卡片
    try {
      const { handleCommand } = await import('./commands.js');
      const reply = await handleCommand(chatId, '/shells');
      if (reply.kind === 'card') return { card: reply.card };
      return { toast: { type: 'info', content: '已发送 tab 列表' } };
    } catch (e) {
      return { toast: { type: 'error', content: (e as Error).message } };
    }
  }

  if (action === 'show-history') {
    const tty = value['tty'] as string | undefined;
    if (!tty) return { toast: { type: 'error', content: '缺 tty' } };
    try {
      const full = await getHistory(tty);
      const tail = full.split('\n').slice(-50).join('\n');
      return {
        card: ackCard({
          title: `📜 ${tty} 末尾 50 行`,
          body: '```\n' + tail + '\n```',
        }),
      };
    } catch (e) {
      return { toast: { type: 'error', content: (e as Error).message } };
    }
  }

  if (action === 'cancel-chain') {
    const chainId = value['chainId'] as string | undefined;
    if (!chainId) return { toast: { type: 'error', content: '缺 chainId' } };
    const chain = chainManager.get(chainId);
    if (!chain) {
      return { toast: { type: 'error', content: `chain ${chainId} 不存在` } };
    }
    if (chain.status !== 'running') {
      return { toast: { type: 'info', content: `chain 已 ${chain.status}` } };
    }
    // 对当前 running step 发 Ctrl-C
    const currentStep = chain.steps[chain.currentIndex];
    if (currentStep?.tty) {
      try {
        const { runScriptOrThrow } = await import('multiagent-host-mac');
        const script = `
on run argv
  set targetTty to item 1 of argv
  tell application "Terminal"
    activate
    repeat with w in windows
      try
        repeat with t in tabs of w
          if (tty of t) is equal to targetTty then
            set frontmost of w to true
            set selected tab of w to t
            tell application "System Events"
              keystroke "c" using {control down}
            end tell
            return "ok"
          end if
        end repeat
      end try
    end repeat
  end tell
  return "not-found"
end run
`;
        await runScriptOrThrow(script, [currentStep.tty]);
      } catch (e) {
        logger.warn('cancel-chain: ctrl-c failed', {
          chainId,
          tty: currentStep.tty,
          err: (e as Error).message,
        });
      }
    }
    chainManager.cancel(chainId);
    return { toast: { type: 'success', content: '⊘ 已终止任务链' } };
  }

  if (action === 'run-template') {
    const tplName = value['name'] as string | undefined;
    if (!tplName) return { toast: { type: 'error', content: '缺模板名' } };
    const { getPreset, extractPlaceholders, expandPrompt } = await import(
      'multiagent-orchestrator'
    );
    const preset = await getPreset(tplName);
    if (!preset) {
      return { toast: { type: 'error', content: `模板 "${tplName}" 不存在` } };
    }
    const placeholders = extractPlaceholders(preset.prompt);
    // 有占位符 → 提示用户用 /run 带参数；没有 → 直接 execute
    if (placeholders.length > 0) {
      const hint =
        `模板 \`${tplName}\` 需要参数：${placeholders.map((p) => `\`{${p}}\``).join(' ')}\n\n` +
        `用：\`/run ${tplName} ${placeholders.map((p) => `${p}=...`).join(' ')}\``;
      void sendText(client, chatId, hint);
      return { toast: { type: 'info', content: '需要参数，看消息提示' } };
    }
    // 无占位符 → 直接 execute；走和飞书发文本一样的路径（@target / active tab）
    const expanded = expandPrompt(preset.prompt, [], {});
    const text = (preset.target ? `@${preset.target} ` : '') + expanded;
    const ctx = { messageId: 'card-trigger', chatId };
    void (async () => {
      try {
        await executeReply(client, ctx, { kind: 'execute', text });
      } catch (e) {
        logger.error('run-template execute failed', e);
        void sendText(client, chatId, `❌ 触发失败：${(e as Error).message}`);
      }
    })();
    return { toast: { type: 'success', content: `▶ 已触发 ${tplName}` } };
  }

  if (action === 'show-template') {
    const tplName = value['name'] as string | undefined;
    if (!tplName) return { toast: { type: 'error', content: '缺模板名' } };
    const { handleCommand } = await import('./commands.js');
    const reply = await handleCommand(chatId, `/template show ${tplName}`);
    if (reply.kind === 'card') return { card: reply.card };
    return { toast: { type: 'info', content: '已发送' } };
  }

  if (action === 'show-task') {
    const taskId = value['taskId'] as string | undefined;
    if (!taskId) return { toast: { type: 'error', content: '缺 taskId' } };
    const { handleCommand } = await import('./commands.js');
    const reply = await handleCommand(chatId, `/task ${taskId}`);
    if (reply.kind === 'card') return { card: reply.card };
    if (reply.kind === 'text') return { toast: { type: 'info', content: reply.text.slice(0, 80) } };
    return { toast: { type: 'info', content: 'ok' } };
  }

  if (action === 'abort-task') {
    const taskId = value['taskId'] as string | undefined;
    if (!taskId) return { toast: { type: 'error', content: '缺 taskId' } };
    const hard = value['hard'] === true;
    try {
      const result = await markTaskAborted(taskId, 'feishu card abort', hard);
      if (!result) return { toast: { type: 'error', content: `task ${taskId} 不存在` } };
      // 同样投递 🛑 到 tab
      if (result.tty) {
        const { send: terminalSend } = await import('multiagent-host-mac');
        const banner = `\n\n🛑 [SOP 中止] task-id ${taskId} 已被中止${hard ? '（hard）' : '（soft）'}。停止 stage 协议。\n\n`;
        void terminalSend(result.tty, banner).catch(() => {});
      }
      return { toast: { type: 'success', content: `🛑 已中止 ${taskId}` } };
    } catch (e) {
      return { toast: { type: 'error', content: (e as Error).message } };
    }
  }

  if (action === 'show-approvals') {
    const { handleCommand } = await import('./commands.js');
    const reply = await handleCommand(chatId, '/approvals');
    if (reply.kind === 'text') {
      void (async () => {
        const { sendTextMessage } = await import('./api.js');
        await sendTextMessage(client, chatId, reply.text);
      })();
    }
    return { toast: { type: 'info', content: '已发送' } };
  }

  if (action === 'delete-template') {
    const tplName = value['name'] as string | undefined;
    if (!tplName) return { toast: { type: 'error', content: '缺模板名' } };
    const { deletePreset } = await import('multiagent-orchestrator');
    const ok = await deletePreset(tplName);
    if (!ok) {
      return { toast: { type: 'error', content: `模板 "${tplName}" 不存在` } };
    }
    // 重新发列表卡确认
    void (async () => {
      try {
        const { handleCommand } = await import('./commands.js');
        const listReply = await handleCommand(chatId, '/template');
        if (listReply.kind === 'card') {
          const { sendCardMessage } = await import('./api.js');
          await sendCardMessage(client, chatId, listReply.card);
        }
      } catch (e) {
        logger.warn('refresh template list after delete failed', {
          err: (e as Error).message,
        });
      }
    })();
    return { toast: { type: 'success', content: `已删除 ${tplName}` } };
  }

  if (action === 'approve' || action === 'reject') {
    const approvalId = value['approvalId'] as string | undefined;
    if (!approvalId) return { toast: { type: 'error', content: '缺 approvalId' } };
    const operator = data.operator?.open_id ?? 'feishu:unknown';
    const decision = action === 'approve' ? 'approved' : 'rejected';
    const result = await approvals.resolve(approvalId, decision, `feishu:${operator}`);
    if (!result) {
      return {
        toast: {
          type: 'error',
          content: `审批 ${approvalId} 不存在或已完成`,
        },
      };
    }
    return {
      toast: {
        type: 'success',
        content: decision === 'approved' ? '✅ 已批准' : '❌ 已拒绝',
      },
    };
  }

  return undefined;
}

export function buildEventDispatcher(client: Lark.Client): Lark.EventDispatcher {
  return new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data: MessageReceiveEvent) => {
      recordInbound();
      const { message_id, chat_id, message_type, content } = data.message;
      const text = message_type === 'text' ? extractText(content) : '';
      // 用 info 只记录精简事实；详情走 debug
      logger.info('message received', {
        chat_id,
        message_type,
        textLen: text.length,
        textPreview: text.length > 40 ? text.slice(0, 40) + '…' : text,
      });
      logger.debug('message received full', { message_id, text });

      if (message_type !== 'text') {
        await client.im.message.reply({
          path: { message_id },
          data: {
            content: JSON.stringify({
              text: `（暂只支持文本，收到的是 ${message_type}）`,
            }),
            msg_type: 'text',
          },
        });
        return;
      }

      const ctx = { messageId: message_id, chatId: chat_id };
      if (!text) return;

      if (isCommand(text)) {
        // fire-and-forget：立刻 ack，async 处理，避免飞书 3-5s 超时重发
        (async () => {
          try {
            const action = await handleCommand(chat_id, text);
            await executeReply(client, ctx, action);
          } catch (e) {
            logger.error('command failed', e);
            void replyText(client, ctx, `命令执行异常：${(e as Error).message}`);
          }
        })();
        return;
      }

      // 解析 @target 语法
      const parsed = parseMessage(text);

      // 解析告警（v1 不支持的混用） → 提示用户
      if (parsed.warning) {
        void sendText(client, chat_id, `⚠️ ${parsed.warning}`);
        return;
      }

      // chain 优先：`@a X >> @b Y >> @c Z`
      if (parsed.chain && parsed.chain.length >= 2) {
        logger.info('chain', { steps: parsed.chain.length });
        handleChain(client, ctx, parsed.chain).catch((e) => {
          logger.error('handleChain failed', e);
          void sendText(client, chat_id, `❌ chain 失败：${(e as Error).message}`);
        });
        return;
      }

      if (parsed.targeted.length > 0) {
        // 一条或多条 @target 命令
        logger.info('@target', {
          count: parsed.targeted.length,
          targets: parsed.targeted.map((t) => t.target),
        });
        if (parsed.targeted.length >= 2) {
          // 批量 → 先发一张聚合卡占位，所有 task pending 共享 messageId
          handleBatch(client, ctx, parsed.targeted).catch((e) => {
            logger.error('handleBatch failed', e);
            void sendText(client, chat_id, `❌ 批量失败：${(e as Error).message}`);
          });
        } else {
          for (const t of parsed.targeted) {
            sendToNamedTarget(client, ctx, t.target, t.text).catch((e) => {
              logger.error('sendToNamedTarget failed', e);
              void sendText(client, chat_id, `❌ @${t.target} 失败：${(e as Error).message}`);
            });
          }
        }
      } else {
        // 没 @ → 走 active tab
        sendToActiveTab(client, ctx, parsed.fallback ?? text).catch((e) => {
          logger.error('sendToActiveTab failed', e);
          void sendText(client, chat_id, `❌ 失败：${(e as Error).message}`);
        });
      }
    },

    'card.action.trigger': async (data: CardActionEvent) => {
      recordInbound();
      const chatId = getChatId(data);
      // fire-and-forget：异步处理并主动 send card / text，不阻塞 callback 返回
      (async () => {
        try {
          const result = await handleCardAction(client, data);
          if (chatId && result?.card) {
            await sendCard(client, chatId, result.card);
          } else if (chatId && !result) {
            await sendText(client, chatId, '⚠️ 未知卡片操作');
          }
        } catch (e) {
          logger.error('card action async failed', e);
          if (chatId) {
            void sendText(client, chatId, `❌ 卡片操作失败：${(e as Error).message}`);
          }
        }
      })();
      // 立刻返回最简响应（很多飞书 schema 2.0 客户端要求空对象或仅 toast）
      return {};
    },
  });
}
