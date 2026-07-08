import { utimesSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as Lark from '@larksuiteoapi/node-sdk';
import { config } from '../config.js';
import { logger } from 'multiagent-orchestrator';
import { isWsLikelyDead, wsState } from './ws-watchdog.js';

const HEALTH_INTERVAL_MS = 30_000;
const FAIL_THRESHOLD = 3;
// 触发 tsx watch 重新加载的"哨兵"文件 —— 用 import.meta.url 自指
// 即当前文件（health-check.ts）本身。tsx watch 追踪 entry 的全部依赖 import 树，
// 只要触碰任何 import 到的文件就能触发 reload。
// 之前硬编码 './src/index.ts' 在项目 monorepo 化后失效 → 自杀路径踩空，daemon 死了不重启。
const RELOAD_TRIGGER = fileURLToPath(import.meta.url);

/**
 * 后台 health check：每 30s 调一次 lark bot.v3.info API。
 * 连续失败 FAIL_THRESHOLD 次 → touch index.ts 让 tsx watch reload + process.exit(1)
 *
 * 这避免 dev "假活" — WS 断了 SDK 不一定恢复，但 health-check 失败会让 tsx 重启整个进程，
 * 新进程会重新建立 WS 长连接。
 */
async function pingLark(): Promise<void> {
  // 用 token endpoint 测网络 + 凭证（最轻量，飞书侧免费且不需要 access token 预热）
  const resp = await fetch(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: config.lark.appId,
        app_secret: config.lark.appSecret,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = (await resp.json()) as { code?: number; msg?: string };
  if (data.code !== 0) throw new Error(`lark code ${data.code} msg=${data.msg}`);
}

export function startHealthCheck(_client: Lark.Client): void {
  let consecutiveFails = 0;

  const triggerReload = (reason: string): void => {
    logger.error(`triggering tsx reload + exit(1): ${reason}`);
    try {
      const now = new Date();
      utimesSync(RELOAD_TRIGGER, now, now);
    } catch (touchErr) {
      logger.warn('utimes failed (but exiting anyway)', {
        err: (touchErr as Error).message,
      });
    }
    setTimeout(() => process.exit(1), 500);
  };

  const tick = async () => {
    // 第一道：检查 WS 是否"看起来死了"（reconnect ≥ 3 次且 90s 没 ready）
    // 这弥补 HTTP-only 检查的盲点 — WS 是另一条连接，HTTP 通不代表 WS 通
    if (isWsLikelyDead()) {
      logger.warn('WS appears dead', {
        reconnectCount: wsState.reconnectCount,
        sinceReadyMs: Date.now() - wsState.lastReadyAt,
        lastInboundAgo: Date.now() - wsState.lastInboundAt,
      });
      triggerReload('WS appears dead (reconnect ≥3 且 ready 超时)');
      return;
    }

    // 第二道：HTTP 健康检查
    try {
      await pingLark();
      if (consecutiveFails > 0) {
        logger.info('health check recovered', { previousFails: consecutiveFails });
      }
      consecutiveFails = 0;
    } catch (e) {
      consecutiveFails++;
      const msg = (e as Error).message?.slice(0, 200) ?? String(e);
      logger.warn('health check failed', {
        attempt: consecutiveFails,
        threshold: FAIL_THRESHOLD,
        err: msg,
      });
      if (consecutiveFails >= FAIL_THRESHOLD) {
        triggerReload(`health check failed ${FAIL_THRESHOLD} times`);
      }
    }
  };

  setInterval(() => {
    void tick();
  }, HEALTH_INTERVAL_MS);

  // 启动后 5s 内做第一次检查（不等 30s）
  setTimeout(() => void tick(), 5000);

  logger.info('health check started', {
    intervalMs: HEALTH_INTERVAL_MS,
    failThreshold: FAIL_THRESHOLD,
  });
}
