import * as Lark from '@larksuiteoapi/node-sdk';
import { config } from '../config.js';
import { logger } from 'multiagent-orchestrator';
import { buildEventDispatcher } from './handlers.js';

export interface LarkRuntime {
  client: Lark.Client;
  wsClient: Lark.WSClient;
}

export function startLarkBot(): LarkRuntime {
  const client = new Lark.Client({
    appId: config.lark.appId,
    appSecret: config.lark.appSecret,
  });

  const wsClient = new Lark.WSClient({
    appId: config.lark.appId,
    appSecret: config.lark.appSecret,
  });

  const dispatcher = buildEventDispatcher(client);
  wsClient.start({ eventDispatcher: dispatcher });

  logger.info('lark bot started (WS long-connection)');
  return { client, wsClient };
}
