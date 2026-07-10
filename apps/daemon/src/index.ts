import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startControlServer } from 'multiagent-framework';
import { startLarkBot } from 'multiagent-im-lark';
import { loadWeComConfig, WeComTransport } from 'multiagent-im-wecom';
import { logger } from 'multiagent-orchestrator';
import { startHealthCheck } from 'multiagent-im-lark';
import { attachWatcherToLark } from 'multiagent-im-lark';
import { installWsWatchdog } from 'multiagent-im-lark';
import { attachStageMemoryListener } from 'multiagent-orchestrator';
import { listTabs, refreshDirIndex, send as terminalSend, forceEnter } from 'multiagent-host-mac';
import type { IMMessageEvent } from 'multiagent-framework';

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
 * 极简版企微 → Terminal tab 派发（v1）。
 *
 * 目前实现：
 *   - 解析 "@target text" 或纯文本
 *   - @target 支持：tty (ttys003 / /dev/ttys003) / tab 标题 / cwd basename
 *   - 无 @ 时提示需要 @target（企微 v1 不支持 sticky/active tty 状态，简单粗暴）
 *   - AppleScript send 到 tab；如果是 claude TUI 还 forceEnter
 *   - 派发结果通过 wecom.sendText 回执给用户
 *
 * 不做（Day 6+）：
 *   - 进度卡 (template_card render + patch)
 *   - pending tracker（企微 patch 靠重发，UX 不同）
 *   - Stop hook auto-push
 *   - /watch, /quiet 等 slash 命令
 */
async function dispatchWeComMessage(
  wecom: WeComTransport,
  ev: IMMessageEvent,
): Promise<void> {
  const text = ev.text.trim();
  if (!text) return;

  // 解析 @target
  const m = /^@(\S+)\s+([\s\S]+)$/.exec(text);
  if (!m) {
    await wecom.sendText(
      ev.chatId,
      '❓ 需要 `@target 命令` 格式（企微 v1 暂不支持 sticky/active tty）\n例：@ttys003 ls -la',
    );
    return;
  }
  const target = (m[1] ?? '').toLowerCase();
  const cmd = m[2] ?? '';

  const tabs = await listTabs();
  const tab = tabs.find((t) => {
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

  const result = await terminalSend(tab.tty, cmd);
  if (!result.ok) {
    await wecom.sendText(ev.chatId, `❌ send 失败：${result.reason ?? '(无原因)'}`);
    return;
  }
  // 如果是 claude TUI，do script 加 \n 会被理解成换行；显式发一次 Return
  if (tab.hasTUI) {
    await new Promise((r) => setTimeout(r, 400));
    await forceEnter(tab.tty);
  }
  await wecom.sendText(
    ev.chatId,
    `✓ 已注入到 ${tab.tty.replace(/^\/dev\//, '')}${tab.cwd ? ` (${tab.cwd})` : ''}\n命令：${cmd.slice(0, 100)}`,
  );
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
      // 收到企微 text 消息 → 用 host-mac 反查 tty + send 到 tab（v1 极简版：不发进度卡）
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
