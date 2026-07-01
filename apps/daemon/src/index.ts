import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
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

async function main() {
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
