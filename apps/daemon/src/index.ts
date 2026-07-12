import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startControlServer } from 'multiagent-framework';
import { startLarkBot } from 'multiagent-im-lark';
import { loadWeComConfig, WeComTransport, renderWeComCard } from 'multiagent-im-wecom';
import { approvals, asks, type ApprovalRequest, type AskRequest } from 'multiagent-orchestrator';
import type { CardSpec } from 'multiagent-framework';
import { logger } from 'multiagent-orchestrator';
import { startHealthCheck } from 'multiagent-im-lark';
import { attachWatcherToLark } from 'multiagent-im-lark';
import { installWsWatchdog } from 'multiagent-im-lark';
import { attachStageMemoryListener } from 'multiagent-orchestrator';
import {
  captureScreen,
  getHistory,
  listTabs,
  refreshDirIndex,
  send as terminalSend,
  sendKeys,
  forceEnter,
} from 'multiagent-host-mac';
import type { IMMessageEvent } from 'multiagent-framework';
import {
  handleCommand,
  isCommand,
  isForwardSlash,
  stripForwardSlash,
  loadChat,
  saveChat,
  pendingTracker,
  watcher,
  RECENT_REPLY_TTL_MS,
  type PendingOutput,
} from 'multiagent-im-lark';
import { sanitizeTerminalOutput } from 'multiagent-im-lark';

/**
 * Upsert Claude Code hooks 到 ~/.claude/settings.json。
 *
 * 装两个 hook：
 *  - Stop → bin/mchat-stop-hook：turn 结束时把 last_assistant_message 推飞书
 *  - PreToolUse (matcher=AskUserQuestion) → bin/mchat-pretooluse-hook：
 *      交互式选项弹出前先把 question+options 推飞书，否则手机端看不见选项
 *
 * 两个 hook 都由脚本内部 fire-and-forget spawn `agent lark send-text --auto`，
 * daemon 根据目标 chat 的 watchAllTabs gate。
 *
 * 幂等：移除任何指向 mchat-* 的旧条目再追加当前绝对路径。保留用户其他 hook。
 */
async function installClaudeCodeHooks(): Promise<void> {
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  if (!existsSync(settingsPath)) {
    logger.info(
      'Claude Code settings.json not found — hooks 未安装 (需先跑一次 claude)',
      { settingsPath },
    );
    return;
  }
  const HERE = fileURLToPath(new URL('.', import.meta.url));
  const binDir = resolve(HERE, '..', '..', '..', 'bin');
  const stopHookPath = resolve(binDir, 'mchat-stop-hook');
  const preToolUseHookPath = resolve(binDir, 'mchat-pretooluse-hook');

  const stopOk = existsSync(stopHookPath);
  const preOk = existsSync(preToolUseHookPath);
  if (!stopOk) logger.warn('bin/mchat-stop-hook not found', { stopHookPath });
  if (!preOk) logger.warn('bin/mchat-pretooluse-hook not found', { preToolUseHookPath });
  if (!stopOk && !preOk) return;

  type HookEntry = {
    matcher?: string;
    hooks?: Array<{ type?: string; command?: string }>;
  };
  try {
    const raw = await readFile(settingsPath, 'utf8');
    const cfg = JSON.parse(raw) as {
      hooks?: {
        Stop?: HookEntry[];
        PreToolUse?: HookEntry[];
        [k: string]: HookEntry[] | undefined;
      };
      [k: string]: unknown;
    };
    if (!cfg.hooks || typeof cfg.hooks !== 'object') cfg.hooks = {};

    /** 从某个 hook slot 里剔除指向 mchat-* 的旧条目，返回剔除数。 */
    const stripOld = (slot: keyof NonNullable<typeof cfg.hooks>): number => {
      const arr = cfg.hooks![slot];
      if (!Array.isArray(arr)) {
        cfg.hooks![slot] = [];
        return 0;
      }
      const before = arr.length;
      cfg.hooks![slot] = arr.filter((entry) => {
        const hks = entry && Array.isArray(entry.hooks) ? entry.hooks : [];
        return !hks.some(
          (h) =>
            h &&
            typeof h.command === 'string' &&
            (h.command.includes('mchat-stop-hook') ||
              h.command.includes('mchat-pretooluse-hook') ||
              h.command.includes('mchat-hook-echo')),
        );
      });
      return before - cfg.hooks![slot]!.length;
    };

    const removedStop = stripOld('Stop');
    const removedPre = stripOld('PreToolUse');

    if (stopOk) {
      cfg.hooks.Stop!.push({
        matcher: '*',
        hooks: [{ type: 'command', command: stopHookPath }],
      });
    }
    if (preOk) {
      cfg.hooks.PreToolUse!.push({
        matcher: 'AskUserQuestion',
        hooks: [{ type: 'command', command: preToolUseHookPath }],
      });
    }

    await writeFile(settingsPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    logger.info('Claude Code hooks upserted', {
      stopHookPath: stopOk ? stopHookPath : null,
      preToolUseHookPath: preOk ? preToolUseHookPath : null,
      removedOld: { Stop: removedStop, PreToolUse: removedPre },
    });
  } catch (e) {
    logger.warn('failed to upsert Claude Code hooks', {
      err: (e as Error).message,
    });
  }
}

/**
 * 幂等把 skills/multiagent-lark/SKILL.md upsert 到 ~/.claude/skills/multiagent-lark/。
 * 内容相同 → 跳过；不同 → 覆盖（用户改了源码后重启 daemon 自动同步）。
 */
async function ensureSkillInstalled(): Promise<void> {
  const HERE = fileURLToPath(new URL('.', import.meta.url));
  // apps/daemon/{src,dist}/index.js → 项目根 = 上溯 3 层
  const projectRoot = resolve(HERE, '..', '..', '..');
  const src = join(projectRoot, 'skills', 'multiagent-lark', 'SKILL.md');
  if (!existsSync(src)) {
    logger.warn('skill 源文件不存在，跳过自动装', { src });
    return;
  }
  const dstDir = join(homedir(), '.claude', 'skills', 'multiagent-lark');
  const dstFile = join(dstDir, 'SKILL.md');
  try {
    const srcContent = await readFile(src, 'utf8');
    let dstContent: string | null = null;
    if (existsSync(dstFile)) {
      try { dstContent = await readFile(dstFile, 'utf8'); } catch { /* ignore */ }
    }
    if (dstContent === srcContent) {
      logger.info('multiagent-lark skill up-to-date', { path: dstFile });
      return;
    }
    await mkdir(dstDir, { recursive: true });
    await writeFile(dstFile, srcContent, 'utf8');
    logger.info(dstContent === null ? 'multiagent-lark skill installed' : 'multiagent-lark skill updated', {
      path: dstFile,
      srcBytes: srcContent.length,
    });
  } catch (e) {
    logger.warn('skill upsert failed', { err: (e as Error).message });
  }
}

/**
 * 检查 Node 版本。低于 22 直接 die —— ESM + tsx watch + fetch 都需要 22+。
 */
function assertNodeVersion(): void {
  const raw = process.versions.node;
  const major = Number(raw.split('.')[0]);
  if (!Number.isFinite(major) || major < 22) {
    logger.error(
      `Node ${raw} 太老，本项目需要 ≥ 22。升级：brew upgrade node 或 nvm install 22 && nvm use 22`,
    );
    process.exit(1);
  }
  logger.info('node version ok', { version: raw });
}

/**
 * .env 缺失 → 若 .env.example 存在则 cp 一份，然后 die 提示补 LARK_APP_ID/SECRET。
 * .env 存在则啥都不做。
 */
async function ensureEnvFile(): Promise<void> {
  const HERE = fileURLToPath(new URL('.', import.meta.url));
  const projectRoot = resolve(HERE, '..', '..', '..');
  const envPath = join(projectRoot, '.env');
  const examplePath = join(projectRoot, '.env.example');
  if (existsSync(envPath)) return;
  if (!existsSync(examplePath)) {
    logger.warn('.env 和 .env.example 都不存在，daemon 可能没法起 Lark bot');
    return;
  }
  try {
    await copyFile(examplePath, envPath);
    logger.error(
      `.env 不存在 → 已从 .env.example 复制模板到 ${envPath}\n` +
      `请填 LARK_APP_ID 和 LARK_APP_SECRET（飞书开发者后台 → 凭证与基础信息）后重启 dev。`,
    );
    process.exit(1);
  } catch (e) {
    logger.warn('cp .env.example .env 失败', { err: (e as Error).message });
  }
}

/**
 * 无 sudo 把 bin/agent symlink 到 ~/.local/bin/agent。
 * 已存在且指向同源 → 跳过；存在但指向别处 → 覆盖（unlink + symlink）。
 * ~/.local/bin 不在 PATH → 打 warn，给一句 shell rc 添加提示。
 */
async function ensureAgentOnPath(): Promise<void> {
  if (platform() !== 'darwin' && platform() !== 'linux') return;
  const HERE = fileURLToPath(new URL('.', import.meta.url));
  const projectRoot = resolve(HERE, '..', '..', '..');
  const agentSrc = join(projectRoot, 'bin', 'agent');
  if (!existsSync(agentSrc)) {
    logger.warn('bin/agent 不存在', { agentSrc });
    return;
  }
  const localBin = join(homedir(), '.local', 'bin');
  const dst = join(localBin, 'agent');
  try {
    await mkdir(localBin, { recursive: true });
    // 已 symlink 到正确路径？
    if (existsSync(dst)) {
      try {
        const { readlink } = await import('node:fs/promises');
        const cur = await readlink(dst);
        if (cur === agentSrc) {
          logger.info('agent CLI symlink up-to-date', { dst });
          checkPath(localBin);
          return;
        }
      } catch { /* 不是 symlink，是 regular file → 让路 */ }
      await unlink(dst);
    }
    await symlink(agentSrc, dst);
    logger.info('agent CLI symlinked', { src: agentSrc, dst });
  } catch (e) {
    logger.warn('symlink agent 失败', { err: (e as Error).message });
    return;
  }
  checkPath(localBin);
}

function checkPath(dir: string): void {
  const paths = (process.env['PATH'] ?? '').split(delimiter);
  if (paths.includes(dir)) return;
  logger.warn(
    `${dir} 不在 PATH，任何 shell 里跑 "agent xxx" 会 command-not-found。加一行到 ~/.zshrc 或 ~/.bashrc：`,
  );
  logger.warn(`    export PATH="${dir}:$PATH"`);
  logger.warn('（然后重启 shell 或 source rc）');
}

/**
 * macOS 权限清单一次性提示：Accessibility / Screen Recording / Automation。
 * 这些都是首次触发时会弹系统对话框的（不能代授），预先提示能让用户理解为什么弹权限。
 */
function emitMacPermissionHints(): void {
  if (platform() !== 'darwin') return;
  logger.info(
    'macOS 权限一次性提示：首次触发时会弹系统对话框，点「允许」即可。位置：System Settings → Privacy & Security：',
  );
  logger.info('  · Accessibility：Terminal / iTerm / osascript（发按键 keystroke / key code）');
  logger.info('  · Screen Recording：Terminal / iTerm（screencapture 抓 tab 窗口）');
  logger.info('  · Automation：允许 Terminal / osascript 控制 Terminal.app / Google Chrome');
}

/**
 * Spawn `caffeinate` 阻止 Mac idle sleep（非合盖场景）。
 *
 * 参数：
 *   -i    阻止 idle sleep（关键，避免 daemon 因 Mac 闲置睡眠断连）
 *   -m    阻止 disk sleep（磁盘慢响应会拖累 lark WS 心跳）
 *   -s    可选，阻止 system sleep（只在 AC 电源下有效；battery mode 无效）
 *   -w    追随 daemon PID，daemon 死 caffeinate 自动退
 *
 * 通过 env 关：AGENT_NO_CAFFEINATE=1
 * 通过 env 加 -s：AGENT_CAFFEINATE_SYSTEM_SLEEP=1
 *
 * ⚠️ 合盖睡眠 macOS kernel 强制，任何用户态方案都无解。要 clamshell mode 需外接电源+显示器+键鼠。
 */
function startCaffeinate(): void {
  if (platform() !== 'darwin') {
    logger.info('caffeinate skipped (non-darwin platform)');
    return;
  }
  if (process.env['AGENT_NO_CAFFEINATE']) {
    logger.info('caffeinate disabled by AGENT_NO_CAFFEINATE');
    return;
  }
  const args = ['-i', '-m', '-w', String(process.pid)];
  if (process.env['AGENT_CAFFEINATE_SYSTEM_SLEEP']) {
    args.splice(1, 0, '-s');
  }
  try {
    const child = spawn('caffeinate', args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    logger.info('caffeinate started', {
      childPid: child.pid,
      trackingDaemonPid: process.pid,
      args,
    });
    child.on('error', (e) => {
      logger.warn('caffeinate spawn error', { err: e.message });
    });
  } catch (e) {
    logger.warn('caffeinate spawn failed', { err: (e as Error).message });
  }
}

/**
 * 企微 → Terminal tab 派发（Day 6+ 版）
 *
 * 特性：
 *   - 解析 "@target text"；无 @ 时用 chat state fallback（recentReplyTty → activeTty）
 *   - target 匹配：tty / 短 tty / 标题 / cwd basename
 *   - AppleScript send + claude TUI forceEnter
 *   - **建 pending**（im='wecom'），watcher 跟踪；isFinal 时 daemon 侧另一个
 *     监听器（见下 `attachWeComFinalListener`）用 wecom transport 发收尾摘要
 *   - **更新 chat state**：activeTty + recentReplyTty，实现 sticky 对话
 *   - 首次注入回执一条简短文本，告诉用户 "命令收到 + tab"
 *
 * 不做（Day 7+）：
 *   - 进度卡 patch（企微不支持任意 body 更新，用简化"初始 ack + 最终摘要"两条模式）
 *   - /slash 命令解析（用户发 /help 之类）
 *   - 群聊 target
 */
async function dispatchWeComMessage(
  wecom: WeComTransport,
  ev: IMMessageEvent,
): Promise<void> {
  const text = ev.text.trim();
  if (!text) return;

  // 优先：input / (wecom-multi) ask 等答案 → 消费此消息为答案
  const pendingAskId = asks.getAwaitingInputAskId(ev.chatId);
  if (pendingAskId) {
    const askReq = asks.get(pendingAskId);
    if (askReq) {
      if (text === '/cancel') {
        await asks.cancel(pendingAskId, `wecom:${ev.senderId}`);
      } else if (askReq.type === 'multi') {
        // 解析 "1,3,5" / "1 3 5" / "1、3、5" / "1；3；5" 等分隔符
        const indices = text
          .split(/[\s,，、;；]+/)
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => Number.isFinite(n) && n >= 1 && n <= askReq.options.length)
          .map((n) => n - 1);   // 1-indexed → 0-indexed
        const uniqueIndices = [...new Set(indices)].sort((a, b) => a - b);
        if (uniqueIndices.length === 0) {
          await wecom.sendText(
            ev.chatId,
            `❓ 没解析出有效选项号（1-${askReq.options.length}）。回复例："1,3" 或 "2 4 5"；发 /cancel 取消。`,
          );
          return;
        }
        const values = uniqueIndices.map((i) => askReq.options[i] ?? '');
        await asks.answer(
          pendingAskId,
          { kind: 'multi', indices: uniqueIndices, values },
          `wecom:${ev.senderId}`,
        );
      } else {
        await asks.answer(pendingAskId, { kind: 'input', text }, `wecom:${ev.senderId}`);
      }
      return;
    }
  }

  // `//foo` 显式转发到 activeTty（去一个 /）—— 跟飞书对齐
  if (isForwardSlash(text)) {
    const forwardText = stripForwardSlash(text);
    return dispatchWeComPlainToTab(wecom, ev, forwardText);
  }

  // slash 命令：先尝试内置 /screen /keys（这两个要 host-mac 直接调），
  // 再走通用 handleCommand（复用 mchat 命令库，只支持 text-kind ReplyAction）
  if (isCommand(text)) {
    return dispatchWeComSlash(wecom, ev, text);
  }

  const chatState = await loadChat(ev.chatId);
  const tabs = await listTabs();

  // 解析 @target；无 @ 时用 chat state fallback
  let target = '';
  let cmd = text;
  const m = /^@(\S+)\s+([\s\S]+)$/.exec(text);
  if (m) {
    target = (m[1] ?? '').toLowerCase();
    cmd = m[2] ?? '';
  }

  let tab: (typeof tabs)[number] | undefined;
  if (target) {
    tab = tabs.find((t) => {
      const ttyShort = t.tty.replace(/^\/dev\//, '').toLowerCase();
      if (ttyShort === target || t.tty.toLowerCase() === target) return true;
      if (t.title.toLowerCase().includes(target)) return true;
      if (t.cwd && t.cwd.toLowerCase().endsWith('/' + target)) return true;
      return false;
    });
    if (!tab) {
      await wecom.sendText(
        ev.chatId,
        `❌ 找不到 target=${target}。可用 tab：\n` +
          tabs.slice(0, 8).map((t) => `- ${t.tty.replace(/^\/dev\//, '')}${t.cwd ? ` (${t.cwd})` : ''}`).join('\n'),
      );
      return;
    }
  } else {
    // 无 @：优先 recentReplyTty（5min sticky），退回 activeTty
    const now = Date.now();
    const stickyOk =
      chatState.recentReplyTty &&
      chatState.recentReplyAt !== undefined &&
      now - chatState.recentReplyAt < RECENT_REPLY_TTL_MS;
    const fallbackTty = stickyOk ? chatState.recentReplyTty : chatState.activeTty;
    if (!fallbackTty) {
      await wecom.sendText(
        ev.chatId,
        '❓ 无 @target 也没设 activeTty。\n用 `@ttysXXX 命令` 首次派发，之后 5 分钟内裸文本会自动到该 tab。',
      );
      return;
    }
    tab = tabs.find((t) => t.tty === fallbackTty);
    if (!tab) {
      await wecom.sendText(
        ev.chatId,
        `❌ 上次的 tab ${fallbackTty} 已关闭。用 @ttysXXX 明示 target。`,
      );
      return;
    }
  }

  // 拿 beforeCharLen baseline
  let beforeCharLen: number | undefined;
  try {
    const h = await getHistory(tab.tty);
    beforeCharLen = h.length;
  } catch {
    /* ignore */
  }

  const result = await terminalSend(tab.tty, cmd);
  if (!result.ok) {
    await wecom.sendText(ev.chatId, `❌ send 失败：${result.reason ?? '(无原因)'}`);
    return;
  }
  if (tab.hasTUI) {
    await new Promise((r) => setTimeout(r, 400));
    await forceEnter(tab.tty);
  }

  // 更新 chat state：activeTty + recentReplyTty
  const now = Date.now();
  chatState.activeTty = tab.tty;
  chatState.recentReplyTty = tab.tty;
  chatState.recentReplyAt = now;
  chatState.lastActiveAt = now;
  await saveChat(chatState);

  // 建 pending —— watcher 会跟踪，isFinal 时 attachWeComFinalListener 发摘要
  if (result.before !== undefined) {
    const p: PendingOutput = {
      tty: tab.tty,
      chatId: ev.chatId,
      sentAt: now,
      beforeLen: result.before,
      lastPushedLen: result.before,
      taskDescription: cmd.slice(0, 80),
      originalPrompt: cmd,
      source: 'wecom',
      im: 'wecom',
    };
    if (tab.cwd) p.cwd = tab.cwd;
    if (target) p.targetLabel = target;
    if (beforeCharLen !== undefined) {
      p.beforeCharLen = beforeCharLen;
      p.lastSeenCharLen = beforeCharLen;
    }
    pendingTracker.add(p);
  }

  await wecom.sendText(
    ev.chatId,
    `✓ 已注入到 ${tab.tty.replace(/^\/dev\//, '')}${tab.cwd ? ` (${tab.cwd})` : ''}\n命令：${cmd.slice(0, 100)}\n（跑完会自动收到摘要；后续 5 分钟内裸文本无需 @target）`,
  );
}

/**
 * 拿"当前对话的目标 tty"：优先 5min sticky（recentReplyTty），退回 activeTty。
 */
function getStickyTty(chatState: {
  recentReplyTty?: string;
  recentReplyAt?: number;
  activeTty?: string;
}): string | undefined {
  const now = Date.now();
  const stickyOk =
    chatState.recentReplyTty &&
    chatState.recentReplyAt !== undefined &&
    now - chatState.recentReplyAt < RECENT_REPLY_TTL_MS;
  return stickyOk ? chatState.recentReplyTty : chatState.activeTty;
}

/**
 * `//foo` 显式转发：把 text 当普通文本发到 activeTty，不解析 @target。
 */
async function dispatchWeComPlainToTab(
  wecom: WeComTransport,
  ev: IMMessageEvent,
  text: string,
): Promise<void> {
  const chatState = await loadChat(ev.chatId);
  const tty = getStickyTty(chatState);
  if (!tty) {
    await wecom.sendText(ev.chatId, '❓ 无 activeTty，先 `@ttysXXX 命令` 首次派发建 sticky');
    return;
  }
  const tabs = await listTabs();
  const tab = tabs.find((t) => t.tty === tty);
  if (!tab) {
    await wecom.sendText(ev.chatId, `❌ tab ${tty} 已关`);
    return;
  }
  const result = await terminalSend(tab.tty, text);
  if (!result.ok) {
    await wecom.sendText(ev.chatId, `❌ send 失败：${result.reason ?? ''}`);
    return;
  }
  if (tab.hasTUI) {
    await new Promise((r) => setTimeout(r, 400));
    await forceEnter(tab.tty);
  }
  const now = Date.now();
  chatState.recentReplyTty = tab.tty;
  chatState.recentReplyAt = now;
  chatState.lastActiveAt = now;
  await saveChat(chatState);
  await wecom.sendText(
    ev.chatId,
    `✓ 已转发到 ${tab.tty.replace(/^\/dev\//, '')}`,
  );
}

/**
 * 企微收到 `/foo` 时的分发：
 *   - `/screen` `/scr` → 抓 sticky tab 的窗口截图 + sendImage
 *   - `/keys` `/k <seq>` → 按键序列发到 sticky tab + 300ms 后自动 send 一张截图
 *   - 其他 → 复用 handleCommand（仅支持 text-kind ReplyAction；card/execute 报错）
 */
async function dispatchWeComSlash(
  wecom: WeComTransport,
  ev: IMMessageEvent,
  text: string,
): Promise<void> {
  const chat_id = ev.chatId;
  const cmdName = text.trim().slice(1).split(/\s+/)[0]?.toLowerCase() ?? '';

  if (cmdName === 'screen' || cmdName === 'scr') {
    const chatState = await loadChat(chat_id);
    const tty = getStickyTty(chatState);
    if (!tty) {
      await wecom.sendText(chat_id, '❌ 无 activeTty，先 `@ttysXXX xxx` 首次派发');
      return;
    }
    try {
      const path = await captureScreen(tty);
      await wecom.sendImage(chat_id, path);
      await wecom.sendText(chat_id, `📸 抓屏 ${tty.replace(/^\/dev\//, '')} 已推`);
    } catch (e) {
      await wecom.sendText(chat_id, `❌ 抓屏失败：${(e as Error).message}`);
    }
    return;
  }

  if (cmdName === 'keys' || cmdName === 'k') {
    const rest = text.trim().slice(cmdName.length + 1).trim();
    if (!rest) {
      await wecom.sendText(
        chat_id,
        '用法：/keys <按键序列>\n例：/keys 2d . ⏎    #下下 空 回\n     /keys ctrl+c\n键位：d/u/l/r=↓↑←→ .=空格 ⏎=回车 t=tab x=esc',
      );
      return;
    }
    const chatState = await loadChat(chat_id);
    const tty = getStickyTty(chatState);
    if (!tty) {
      await wecom.sendText(chat_id, '❌ 无 activeTty，先 `@ttysXXX xxx` 首次派发');
      return;
    }
    try {
      await sendKeys(tty, rest);
      setTimeout(async () => {
        try {
          const path = await captureScreen(tty);
          await wecom.sendImage(chat_id, path);
        } catch {
          /* silent */
        }
      }, 300);
      await wecom.sendText(
        chat_id,
        `✓ 已发按键到 ${tty.replace(/^\/dev\//, '')}：\`${rest}\`（300ms 后回图确认）`,
      );
    } catch (e) {
      await wecom.sendText(chat_id, `❌ /keys 失败：${(e as Error).message}`);
    }
    return;
  }

  // 通用：走 handleCommand 复用 mchat 命令库
  try {
    const action = await handleCommand(chat_id, text);
    if (action.kind === 'text') {
      await wecom.sendText(chat_id, action.text);
    } else if (action.kind === 'card') {
      await wecom.sendText(
        chat_id,
        `此命令 (/${cmdName}) 返回卡片，企微暂不支持渲染。可在飞书里执行，或用 /help /watch /quiet /use /where /recall /approvals 等纯文本命令。`,
      );
    } else if (action.kind === 'execute') {
      // 展开的 prompt 当作普通派发
      await dispatchWeComMessage(wecom, { ...ev, text: action.text });
    } else if (action.kind === 'forward-slash-to-tab') {
      await dispatchWeComPlainToTab(wecom, ev, action.text);
    } else {
      await wecom.sendText(chat_id, `命令 /${cmdName} 类型 ${action.kind} 企微暂不支持`);
    }
  } catch (e) {
    await wecom.sendText(chat_id, `命令执行异常：${(e as Error).message}`);
  }
}

/**
 * 监听 watcher.taskOutput —— 只处理 pending.im === 'wecom'，在 isFinal 时把
 * 任务摘要用 wecom transport 发到源 chat。中间不 patch（企微 body update 有限，
 * 用"初始 ack + 最终摘要"简化模式）。
 */
function attachWeComFinalListener(wecom: WeComTransport): void {
  watcher.events.on(
    'taskOutput',
    async ({
      pending,
      isFinal,
      taskOnlyTail,
      outputTail,
    }: {
      pending: PendingOutput;
      isFinal: boolean;
      taskOnlyTail: string;
      outputTail: string;
    }) => {
      if (pending.im !== 'wecom') return;
      if (!isFinal) return;
      try {
        const clean = sanitizeTerminalOutput(taskOnlyTail || outputTail || '').trimEnd();
        const tailForCard =
          clean.length === 0
            ? '(任务已完成，无新输出)'
            : clean.length > 1500
              ? clean.slice(-1500) + '\n…(截断到最后 1500 字)'
              : clean;
        const shortTty = pending.tty.replace(/^\/dev\//, '');
        const msg = `✓ ${shortTty} 任务完成\n命令：${pending.taskDescription}\n\n${tailForCard}`;
        await wecom.sendText(pending.chatId, msg);
      } catch (e) {
        logger.warn('wecom final push failed', { err: (e as Error).message });
      }
    },
  );
}

/**
 * AskRequest → wecom CardSpec，然后走 renderWeComCard。
 * ask card 只有 single / input 类型能真正走交互；multi 走降级卡（renderMultiUnsupportedCard）。
 */
function askToCardSpec(req: AskRequest): CardSpec {
  if (req.type === 'input') {
    return {
      kind: 'ask',
      title: req.title,
      template: 'blue',
      options: [],  // 空 → renderer 走 renderAskInputCard
      inputHint: '（回复本消息发送答案；发 /cancel 取消）',
    };
  }
  if (req.type === 'multi') {
    // 交给 renderer 显示 unsupported（selectedIndices 存在 → renderer 认为是 multi）
    return {
      kind: 'ask',
      title: req.title,
      template: 'yellow',
      options: req.options,
      selectedIndices: req.selection,
    };
  }
  // single —— 每个 option 一个按钮 + 取消按钮
  const actions: Array<{ label: string; type: 'primary' | 'default' | 'danger'; value: Record<string, unknown> }> = req.options.map((opt, i) => ({
    label: `${i + 1}. ${opt}`,
    type: 'primary',
    value: { action: 'ask.pick', askId: req.id, index: i },
  }));
  actions.push({
    label: '⊘ 取消',
    type: 'default',
    value: { action: 'ask.cancel', askId: req.id },
  });
  return {
    kind: 'ask',
    title: req.title,
    template: 'yellow',
    body: '点一个选项即可提交',
    actions,
  };
}

/**
 * 企微侧 ask 生命周期。跟 lark notifier 里的 asks.events 监听器平行运行。
 * created → 发企微交互卡；resolved → 发一条 "已回答/已取消/已超时" 文本（企微
 * body update 有限，不 patch 卡）
 */
function attachWeComAskListener(wecom: WeComTransport): void {
  asks.events.on('created', async (req: AskRequest) => {
    if (!req.chatId.startsWith('wecom:')) return;
    try {
      const spec = askToCardSpec(req);
      const card = renderWeComCard(spec);
      const r = await wecom.sendCard(req.chatId, spec);
      asks.setCardMessageId(req.id, r.messageId);
      logger.info('wecom ask card sent', { id: req.id, type: req.type });
      void card; // 已经通过 sendCard 里的 render 送出，此处无需再用
    } catch (e) {
      logger.warn('wecom ask card send failed', {
        id: req.id,
        err: (e as Error).message,
      });
    }
  });

  asks.events.on('resolved', async (req: AskRequest) => {
    if (!req.chatId.startsWith('wecom:')) return;
    try {
      let msg = '';
      if (req.status === 'answered' && req.answer) {
        if (req.answer.kind === 'single') {
          msg = `✅ 已选：${req.answer.index + 1}. ${req.answer.value}`;
        } else if (req.answer.kind === 'input') {
          msg = `✅ 已回复：${req.answer.text.slice(0, 200)}`;
        } else if (req.answer.kind === 'multi') {
          msg = `✅ 已选（${req.answer.indices.length}项）：${req.answer.values.join(' / ')}`;
        }
      } else if (req.status === 'cancelled') {
        msg = `⊘ 已取消：${req.title}`;
      } else if (req.status === 'timeout') {
        msg = `⌛ 已超时：${req.title}`;
      }
      if (msg) await wecom.sendText(req.chatId, msg);
    } catch (e) {
      logger.warn('wecom ask resolved push failed', {
        id: req.id,
        err: (e as Error).message,
      });
    }
  });
}

/**
 * 企微卡片按钮点击 → 路由到对应 handler。目前支持：
 *   - ask.pick / ask.cancel（AskManager）
 *   - approve / reject（ApprovalManager）
 */
function attachWeComCardActionRouter(wecom: WeComTransport): void {
  wecom.events.on('cardAction', async (ev) => {
    const action = ev.action;
    const value = ev.value;
    if (action === 'ask.pick') {
      const askId = value['askId'] as string | undefined;
      const index = value['index'] as number | undefined;
      if (!askId || typeof index !== 'number') return;
      const req = asks.get(askId);
      if (!req) {
        void wecom.sendText(ev.chatId, `⚠️ ask ${askId} 已完成或不存在`);
        return;
      }
      const picked = req.options[index] ?? '';
      await asks.answer(
        askId,
        { kind: 'single', index, value: picked },
        `wecom:${ev.operatorId}`,
      );
      return;
    }
    if (action === 'ask.cancel') {
      const askId = value['askId'] as string | undefined;
      if (!askId) return;
      await asks.cancel(askId, `wecom:${ev.operatorId}`);
      return;
    }
    if (action === 'approve' || action === 'reject') {
      const approvalId = value['approvalId'] as string | undefined;
      if (!approvalId) return;
      const decision = action === 'approve' ? 'approved' : 'rejected';
      const r = await approvals.resolve(approvalId, decision, `wecom:${ev.operatorId}`);
      if (!r) {
        void wecom.sendText(ev.chatId, `⚠️ 审批 ${approvalId} 不存在或已完成`);
      }
      return;
    }
    logger.info('wecom cardAction unhandled', { action, value });
  });
}

/**
 * 企微侧 approval 生命周期。跟 lark notifier 里的 approvals.events 平行运行。
 * created → 发企微 button_interaction 审批卡；resolved → 发一条 "✅ 已批准 by X" / "❌ 已拒绝" 文本
 */
function attachWeComApprovalListener(wecom: WeComTransport): void {
  approvals.events.on('created', async (req: ApprovalRequest) => {
    if (!req.chatId || !req.chatId.startsWith('wecom:')) return;
    try {
      const spec: CardSpec = {
        kind: 'approval',
        title: `🚨 需审批 · ${req.title.slice(0, 80)}`,
        template: 'yellow',
        body: req.body.slice(0, 500),
        metaLines: [`5 min 超时`, `id: ${req.id.slice(0, 20)}`],
        actions: [
          {
            label: '✅ 批准',
            type: 'primary',
            value: { action: 'approve', approvalId: req.id },
          },
          {
            label: '❌ 拒绝',
            type: 'danger',
            value: { action: 'reject', approvalId: req.id },
          },
        ],
      };
      const r = await wecom.sendCard(req.chatId, spec);
      approvals.setCardMessageId(req.id, r.messageId);
      logger.info('wecom approval card sent', { id: req.id });
    } catch (e) {
      logger.warn('wecom approval card send failed', {
        id: req.id,
        err: (e as Error).message,
      });
    }
  });

  approvals.events.on('resolved', async (req: ApprovalRequest) => {
    if (!req.chatId || !req.chatId.startsWith('wecom:')) return;
    try {
      const by = req.resolvedBy ? ` by ${req.resolvedBy}` : '';
      const msg =
        req.status === 'approved'
          ? `✅ 已批准${by}：${req.title}`
          : req.status === 'rejected'
            ? `❌ 已拒绝${by}：${req.title}`
            : `⌛ 已超时（自动拒绝）：${req.title}`;
      await wecom.sendText(req.chatId, msg);
    } catch (e) {
      logger.warn('wecom approval resolved push failed', {
        id: req.id,
        err: (e as Error).message,
      });
    }
  });
}

async function main() {
  // ---- Preflight（都是幂等 / 快速，早失败 hint 给用户） ----
  assertNodeVersion();
  await ensureEnvFile();               // 缺 .env 时会 exit(1)
  emitMacPermissionHints();

  // 先起 caffeinate 阻止 idle sleep（用 daemon.pid 追踪，daemon 挂了它自动退）
  startCaffeinate();

  // WS watchdog 必须在 startLarkBot 前安装 —— 它 monkey-patch console.log 截获 SDK 输出
  installWsWatchdog();
  const lark = startLarkBot();

  // ---- 企微 transport（可选）：仅在 .env 里配了 WECOM_* 时 attach ----
  // 需要在 startControlServer 之前起，让 server 拿到 transport 引用
  let wecom: WeComTransport | null = null;
  const wecomCfg = loadWeComConfig();
  if (wecomCfg) {
    try {
      wecom = new WeComTransport(wecomCfg);
      await wecom.start();
      wecom.events.on('message', async (ev) => {
        logger.info('wecom message received', {
          chatId: ev.chatId,
          senderId: ev.senderId,
          textPreview: ev.text.slice(0, 60),
        });
        try {
          await dispatchWeComMessage(wecom!, ev);
        } catch (e) {
          logger.warn('wecom dispatch failed', { err: (e as Error).message });
          try {
            await wecom!.sendText(ev.chatId, `❌ 派发失败：${(e as Error).message}`);
          } catch { /* ignore */ }
        }
      });
      wecom.events.on('cardAction', (ev) => {
        logger.info('wecom cardAction received (未接 handler)', {
          chatId: ev.chatId,
          action: ev.action,
        });
      });
      // watcher 检测 tab 完成时用 wecom transport 发摘要（简化模式：initial ack + final only）
      attachWeComFinalListener(wecom);
      // ask 生命周期：created → 发企微交互卡；resolved → 文本通知（结果 by via lark ask CLI）
      attachWeComAskListener(wecom);
      // approval 生命周期：created → 发企微审批卡；resolved → 文本通知
      attachWeComApprovalListener(wecom);
      // 按钮点击 → 路由到 AskManager / ApprovalManager
      attachWeComCardActionRouter(wecom);
      logger.info('wecom transport attached', {
        corpId: wecomCfg.corpId,
        agentId: wecomCfg.agentId,
        port: wecomCfg.callbackHttpPort,
      });
    } catch (e) {
      logger.warn('wecom transport start failed（daemon 继续跑，只是企微不可用）', {
        err: (e as Error).message,
      });
      wecom = null;
    }
  } else {
    logger.info('wecom transport 未 attach（缺 WECOM_CORP_ID/AGENT_ID/SECRET/TOKEN/AES_KEY 任一）');
  }

  await startControlServer(lark.client, wecom ?? undefined);
  attachWatcherToLark(lark.client);
  attachStageMemoryListener();
  startHealthCheck(lark.client);
  await ensureSkillInstalled();
  await installClaudeCodeHooks();
  await ensureAgentOnPath();

  // 后台刷新目录索引（首次可能扫 15s，不阻塞主流程）
  void refreshDirIndex().catch((e) => {
    logger.warn('dir-index initial refresh failed', { err: (e as Error).message });
  });

  process.on('SIGINT', () => {
    logger.info('received SIGINT, shutting down');
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    logger.info('received SIGTERM, shutting down');
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error('fatal startup error', err);
  process.exit(1);
});
