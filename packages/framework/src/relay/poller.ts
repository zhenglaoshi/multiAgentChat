import {
  applyIncoming,
  logger,
  markProcessed,
  validateIncoming,
  type ApplyResult,
  type HandoffEnvelope,
} from 'multiagent-orchestrator';
import type { RelayClient } from './client.js';

/** 收到并处理完一条 envelope 后回调，daemon 用它投递飞书。 */
export type HandoffDeliver = (result: ApplyResult, env: HandoffEnvelope) => void | Promise<void>;

export interface RelayPoller {
  stop(): void;
}

const POLL_WAIT_SEC = 25;
const ERROR_BACKOFF_MS = 5_000;

/**
 * 起长轮询循环：poll → 校验 → 白名单闸门 → 去重 → applyIncoming → 投递飞书 → ack。
 * at-least-once + markProcessed 去重保证幂等。收件白名单在这里 fail-closed 拦截。
 */
export function startRelayPoller(client: RelayClient, deliver: HandoffDeliver): RelayPoller {
  let stopped = false;

  async function loop(): Promise<void> {
    logger.info('relay poller 启动', { identity: client.identity, allow: [...client.allow] });
    while (!stopped) {
      let items: HandoffEnvelope[];
      try {
        items = await client.poll(POLL_WAIT_SEC);
      } catch (e) {
        if (stopped) break;
        logger.warn('relay poll 失败，退避重试', { err: (e as Error).message });
        await sleep(ERROR_BACKOFF_MS);
        continue;
      }
      if (items.length === 0) continue;

      const toAck: string[] = [];
      for (const raw of items) {
        try {
          await handleOne(client, raw, deliver, toAck);
        } catch (e) {
          // 处理失败 → 不 ack，下轮重投
          logger.warn('handoff 处理失败，保留重投', {
            msgId: (raw as HandoffEnvelope)?.msgId,
            err: (e as Error).message,
          });
        }
      }
      if (toAck.length > 0) {
        try {
          await client.ack(toAck);
        } catch (e) {
          logger.warn('relay ack 失败（下轮会重投，靠去重兜底）', { err: (e as Error).message });
        }
      }
    }
    logger.info('relay poller 停止');
  }

  void loop();
  return { stop: () => { stopped = true; } };
}

async function handleOne(
  client: RelayClient,
  raw: HandoffEnvelope,
  deliver: HandoffDeliver,
  toAck: string[],
): Promise<void> {
  const v = validateIncoming(raw);
  if (!v.ok) {
    logger.warn('丢弃非法 envelope', { reason: v.error });
    const badId = (raw as { msgId?: unknown })?.msgId;
    if (typeof badId === 'string' && badId) toAck.push(badId); // 有 msgId 才 ack，别卡队列
    return;
  }
  const env = v.env;

  // 收件闸门：HANDOFF_ALLOW 非空 → 严格 opt-in（只收名单内）；为空 → 收所有（门户模型：
  // relay 已凭 SSO/邀请码登记发件人身份 + 收件人黑名单在 relay 侧拦截，客户端默认放行）。
  if (client.allow.size > 0 && !client.allow.has(env.from)) {
    logger.warn('handoff 被本地白名单拦截（HANDOFF_ALLOW 已设为 opt-in）', { from: env.from });
    toAck.push(env.msgId);
    return;
  }

  // 先 applyIncoming（幂等：create 按 id 判重、status 按 canTransition 判重）。
  // 若这里抛异常 → 不 ack、下轮重投重试；不会因提前标记"已处理"而静默丢消息。
  const result = await applyIncoming(env, client.identity);

  // markProcessed 只用于"去重投递"（避免重投时给飞书重复弹卡），不用于"去重尝试"。
  const firstTime = await markProcessed(env.msgId);
  if (firstTime) {
    try {
      await deliver(result, env);
    } catch (e) {
      // 投递失败不影响 ack：task 已落盘，可 `agent handoff list` 查
      logger.warn('handoff 飞书投递失败（任务已落盘）', { err: (e as Error).message });
    }
  }
  toAck.push(env.msgId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
