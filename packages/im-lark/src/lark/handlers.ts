import * as Lark from '@larksuiteoapi/node-sdk';
import { approvals, asks } from 'multiagent-orchestrator';
import { loadChat, saveChat } from '../chats/store.js';
import { PENDING_ANSWER_TTL_MS, RECENT_REPLY_TTL_MS, ASK_ARM_TTL_MS } from '../chats/types.js';
import { buildDownEnterSeq, resolveAskAnswerIndex } from './ask-drive.js';
import { logger } from 'multiagent-orchestrator';
import { recordCwd } from 'multiagent-host-mac';
import { formatRecallPrefix, recall, tokenize } from 'multiagent-orchestrator';
import { pendingTracker } from '../monitor/pending.js';
import { recordInbound } from '../monitor/ws-watchdog.js';
import { captureScreen, closeTabGracefully, detectSelfTty, forceEnter, getHistory, getUserFocus, launchAgentInTab, launchClaudeInTab, listTabs, newTab, openPermissionPane, send, sendKeys, sendKeysRaw } from 'multiagent-host-mac';
import { detectAgentFromProcs, listAgentAdapters } from 'multiagent-orchestrator';

// SYSTEM_GUIDANCE 的去重 — per-tab，每 tty 6h 内最多注入一次
// 这是 module-level 内存状态，dev 重启会清空（重启后第一次注入是合理的）
const SYSTEM_GUIDANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const systemGuidanceShownAt = new Map<string, number>();

const SYSTEM_GUIDANCE = [
  '[系统提示 - 自动注入]',
  '本对话来自飞书机器人 multiAgentChat。飞书侧通过 AppleScript 观测此 tab 的输出，但 **alt-screen TUI 模式下飞书看不见你的实时屏幕**。',
  '',
  '🔴 首要原则：**两个渠道并行输出，两边都能看到**',
  '- 用户可能同时在飞书 & pc shell 面前 → 响应必须在 shell TUI 里**先完整回答一遍**（自然对话），**然后**用 `agent lark send-text` 推**同样一份**摘要给飞书',
  '- 不要**只**推飞书不在 TUI 里说；也不要**只**在 TUI 里说不推飞书',
  '- 长内容（>2000 字）：TUI 里完整、飞书推浓缩摘要；绝不能相反',
  '',
  '所以：',
  '- 任务完成时先在 TUI 完整回答，然后**必须**调用 `agent lark send-text "结果摘要..."` 主动推送到飞书',
  '- 长任务请每完成一步用 `agent lark send-text` 推送进度',
  '- 文件产出用 `agent lark send-file <path>` 推送文件本体',
  '- **要用户从多选项里选（单选/多选）或让用户填一段文本，用 `agent lark ask` —— 弹飞书交互卡片，用户手指点选/回复，答案 JSON 从 stdout 回给你。用户不必手打命令。**',
  '    单选：`agent lark ask single --title "选哪个？" --options "选项A,选项B,选项C"`',
  '    多选：`agent lark ask multi  --title "勾选多个" --options "1,2,3"`',
  '    ⚠ 选项文本里**含逗号**时 `--options` 会被拆乱 → 改用 JSON 数组：`--options \'["含,逗号的选项","选项2"]\'`（或 `--options-json`），一个 flag 安全搞定',
  '    输入：`agent lark ask input  --title "输入什么"`  （用户在飞书 chat 里直接回复文本即可）',
  '    多问题表单：`agent lark ask form --title "标题" --spec-json \'{"questions":[{"title":"Q1","type":"single","options":["A","B"],"allowText":true},{"title":"Q2","type":"multi","options":["X","Y"]}]}\'` —— 一次问多个、每题单/多选、allowText 题可自由输入；stdout 返回 `{"status":"answered","type":"form","answers":[{"q":0,"kind":"single","index":0,"value":"A"},...]}`。**这是 AskUserQuestion 的飞书替代，多问题场景用它，别用 AskUserQuestion（用户手机看不见）**',
  '    stdout 示例：`{"status":"answered","type":"single","index":1,"value":"选项B"}`；status 也可能是 cancelled / timeout',
  '    退出码：0=answered，1=cancelled，2=timeout',
  '- 不要调 AskUserQuestion 或在 TUI 里等键盘输入，用户手机端看不见 TUI —— **一定要用 `agent lark ask`**',
  '- 高风险操作（写数据库 / git push --force / rm -rf / 改 .env）先 `agent request-approval --title --body` 等批准',
  '- 不要直接调任何 webhook（功能弱、不支持文件）',
  '- **「龙虾」= CareyClaw 平台**（bot.ihealthcn.com）。用户说「龙虾/careyclaw 有没有XX接口 / 这个接口怎么调 / 帮我拿XX数据」→ 触发已装的 **careyclaw-apis** 技能（检索/试调平台业务 API）；说「龙虾/careyclaw 部署/发布应用」→ 触发 **careyclaw-deploy** 技能。首次会给浏览器授权链接（用 `agent lark send-text` 把链接推给用户去点）。',
  '',
].join('\n');

// 短提醒：claude TUI tab 每条消息末尾都注入（防止 6h 间隔的 SYSTEM_GUIDANCE 过期遗忘）
const CLAUDE_TUI_REMINDER = [
  '',
  '---',
  '⚠ 回到飞书 — 飞书看不见你的 TUI 屏幕。**先在 TUI 完整回答用户，然后再** `agent lark send-text "<同样一份摘要>"` 推到飞书（两个渠道并行，不能只推不答）。要用户从选项里选（单/多选）或填文本，**用 `agent lark ask single|multi|input`**（stdout 拿答案 JSON），不要用 AskUserQuestion 或在 TUI 里 wait 键盘。',
].join('\n');
import { patchCard, sendCardReturnId, sendImage } from './api.js';
import { ackCard, askCard, batchProgressCard, browseCard, careyclawKeyCard, careyclawKeyFormCard, chainProgressCard, closeIdleConfirmCard, closeTabConfirmCard, connectConfirmCard, connectFormCard, connectStatusCard, planCard, progressCard, receiptCard, tapdClaimCard, type BatchTaskItem, type ChainStepItem } from './cards.js';
import { getCareyclawKeyStatus, setCareyclawKey } from 'multiagent-orchestrator';
import { generatePlan, getPlan } from 'multiagent-orchestrator';
import { getPerfItem, savePerfItem, markPerfSnoozed, markPerfIgnoredForever, createPerfStory } from 'multiagent-orchestrator';
import type { PerfItem } from 'multiagent-orchestrator';
import { integrationStatuses, getIntegration, upsertEnvKeys, setIntegrationDisabled, installIntegrationSkills } from 'multiagent-orchestrator';
import { spawn } from 'node:child_process';
import { utimesSync } from 'node:fs';

// /connect：某对接提交的配置值暂存（确认后才写 .env）。ephemeral。
const connectStaging = new Map<string, Record<string, string>>();
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { parseMessage, resolveTarget } from './target.js';
import { buildImageOnlyPrompt, buildImagePromptPrefix, downloadInboundImages, parseImageKey, parsePost } from './resource.js';
import { chainManager } from '../monitor/chains.js';

// 飞书图文入站：纯图片消息先暂存，等 N 秒内的文字描述来配对（B 方案）。
// 超时（没等到文字）→ 按纯图直发 active tab（C 方案）。
const IMG_PAIR_WINDOW_MS = 90_000;
interface PendingInboundImage { paths: string[]; timer: NodeJS.Timeout; }
const pendingImagesByChat = new Map<string, PendingInboundImage>();

function addPendingImage(chatId: string, paths: string[], onTimeout: (paths: string[]) => void): void {
  const existing = pendingImagesByChat.get(chatId);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    pendingImagesByChat.delete(chatId);
    onTimeout(paths);
  }, IMG_PAIR_WINDOW_MS);
  pendingImagesByChat.set(chatId, { paths, timer });
}

function takePendingImage(chatId: string): string[] {
  const p = pendingImagesByChat.get(chatId);
  if (!p) return [];
  clearTimeout(p.timer);
  pendingImagesByChat.delete(chatId);
  return p.paths;
}

// ---- gated-tab 消息队列：目标 tab 卡在 gate/审批（claude 阻塞）时，新消息排队而非丢弃；
//      审批解锁 + 当前任务 done/failed（tab 真空闲）后自动 flush，按序重发。----
interface QueuedMsg { text: string; chatId: string; targetLabel?: string }
const gatedQueue = new Map<string, QueuedMsg[]>();  // tty → 排队消息（FIFO）
const GATED_QUEUE_CAP = 10;

/** 排队一条；返回队列中的位次（1-based），满了返回 -1。 */
function enqueueGated(tty: string, msg: QueuedMsg): number {
  const q = gatedQueue.get(tty) ?? [];
  if (q.length >= GATED_QUEUE_CAP) return -1;
  q.push(msg);
  gatedQueue.set(tty, q);
  return q.length;
}

/** tab 空闲后 flush 该 tty 的排队消息，按序重发（由 notifier 的 task:done/failed 监听调用）。 */
export async function flushGatedQueue(client: Lark.Client, tty: string): Promise<void> {
  const q = gatedQueue.get(tty);
  if (!q || q.length === 0) return;
  gatedQueue.delete(tty);
  const tabs = await listTabs();
  const tab = tabs.find((t) => t.tty === tty);
  if (!tab) {
    logger.warn('flushGatedQueue: tab 已不存在，丢弃队列', { tty, dropped: q.length });
    return;
  }
  logger.info('flushGatedQueue: 派发排队消息', { tty, count: q.length });
  for (const m of q) {
    const ctx = { messageId: 'queue-flush', chatId: m.chatId };
    await sendText(client, m.chatId, `▶️ 队列继续：${tty} 已空闲，派发排队的「${m.text.slice(0, 30)}${m.text.length > 30 ? '…' : ''}」`).catch(() => {});
    await dispatchSendToTab(client, ctx, tab, m.text, m.targetLabel);
    await new Promise((r) => setTimeout(r, 1500));  // 每条间隔，避免糊在一起
  }
}

interface BatchInfo {
  batchId: string;
  batchMessageId: string;
  total: number;
}

interface ChainInfo {
  chainId: string;
  chainStepIndex: number;
}
import { handleCommand, isCommand, isForwardSlash, stripForwardSlash, type ReplyAction, type SopActionData } from './commands.js';
import { replyText, sendText } from './reply.js';
import { createTask, generateTaskId, listTasks, markTaskAborted, setTaskProgressMessageId } from 'multiagent-orchestrator';
import { buildSopWrapperPrompt } from 'multiagent-orchestrator';
import { buildTapdPrompt } from 'multiagent-orchestrator';
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
    form_value?: Record<string, unknown>;  // schema 2.0 表单提交：{ input_name: value }
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

async function buildBrowseReply(
  cwd: string,
): Promise<{ toast?: { type: string; content: string }; card?: unknown }> {
  if (!existsSync(cwd)) {
    return { toast: { type: 'error', content: `目录不存在：${cwd}` } };
  }
  let subdirs: { path: string; name: string; isGitRepo: boolean }[] = [];
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    subdirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({
        path: `${cwd}/${e.name}`,
        name: e.name,
        isGitRepo: existsSync(`${cwd}/${e.name}/.git`),
      }))
      .sort((a, b) => {
        // git repo 排前面
        if (a.isGitRepo !== b.isGitRepo) return a.isGitRepo ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  } catch (e) {
    return { toast: { type: 'error', content: `读目录失败: ${(e as Error).message}` } };
  }
  const parent = cwd === '/' ? undefined : dirname(cwd);
  return {
    card: browseCard({
      currentCwd: cwd,
      parentCwd: parent === cwd ? undefined : parent,
      subdirs: subdirs.slice(0, 30),
      home: homedir(),
      truncated: subdirs.length > 30,
    }),
  };
}

function getChatId(data: CardActionEvent): string | undefined {
  return data.context?.open_chat_id ?? data.open_chat_id;
}

/** 兼容 schema 1.x / 2.0 拿卡片消息 id（patch 原卡需要） */
function getMessageId(data: CardActionEvent): string | undefined {
  return data.context?.open_message_id ?? data.open_message_id;
}

/**
 * 按钮点击后 patch 原卡为回执态 —— 通用 helper。
 * patchCard 失败静默降级（logger.warn），不影响业务动作。
 *
 * @param template 'green'=完成/成功（默认）、'blue'=arm/等待、'grey'=已消费
 */
async function patchOrigToReceipt(
  client: Lark.Client,
  data: CardActionEvent,
  title: string,
  detail?: string,
  template: 'green' | 'blue' | 'grey' = 'green',
): Promise<void> {
  const messageId = getMessageId(data);
  if (!messageId) return;
  try {
    await patchCard(
      client,
      messageId,
      receiptCard({ title, ...(detail ? { detail } : {}), template }),
    );
  } catch (e) {
    logger.warn('patchCard receipt failed', { err: (e as Error).message, messageId });
  }
}

// ---- AskUserQuestion（claude 原生上下键选择菜单）方向键驱动 ----
// buildDownEnterSeq / resolveAskAnswerIndex 是纯逻辑，抽到 ./ask-drive.ts 便于单测。

/**
 * 卡片点选项（按钮 ask-select / 下拉 askans|）→ 用方向键驱动源 shell 里 claude 的
 * 原生 AskUserQuestion 菜单选中第 index 项。
 * guard：必须仍处于 armed（chat.askArm 匹配该 tty 且未过期）—— 否则本地可能已作答 /
 * 菜单已关闭，此时注方向键会打进已经不是菜单的终端，直接拒绝（toast 提示，不 patch）。
 */
async function driveAskSelectFromCard(
  client: Lark.Client,
  data: CardActionEvent,
  chatId: string,
  tty: string,
  index: number,
  label: string,
): Promise<{ toast?: { type: string; content: string }; card?: unknown }> {
  const chat = await loadChat(chatId);
  const arm = chat.askArm;
  if (!arm || arm.tty !== tty || Date.now() - arm.at > ASK_ARM_TTL_MS) {
    return { toast: { type: 'info', content: '该选择菜单已作答或已过期' } };
  }
  const tabs = await listTabs();
  if (!tabs.find((t) => t.tty === tty)) {
    delete chat.askArm;
    if (chat.pendingAnswerTty === tty) {
      delete chat.pendingAnswerTty;
      delete chat.pendingAnswerAt;
    }
    await saveChat(chat).catch(() => {});
    return {
      toast: { type: 'error', content: `tab ${tty} 不存在了` },
      card: ackCard({ title: '❌ 发送失败', body: `tab \`${tty}\` 已经不在了`, template: 'red' }),
    };
  }
  try {
    await sendKeys(tty, buildDownEnterSeq(index));
  } catch (e) {
    return { toast: { type: 'error', content: (e as Error).message } };
  }
  // 消费 arm（本轮已作答）；pendingAnswerTty 也清（不再 one-shot 路由这条问题）
  delete chat.askArm;
  if (chat.pendingAnswerTty === tty) {
    delete chat.pendingAnswerTty;
    delete chat.pendingAnswerAt;
  }
  await saveChat(chat).catch(() => {});
  const shown = label || arm.options[index] || `选项 ${index + 1}`;
  void patchOrigToReceipt(
    client,
    data,
    `✓ 已选『${shown.length > 20 ? shown.slice(0, 20) + '…' : shown}』(↓×${index}+⏎) → ${tty}`,
  );
  return {};
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

/**
 * 打字兜底解析 single/multi ask 的答案：
 *  - single：裸数字 "2"（1-based）/ 选项原文精确匹配 → AskAnswerSingle
 *  - multi：逗号/空格/顿号分隔数字 "1,3" / "1 3" → AskAnswerMulti；选项原文（单个）也可
 * 解析不出（像普通消息）→ 返回 null，不劫持。
 */
function parseTypedAskAnswer(
  text: string,
  options: string[],
  type: 'single' | 'multi',
): { kind: 'single'; index: number; value: string } | { kind: 'multi'; indices: number[]; values: string[] } | null {
  const t = text.trim();
  // 选项原文精确匹配（single）
  if (type === 'single') {
    const exact = options.findIndex((o) => o === t);
    if (exact >= 0) return { kind: 'single', index: exact, value: options[exact]! };
    if (/^\d+$/.test(t)) {
      const idx = Number(t) - 1;
      if (idx >= 0 && idx < options.length) return { kind: 'single', index: idx, value: options[idx]! };
    }
    return null;
  }
  // multi：分隔的数字
  const tokens = t.split(/[\s,，、]+/).filter(Boolean);
  if (tokens.length > 0 && tokens.every((tok) => /^\d+$/.test(tok))) {
    const indices = [...new Set(tokens.map((tok) => Number(tok) - 1))].filter((i) => i >= 0 && i < options.length).sort((a, b) => a - b);
    if (indices.length > 0) return { kind: 'multi', indices, values: indices.map((i) => options[i]!) };
  }
  // multi：单个选项原文
  const exact = options.findIndex((o) => o === t);
  if (exact >= 0) return { kind: 'multi', indices: [exact], values: [options[exact]!] };
  return null;
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
  } else if (action.kind === 'tweak-subagent') {
    await dispatchTweakSubagent(client, ctx, action.name, action.feedback, action.currentDef);
  } else if (action.kind === 'forward-slash-to-tab') {
    // Claude Code 内建 slash 命令（/help /config /model 等），mchat 不认，转发到 activeTty
    logger.info('slash forwarded (native)', {
      chatId: ctx.chatId,
      preview: action.text.slice(0, 40),
      reason: action.reason,
    });
    await sendToActiveTab(client, ctx, action.text);
  }
}

/**
 * /subagent tweak <name> <feedback> 触发的分派：
 * 派一段特殊 prompt 给 active tab 的主 claude，让它按 feedback 修改现有 subagent
 * 后调 `agent subagent gen-submit --hard`（overwrite）交回框架落盘。
 */
async function dispatchTweakSubagent(
  client: Lark.Client,
  ctx: { messageId: string; chatId: string },
  name: string,
  feedback: string,
  currentDef: {
    name: string;
    description?: string;
    tools?: string[];
    model?: string;
    color?: string;
    body: string;
  },
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
    const stale = chat.activeTty;
    delete chat.activeTty;
    await saveChat(chat).catch(() => {});
    await replyText(client, ctx, `❌ ★ ${stale} 已不在（可能被关闭/删除），已清除。\n用 \`/shells\` 重选一个 active tab 再发。`);
    return;
  }
  const sessionId = `satweak-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const currentJson = JSON.stringify({ subagents: [currentDef] }, null, 2);
  const prompt = [
    `🛠 [Subagent Tweak 任务]`,
    `session: ${sessionId}`,
    `chat-id: ${ctx.chatId}`,
    ``,
    `用户想改现有 subagent **${name}**。`,
    ``,
    `当前定义（JSON）：`,
    '```json',
    currentJson,
    '```',
    ``,
    `**改动指令**：`,
    `${feedback}`,
    ``,
    `请：`,
    `1. 理解 feedback 想改啥（改 body？改 tools？改 description？）`,
    `2. 产出**修改后**的 subagent JSON（**保持 name 不变**）：`,
    '```json',
    `{`,
    `  "subagents": [`,
    `    {`,
    `      "name": "${name}",`,
    `      "description": "...",`,
    `      "tools": [...],`,
    `      "model": "...",`,
    `      "color": "...",`,
    `      "body": "改后的 system prompt"`,
    `    }`,
    `  ]`,
    `}`,
    '```',
    ``,
    `3. **务必用 --hard flag** 触发覆盖（否则 framework 会因为冲突跳过）：`,
    '',
    '```bash',
    `agent subagent gen-submit \\`,
    `  --task-id ${sessionId} \\`,
    `  --chat ${ctx.chatId} \\`,
    `  --hard \\`,
    `  --body '<单行 JSON>'`,
    '```',
    ``,
    `framework 会解析 → 校验 → 覆盖 ~/.claude/agents/${name}.md → 推消息到飞书。你不用另发飞书消息。`,
  ].join('\n');

  await replyText(
    client,
    ctx,
    `🛠 派发 tweak 任务到 ${tab.tty}\nsession: \`${sessionId}\`\n改的：\`${name}\`\n指令：${feedback.slice(0, 100)}${feedback.length > 100 ? '…' : ''}`,
  );

  await dispatchSendToTab(client, ctx, tab, prompt);
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
    // active tab 已被删/关 → 清掉失效 activeTty，避免后续消息继续发向已不存在的 shell（误路由）
    const stale = chat.activeTty;
    delete chat.activeTty;
    await saveChat(chat).catch(() => {});
    await replyText(client, ctx, `❌ ★ ${stale} 已不在（可能被关闭/删除），已清除。\n用 \`/shells\` 重选一个 active tab 再发。`);
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
    // 显式 @target → 尊重用户意愿，attach 到已有 tab
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
    // 无 @target → 智能决定 attach 还是 spawn
    const chat = await loadChat(ctx.chatId);
    const tabsPre = await listTabs();
    const focus = await getUserFocus();

    // Attach 条件：activeTty 存在 + 就是 frontmost tab + 有 claude TUI
    let shouldAttach = false;
    if (chat.activeTty) {
      const activeTab = tabsPre.find((t) => t.tty === chat.activeTty);
      if (
        activeTab &&
        activeTab.hasTUI &&
        focus.terminalFrontmost &&
        focus.tty === chat.activeTty
      ) {
        shouldAttach = true;
      }
    }

    if (shouldAttach) {
      const activeTab = tabsPre.find((t) => t.tty === chat.activeTty)!;
      tab = activeTab;
      targetLabel = 'attached';
      promptForTab = parsed.fallback ?? text;
      await replyText(
        client,
        ctx,
        `🔗 检测到你正在盯着 ${activeTab.tty}（Terminal frontmost + claude TUI），attach 派发（跳过 spawn）\n如新加的 subagent 不认，退出这个 claude session 重开再跑`,
      );
    } else {
      // spawn 新 tab（背景，不抢焦点）
      let baseCwd: string | undefined;
      if (chat.activeTty) {
        const activeTab = tabsPre.find((t) => t.tty === chat.activeTty);
        if (activeTab?.cwd) baseCwd = activeTab.cwd;
      }

      const reason = !focus.terminalFrontmost
        ? '你不在 Terminal（在别的 app）'
        : !chat.activeTty
          ? '本 chat 无 active tab'
          : focus.tty !== chat.activeTty
            ? `Terminal frontmost tab 是 ${focus.tty ?? '?'}，不是 active ${chat.activeTty}`
            : 'active tab 没在跑 claude TUI';
      await replyText(
        client,
        ctx,
        `🎬 spawn 新 tab（原因：${reason}）\ncwd: ${baseCwd ?? 'default'}，Terminal 会闪 200ms 就切回`,
      );

      let newTty: string;
      try {
        const opts: Parameters<typeof newTab>[0] = { mode: 'new-tab-background' };
        if (baseCwd) opts.cwd = baseCwd;
        newTty = await newTab(opts);
      } catch (e) {
        await replyText(client, ctx, `❌ 新 tab 创建失败：${(e as Error).message}`);
        return;
      }

      await new Promise((r) => setTimeout(r, 1500));
      try {
        // 用 launchClaudeInTab（会双 forceEnter 过"信任此文件夹?"trust 弹窗）——
        // 原来的 raw send('claude') 不过 trust：新目录首启时 trust 弹窗会吃掉随后发的 SOP wrapper，
        // claude 只收到空回车 → 回"收到一条空消息"。对齐 TAPD 认领的开工流程。
        const r = await launchClaudeInTab(newTty, { continueSession: false });
        if (!r.ok) throw new Error(r.reason ?? 'launch failed');
      } catch (e) {
        await replyText(client, ctx, `❌ 新 tab ${newTty} 起 claude 失败：${(e as Error).message}`);
        return;
      }

      // 轮询等 claude 进程真的起来（确认 launch 成功，不是盲等固定秒数），最多 ~18s。
      // 注：hasTUI 只认 vim/htop，claude 不在其列，不能用它判就绪 → 用进程名判。
      // launchClaudeInTab 已在轮询前双 forceEnter 过 trust。claude 进程在 = 已启动。
      const isClaudeProc = (t: Awaited<ReturnType<typeof listTabs>>[number]) =>
        t.processes.some((p) => p === 'claude' || p === 'claude-code' || /\/claude$/i.test(p) || p.toLowerCase().includes('claude'));
      let found: Awaited<ReturnType<typeof listTabs>>[number] | undefined;
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const tabsAfter = await listTabs();
        found = tabsAfter.find((t) => t.tty === newTty);
        if (found && isClaudeProc(found)) break;
      }
      if (!found) {
        await replyText(client, ctx, `❌ 新 tab ${newTty} spawn 后 listTabs 找不到`);
        return;
      }
      if (!isClaudeProc(found)) {
        await replyText(client, ctx, `⚠️ 新 tab ${newTty} 的 claude 还没起来（可能卡在 trust/登录）。SOP 未派发，避免发空消息——请去那个 tab 手动看一眼再重试。`);
        return;
      }
      // claude 进程在了 → 再给 2.5s settle，让它过完 trust/进主界面，再发 wrapper（否则可能撞上启动画面）
      await new Promise((r) => setTimeout(r, 2500));
      tab = found;
      targetLabel = 'fresh';
      promptForTab = parsed.fallback ?? text;

      await replyText(
        client,
        ctx,
        `✅ 新 tab ${newTty} claude 就绪，派发 SOP`,
      );
    }
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
  const tabs = await listTabs();
  const now = Date.now();

  // 路由优先级（无 @target 时）：
  //  1. pendingAnswerTty (one-shot, TTL 10min) —— AskUserQuestion / [→ 发一条] arm 过
  //  2. recentReplyTty (sticky, TTL 5min，每次刷新) —— pendingAnswerTty 消耗后 promote 出来
  //  3. activeTty —— 默认兜底

  // ---- Priority 1: pendingAnswerTty one-shot ----
  if (
    chat.pendingAnswerTty &&
    chat.pendingAnswerAt &&
    now - chat.pendingAnswerAt <= PENDING_ANSWER_TTL_MS
  ) {
    const answerTab = tabs.find((t) => t.tty === chat.pendingAnswerTty);
    if (answerTab) {
      const consumedTty = chat.pendingAnswerTty;
      logger.info('routing via pendingAnswerTty (one-shot → sticky)', {
        tty: consumedTty,
        ageMs: now - chat.pendingAnswerAt,
      });
      delete chat.pendingAnswerTty;
      delete chat.pendingAnswerAt;
      // promote 到 sticky recentReplyTty（若不是 activeTty 本身 —— 是的话没必要绕）
      if (consumedTty !== chat.activeTty) {
        chat.recentReplyTty = consumedTty;
        chat.recentReplyAt = now;
      }
      chat.lastActiveAt = now;
      await saveChat(chat);
      await dispatchSendToTab(client, ctx, answerTab, text);
      return;
    }
    // tab 消失了 → 清空 pending，继续走后续优先级
    logger.info('pendingAnswerTty tab gone, clearing', { tty: chat.pendingAnswerTty });
    delete chat.pendingAnswerTty;
    delete chat.pendingAnswerAt;
    await saveChat(chat);
  }

  // ---- Priority 2: recentReplyTty sticky ----
  if (
    chat.recentReplyTty &&
    chat.recentReplyAt &&
    now - chat.recentReplyAt <= RECENT_REPLY_TTL_MS &&
    chat.recentReplyTty !== chat.activeTty
  ) {
    const stickyTab = tabs.find((t) => t.tty === chat.recentReplyTty);
    if (stickyTab) {
      logger.info('routing via recentReplyTty (sticky refresh)', {
        tty: chat.recentReplyTty,
        ageMs: now - chat.recentReplyAt,
      });
      chat.recentReplyAt = now; // 刷新 TTL 起点
      chat.lastActiveAt = now;
      await saveChat(chat);
      await dispatchSendToTab(client, ctx, stickyTab, text);
      return;
    }
    // tab 消失了 → 清空 sticky，继续走 activeTty
    logger.info('recentReplyTty tab gone, clearing', { tty: chat.recentReplyTty });
    delete chat.recentReplyTty;
    delete chat.recentReplyAt;
    await saveChat(chat);
  }

  // ---- Priority 3: activeTty ----
  if (!chat.activeTty) {
    logger.info('sendToActiveTab: no active tty');
    await replyText(
      client,
      ctx,
      '本会话还没有 active tab。\n发送 `/shells` 选一个，或 `/new` 开新的，\n或者用 `@<tty|name>` 直接发到任意 tab（不切 active）。',
    );
    return;
  }
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
  // 空内容防护：只发了 @目标 / 内容被 strip 空 / 空消息 → 别注入空 prompt，否则 tab 里的
  // claude（尤其 careyclaw 这类交互式）会收到"[本次任务]\n(空)"→ 回"收到的消息是空的没内容"刷屏。
  if (!text || !text.trim()) {
    logger.warn('dispatchSendToTab: 空 text，跳过注入', { tty: tab.tty, targetLabel });
    await replyText(client, ctx, `⚠️ 消息内容为空，没发送到 ${tab.tty}（是不是只发了 @目标、或图片没配文字？直接把要说的内容打出来）`).catch(() => {});
    return;
  }

  // AskUserQuestion 方向键驱动：该 tab 正卡在 claude 原生选择菜单（askArm）+ 这条回复能映射到
  // 某个选项（裸数字 / 选项文本）→ 用 sendKeys 发 (index)↓+回车 驱动菜单选中，而不是 do script
  // 打文本（打文本移动不了高亮、选不中，历史 bug）。映射不出（改主意 / 自由输入 / 想 @ 别处）→
  // 不劫持，照常落到下方文本注入（无回归）；本地已作答时 arm 已被 PostToolUse 清掉，也不会命中。
  // 仅对**用户直接回复**生效：chain/batch 编排步骤（有 batchInfo/chainInfo）是完整任务 prompt，
  // 不该被当成选项应答（即便碰巧是裸数字）。
  if (!batchInfo && !chainInfo) {
    const askChat = await loadChat(ctx.chatId).catch(() => null);
    const arm = askChat?.askArm;
    if (arm && arm.tty === tab.tty && Date.now() - arm.at <= ASK_ARM_TTL_MS) {
      const idx = resolveAskAnswerIndex(text, arm.options);
      if (idx >= 0) {
        try {
          await sendKeys(tab.tty, buildDownEnterSeq(idx));
        } catch (e) {
          await replyText(client, ctx, `❌ 驱动选择菜单失败：${(e as Error).message}`).catch(() => {});
          return;
        }
        delete askChat!.askArm;
        if (askChat!.pendingAnswerTty === tab.tty) {
          delete askChat!.pendingAnswerTty;
          delete askChat!.pendingAnswerAt;
        }
        await saveChat(askChat!).catch(() => {});
        const label = arm.options[idx] ?? `选项 ${idx + 1}`;
        await replyText(
          client,
          ctx,
          `✓ 已选『${label.length > 24 ? label.slice(0, 24) + '…' : label}』(↓×${idx}+⏎) → ${tab.tty}`,
        ).catch(() => {});
        return;
      }
    }
  }

  // gate 排队：目标 tab 有 awaiting-gate 的 SOP → claude 阻塞在 gate 等审批，注入也不会被处理。
  // 排队而非丢弃 + 重推审批卡 + 提醒；审批解锁、当前任务 done/failed 后自动 flush（flushGatedQueue）。
  if (ctx.messageId !== 'queue-flush') {  // flush 时不再自查（此时应已空闲）
    const gated = await listTasks({ status: 'awaiting-gate', tty: tab.tty });
    if (gated.length > 0) {
      const gt = gated[0]!;
      const pos = enqueueGated(tab.tty, { text, chatId: ctx.chatId, ...(targetLabel ? { targetLabel } : {}) });
      if (pos === -1) {
        await replyText(client, ctx, `⚠️ ${tab.tty} 的 SOP 卡在 gate『${gt.awaitingGate ?? '?'}』等审批，排队已满(${GATED_QUEUE_CAP} 条)，本条未入队。先去 \`/approvals\` 处理审批。`);
      } else {
        await replyText(client, ctx, `⏸ ${tab.tty} 的 SOP 正卡在 gate『${gt.awaitingGate ?? '?'}』等你审批 —— claude 被阻塞、收不到新消息（不是系统坏了）。\n已把这条**排队**（第 ${pos} 条），**审批 + 当前任务跑完后会自动执行**。下面重推审批卡，处理它即可：`);
        const pending = approvals.listActive().find((a) => a.taskId === gt.taskId);
        if (pending) {
          const { buildApprovalCard } = await import('./cards.js');
          const { sendCardMessage } = await import('./api.js');
          await sendCardMessage(client, ctx.chatId, buildApprovalCard(pending)).catch(() => {});
        }
      }
      return;
    }
  }

  logger.info('dispatchSendToTab', {
    tty: tab.tty,
    busy: tab.busy,
    hasTUI: tab.hasTUI,
    targetLabel,
    batchId: batchInfo?.batchId,
  });

  // 0. 裸 agent 名 → 启动对应 CLI。
  //    目标 tab 还没跑 agent（普通 shell），且这条消息正好就是某个 agent 的名字（"codex" / "claude"）
  //    → 意图是"进入该 CLI"而非"发 prompt"。直接 launchAgentInTab 裸启动 + 过 trust 弹窗，
  //    **跳过** SYSTEM_GUIDANCE/recall/[本次任务] 包装 —— 那套是给 TUI 内 agent 看的，整坨塞进
  //    shell 会被 `do script` 当命令执行，报一堆 command not found，agent 从没被干净启动。
  if (!detectAgentFromProcs(tab.processes)) {
    const word = text.trim().toLowerCase();
    const target = listAgentAdapters().find((a) => word === a.kind || word === a.binaryName);
    if (target) {
      logger.info('bare agent word → launch CLI', { tty: tab.tty, kind: target.kind });
      const launched = await launchAgentInTab(tab.tty, target.kind);
      if (launched.ok) {
        await replyText(
          client,
          ctx,
          `🚀 已在 ${tab.tty} 启动 ${target.displayName}（\`${launched.command}\`）。就绪后直接发消息即可开始对话。`,
        ).catch(() => {});
      } else {
        await sendText(
          client,
          ctx.chatId,
          `❌ 在 ${tab.tty} 启动 ${target.displayName} 失败：${launched.reason ?? '未知'}`,
        ).catch(() => {});
      }
      return;
    }
  }

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
          sentAt: now,
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

/** 候选 repo：书签(/pin) 优先，再 recent-cwd，去重。 */
async function tapdRepoCandidates(
  hm: typeof import('multiagent-host-mac'),
): Promise<{ path: string; label: string }[]> {
  // 优先级：/pin 书签 → 最近用过的 cwd → 全机 git 仓库索引（新人装完即有，dir-index 自带后台刷新）
  const [recents, bms, index] = await Promise.all([
    hm.listRecentCwds(),
    hm.listBookmarks(),
    hm.getDirIndex().catch(() => ({ dirs: [] as { path: string; name: string; isGitRepo: boolean }[] })),
  ]);
  const seen = new Set<string>();
  const out: { path: string; label: string }[] = [];
  for (const b of bms) if (!seen.has(b.path)) { seen.add(b.path); out.push({ path: b.path, label: `@${b.alias}` }); }
  for (const c of recents) if (!seen.has(c)) { seen.add(c); out.push({ path: c, label: c.split('/').pop() || c }); }
  for (const d of index.dirs) {
    if (d.isGitRepo && !seen.has(d.path)) { seen.add(d.path); out.push({ path: d.path, label: d.name }); }
  }
  return out;
}


/** 按脏工作区策略切各 repo 分支 → 开一个 claude tab → 注入 bug 上下文 → 回结果卡。 */
async function finalizeTapdClaim(
  client: Lark.Client,
  chatId: string,
  claim: import('multiagent-orchestrator').TapdClaim,
  strategy: string,
): Promise<void> {
  const hm = await import('multiagent-host-mac');
  const orch = await import('multiagent-orchestrator');
  const { sendCardMessage, sendTextMessage } = await import('./api.js');
  const { ackCard } = await import('./cards.js');
  try {
    const baseMode = claim.base ?? 'head';
    const id6 = claim.id.slice(-6);
    // kind：显式 claim.kind 优先（认领卡「🏷 类型」选），否则由 base/sop 派生（兼容旧 claim）
    const kind: import('multiagent-host-mac').TaskKind = orch.resolveClaimKind(claim);
    let results: { ok: boolean; repo: string; cwd: string; branch: string; action: string; reason?: string; note?: string }[] = [];
    let taskDir: string | undefined;
    if (kind === 'indev') {
      // 开发中的 bug：在各 repo 当前分支原地改（分支报告准确，不建目录）
      for (const repo of claim.selectedRepos) results.push(await hm.useCurrentBranch(repo));
    } else {
      // 线上bug/新需求：在 ~/ihealth-work/<fix|feature>_<id6>/ 下为每个 repo 建 worktree（本地有源）/ clone（无源）
      const base = baseMode === 'head' ? undefined : baseMode; // master/develop 从主干切；head 用 HEAD
      const repoPlans = claim.selectedRepos.map((p) => ({ name: p.split('/').filter(Boolean).pop() || p, sourcePath: p }));
      const ws = await hm.prepareTaskWorkspace({ kind, id6, repos: repoPlans, ...(base ? { base } : {}) });
      taskDir = ws.taskDir;
      results = ws.repos.map((r, i) => ({
        ok: r.ok,
        repo: repoPlans[i]?.sourcePath ?? r.name,   // 源 repo 路径
        cwd: r.cwd,                                  // worktree 工作目录（cwd!==repo → prompt 标 worktree）
        branch: ws.branch,
        action: r.ok ? 'created' : 'failed',
        ...(r.via === 'clone' ? { note: 'clone' } : {}),
        ...(r.reason ? { reason: r.reason } : {}),
      }));
    }
    const okRepos = results.filter((r) => r.ok);
    if (okRepos.length === 0) {
      await sendCardMessage(client, chatId, ackCard({
        title: `⚠️ ${claim.branch} 未开工`,
        body: `没有可用 repo：\n${results.map((r) => `❌ ${r.repo.split('/').pop()}：${r.reason ?? r.note ?? ''}`).join('\n')}`,
      }));
      return;
    }
    const primaryCwd = okRepos[0]!.cwd;
    const tty = await hm.newTab({ cwd: primaryCwd });
    await new Promise((r) => setTimeout(r, 1500));
    await hm.launchClaudeInTab(tty, { continueSession: false });
    await new Promise((r) => setTimeout(r, 1500));

    const tapdPrompt = buildTapdPrompt(claim, results);
    let modeNote: string;
    if (claim.sop) {
      // 需求（或用户切成 SOP）：跑多 stage SOP（Explore→需求分析→架构→[gate]→编码→测试→回归）
      const taskId = generateTaskId();
      const task = await createTask({
        taskId,
        tty,
        cwd: primaryCwd,
        chatId,
        stages: [...orch.DEFAULT_SDLC_STAGES],
        gates: [...orch.DEFAULT_SDLC_GATES],
        loops: orch.DEFAULT_SDLC_LOOPS.map((l) => ({ ...l })),
        artifactDir: `docs/tasks/${taskId}`,
        userPrompt: tapdPrompt,
        presetName: 'tapd-sop',
      });
      try {
        const mid = await sendCardReturnId(client, chatId, buildStageProgressCardFromTask(task, homedir()));
        if (mid) await setTaskProgressMessageId(task.taskId, mid);
      } catch { /* 降级：无进度卡 */ }
      await hm.send(tty, buildSopWrapperPrompt(task, tapdPrompt));
      modeNote = `🎯 SOP 编排 · task \`${task.taskId}\`（after-architect 有审批 gate）`;
    } else {
      // 缺陷：普通任务，直接修
      await hm.send(tty, tapdPrompt);
      modeNote = '🔧 普通任务（直接修）';
    }
    await new Promise((r) => setTimeout(r, 600));
    await hm.forceEnter(tty).catch(() => {});
    claim.status = 'working'; claim.tty = tty;
    claim.stage = 'fixing'; claim.chatId = chatId; // A 生命周期
    // B：记住该项目的 repo/基准/模式，下次认领自动预选
    await orch.saveRepoMap(claim.workspaceId, { repos: claim.selectedRepos, base: claim.base, sop: claim.sop });
    // 落 worktask 记录（目录↔任务↔分支，/worktasks 可搜）
    await orch.saveWorkTask({
      id: claim.id, id6, kind, title: claim.title,
      ...(taskDir ? { taskDir } : {}),
      branch: kind === 'indev' ? (okRepos[0]?.branch ?? claim.branch) : claim.branch,
      repos: okRepos.map((r) => r.cwd),
      base: claim.base, source: 'tapd', tapdUrl: claim.url,
      createdAt: Date.now(),
    }).catch((e) => logger.warn('saveWorkTask failed', { err: (e as Error).message }));
    const chat = await loadChat(chatId); chat.activeTty = tty; chat.lastActiveAt = Date.now(); await saveChat(chat);
    const lines = results.map((r) =>
      r.ok
        ? `✅ ${r.repo.split('/').pop()} → ${r.branch}（${r.action}）${r.note ? ` · ${r.note}` : ''}`
        : `❌ ${r.repo.split('/').pop()}：${r.reason ?? r.note ?? '失败'}`,
    );
    const dirNote = taskDir ? `📁 ${taskDir}\n` : '';
    claim.stageNote = `${modeNote}\n${dirNote}${lines.join('\n')}`;
    // A 生命周期卡：存 messageId 供后续 agent tapd stage patch
    const mid = await sendCardReturnId(client, chatId, tapdClaimCard(claim));
    if (mid) claim.cardMessageId = mid;
    await orch.saveClaim(claim);
  } catch (e) {
    await sendTextMessage(client, chatId, `❌ TAPD 开工失败：${(e as Error).message}`).catch(() => {});
  }
}

/** 拼 perf 认领注入 tab 的 prompt；tapdUrl 有则附上已建的 TAPD 需求链接。 */
function buildPerfClaimPrompt(item: PerfItem, tapdUrl?: string): string {
  const parts: string[] = [
    `【performance 性能建议 · ${item.priority}】${item.title}`,
  ];
  if (tapdUrl) parts.push(`已建 TAPD 需求：${tapdUrl}（修完在该需求下用 MCP 评论回填 commit/PR）`);
  if (item.localPath) parts.push(`仓库路径：${item.localPath}（先 cd 过去）`);
  else if (item.repo) parts.push(`仓库：${item.repo}`);
  if (item.database || item.collection) parts.push(`命名空间：${[item.database, item.collection].filter(Boolean).join('.')}`);
  if (item.rootCause) parts.push(`根因：${item.rootCause}`);
  if (item.rationale) parts.push(`说明：${item.rationale}`);
  if (item.indexCommand) parts.push(`建议索引：${item.indexCommand}`);
  if (item.codeFile) parts.push(`涉及文件：${item.codeFile}${item.codePermalink ? `（${item.codePermalink}）` : ''}`);
  if (item.codeChange) parts.push(`建议改动：${item.codeChange}`);
  parts.push('请定位并修复该性能问题；**验证只用本地/测试环境，严禁连线上库/生产**。改完把方案+改动摘要用 `agent lark send-text` 回我；涉及加索引/改库先 `agent request-approval`。');
  return parts.join('\n');
}

/**
 * 为单个任务准备 worktree 隔离目录（~/ihealth-work/<kind>_<id6>/<repo>/）并开新 tab 跑 prompt。
 * localPath 缺失或建目录失败 → 返回 { isolated:false }，调用方回退 active tab。落 worktask 记录。
 */
async function openTaskWorktreeTab(opts: {
  kind: 'fix' | 'feature'; id6: string; localPath?: string; prompt: string;
  chatId: string; title: string; id: string; source: 'perf' | 'tapd'; tapdUrl?: string;
}): Promise<{ isolated: boolean; tty?: string; taskDir?: string }> {
  if (!opts.localPath) return { isolated: false };
  const hm = await import('multiagent-host-mac');
  const orch = await import('multiagent-orchestrator');
  const name = opts.localPath.split('/').filter(Boolean).pop() || opts.localPath;
  const ws = await hm.prepareTaskWorkspace({ kind: opts.kind, id6: opts.id6, repos: [{ name, sourcePath: opts.localPath }] });
  const ok = ws.repos.find((r) => r.ok);
  if (!ok) return { isolated: false };
  await orch.saveWorkTask({
    id: opts.id, id6: opts.id6, kind: opts.kind, title: opts.title,
    ...(ws.taskDir ? { taskDir: ws.taskDir } : {}),
    branch: ws.branch, repos: [ok.cwd], source: opts.source,
    ...(opts.tapdUrl ? { tapdUrl: opts.tapdUrl } : {}),
    createdAt: Date.now(),
  }).catch((e) => logger.warn('saveWorkTask (perf) failed', { err: (e as Error).message }));
  const tty = await newTab({ cwd: ok.cwd });
  await new Promise((r) => setTimeout(r, 1500));
  await hm.launchClaudeInTab(tty, { continueSession: false });
  await new Promise((r) => setTimeout(r, 1500));
  await send(tty, opts.prompt);
  await new Promise((r) => setTimeout(r, 600));
  await forceEnter(tty).catch(() => {});
  const chat = await loadChat(opts.chatId); chat.activeTty = tty; chat.lastActiveAt = Date.now(); await saveChat(chat);
  return { isolated: true, tty, ...(ws.taskDir ? { taskDir: ws.taskDir } : {}) };
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

  if (action === 'plan-dispatch') {
    const planId = value['planId'] as string | undefined;
    const step = Number(value['step']);
    if (!planId || !Number.isInteger(step)) return { toast: { type: 'error', content: '缺 planId/step' } };
    const plan = getPlan(planId);
    if (!plan) return { toast: { type: 'error', content: '计划已过期（dev 重启会清空），重新 /plan' } };
    const st = plan.steps[step];
    if (!st) return { toast: { type: 'error', content: '步骤不存在' } };
    const ctx = { messageId: 'plan-dispatch', chatId };
    // fire-and-forget：优先 planner 建议的 target（能解析到 tab 才用），否则发 active tab
    (async () => {
      try {
        let routedTo = '';
        if (st.target) {
          const tabs = await listTabs();
          const resolved = resolveTarget(tabs, st.target.replace(/^\/dev\//, '').toLowerCase());
          if (resolved) { await sendToNamedTarget(client, ctx, st.target, st.prompt); routedTo = st.target; }
        }
        if (!routedTo) await sendToActiveTab(client, ctx, st.prompt);
        void sendText(client, chatId, `▶ 已派发步骤 ${step + 1}「${st.title}」${routedTo ? `→ ${routedTo}` : '→ active tab'}`);
      } catch (e) {
        void sendText(client, chatId, `❌ 派发步骤 ${step + 1} 失败：${(e as Error).message}`);
      }
    })();
    return { toast: { type: 'success', content: `派发步骤 ${step + 1}` } };
  }

  if (action === 'careyclaw-key-update') {
    void sendCard(client, chatId, careyclawKeyFormCard());
    return { toast: { type: 'info', content: '打开更新表单' } };
  }

  if (action === 'careyclaw-key-submit') {
    const fv = (data.action?.form_value ?? {}) as Record<string, unknown>;
    const key = typeof fv['dev_key'] === 'string' ? (fv['dev_key'] as string).trim() : '';
    const exp = typeof fv['expires_at'] === 'string' ? (fv['expires_at'] as string).trim() : '';
    if (!key) return { toast: { type: 'error', content: '没填密钥' } };
    (async () => {
      try {
        await setCareyclawKey(key, exp || undefined);
        void sendText(client, chatId, `✅ CareyClaw 调试密钥已更新（存到本项目 .env）${exp ? `，到期日 ${exp}` : ''}。开发 careyclaw app 时，在那个项目里说"把 CAREYCLAW_DEV_KEY 写进 .env.local"即可用真实 API 调试。`);
      } catch (e) {
        void sendText(client, chatId, `❌ 更新失败：${(e as Error).message}`);
      }
    })();
    return { toast: { type: 'success', content: '已保存' } };
  }

  if (action === 'connect-config') {
    const key = value['key'] as string | undefined;
    const it = key ? getIntegration(key) : undefined;
    if (!it) return { toast: { type: 'error', content: '未知对接' } };
    // skill 型：下载安装官方 Claude Code 技能，不填 env。
    if (it.skillType) {
      (async () => {
        try {
          const r = await installIntegrationSkills(it);
          if (r.ok) {
            void sendText(client, chatId, `📥 ${it.name} 技能已安装：${r.installed.join(' + ')}\n用法：飞书直接说「careyclaw 有没有查XX的接口 / 这个接口怎么调」检索试调，或「部署应用到 careyclaw 测试/生产」发布。首次会给你一个浏览器授权链接（点确认即可，无需填密钥）。`);
          } else {
            void sendText(client, chatId, `❌ ${it.name} 技能安装失败：${r.failed.join(', ')}（检查能否访问 bot.ihealthcn.com）`);
          }
        } catch (e) {
          void sendText(client, chatId, `❌ 安装失败：${(e as Error).message}`);
        }
      })();
      return { toast: { type: 'info', content: '安装技能中…' } };
    }
    // agent 型（codex）：检测状态 + 发引导，不填 env 不装技能
    if (it.agentType === 'codex') {
      (async () => {
        try {
          const { codexAgentStatus, codexNextStep } = await import('multiagent-orchestrator');
          const st = await codexAgentStatus();
          const lines = [
            `**${it.name}** 状态：`,
            `${st.installed ? '✅' : '⬜'} CLI 安装${st.binPath ? `（${st.binPath}）` : ''}`,
            `${st.loggedIn ? '✅' : '⬜'} 登录${st.loginDetail ? `（${st.loginDetail}）` : ''}`,
            `${st.notifyHooked ? '✅' : '⬜'} notify 回传钩子`,
            '',
            `👉 ${codexNextStep(st)}`,
          ];
          void sendText(client, chatId, lines.join('\n'));
        } catch (e) {
          void sendText(client, chatId, `❌ codex 状态检测失败：${(e as Error).message}`);
        }
      })();
      return { toast: { type: 'info', content: '检测 codex 状态…' } };
    }
    const form = connectFormCard(it);
    if (form) {
      void sendCard(client, chatId, form);
    } else {
      // 纯开关型（如知识提炼）：直接暂存固定值 → 确认
      const kv: Record<string, string> = {};
      for (const f of it.fields) if (f.fixedValue) kv[f.env] = f.fixedValue;
      connectStaging.set(it.key, kv);
      void sendCard(client, chatId, connectConfirmCard(it.key, it.name, Object.entries(kv).map(([k, v]) => `· ${k} = ${v}`)));
    }
    return { toast: { type: 'info', content: '打开配置…' } };
  }

  if (action === 'connect-submit') {
    const key = value['key'] as string | undefined;
    const it = key ? getIntegration(key) : undefined;
    if (!it) return { toast: { type: 'error', content: '未知对接' } };
    const fv = (data.action?.form_value ?? {}) as Record<string, unknown>;
    const kv: Record<string, string> = {};
    for (const f of it.fields) {
      if (f.fixedValue) { kv[f.env] = f.fixedValue; continue; }
      const v = fv[f.env];
      if (typeof v === 'string' && v.trim()) kv[f.env] = v.trim();
    }
    if (Object.keys(kv).length === 0) return { toast: { type: 'error', content: '没填任何值' } };
    connectStaging.set(it.key, kv);
    // 脱敏展示
    const lines = it.fields.filter((f) => kv[f.env] !== undefined).map((f) => {
      const val = kv[f.env]!;
      const shown = f.secret ? (val.length <= 4 ? '****' : val.slice(0, 2) + '***' + val.slice(-2)) : val;
      return `· ${f.label}(${f.env}) = ${shown}`;
    });
    void sendCard(client, chatId, connectConfirmCard(it.key, it.name, lines));
    return { toast: { type: 'success', content: '已收到，确认写入' } };
  }

  if (action === 'connect-apply') {
    const key = value['key'] as string | undefined;
    const it = key ? getIntegration(key) : undefined;
    const kv = key ? connectStaging.get(key) : undefined;
    if (!it || !kv || Object.keys(kv).length === 0) return { toast: { type: 'error', content: '配置已失效，请重新 /connect' } };
    (async () => {
      try {
        await upsertEnvKeys(kv);
        connectStaging.delete(key!);
        await patchOrigToReceipt(client, data, `✅ 已写入 .env · ${it.name}`, '正在重启 dev 生效…', 'green');
        void sendText(client, chatId, `🔌 ${it.name} 配置已写入 .env，正在重启 dev（约数秒）。重启后发 /connect 可确认状态变 ✅。`);
        // 触发 tsx watch reload（新进程重跑 dotenv/config 读新 .env）
        setTimeout(() => { try { const now = Date.now() / 1000; utimesSync(resolve('apps/daemon/src/index.ts'), now, now); } catch (e) { logger.warn('connect restart touch 失败', { err: (e as Error).message }); } }, 800);
      } catch (e) {
        void sendText(client, chatId, `❌ 写入 .env 失败：${(e as Error).message}`);
      }
    })();
    return {}; // return toast 会盖掉 IIFE 里的 patchCard（CLAUDE.md）；靠卡刷新 + sendText 反馈
  }

  if (action === 'connect-cancel') {
    const key = value['key'] as string | undefined;
    if (key) connectStaging.delete(key);
    void patchOrigToReceipt(client, data, '⊘ 已取消对接配置', undefined, 'grey');
    return {};
  }

  if (action === 'connect-disable' || action === 'connect-enable') {
    const key = value['key'] as string | undefined;
    const it = key ? getIntegration(key) : undefined;
    if (!it) return { toast: { type: 'error', content: '未知对接' } };
    const disable = action === 'connect-disable';
    (async () => {
      try {
        await setIntegrationDisabled(key!, disable);   // 只改停用列表，不动该对接配置 env
        await patchOrigToReceipt(client, data, `${disable ? '⏸ 已停用' : '▶ 已启用'} · ${it.name}`, `配置保留，重启 dev 生效…`, disable ? 'grey' : 'green');
        void sendText(client, chatId, `${disable ? '⏸' : '▶'} ${it.name} 已${disable ? '停用（配置保留，可随时启用）' : '启用'}，正在重启 dev 生效。`);
        setTimeout(() => { try { const now = Date.now() / 1000; utimesSync(resolve('apps/daemon/src/index.ts'), now, now); } catch (e) { logger.warn('connect toggle restart touch 失败', { err: (e as Error).message }); } }, 800);
      } catch (e) {
        void sendText(client, chatId, `❌ ${disable ? '停用' : '启用'}失败：${(e as Error).message}`);
      }
    })();
    return {}; // 同上：靠卡刷新 + sendText 反馈，不 return toast
  }

  if (action === 'perf-claim') {
    const id = value['id'] as string | undefined;
    if (!id) return { toast: { type: 'error', content: '缺 id' } };
    const item = getPerfItem(id);
    if (!item) return { toast: { type: 'error', content: '该建议已过期（dev 重启会清空缓存），等下一轮 watcher 重推' } };
    const ctx = { messageId: 'perf-claim', chatId };
    const prompt = buildPerfClaimPrompt(item);
    (async () => {
      try {
        await sendToActiveTab(client, ctx, prompt);
        void sendText(client, chatId, `🔧 已认领「${item.title.slice(0, 40)}」→ 已把上下文发到 active tab（没设就先 /use @xxx）`);
      } catch (e) {
        void sendText(client, chatId, `❌ 认领派发失败：${(e as Error).message}`);
      }
    })();
    return { toast: { type: 'success', content: '已认领，派发中' } };
  }

  // 认领并创建需求：建一条 TAPD 需求（创建人+开发负责人=认领者，挂后端服务分类）→ 再派发修复
  if (action === 'perf-claim-story') {
    const id = value['id'] as string | undefined;
    if (!id) return { toast: { type: 'error', content: '缺 id' } };
    const item = getPerfItem(id);
    if (!item) return { toast: { type: 'error', content: '该建议已过期（dev 重启会清空缓存），等下一轮 watcher 重推' } };
    const ctx = { messageId: 'perf-claim-story', chatId };
    (async () => {
      try {
        // 幂等：已建过就复用，不重建
        let storyUrl = item.tapdStoryUrl;
        if (item.tapdStoryId && storyUrl) {
          void sendText(client, chatId, `📋 该建议已建过 TAPD 需求：${storyUrl}（复用，不重建）`);
        } else {
          const r = await createPerfStory(item);
          if (!r.ok) {
            void sendText(client, chatId, `❌ 建 TAPD 需求失败：${r.error}\n（可先「🔧 认领修复」不建需求；或等 MCP 网关恢复重试）`);
            return;
          }
          storyUrl = r.url;
          item.tapdStoryUrl = r.url;
          if (r.storyId) item.tapdStoryId = r.storyId;
          savePerfItem(item); // 回填缓存，防重建
          void sendText(client, chatId, `📋 已建 TAPD 需求（创建人+开发负责人=你）：${r.url}`);
        }
        // 建完 → 用 story 后6位建隔离目录开 tab 修（本地有源）；无源回退 active tab
        const prompt = buildPerfClaimPrompt(item, storyUrl);
        const id6 = (item.tapdStoryId ?? item.id).slice(-6);
        const wt = await openTaskWorktreeTab({
          kind: 'fix', id6,
          ...(item.localPath ? { localPath: item.localPath } : {}),
          prompt, chatId, title: item.title, id: item.tapdStoryId ?? item.id, source: 'perf',
          ...(storyUrl ? { tapdUrl: storyUrl } : {}),
        });
        if (wt.isolated) {
          void sendText(client, chatId, `📁 已建隔离目录：${wt.taskDir}\n🔧 已在新 tab ${wt.tty} 开修「${item.title.slice(0, 40)}」（含需求链接，fix_${id6} 分支）`);
        } else {
          await sendToActiveTab(client, ctx, prompt);
          void sendText(client, chatId, `🔧 已认领「${item.title.slice(0, 40)}」（本地无该 repo 源，未建隔离目录）→ 上下文已发 active tab（没设先 /use @xxx）`);
        }
      } catch (e) {
        void sendText(client, chatId, `❌ 认领并建需求失败：${(e as Error).message}`);
      }
    })();
    return { toast: { type: 'success', content: '建需求 + 派发中…' } };
  }

  if (action === 'perf-snooze') {
    const id = value['id'] as string | undefined;
    if (!id) return { toast: { type: 'error', content: '缺 id' } };
    await markPerfSnoozed(id);
    void patchOrigToReceipt(client, data, '🕐 已稍后提醒', '3 小时后再推', 'grey');
    return {};
  }

  if (action === 'perf-not-mine') {
    const id = value['id'] as string | undefined;
    if (!id) return { toast: { type: 'error', content: '缺 id' } };
    await markPerfIgnoredForever(id);
    void patchOrigToReceipt(client, data, '🙈 已标记：不再提醒此项', undefined, 'grey');
    return {};
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
    // 用户明确切了 shell → 清 one-shot pendingAnswerTty 与 sticky recentReplyTty
    // （否则旧粘性会抢新 activeTty 的路由）
    delete chat.pendingAnswerTty;
    delete chat.pendingAnswerAt;
    delete chat.recentReplyTty;
    delete chat.recentReplyAt;
    await saveChat(chat);
    if (tab.cwd) void recordCwd(tab.cwd);
    // patch 原卡为回执做反馈（**fire-and-forget**）；**绝不能 return { toast }** ——
    // 飞书收到 toast 响应会把卡当"已处理无更新"，盖掉这个 patch → 点了像没反应（CLAUDE.md 坑）。
    void patchOrigToReceipt(
      client,
      data,
      `⭐ 已切到 ${tab.tty}`,
      tab.cwd ? `cwd: \`${tab.cwd}\`` : undefined,
    );
    return {};
  }

  // ==== 关闭 tab（先退 agent 再关；破坏性 → 确认 + 禁关 daemon 自己）====
  if (action === 'close-tab-confirm') {
    // 点每个 tab 的「🗑 关闭」→ 弹确认卡（另发新消息，不 patch tabsCard）。
    const tty = value['tty'] as string | undefined;
    if (!tty) return { toast: { type: 'error', content: '缺 tty' } };
    void (async () => {
      const tabs = await listTabs();
      const tab = tabs.find((t) => t.tty === tty);
      if (!tab) { void sendText(client, chatId, `⚠️ ${tty} 已不在（可能已关）`); return; }
      if (detectSelfTty() === tty) { void sendText(client, chatId, `🚫 ${tty} 是 daemon 自己所在的 tab，不能关（会把整套服务关掉）`); return; }
      const adapter = detectAgentFromProcs(tab.processes);
      const { sendCardMessage } = await import('./api.js');
      void sendCardMessage(client, chatId, closeTabConfirmCard(tty, {
        ...(tab.cwd ? { cwd: tab.cwd } : {}),
        hasAgent: adapter !== null,
        ...(adapter ? { agentLabel: adapter.displayName } : {}),
      }));
    })();
    return {};
  }

  if (action === 'close-tab-do') {
    const tty = value['tty'] as string | undefined;
    if (!tty) return { toast: { type: 'error', content: '缺 tty' } };
    void (async () => {
      const r = await closeTabGracefully(tty);
      if (!r.closed) { void sendText(client, chatId, `❌ ${r.reason ?? `关闭 ${tty} 失败`}`); return; }
      const note = r.hadAgent
        ? r.agentExited ? `已退出 ${r.agentKind ?? 'agent'}` : `${r.agentKind ?? 'agent'} 没退干净，已强关`
        : undefined;
      void patchOrigToReceipt(client, data, `🗑 已关闭 ${tty}`, note, 'grey');
    })();
    return {};
  }

  if (action === 'close-idle-confirm') {
    void (async () => {
      const self = detectSelfTty();
      const tabs = await listTabs();
      // 空闲 = 非忙碌 + 非 daemon 自己（含普通 shell 和 idle 的 agent；有 agent 的关前会先退）
      const idle = tabs.filter((t) => t.tty !== self && !t.busy);
      if (idle.length === 0) { void sendText(client, chatId, 'ℹ️ 没有空闲 tab 可关（都在忙 / 只剩 daemon 自己）'); return; }
      const { sendCardMessage } = await import('./api.js');
      void sendCardMessage(client, chatId, closeIdleConfirmCard(idle.map((t) => ({
        tty: t.tty,
        ...(t.cwd ? { cwd: t.cwd } : {}),
        ...(detectAgentFromProcs(t.processes) ? { agentLabel: detectAgentFromProcs(t.processes)!.displayName } : {}),
      }))));
    })();
    return {};
  }

  if (action === 'close-idle-do') {
    void (async () => {
      const self = detectSelfTty();
      const tabs = await listTabs();
      const idle = tabs.filter((t) => t.tty !== self && !t.busy);
      let closed = 0;
      const failed: string[] = [];
      for (const t of idle) {
        const r = await closeTabGracefully(t.tty);
        if (r.closed) closed++;
        else failed.push(t.tty);
      }
      const detail = `关闭 ${closed}/${idle.length} 个${failed.length ? `　未关：${failed.join(', ')}` : ''}`;
      void patchOrigToReceipt(client, data, '🧹 批量关闭完成', detail, 'grey');
    })();
    return {};
  }

  if (action === 'close-cancel') {
    void patchOrigToReceipt(client, data, '⊘ 已取消', '没有关闭任何 tab', 'grey');
    return {};
  }

  // ==== macOS 授权缺失卡：打开面板 / 授好了重启复检 ====
  if (action === 'perm-open-pane') {
    const pane = value['pane'] === 'accessibility' ? 'accessibility' : 'automation';
    openPermissionPane(pane);
    const label = pane === 'accessibility' ? '「辅助功能」' : '「自动化」';
    void sendText(
      client, chatId,
      `📂 已在 Mac 打开${label}授权面板。\n到电脑旁勾选 node（launchd 模式）/ Terminal（dev 模式）后，回来点【🔄 我授好了 · 重启复检】。\n⚠️ 授权只能在 Mac 本地点，远程点不了。`,
    );
    return {};
  }

  if (action === 'perm-recheck') {
    void (async () => {
      await sendText(client, chatId, '🔄 正在重启 daemon 复检授权…（约 5 秒；补齐会推 ✅，仍缺会再报）').catch(() => {});
      // kickstart 自己（launchd 会立刻拉起新进程，新进程启动 10s 后自动复检并推结果）。
      // 放 sendText 之后，避免消息还没发出去进程就被杀。dev 模式无此 label，kickstart 失败即忽略。
      try {
        const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
        spawn('launchctl', ['kickstart', '-k', `gui/${uid}/com.multiagent-chat.daemon`], {
          stdio: 'ignore', detached: true,
        }).unref();
      } catch { /* ignore */ }
    })();
    return {};
  }

  if (action === 'worktask-open') {
    const id = value['id'] as string | undefined;
    if (!id) return { toast: { type: 'error', content: '缺 id' } };
    const orch = await import('multiagent-orchestrator');
    const wt = await orch.getWorkTask(id);
    if (!wt || wt.repos.length === 0) return { toast: { type: 'error', content: '记录已失效或无目录' } };
    const cwd = wt.repos[0]!;
    if (!existsSync(cwd)) {
      void sendText(client, chatId, `⚠️ 目录已不存在（可能被清理/删除）：\n\`${cwd}\`\n分支 \`${wt.branch}\`，需要的话重新认领会重建。`);
      return { toast: { type: 'error', content: '目录已不存在' } };
    }
    try {
      const tty = await newTab({ cwd });
      const chat = await loadChat(chatId); chat.activeTty = tty; chat.lastActiveAt = Date.now(); await saveChat(chat);
      void recordCwd(cwd);
      const extra = wt.repos.length > 1
        ? `\n<font color='grey'>另 ${wt.repos.length - 1} 个 repo：${wt.repos.slice(1).map((r) => r.split('/').pop()).join('、')}</font>`
        : '';
      void sendText(client, chatId, `📂 已在新 tab \`${tty}\` 打开「${wt.title.slice(0, 40)}」\ncwd: \`${cwd}\`　·　分支 \`${wt.branch}\`　·　已设为 active${extra}`);
      return { toast: { type: 'success', content: `📂 打开 ${tty}` } };
    } catch (e) {
      return { toast: { type: 'error', content: (e as Error).message } };
    }
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

  if (action === 'browse-dir' || action === 'browse-dir-select') {
    let target: string | undefined;
    if (action === 'browse-dir-select') {
      const option = data.action?.option;
      if (option?.startsWith('browse-dir|')) {
        target = option.slice('browse-dir|'.length);
      }
    } else {
      target = value['cwd'] as string | undefined;
    }
    if (!target) return { toast: { type: 'error', content: '缺 cwd' } };
    return await buildBrowseReply(target);
  }

  // AskUserQuestion 选项按钮：点了发方向键 (index)↓+回车 驱动源 shell 的原生选择菜单。
  if (action === 'ask-select') {
    const tty = value['tty'] as string | undefined;
    const index = Number(value['index']);
    const label = (value['label'] as string | undefined) ?? '';
    if (!tty || !Number.isInteger(index) || index < 0) {
      return { toast: { type: 'error', content: '无效选项' } };
    }
    return await driveAskSelectFromCard(client, data, chatId, tty, index, label);
  }

  // originShellPushCard 的下拉选择：
  //  - `askans|<tty>|<index>` → AskUserQuestion 箭头菜单，方向键驱动（同 ask-select）
  //  - `answer|<tty>|<label>` → 老路径：把 label 打进源 shell（send-to-tab 语义）
  if (action === 'answer-select') {
    const option = data.action?.option;
    if (option && option.startsWith('askans|')) {
      const rest = option.slice('askans|'.length);
      const sep = rest.indexOf('|');
      if (sep < 0) return { toast: { type: 'error', content: '无效选项格式' } };
      const tty = rest.slice(0, sep);
      const index = Number(rest.slice(sep + 1));
      if (!Number.isInteger(index) || index < 0) {
        return { toast: { type: 'error', content: '无效选项编号' } };
      }
      return await driveAskSelectFromCard(client, data, chatId, tty, index, '');
    }
    if (!option || !option.startsWith('answer|')) {
      return { toast: { type: 'error', content: '无效的选项' } };
    }
    // 用 split 只切前 2 段，第 3 段保留 label 里可能的 `|`
    const rest = option.slice('answer|'.length);
    const sep = rest.indexOf('|');
    if (sep < 0) return { toast: { type: 'error', content: '无效选项格式' } };
    const tty = rest.slice(0, sep);
    const label = rest.slice(sep + 1);
    try {
      const sent = await sendKeysRaw(tty, label);
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
      // fire-and-forget patch；return {} 让卡刷新生效（return toast 会盖掉 patch，见 CLAUDE.md）
      void patchOrigToReceipt(
        client,
        data,
        `✓ 已回答『${label.length > 20 ? label.slice(0, 20) + '…' : label}』→ ${tty}`,
      );
      return {};
    } catch (e) {
      return { toast: { type: 'error', content: (e as Error).message } };
    }
  }

  // originShellPushCard 上的「→ 回复当前」按钮：把 pendingAnswerTty 重定向到
  // chat.activeTty，覆盖卡片默认的"回复源 shell"行为。逃生口场景：
  //   activeTty=A；shell B 弹 AskUserQuestion → pendingAnswerTty=B
  //   用户点这个按钮 → pendingAnswerTty=A → 下一条裸文本走 A
  if (action === 'arm-active-reply') {
    const chat = await loadChat(chatId);
    if (!chat.activeTty) {
      return {
        toast: { type: 'error', content: '本 chat 无 active tab；用 /use 选一个' },
      };
    }
    const tabs = await listTabs();
    const tab = tabs.find((t) => t.tty === chat.activeTty);
    if (!tab) {
      return { toast: { type: 'error', content: `active ${chat.activeTty} 不存在` } };
    }
    chat.pendingAnswerTty = chat.activeTty;
    chat.pendingAnswerAt = Date.now();
    // sticky 也清一下，让 activeTty 干净接管
    delete chat.recentReplyTty;
    delete chat.recentReplyAt;
    await saveChat(chat);
    void patchOrigToReceipt(
      client,
      data,
      `⏳ 下一条文本发到 active（${chat.activeTty}）`,
      `${tab.cwd ? `cwd: \`${tab.cwd}\`\n` : ''}<font color='grey'>在下方 chat 直接输入即可</font>`,
      'blue',
    );
    return {};
  }

  // 「→ 发一条」按钮：不发消息，只 arm 一个 pendingAnswerTty（复用 AskUserQuestion
  // 的同一机制）。下一条无 @target 的裸文本自动路由到该 tab，one-shot 消耗。
  // 目的：手机端免打 @tty，两 tap（选 tab + 输文本）就能定向发一条。
  if (action === 'send-to-tab-arm') {
    const tty = value['tty'] as string | undefined;
    if (!tty) return { toast: { type: 'error', content: '缺 tty' } };
    const tabs = await listTabs();
    const tab = tabs.find((t) => t.tty === tty);
    if (!tab) return { toast: { type: 'error', content: `tab ${tty} 不存在` } };
    const chat = await loadChat(chatId);
    chat.pendingAnswerTty = tty;
    chat.pendingAnswerAt = Date.now();
    await saveChat(chat);
    void patchOrigToReceipt(
      client,
      data,
      `⏳ 下一条文本发到 ${tty}`,
      `${tab.cwd ? `cwd: \`${tab.cwd}\`\n` : ''}<font color='grey'>在下方 chat 直接输入即可（10 min 内 one-shot 生效）</font>`,
      'blue',
    );
    return {};
  }

  if (action === 'send-to-tab') {
    const tty = value['tty'] as string | undefined;
    const text = (value['text'] as string | undefined) ?? '';
    if (!tty) return { toast: { type: 'error', content: '缺 tty' } };
    try {
      const sent = await sendKeysRaw(tty, text);
      if (!sent) {
        // tab 消失 → 保留原卡（作为可诊断上下文），另发红色错误卡
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
      // patch 原卡为回执（fire-and-forget）；return {} 让 patch 生效（return toast 会盖掉它）
      void patchOrigToReceipt(
        client,
        data,
        `✓ 已回答『${shown.length > 20 ? shown.slice(0, 20) + '…' : shown}』→ ${tty}`,
      );
      return {};
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

  // ⚠ 反馈只能走 sendText / patchCard —— 本回调走 card.action.trigger 的 fire-and-forget IIFE，
  // 那里只消费 result.card、**丢弃 result.toast** 后回飞书 {}（见文件末 card.action.trigger 分发 +
  // CLAUDE.md "绝不能 return { toast }" 坑）。所以 cancel-* 若只 return { toast }，Ctrl-C 其实发出去了
  // 但飞书侧零反馈 → 用户"点了看不出效果"。这里一律 fire-and-forget sendText + return {}。
  if (action === 'cancel-all-pending') {
    const allPending = pendingTracker.all();
    if (allPending.length === 0) {
      void sendText(client, chatId, 'ℹ️ 没有 pending 任务');
      return {};
    }
    let count = 0;
    for (const p of allPending) {
      try {
        await sendKeys(p.tty, 'ctrl+c'); // System Events：会把该 tab 拉前台再按 Ctrl-C
        count++;
      } catch (e) {
        logger.warn('cancel-all: ctrl-c failed', { tty: p.tty, err: (e as Error).message });
      }
    }
    void sendText(client, chatId, `⊘ 已对 ${count}/${allPending.length} 个 tab 发送 Ctrl-C`);
    return {};
  }

  if (action === 'cancel-task') {
    const tty = value['tty'] as string | undefined;
    if (!tty) {
      void sendText(client, chatId, '❌ 缺 tty，无法发 Ctrl-C');
      return {};
    }
    try {
      // Ctrl-C 靠 System Events keystroke（sendKeys 会把该 tab 拉前台再按 ⌃C）。单次 Ctrl-C
      // 中断当前 shell 命令 / claude|codex 的本轮生成；要退出 TUI 用 /restart（双 Ctrl-C）。
      await sendKeys(tty, 'ctrl+c');
      void sendText(client, chatId, `⊘ 已对 ${tty} 发送 Ctrl-C（中断当前命令 / 本轮生成；仍在跑就再点一次，退出 TUI 用 /restart）`);
    } catch (e) {
      void sendText(client, chatId, `❌ 对 ${tty} 发 Ctrl-C 失败：${(e as Error).message}`);
    }
    return {};
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

  // ---- TAPD 认领流程 ----
  if (action === 'tapd-claim') {
    const id = value['id'] as string | undefined;
    const system = (value['system'] as 'bug' | 'story' | undefined) ?? 'bug';
    const workspaceId = Number(value['workspaceId']);
    const branch = value['branch'] as string | undefined;
    const title = (value['title'] as string | undefined) ?? '';
    if (!id || !branch) return { toast: { type: 'error', content: '缺 id/branch' } };
    void (async () => {
      try {
        const orch = await import('multiagent-orchestrator');
        const hm = await import('multiagent-host-mac');
        const { tapdRepoPickerCard } = await import('./cards.js');
        const { sendCardMessage } = await import('./api.js');
        const cfg = orch.loadTapdConfig();
        let description: string | undefined;
        if (cfg.enabled && Number.isFinite(workspaceId)) {
          const c = new orch.TapdMcpClient(cfg.mcpUrl, cfg.token);
          const d = await orch.getItemDetail(c, workspaceId, system, id).catch(() => null);
          if (d?.description) description = d.description;
        }
        const url = system === 'bug'
          ? `https://www.tapd.cn/${workspaceId}/bugtrace/bugs/view/${id}`
          : `https://www.tapd.cn/${workspaceId}/prong/stories/view/${id}`;
        const claim = {
          id, system, workspaceId, title, branch, url, description,
          selectedRepos: [] as string[],
          sop: system === 'story', // 需求默认走 SOP，缺陷默认普通任务
          base: 'head' as 'current' | 'head' | 'master' | 'develop', // 默认从 HEAD 切
          status: 'picking' as const, createdAt: Date.now(),
        };
        // B 一键认领：该 TAPD 项目上次认领过 → 自动预选 repo/基准/模式
        const prev = await orch.getRepoMap(workspaceId);
        if (prev) {
          claim.selectedRepos = prev.repos;
          claim.base = prev.base;
          claim.sop = prev.sop;
        }
        await orch.saveClaim(claim);
        const candidates = await tapdRepoCandidates(hm);
        await sendCardMessage(client, chatId, tapdRepoPickerCard(claim, candidates, process.env['HOME'] ?? ''));
      } catch (e) {
        logger.warn('tapd-claim failed', { err: (e as Error).message });
      }
    })();
    return { toast: { type: 'info', content: '认领中，选 repo…' } };
  }

  if (action === 'tapd-pick-repo') {
    const id = value['id'] as string | undefined;
    const cwd = value['cwd'] as string | undefined;
    if (!id || !cwd) return { toast: { type: 'error', content: '缺 id/cwd' } };
    const orch = await import('multiagent-orchestrator');
    const hm = await import('multiagent-host-mac');
    const { tapdRepoPickerCard } = await import('./cards.js');
    const claim = await orch.toggleRepo(id, cwd);
    if (!claim) return { toast: { type: 'error', content: '认领已失效' } };
    const candidates = await tapdRepoCandidates(hm);
    return { card: tapdRepoPickerCard(claim, candidates, process.env['HOME'] ?? '') };
  }

  if (action === 'tapd-toggle-sop') {
    const id = value['id'] as string | undefined;
    if (!id) return { toast: { type: 'error', content: '缺 id' } };
    const orch = await import('multiagent-orchestrator');
    const hm = await import('multiagent-host-mac');
    const { tapdRepoPickerCard } = await import('./cards.js');
    const claim = await orch.loadClaim(id);
    if (!claim) return { toast: { type: 'error', content: '认领已失效' } };
    claim.sop = !claim.sop;
    await orch.saveClaim(claim);
    const candidates = await tapdRepoCandidates(hm);
    return { card: tapdRepoPickerCard(claim, candidates, process.env['HOME'] ?? '') };
  }

  if (action === 'tapd-cycle-kind') {
    const id = value['id'] as string | undefined;
    if (!id) return { toast: { type: 'error', content: '缺 id' } };
    const orch = await import('multiagent-orchestrator');
    const hm = await import('multiagent-host-mac');
    const { tapdRepoPickerCard } = await import('./cards.js');
    const claim = await orch.loadClaim(id);
    if (!claim) return { toast: { type: 'error', content: '认领已失效' } };
    const order = ['fix', 'feature', 'indev'] as const;
    const cur = order.indexOf(orch.resolveClaimKind(claim));
    const next = order[(cur + 1) % order.length]!;
    claim.kind = next;
    // 让 base/sop 跟随 kind 取合理默认（sop 仍可用「切成」按钮微调，两者正交）
    if (next === 'indev') { claim.base = 'current'; claim.sop = false; }
    else { if (claim.base === 'current') claim.base = 'head'; claim.sop = next === 'feature'; }
    await orch.saveClaim(claim);
    const candidates = await tapdRepoCandidates(hm);
    return { card: tapdRepoPickerCard(claim, candidates, process.env['HOME'] ?? '') };
  }

  if (action === 'tapd-cycle-base') {
    const id = value['id'] as string | undefined;
    if (!id) return { toast: { type: 'error', content: '缺 id' } };
    const orch = await import('multiagent-orchestrator');
    const hm = await import('multiagent-host-mac');
    const { tapdRepoPickerCard } = await import('./cards.js');
    const claim = await orch.loadClaim(id);
    if (!claim) return { toast: { type: 'error', content: '认领已失效' } };
    const order = ['head', 'current', 'develop', 'master'] as const;
    const cur = order.indexOf((claim.base ?? 'head') as (typeof order)[number]);
    claim.base = order[(cur + 1) % order.length]!;
    await orch.saveClaim(claim);
    const candidates = await tapdRepoCandidates(hm);
    return { card: tapdRepoPickerCard(claim, candidates, process.env['HOME'] ?? '') };
  }

  if (action === 'tapd-ignore') {
    const id = value['id'] as string | undefined;
    if (id) {
      const orch = await import('multiagent-orchestrator');
      const claim = await orch.loadClaim(id);
      if (claim) { claim.status = 'ignored'; await orch.saveClaim(claim); }
    }
    void patchOrigToReceipt(client, data, '✅ 已忽略此项', undefined, 'grey');
    return {};
  }

  if (action === 'tapd-snooze') {
    const id = value['id'] as string | undefined;
    if (!id) return { toast: { type: 'error', content: '缺 id' } };
    const orch = await import('multiagent-orchestrator');
    await orch.markSnoozed(id);
    void patchOrigToReceipt(client, data, '🕐 已稍后提醒', '3 小时后再推', 'grey');
    return {};
  }

  if (action === 'tapd-not-mine') {
    const id = value['id'] as string | undefined;
    if (!id) return { toast: { type: 'error', content: '缺 id' } };
    const orch = await import('multiagent-orchestrator');
    await orch.markIgnoredForever(id);
    void patchOrigToReceipt(client, data, '🙈 已标记：不再提醒此项', '如需重新指派请在 TAPD 改处理人/开发负责人', 'grey');
    return {};
  }

  // ==== TAPD 建任务级联（选项目 → 选类别 → 建）+ 列表状态变更 ====
  // 全部：立即 return {}（不 toast，避免盖 patch），重活 fire-and-forget patch/send。
  if (action === 'tapd-nw-p') {
    // ①选完项目 → 表单卡(2.0)另发**新消息**（不 patch 原 v1 选项目卡，避免跨 schema patch 不生效）；
    // 原选项目卡 patch 成 v1 ack 收尾（v1→v1 安全）。
    const draftId = value['d'] as string | undefined;
    const option = data.action?.option;
    if (!draftId || !option) return { toast: { type: 'error', content: '缺草稿/选项' } };
    const messageId = getMessageId(data);
    void (async () => {
      const flow = await import('./tapd-flow.js');
      const r = await flow.pickProjectShowForm(draftId, option);
      if (r.error) { void sendText(client, chatId, `❌ ${r.error}`); return; }
      const { sendCardMessage } = await import('./api.js');
      void sendCardMessage(client, chatId, r.card);
      if (r.ack && messageId) void patchCard(client, messageId, r.ack);
    })();
    return {};
  }

  if (action === 'tapd-nw-submit') {
    // ②表单提交（form_value: { title, content }）→ 建需求 → patch 表单卡(2.0→2.0 安全)为结果卡。
    const draftId = value['d'] as string | undefined;
    const fv = (data.action?.form_value ?? {}) as Record<string, unknown>;
    const title = typeof fv['title'] === 'string' ? (fv['title'] as string).trim() : '';
    const content = typeof fv['content'] === 'string' ? (fv['content'] as string).trim() : '';
    if (!draftId) { void sendText(client, chatId, '❌ 缺草稿，重新 /tapd new'); return {}; }
    if (!title) { void sendText(client, chatId, '❌ 「主题(标题)」不能为空，请在表单里填了再提交'); return {}; }
    const messageId = getMessageId(data);
    void (async () => {
      const flow = await import('./tapd-flow.js');
      const r = await flow.submitCreate(draftId, { title, ...(content ? { content } : {}) });
      if (r.error) { void sendText(client, chatId, `❌ ${r.error}`); return; }
      if (messageId) void patchCard(client, messageId, r.card);
    })();
    return {};
  }

  if (action === 'tapd-list') {
    void (async () => {
      const flow = await import('./tapd-flow.js');
      const { sendCardMessage } = await import('./api.js');
      const r = await flow.buildMyTapdListCard();
      if (r.error) { void sendText(client, chatId, `❌ ${r.error}`); return; }
      void sendCardMessage(client, chatId, r.card);
    })();
    return {};
  }

  if (action === 'tapd-st') {
    const ws = Number(value['ws']);
    const sys: 'bug' | 'story' = value['sys'] === 'bug' ? 'bug' : 'story';
    const id = value['id'] as string | undefined;
    const wt = (value['wt'] as string | undefined) ?? '';
    const cur = (value['cur'] as string | undefined) ?? '';
    const title = (value['t'] as string | undefined) ?? '';
    if (!id || !Number.isFinite(ws)) return { toast: { type: 'error', content: '缺 ws/id' } };
    void (async () => {
      const flow = await import('./tapd-flow.js');
      const { sendCardMessage } = await import('./api.js');
      const r = await flow.buildStatusPickCard({ ws, sys, id, wt, cur, title });
      if (r.error) { void sendText(client, chatId, `❌ ${r.error}`); return; }
      void sendCardMessage(client, chatId, r.card);
    })();
    return {};
  }

  if (action === 'tapd-st-set') {
    const ws = Number(value['ws']);
    const sys: 'bug' | 'story' = value['sys'] === 'bug' ? 'bug' : 'story';
    const id = value['id'] as string | undefined;
    const option = data.action?.option; // "st|<中文状态名>"
    if (!id || !Number.isFinite(ws) || !option) return { toast: { type: 'error', content: '缺 ws/id/状态' } };
    const vStatus = option.startsWith('st|') ? option.slice(3) : option;
    const messageId = getMessageId(data);
    void (async () => {
      const flow = await import('./tapd-flow.js');
      const res = await flow.applyStatusChange({ ws, sys, id, vStatus });
      if (messageId) {
        void patchCard(client, messageId, receiptCard(
          res.ok
            ? { title: `✅ 已改为「${res.label}」`, template: 'green' }
            : { title: '❌ 改状态失败', detail: res.error ?? '', template: 'grey' },
        ));
      } else if (!res.ok) {
        void sendText(client, chatId, `❌ 改状态失败：${res.error}`);
      }
    })();
    return {};
  }

  if (action === 'tapd-claim-go') {
    const id = value['id'] as string | undefined;
    if (!id) return { toast: { type: 'error', content: '缺 id' } };
    const orch = await import('multiagent-orchestrator');
    const claim = await orch.loadClaim(id);
    if (!claim) return { toast: { type: 'error', content: '认领已失效' } };
    if (claim.selectedRepos.length === 0) return { toast: { type: 'error', content: '先选至少一个 repo' } };
    void (async () => {
      try {
        const hm = await import('multiagent-host-mac');
        const { sendCardMessage } = await import('./api.js');
        const { tapdDirtyCard } = await import('./cards.js');
        // 当前分支直接改（不建新分支）→ 无需切换，脏是预期的，直接开工
        if (claim.base === 'current') {
          await finalizeTapdClaim(client, chatId, claim, 'normal');
          return;
        }
        // 要切新分支：切前查每个选中 repo 的脏状态
        const states = await Promise.all(claim.selectedRepos.map((r) => hm.gitWorkingState(r)));
        const dirty = states.filter((s) => s.isRepo && s.dirty);
        if (dirty.length > 0) {
          // 有脏 → 弹策略卡让用户选（C 方案）
          await sendCardMessage(client, chatId, tapdDirtyCard(
            claim,
            dirty.map((d) => ({ repo: d.repo, branch: d.branch, changeCount: d.changeCount })),
            process.env['HOME'] ?? '',
          ));
          return;
        }
        // 全干净 → 直接切开工
        await finalizeTapdClaim(client, chatId, claim, 'normal');
      } catch (e) {
        logger.warn('tapd-claim-go failed', { err: (e as Error).message });
      }
    })();
    return { toast: { type: 'info', content: '检查工作区…' } };
  }

  if (action === 'tapd-go-strategy') {
    const id = value['id'] as string | undefined;
    const strategy = (value['strategy'] as string | undefined) ?? 'stash';
    if (!id) return { toast: { type: 'error', content: '缺 id' } };
    const orch = await import('multiagent-orchestrator');
    const claim = await orch.loadClaim(id);
    if (!claim) return { toast: { type: 'error', content: '认领已失效' } };
    void finalizeTapdClaim(client, chatId, claim, strategy).catch((e) =>
      logger.warn('tapd-go-strategy failed', { err: (e as Error).message }),
    );
    return { toast: { type: 'success', content: `按「${strategy}」开工中…` } };
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

  if (action === 'pending-quiet' || action === 'pending-unquiet') {
    const tty = value['tty'] as string | undefined;
    const sentAt = value['sentAt'] as number | undefined;
    if (!tty || typeof sentAt !== 'number') {
      return { toast: { type: 'error', content: '缺 tty/sentAt' } };
    }
    const pendings = pendingTracker.forTty(tty);
    const p = pendings.find((x) => x.sentAt === sentAt);
    if (!p) {
      return { toast: { type: 'error', content: '任务已完成或找不到' } };
    }
    const next = action === 'pending-quiet';
    p.quietUntilDone = next;
    logger.info('pending quiet toggled', { tty, sentAt, quiet: next });
    // 立刻 patch 一次卡片，让按钮和状态提示同步
    if (p.progressMessageId) {
      const tabs = await listTabs();
      const tab = tabs.find((t) => t.tty === tty);
      if (tab) {
        try {
          const chatState = await loadChat(chatId);
          const card = progressCard({
            state: 'running',
            tty,
            taskDescription: p.taskDescription,
            ...(tab.cwd ? { cwd: tab.cwd } : {}),
            outputTail: '(静默中，任务完成时会更新最终输出)',
            startedAt: p.sentAt,
            updatedAt: Date.now(),
            isActiveForChat: chatState.activeTty === tty,
            sentAt: p.sentAt,
            quietUntilDone: next,
            ...(p.originalPrompt ? { rerunPrompt: p.originalPrompt } : {}),
            ...(p.targetLabel ? { rerunTargetLabel: p.targetLabel } : {}),
            ...(p.source ? { source: p.source } : {}),
          });
          void patchCard(client, p.progressMessageId, card);
        } catch (e) {
          logger.warn('pending-quiet card patch failed', { err: (e as Error).message });
        }
      }
    }
    return {
      toast: {
        type: 'success',
        content: next ? '🔇 已静默，完成时才更新' : '🔊 已恢复实时进度',
      },
    };
  }

  if (action === 'ask.pick' || action === 'ask.toggle' || action === 'ask.submit' || action === 'ask.cancel') {
    const askId = value['askId'] as string | undefined;
    if (!askId) return { toast: { type: 'error', content: '缺 askId' } };
    const req = asks.get(askId);
    if (!req) {
      return { toast: { type: 'error', content: 'ask 已完成或不存在' } };
    }
    const operator = data.operator?.open_id ?? 'unknown';
    const by = `feishu:${operator}`;

    // 这些分支返回 { toast, card }：card.action.trigger 会把 card 塞进回调响应
    // 直接替换被点的卡片（即时刷新），toast 同帧弹出。不再走异步 patchCard，
    // 避免"toast 盖掉 patch"的老坑，也消除点击后的空窗。
    if (action === 'ask.pick') {
      const index = value['index'] as number | undefined;
      if (typeof index !== 'number') return { toast: { type: 'error', content: '缺 index' } };
      const picked = req.options[index] ?? '';
      const updated = await asks.answer(askId, { kind: 'single', index, value: picked }, by);
      return {
        toast: { type: 'success', content: `✅ 已选：${picked}` },
        card: updated ? askCard(updated) : undefined,
      };
    }

    if (action === 'ask.toggle') {
      const index = value['index'] as number | undefined;
      if (typeof index !== 'number') return { toast: { type: 'error', content: '缺 index' } };
      const updated = asks.toggle(askId, index);
      return {
        toast: {
          type: 'info',
          content: updated ? `已选 ${updated.selection.length} 项` : '状态刷新',
        },
        card: updated ? askCard(updated) : undefined,
      };
    }

    if (action === 'ask.submit') {
      const indices = [...req.selection];
      const values = indices.map((i) => req.options[i] ?? '');
      const updated = await asks.answer(askId, { kind: 'multi', indices, values }, by);
      return {
        toast: { type: 'success', content: `✅ 已提交（${indices.length} 项）` },
        card: updated ? askCard(updated) : undefined,
      };
    }

    // ask.cancel
    const updated = await asks.cancel(askId, by);
    return {
      toast: { type: 'success', content: '⊘ 已取消' },
      card: updated ? askCard(updated) : undefined,
    };
  }

  // ── form（多问题向导）卡片操作 ──
  if (action === 'ask.form-toggle' || action === 'ask.form-nav' || action === 'ask.form-submit' || action === 'ask.form-cancel' || action === 'ask.form-text') {
    const askId = value['askId'] as string | undefined;
    if (!askId) return { toast: { type: 'error', content: '缺 askId' } };
    const req = asks.get(askId);
    if (!req || req.status !== 'pending') return { toast: { type: 'error', content: 'ask 已完成或不存在' } };
    const by = `feishu:${data.operator?.open_id ?? 'unknown'}`;
    // 表单操作后仍 pending 时用 asks.get 取当前态建卡；已 resolve 的分支用返回值建卡。
    const curCard = () => {
      const cur = asks.get(askId);
      return cur ? askCard(cur) : undefined;
    };

    if (action === 'ask.form-toggle') {
      const q = Number(value['q']);
      const i = Number(value['i']);
      if (!Number.isInteger(q) || !Number.isInteger(i)) return { toast: { type: 'error', content: '缺 q/i' } };
      const updated = asks.toggleForm(askId, q, i);
      // 不自动前进：留在本题让用户看到 🔘/☑ 变化，再手动「下一题」或「提交」
      const on = (updated?.formSelection?.[q]?.length ?? 0) > 0;
      return { toast: { type: 'info', content: on ? '已选' : '已取消选择' }, card: curCard() };
    }

    if (action === 'ask.form-nav') {
      const to = Number(value['to']);
      if (!Number.isInteger(to)) return { toast: { type: 'error', content: '缺 to' } };
      asks.setFormCursor(askId, to);
      return { toast: { type: 'info', content: '已切换' }, card: curCard() };
    }

    if (action === 'ask.form-text') {
      const q = Number(value['q']);
      if (!Number.isInteger(q)) return { toast: { type: 'error', content: '缺 q' } };
      const armed = asks.armFormText(askId, q);
      return armed
        ? { toast: { type: 'info', content: '请在对话里直接回复文字' }, card: curCard() }
        : { toast: { type: 'error', content: '本题不支持自由输入' } };
    }

    if (action === 'ask.form-submit') {
      const res = await asks.submitForm(askId, by);
      if (res && res.ok === false) {
        // 有单选题没选 → 跳到第一个缺的题
        const first = res.missing[0] ?? 0;
        asks.setFormCursor(askId, first);
        return { toast: { type: 'error', content: `第 ${first + 1} 题还没选` }, card: curCard() };
      }
      if (res && res.ok) {
        return { toast: { type: 'success', content: '✅ 已提交' }, card: askCard(res.request) };
      }
      return { toast: { type: 'success', content: '✅ 已提交' } };
    }

    // ask.form-cancel
    const cancelled = await asks.cancel(askId, by);
    return { toast: { type: 'success', content: '⊘ 已取消' }, card: cancelled ? askCard(cancelled) : undefined };
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
      // 归一化：text / post(富文本) / image → 文字 + 内联图片 key
      let text = '';
      let inlineImageKeys: string[] = [];
      if (message_type === 'text') {
        text = extractText(content);
      } else if (message_type === 'post') {
        const p = parsePost(content);
        text = p.text;
        inlineImageKeys = p.imageKeys;
      } else if (message_type === 'image') {
        const k = parseImageKey(content);
        if (k) inlineImageKeys = [k];
      } else {
        // 其它类型（音频/视频/文件/表情包…）暂不支持
        await client.im.message.reply({
          path: { message_id },
          data: { content: JSON.stringify({ text: `（暂只支持文本 / 图片 / 图文，收到的是 ${message_type}）` }), msg_type: 'text' },
        });
        return;
      }
      logger.info('message received', {
        chat_id,
        message_type,
        textLen: text.length,
        images: inlineImageKeys.length,
        textPreview: text.length > 40 ? text.slice(0, 40) + '…' : text,
      });
      logger.debug('message received full', { message_id, text });

      const ctx = { messageId: message_id, chatId: chat_id };

      // 下载本条消息内联的图片（image / 富文本带图）
      let nowImagePaths: string[] = [];
      if (inlineImageKeys.length > 0) {
        nowImagePaths = await downloadInboundImages(client, message_id, inlineImageKeys);
        if (nowImagePaths.length === 0) {
          void sendText(client, chat_id, '❌ 收到图片但下载失败——多半是飞书应用没开 `im:resource`（读消息资源）权限。去开发者后台 → 权限管理 添加后重发。');
          return;
        }
      }

      // 纯图（无文字描述）→ 暂存等配对（B）；90s 没等到文字 → 按纯图直发 active tab（C）
      if (!text.trim() && nowImagePaths.length > 0) {
        addPendingImage(chat_id, nowImagePaths, (paths) => {
          void sendToActiveTab(client, ctx, buildImageOnlyPrompt(paths)).catch((e) => logger.error('pending-image timeout dispatch failed', e));
          void sendText(client, chat_id, `⏳ 没等到文字描述，已把 ${paths.length} 张图直接发给 active tab，让 claude 自己看图判断。`);
        });
        void sendText(client, chat_id, `📎 收到 ${nowImagePaths.length} 张图。${IMG_PAIR_WINDOW_MS / 1000}s 内再发一句文字描述（可带 @ttysXXX 指定 tab）→ 图+字一起给 claude；不发的话到点我直接把图发给 active tab。`);
        return;
      }

      if (!text.trim()) return;

      // 优先：input-type ask 等答案 → 消费此消息作为答案，短路后续路由
      {
        const pendingAskId = asks.getAwaitingInputAskId(chat_id);
        if (pendingAskId) {
          const askReq = asks.get(pendingAskId);
          if (askReq) {
            // /cancel 短路取消，其余当答案
            if (text.trim() === '/cancel') {
              (async () => {
                const updated = await asks.cancel(pendingAskId, `feishu:${data.sender?.sender_id?.open_id ?? 'unknown'}`);
                if (updated?.cardMessageId) {
                  void patchCard(client, updated.cardMessageId, askCard(updated));
                }
                void sendText(client, chat_id, '⊘ 已取消 ask');
              })();
              return;
            }
            (async () => {
              const updated = await asks.answer(
                pendingAskId,
                { kind: 'input', text },
                `feishu:${data.sender?.sender_id?.open_id ?? 'unknown'}`,
              );
              if (updated?.cardMessageId) {
                void patchCard(client, updated.cardMessageId, askCard(updated));
              }
            })();
            return;
          }
        }
      }

      // form 向导：某题「💬 打字回答」已武装 → 本条文字记为该题答案，自动前进并刷新卡片
      {
        const awaiting = asks.getAwaitingFormInput(chat_id);
        if (awaiting && text.trim() !== '/cancel') {
          const updated = asks.answerFormText(chat_id, text.trim());
          if (updated) {
            if (updated.cardMessageId) void patchCard(client, updated.cardMessageId, askCard(updated));
            void sendText(client, chat_id, `✅ 第 ${awaiting.q + 1} 题已记录：💬 ${text.trim().slice(0, 40)}`);
            return;
          }
        }
      }

      // 打字兜底：single/multi ask 待答时，允许直接打字回答（裸数字 2 / 逗号 1,3 / 选项原文）。
      // 卡片点击丢包/限流时的解冻通道。不劫持命令(/)和 @target 消息。
      {
        const t = text.trim();
        const pending = asks.getPendingByChat(chat_id);
        if (pending && (pending.type === 'single' || pending.type === 'multi') && !t.startsWith('/') && !t.startsWith('@')) {
          const parsed = parseTypedAskAnswer(t, pending.options, pending.type);
          if (parsed) {
            (async () => {
              const by = `feishu:${data.sender?.sender_id?.open_id ?? 'unknown'}`;
              const updated = await asks.answer(pending.id, parsed, by);
              if (updated?.cardMessageId) void patchCard(client, updated.cardMessageId, askCard(updated));
              const label = parsed.kind === 'single' ? parsed.value : parsed.values.join('、') || '（空）';
              void sendText(client, chat_id, `✅ 已按打字回答：${label}`);
            })();
            return;
          }
        }
      }

      // 图文配对：本条文字将发往 tab 时，把「之前暂存的图(B)」+「本条内联图」作为前缀一并注入。
      // 命令（/xxx，非 //）不消费图片——留给下一条真正发往 tab 的文字。
      const willGoToTab = !(isCommand(text) && !isForwardSlash(text));
      let imgPrefix = '';
      if (willGoToTab) {
        const attach = [...takePendingImage(chat_id), ...nowImagePaths];
        if (attach.length > 0) imgPrefix = buildImagePromptPrefix(attach);
      }

      // `//foo` 显式转发到 activeTty —— 剥掉一个 `/`，当普通文本发给 tab
      if (isForwardSlash(text)) {
        const forwardText = stripForwardSlash(text);
        logger.info('slash forwarded to activeTty', {
          chat_id,
          preview: forwardText.slice(0, 40),
        });
        sendToActiveTab(client, ctx, imgPrefix + forwardText).catch((e) => {
          logger.error('sendToActiveTab (forward-slash) failed', e);
          void sendText(client, chat_id, `❌ // 转发失败：${(e as Error).message}`);
        });
        return;
      }

      if (isCommand(text)) {
        // 特殊：/screen 抓屏、/keys 按键遥控 —— 需要 client + host-mac，直接在这里 fire-and-forget
        const cmdName = text.trim().slice(1).split(/\s+/)[0]?.toLowerCase() ?? '';
        if (cmdName === 'screen' || cmdName === 'scr') {
          (async () => {
            try {
              const chat = await loadChat(chat_id);
              const targetTty = (chat.recentReplyTty && chat.recentReplyAt !== undefined && (Date.now() - chat.recentReplyAt < RECENT_REPLY_TTL_MS))
                ? chat.recentReplyTty
                : chat.activeTty;
              if (!targetTty) {
                void sendText(client, chat_id, '❌ 没设 activeTty，先 /use @xxx');
                return;
              }
              const path = await captureScreen(targetTty);
              await sendImage(client, chat_id, path);
              void sendText(client, chat_id, `📸 抓屏 ${targetTty} 已推`);
            } catch (e) {
              void sendText(client, chat_id, `❌ 抓屏失败：${(e as Error).message}`);
            }
          })();
          return;
        }
        if (cmdName === 'keys' || cmdName === 'k') {
          (async () => {
            try {
              const rest = text.trim().slice(cmdName.length + 1).trim();
              if (!rest) {
                void sendText(client, chat_id, '用法：/keys <按键序列>\n例：/keys 2d . ⏎    #下下 空 回\n     /keys ctrl+c\n键位：d/u/l/r=↓↑←→ .=空格 ⏎=回车 t=tab x=esc\n重复：3d 或 d*3；打字用引号 \'text\'');
                return;
              }
              const chat = await loadChat(chat_id);
              const targetTty = (chat.recentReplyTty && chat.recentReplyAt !== undefined && (Date.now() - chat.recentReplyAt < RECENT_REPLY_TTL_MS))
                ? chat.recentReplyTty
                : chat.activeTty;
              if (!targetTty) {
                void sendText(client, chat_id, '❌ 没设 activeTty，先 /use @xxx');
                return;
              }
              await sendKeys(targetTty, rest);
              // 300ms 后自动抓一张回推确认
              setTimeout(async () => {
                try {
                  const path = await captureScreen(targetTty);
                  await sendImage(client, chat_id, path);
                } catch { /* silent */ }
              }, 300);
              void sendText(client, chat_id, `✓ 已发按键到 ${targetTty}：\`${rest}\`（300ms 后回一张确认图）`);
            } catch (e) {
              void sendText(client, chat_id, `❌ /keys 失败：${(e as Error).message}`);
            }
          })();
          return;
        }
        if (cmdName === 'report' || cmdName === 'rp') {
          (async () => {
            try {
              const rest = text.trim().slice(cmdName.length + 1).trim().toLowerCase();
              const brief = /(--brief|简报)/.test(rest);
              const window: 'day' | 'week' | 'month' | 'year' =
                rest.startsWith('d') || rest.includes('日') ? 'day'
                : rest.startsWith('m') || rest.includes('月') ? 'month'
                : rest.startsWith('y') || rest.includes('年') ? 'year'
                : 'week';
              const wLabel = { day: '日报', week: '周报', month: '月报', year: '年报' }[window];
              const hm = await import('multiagent-host-mac');
              const orch = await import('multiagent-orchestrator');
              const index = await hm.getDirIndex().catch(() => ({ dirs: [] as { path: string; isGitRepo: boolean }[] }));
              const repos = index.dirs.filter((d) => d.isGitRepo).map((d) => d.path);
              const collect = () => orch.collectWorkData({ window, repos });
              const asPptx = (window === 'month' || window === 'year') && !brief;
              void sendText(client, chat_id, `📊 ${wLabel}${asPptx ? '(PPT)' : '简报'}生成中…（采集 git+任务记忆 → claude 合成，约 30-60s）`);
              if (asPptx) {
                const out = `/tmp/mchat-report-${window}-${Date.now()}.pptx`;
                const { path } = await orch.generatePptxReport(collect, out, '郑纪泉');
                const { sendFile } = await import('./api.js');
                await sendFile(client, chat_id, path);
                void sendText(client, chat_id, `✅ ${wLabel} PPT 已生成（想要简报版发 \`/report ${window} --brief\`）`);
              } else {
                const { markdown } = await orch.generateBrief(collect);
                await sendText(client, chat_id, markdown);
              }
            } catch (e) {
              void sendText(client, chat_id, `❌ 报告生成失败：${(e as Error).message}`);
            }
          })();
          return;
        }
        if (cmdName === 'careyclaw' || cmdName === '龙虾') {
          (async () => {
            try {
              const st = await getCareyclawKeyStatus();
              await sendCard(client, chat_id, careyclawKeyCard(st));
            } catch (e) {
              void sendText(client, chat_id, `❌ /careyclaw 失败：${(e as Error).message}`);
            }
          })();
          return;
        }
        if (cmdName === 'connect' || cmdName === '对接') {
          (async () => {
            try {
              const st = await integrationStatuses();
              await sendCard(client, chat_id, connectStatusCard(st));
            } catch (e) {
              void sendText(client, chat_id, `❌ /connect 失败：${(e as Error).message}`);
            }
          })();
          return;
        }
        if (cmdName === 'plan') {
          (async () => {
            try {
              const goal = text.trim().slice(cmdName.length + 1).trim();
              if (!goal) { void sendText(client, chat_id, '用法：`/plan <目标>` —— 我用 claude 把目标分解成可逐步派发的计划'); return; }
              void sendText(client, chat_id, `🧩 规划中…（claude 分解目标，约 30-90s）`);
              const tabs = await listTabs().catch(() => []);
              const { getDirIndex } = await import('multiagent-host-mac');
              const index = await getDirIndex().catch(() => ({ dirs: [] as { path: string; isGitRepo: boolean }[] }));
              const repos = index.dirs.filter((d) => d.isGitRepo).map((d) => d.path).slice(0, 40);
              const plan = await generatePlan(goal, {
                tabs: tabs.map((t) => ({ tty: t.tty, cwd: t.cwd, title: t.title })),
                repos,
              });
              await sendCard(client, chat_id, planCard(plan));
            } catch (e) {
              void sendText(client, chat_id, `❌ 规划失败：${(e as Error).message}`);
            }
          })();
          return;
        }
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

      // chain 优先：`@a X >> @b Y >> @c Z`（图片前缀挂到第一步）
      if (parsed.chain && parsed.chain.length >= 2) {
        logger.info('chain', { steps: parsed.chain.length });
        if (imgPrefix && parsed.chain[0]) parsed.chain[0].prompt = imgPrefix + parsed.chain[0].prompt;
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
          // 批量 → 先发一张聚合卡占位，所有 task pending 共享 messageId（图片前缀挂到每个）
          const targeted = imgPrefix ? parsed.targeted.map((t) => ({ ...t, text: imgPrefix + t.text })) : parsed.targeted;
          handleBatch(client, ctx, targeted).catch((e) => {
            logger.error('handleBatch failed', e);
            void sendText(client, chat_id, `❌ 批量失败：${(e as Error).message}`);
          });
        } else {
          for (const t of parsed.targeted) {
            sendToNamedTarget(client, ctx, t.target, imgPrefix + t.text).catch((e) => {
              logger.error('sendToNamedTarget failed', e);
              void sendText(client, chat_id, `❌ @${t.target} 失败：${(e as Error).message}`);
            });
          }
        }
      } else {
        // 没 @ → 走 active tab
        sendToActiveTab(client, ctx, imgPrefix + (parsed.fallback ?? text)).catch((e) => {
          logger.error('sendToActiveTab failed', e);
          void sendText(client, chat_id, `❌ 失败：${(e as Error).message}`);
        });
      }
    },

    'card.action.trigger': async (data: CardActionEvent) => {
      recordInbound();
      const chatId = getChatId(data);

      // ── ask.* 类卡片：同步处理 + 回调响应里同时返回 toast + 更新后的卡片 ──
      // 飞书回调响应带 card（type:'raw'）时会用它替换被点的卡片 → 即时刷新；
      // 同帧带 toast 弹提示。二者共存，不再依赖异步 patchCard，消除点击后的空窗。
      // （asks.* 均为本地内存操作，能在回调窗口内同步完成。）
      // 注意：这条例外只对 ask.* 成立——其它卡片仍必须走下面的 fire-and-forget，
      // 见 docs/features.md：普通卡片单独 return { toast } 会盖掉异步 patchCard。
      const actionName = data.action?.value?.['action'];
      if (typeof actionName === 'string' && actionName.startsWith('ask.')) {
        try {
          const result = await handleCardAction(client, data);
          const resp: { toast?: unknown; card?: unknown } = {};
          if (result?.toast) resp.toast = result.toast;
          if (result?.card) resp.card = { type: 'raw', data: result.card };
          return resp;
        } catch (e) {
          logger.error('ask card action failed', e);
          return { toast: { type: 'error', content: `失败：${(e as Error).message}` } };
        }
      }

      // fire-and-forget：立即返回空响应，重活异步。**不能返回 toast** —— 飞书收到回调 toast
      // 响应后会把卡片当"已处理、无更新"，盖掉我们另发的 patchCard（标记不刷新）。
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
      return {};
    },
  });
}
