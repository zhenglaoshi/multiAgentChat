import * as Lark from '@larksuiteoapi/node-sdk';
import { approvals, asks } from 'multiagent-orchestrator';
import { loadChat, saveChat } from '../chats/store.js';
import { PENDING_ANSWER_TTL_MS, RECENT_REPLY_TTL_MS } from '../chats/types.js';
import { logger } from 'multiagent-orchestrator';
import { recordCwd } from 'multiagent-host-mac';
import { formatRecallPrefix, recall, tokenize } from 'multiagent-orchestrator';
import { pendingTracker } from '../monitor/pending.js';
import { recordInbound } from '../monitor/ws-watchdog.js';
import { captureScreen, forceEnter, getHistory, getUserFocus, listTabs, newTab, send, sendKeys, sendKeysRaw } from 'multiagent-host-mac';

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
  '    输入：`agent lark ask input  --title "输入什么"`  （用户在飞书 chat 里直接回复文本即可）',
  '    stdout 示例：`{"status":"answered","type":"single","index":1,"value":"选项B"}`；status 也可能是 cancelled / timeout',
  '    退出码：0=answered，1=cancelled，2=timeout',
  '- 不要调 AskUserQuestion 或在 TUI 里等键盘输入，用户手机端看不见 TUI —— **一定要用 `agent lark ask`**',
  '- 高风险操作（写数据库 / git push --force / rm -rf / 改 .env）先 `agent request-approval --title --body` 等批准',
  '- 不要直接调任何 webhook（功能弱、不支持文件）',
  '',
].join('\n');

// 短提醒：claude TUI tab 每条消息末尾都注入（防止 6h 间隔的 SYSTEM_GUIDANCE 过期遗忘）
const CLAUDE_TUI_REMINDER = [
  '',
  '---',
  '⚠ 回到飞书 — 飞书看不见你的 TUI 屏幕。**先在 TUI 完整回答用户，然后再** `agent lark send-text "<同样一份摘要>"` 推到飞书（两个渠道并行，不能只推不答）。要用户从选项里选（单/多选）或填文本，**用 `agent lark ask single|multi|input`**（stdout 拿答案 JSON），不要用 AskUserQuestion 或在 TUI 里 wait 键盘。',
].join('\n');
import { patchCard, sendCardReturnId, sendImage } from './api.js';
import { ackCard, askCard, batchProgressCard, browseCard, chainProgressCard, progressCard, receiptCard, type BatchTaskItem, type ChainStepItem } from './cards.js';
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, basename } from 'node:path';
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
import { handleCommand, isCommand, isForwardSlash, stripForwardSlash, type ReplyAction, type SopActionData } from './commands.js';
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
    await replyText(client, ctx, `❌ ★ ${chat.activeTty} 在 Terminal 已不存在`);
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

      await new Promise((r) => setTimeout(r, 1200));
      try {
        const r = await send(newTty, 'claude');
        if (!r.ok) throw new Error(r.reason ?? 'send failed');
      } catch (e) {
        await replyText(client, ctx, `❌ 新 tab ${newTty} 起 claude 失败：${(e as Error).message}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 8000));

      const tabsAfter = await listTabs();
      const found = tabsAfter.find((t) => t.tty === newTty);
      if (!found) {
        await replyText(client, ctx, `❌ 新 tab ${newTty} spawn 后 listTabs 找不到`);
        return;
      }
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
  const [recents, bms] = await Promise.all([hm.listRecentCwds(), hm.listBookmarks()]);
  const seen = new Set<string>();
  const out: { path: string; label: string }[] = [];
  for (const b of bms) if (!seen.has(b.path)) { seen.add(b.path); out.push({ path: b.path, label: `@${b.alias}` }); }
  for (const c of recents) if (!seen.has(c)) { seen.add(c); out.push({ path: c, label: c.split('/').pop() || c }); }
  return out;
}

/** 拼注入 claude 的 bug/需求上下文 prompt（多 repo：都已切到同名分支，claude 跨 repo 编排）。 */
function buildTapdPrompt(
  claim: { system: string; title: string; id: string; url: string; branch: string; description?: string },
  results: { ok: boolean; repo: string; branch: string; action: string; reason?: string }[],
): string {
  const kind = claim.system === 'bug' ? '缺陷' : '需求';
  const repos = results.filter((r) => r.ok).map((r) => `- ${r.repo}（分支 ${r.branch}）`).join('\n');
  const descRaw = claim.description ? claim.description.replace(/<[^>]+>/g, '').replace(/\s+\n/g, '\n').trim() : '';
  const desc = descRaw ? `\n\n描述/复现：\n${descRaw.slice(0, 1500)}` : '';
  return [
    `我在处理一个 TAPD ${kind}，请帮我${claim.system === 'bug' ? '定位并修复' : '实现'}。`,
    ``,
    `标题：${claim.title}`,
    `TAPD #${claim.id}：${claim.url}`,
    `涉及 repo（均已切到分支 ${claim.branch}）：`,
    repos || '（无）',
    desc,
    ``,
    `请在这些 repo 里完成改动、各自提交（commit message 带 "TAPD #${claim.id}"）。跨 repo 用 cd 或 git -C。完成后把摘要用 \`agent lark send-text\` 推给我。`,
  ].join('\n');
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
    // 用户明确切了 shell → 清 one-shot pendingAnswerTty 与 sticky recentReplyTty
    // （否则旧粘性会抢新 activeTty 的路由）
    delete chat.pendingAnswerTty;
    delete chat.pendingAnswerAt;
    delete chat.recentReplyTty;
    delete chat.recentReplyAt;
    await saveChat(chat);
    if (tab.cwd) void recordCwd(tab.cwd);
    // patch 原卡为回执，不再新发 ackCard 避免 timeline 堆卡
    await patchOrigToReceipt(
      client,
      data,
      `⭐ 已切到 ${tab.tty}`,
      tab.cwd ? `cwd: \`${tab.cwd}\`` : undefined,
    );
    return {
      toast: { type: 'success', content: `★ 切到 ${tab.tty}` },
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

  // originShellPushCard 的下拉选择：value 是 `answer|<tty>|<label>`，用户选中后
  // 直接把 label 打进源 shell（同 send-to-tab 语义，只是组件不同）。
  if (action === 'answer-select') {
    const option = data.action?.option;
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
      await patchOrigToReceipt(
        client,
        data,
        `✓ 已回答『${label.length > 20 ? label.slice(0, 20) + '…' : label}』→ ${tty}`,
      );
      return {
        toast: { type: 'success', content: `→ 已发送到 ${tty}` },
      };
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
    await patchOrigToReceipt(
      client,
      data,
      `⏳ 下一条文本发到 active（${chat.activeTty}）`,
      `${tab.cwd ? `cwd: \`${tab.cwd}\`\n` : ''}<font color='grey'>在下方 chat 直接输入即可</font>`,
      'blue',
    );
    return {
      toast: { type: 'info', content: `⏳ 等你输入 → active ${chat.activeTty}` },
    };
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
    await patchOrigToReceipt(
      client,
      data,
      `⏳ 下一条文本发到 ${tty}`,
      `${tab.cwd ? `cwd: \`${tab.cwd}\`\n` : ''}<font color='grey'>在下方 chat 直接输入即可（10 min 内 one-shot 生效）</font>`,
      'blue',
    );
    return {
      toast: { type: 'info', content: `⏳ 等你输入 → ${tty}` },
    };
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
      // patch 原卡为回执，去掉按钮避免重复点击
      await patchOrigToReceipt(
        client,
        data,
        `✓ 已回答『${shown.length > 20 ? shown.slice(0, 20) + '…' : shown}』→ ${tty}`,
      );
      return {
        toast: { type: 'success', content: `→ 已发送到 ${tty}` },
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
          selectedRepos: [] as string[], status: 'picking' as const, createdAt: Date.now(),
        };
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

  if (action === 'tapd-ignore') {
    const id = value['id'] as string | undefined;
    if (id) {
      const orch = await import('multiagent-orchestrator');
      const claim = await orch.loadClaim(id);
      if (claim) { claim.status = 'ignored'; await orch.saveClaim(claim); }
    }
    return { toast: { type: 'info', content: '已忽略' } };
  }

  if (action === 'tapd-claim-go') {
    const id = value['id'] as string | undefined;
    if (!id) return { toast: { type: 'error', content: '缺 id' } };
    const orch = await import('multiagent-orchestrator');
    const claim = await orch.loadClaim(id);
    if (!claim) return { toast: { type: 'error', content: '认领已失效' } };
    if (claim.selectedRepos.length === 0) return { toast: { type: 'error', content: '先选至少一个 repo' } };
    void (async () => {
      const { sendCardMessage, sendTextMessage } = await import('./api.js');
      try {
        const hm = await import('multiagent-host-mac');
        const { ackCard } = await import('./cards.js');
        // 1. 每个选中 repo 切同名分支
        const results = [];
        for (const repo of claim.selectedRepos) {
          results.push(await hm.gitCheckoutBranch(repo, claim.branch));
        }
        const okRepos = results.filter((r) => r.ok);
        const primary = okRepos[0]?.repo ?? claim.selectedRepos[0]!;
        // 2. 开一个 tab 在主 repo，起 claude（自动过 trust）
        const tty = await hm.newTab({ cwd: primary });
        await new Promise((r) => setTimeout(r, 1500));
        await hm.launchClaudeInTab(tty, { continueSession: false });
        await new Promise((r) => setTimeout(r, 1500));
        // 3. 注入 bug 上下文并提交
        await hm.send(tty, buildTapdPrompt(claim, results));
        await new Promise((r) => setTimeout(r, 600));
        await hm.forceEnter(tty).catch(() => {});
        // 4. 更新状态 + chat active
        claim.status = 'working'; claim.tty = tty; await orch.saveClaim(claim);
        const chat = await loadChat(chatId); chat.activeTty = tty; chat.lastActiveAt = Date.now(); await saveChat(chat);
        // 5. 结果卡
        const lines = results.map((r) =>
          r.ok
            ? `✅ ${r.repo.split('/').pop()} → \`${r.branch}\`（${r.action}）`
            : `❌ ${r.repo.split('/').pop()}：${r.reason}`,
        );
        await sendCardMessage(client, chatId, ackCard({
          title: `🌿 已开工 · ${claim.branch}`,
          body: `tab \`${tty}\` · ${claim.system === 'bug' ? '缺陷' : '需求'} #${claim.id}\n${lines.join('\n')}\n\n已把 bug 上下文注入 claude，它会跨 repo 处理并推结果给你。`,
        }));
      } catch (e) {
        await sendTextMessage(client, chatId, `❌ TAPD 开工失败：${(e as Error).message}`).catch(() => {});
      }
    })();
    return { toast: { type: 'success', content: '建分支开 tab 中…' } };
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

    if (action === 'ask.pick') {
      const index = value['index'] as number | undefined;
      if (typeof index !== 'number') return { toast: { type: 'error', content: '缺 index' } };
      const picked = req.options[index] ?? '';
      const updated = await asks.answer(askId, { kind: 'single', index, value: picked }, by);
      if (updated?.cardMessageId) {
        void patchCard(client, updated.cardMessageId, askCard(updated));
      }
      return { toast: { type: 'success', content: `已选：${picked}` } };
    }

    if (action === 'ask.toggle') {
      const index = value['index'] as number | undefined;
      if (typeof index !== 'number') return { toast: { type: 'error', content: '缺 index' } };
      const updated = asks.toggle(askId, index);
      if (updated?.cardMessageId) {
        void patchCard(client, updated.cardMessageId, askCard(updated));
      }
      return {
        toast: {
          type: 'info',
          content: updated ? `已选 ${updated.selection.length} 项` : '状态刷新',
        },
      };
    }

    if (action === 'ask.submit') {
      const indices = [...req.selection];
      const values = indices.map((i) => req.options[i] ?? '');
      const updated = await asks.answer(askId, { kind: 'multi', indices, values }, by);
      if (updated?.cardMessageId) {
        void patchCard(client, updated.cardMessageId, askCard(updated));
      }
      return { toast: { type: 'success', content: `已提交（${indices.length} 项）` } };
    }

    // ask.cancel
    const updated = await asks.cancel(askId, by);
    if (updated?.cardMessageId) {
      void patchCard(client, updated.cardMessageId, askCard(updated));
    }
    return { toast: { type: 'success', content: '已取消' } };
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

      // `//foo` 显式转发到 activeTty —— 剥掉一个 `/`，当普通文本发给 tab
      if (isForwardSlash(text)) {
        const forwardText = stripForwardSlash(text);
        logger.info('slash forwarded to activeTty', {
          chat_id,
          preview: forwardText.slice(0, 40),
        });
        sendToActiveTab(client, ctx, forwardText).catch((e) => {
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
