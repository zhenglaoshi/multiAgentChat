/**
 * WS 长连接状态监控。
 *
 * @larksuiteoapi/node-sdk 没暴露 WSClient 事件，只通过 console.log 打日志：
 *   [info]: [ '[ws]', 'reconnect' ]
 *   [info]: [ '[ws]', 'ws client ready' ]
 *
 * 我们 monkey-patch console.log 拦截这些日志 → 跟踪 WS 真实状态 → health-check 综合判断。
 *
 * 这弥补了 HTTP-only health-check 的盲点（HTTP 通但 WS 死的场景）。
 */

import { logger } from 'multiagent-orchestrator';

export const wsState = {
  installed: false,
  /** 最近一次 'ws client ready' 时间戳 */
  lastReadyAt: 0,
  /** 最近一次 'reconnect' 时间戳 */
  lastReconnectAt: 0,
  /** 自上次 ready 以来累计 reconnect 次数 */
  reconnectCount: 0,
  /** 累计 ready 次数 */
  totalReady: 0,
  /** 最近一次收到飞书 inbound event (message_received / card.action.trigger) 的时间戳 */
  lastInboundAt: 0,
};

export function recordInbound(): void {
  wsState.lastInboundAt = Date.now();
}

export function installWsWatchdog(): void {
  if (wsState.installed) return;
  wsState.installed = true;
  wsState.lastReadyAt = Date.now();

  // monkey-patch console.log 截获 SDK 的 ws 输出
  // SDK 用类似 `console.log('[info]:', ['[ws]', 'reconnect'])` 这种格式
  const origLog = console.log;
  console.log = function patched(...args: unknown[]): void {
    try {
      const s = args
        .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
        .join(' ');
      if (s.includes('[ws]')) {
        if (s.includes('ws client ready')) {
          const since = Date.now() - wsState.lastReadyAt;
          wsState.lastReadyAt = Date.now();
          wsState.totalReady++;
          if (wsState.reconnectCount > 0) {
            logger.info('WS recovered', {
              previousReconnects: wsState.reconnectCount,
              downtimeMs: since,
            });
          }
          wsState.reconnectCount = 0;
        } else if (s.includes('reconnect')) {
          wsState.lastReconnectAt = Date.now();
          wsState.reconnectCount++;
          logger.warn('WS reconnect detected', {
            count: wsState.reconnectCount,
            lastReadyAgo: Date.now() - wsState.lastReadyAt,
          });
        }
      }
    } catch {
      /* never crash log path */
    }
    origLog.apply(console, args);
  } as typeof console.log;
}

function safeStringify(x: unknown): string {
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

/**
 * 检查 WS 是否"看起来死了"。
 * 判定：reconnect >= 3 次 且 距上次 ready >= 90s
 */
export function isWsLikelyDead(): boolean {
  if (!wsState.installed) return false;
  if (wsState.reconnectCount < 3) return false;
  const sinceReady = Date.now() - wsState.lastReadyAt;
  return sinceReady >= 90_000;
}
