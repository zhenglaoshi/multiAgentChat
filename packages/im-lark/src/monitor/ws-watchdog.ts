/**
 * WS 长连接状态监控。
 *
 * @larksuiteoapi/node-sdk 没暴露 WSClient 事件，只打日志：`logger.info('[ws]', 'reconnect')` /
 * `logger.info('[ws]', 'ws client ready')`（SDK 1.68 lib 实测两个独立字符串参数）。
 *
 * 2026-10-19 起（多 bot）：每个 Client/WSClient 都传 `createWsLogger(botId)` 自定义 logger，按 bot 分流 ——
 * 默认 bot 进 `wsState`（参与 health-check 自杀判定），附属 bot 进 `extraBotWsState`（只告警）。
 * 传了 logger 后 SDK 不再 console.log，下面 `installWsWatchdog` 的 console.log monkey-patch 对这些 WS 已不再截到东西，
 * 保留它只为：① 初始化 `wsState.lastReadyAt`；② 万一哪条路径没传 logger（旧写法）仍能兜住。
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

/**
 * 非默认 bot 的 WS 状态（只记录、不参与自杀判定）。
 * 原因：数字员工等附属 bot 凭证填错 / 应用没发布时会 reconnect 风暴，若也算进 wsState 会让 daemon
 * 无限重启、把主 bot 一起拖死；它们挂了只影响自己那条通道，打 warn 即可。
 */
export const extraBotWsState = new Map<string, { lastReadyAt: number; reconnectCount: number }>();

function observeWsLine(botId: string, isDefault: boolean, s: string): void {
  if (!s.includes('[ws]')) return;
  if (isDefault) {
    if (s.includes('ws client ready')) {
      const since = Date.now() - wsState.lastReadyAt;
      wsState.lastReadyAt = Date.now();
      wsState.totalReady++;
      if (wsState.reconnectCount > 0) {
        logger.info('WS recovered', { previousReconnects: wsState.reconnectCount, downtimeMs: since });
      }
      wsState.reconnectCount = 0;
    } else if (s.includes('reconnect')) {
      wsState.lastReconnectAt = Date.now();
      wsState.reconnectCount++;
      logger.warn('WS reconnect detected', { count: wsState.reconnectCount, lastReadyAgo: Date.now() - wsState.lastReadyAt });
    }
    return;
  }
  const st = extraBotWsState.get(botId) ?? { lastReadyAt: 0, reconnectCount: 0 };
  if (s.includes('ws client ready')) {
    st.lastReadyAt = Date.now();
    if (st.reconnectCount > 0) logger.info(`WS[${botId}] recovered`, { previousReconnects: st.reconnectCount });
    st.reconnectCount = 0;
  } else if (s.includes('reconnect')) {
    st.reconnectCount++;
    // 持续失败只每 10 次提醒一次，避免刷屏
    if (st.reconnectCount <= 3 || st.reconnectCount % 10 === 0) {
      logger.warn(`WS[${botId}] reconnect（附属 bot，不触发重启）`, { count: st.reconnectCount, hint: '检查该应用凭证 / 是否已发布 / 事件订阅是否选了长连接' });
    }
  }
  extraBotWsState.set(botId, st);
}

/**
 * 给 SDK Client / WSClient 用的自定义 logger：多 bot 时 SDK 自己的 console.log 分不出是哪条 WS，
 * 改为每个 bot 一个 logger，日志带 `[bot]` 标签，并按 bot 分流到 wsState（默认 bot）/ extraBotWsState（其它）。
 * 传了 logger 后 SDK 不再 console.log，上面的 monkey-patch 对该 bot 自然失效，两者不会重复计数。
 */
export function createWsLogger(botId: string, isDefault: boolean): {
  error: (...msg: unknown[]) => void;
  warn: (...msg: unknown[]) => void;
  info: (...msg: unknown[]) => void;
  debug: (...msg: unknown[]) => void;
  trace: (...msg: unknown[]) => void;
} {
  const tag = `[lark:${botId}]`;
  const emit = (level: 'error' | 'warn' | 'info' | 'debug', args: unknown[]): void => {
    const s = args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ');
    try {
      observeWsLine(botId, isDefault, s);
    } catch {
      /* never crash log path */
    }
    // 保持与 SDK 原输出同样走 console（dev 日志里能看到），只是加了 bot 标签
    if (level === 'error') console.error(tag, ...args);
    else if (level === 'warn') console.warn(tag, ...args);
    else if (level === 'info') console.info(tag, ...args);
    else if (process.env['LOG_LEVEL'] === 'debug') console.debug(tag, ...args);
  };
  return {
    error: (...m) => emit('error', m),
    warn: (...m) => emit('warn', m),
    info: (...m) => emit('info', m),
    debug: (...m) => emit('debug', m),
    trace: () => {},
  };
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
