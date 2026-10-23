import * as Lark from '@larksuiteoapi/node-sdk';
import { logger } from 'multiagent-orchestrator';
import { buildEventDispatcher } from './handlers.js';
import { DEFAULT_LARK_BOT_ID, getLarkBotProfiles, parseLarkBotProfiles, registerLarkClient, type LarkBotProfile } from './bots.js';
import { createWsLogger } from '../monitor/ws-watchdog.js';

export interface LarkRuntime {
  client: Lark.Client;
  wsClient: Lark.WSClient;
  bot: LarkBotProfile;
}

export interface LarkRuntimes extends LarkRuntime {
  /** 全部 bot（含默认）。`client` / `wsClient` / `bot` 字段 = 默认 bot（`local`），老调用点零改动。 */
  bots: LarkRuntime[];
}

function startOne(bot: LarkBotProfile): LarkRuntime {
  const isDefault = bot.id === DEFAULT_LARK_BOT_ID;
  const wsLogger = createWsLogger(bot.id, isDefault);
  const client = new Lark.Client({ appId: bot.appId, appSecret: bot.appSecret, logger: wsLogger });
  const wsClient = new Lark.WSClient({ appId: bot.appId, appSecret: bot.appSecret, logger: wsLogger });
  registerLarkClient(bot.id, client);
  const dispatcher = buildEventDispatcher(client, bot);
  wsClient.start({ eventDispatcher: dispatcher });
  logger.info('lark bot started (WS long-connection)', { bot: bot.id, role: bot.role, label: bot.label, appId: bot.appId });
  return { client, wsClient, bot };
}

/**
 * 起全部飞书 bot（默认 `local` + env 里 `LARK_BOT_<ID>_*` 配的附属 bot，见 bots.ts）。
 * 返回值兼容旧签名：顶层 client/wsClient 就是默认 bot 的。
 */
export function startLarkBot(): LarkRuntimes {
  const { skipped } = parseLarkBotProfiles();
  for (const why of skipped) logger.warn('lark bot 配置被跳过', { why });
  const profiles = getLarkBotProfiles();
  const primary = profiles.find((p) => p.id === DEFAULT_LARK_BOT_ID);
  if (!primary) throw new Error('缺 LARK_APP_ID / LARK_APP_SECRET（默认飞书 bot 必须配）');
  const runtimes: LarkRuntime[] = [startOne(primary)];
  for (const p of profiles) {
    if (p.id === DEFAULT_LARK_BOT_ID) continue;
    try {
      runtimes.push(startOne(p));
    } catch (e) {
      // 附属 bot 起不来不拖累主 bot
      logger.warn('附属 lark bot 启动失败（daemon 继续跑）', { bot: p.id, err: (e as Error).message });
    }
  }
  if (runtimes.length > 1) {
    logger.info('多飞书 bot 已就绪', { bots: runtimes.map((r) => `${r.bot.id}(${r.bot.role})`) });
  }
  return { ...runtimes[0]!, bots: runtimes };
}
