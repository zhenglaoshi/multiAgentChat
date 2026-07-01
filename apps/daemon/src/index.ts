import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { startControlServer } from 'multiagent-framework';
import { startLarkBot } from 'multiagent-im-lark';
import { logger } from 'multiagent-orchestrator';
import { startHealthCheck } from 'multiagent-im-lark';
import { attachWatcherToLark } from 'multiagent-im-lark';
import { installWsWatchdog } from 'multiagent-im-lark';
import { attachStageMemoryListener } from 'multiagent-orchestrator';

function checkSkillInstalled(): void {
  const skillFile = join(homedir(), '.claude', 'skills', 'multiagent-lark', 'SKILL.md');
  if (existsSync(skillFile)) {
    logger.info('multiagent-lark skill installed', { path: skillFile });
  } else {
    logger.warn(
      'multiagent-lark skill NOT installed — 跑 `agent install-skill` 让所有 Mac 上的 Claude Code 都知道用 agent lark',
    );
  }
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

async function main() {
  // 先起 caffeinate 阻止 idle sleep（用 daemon.pid 追踪，daemon 挂了它自动退）
  startCaffeinate();

  // WS watchdog 必须在 startLarkBot 前安装 —— 它 monkey-patch console.log 截获 SDK 输出
  installWsWatchdog();
  const lark = startLarkBot();
  await startControlServer(lark.client);
  attachWatcherToLark(lark.client);
  attachStageMemoryListener();
  startHealthCheck(lark.client);
  checkSkillInstalled();

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
