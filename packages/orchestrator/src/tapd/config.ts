import type { TapdConfig } from './types.js';

/**
 * 从 env 读 TAPD 配置。缺 URL/TOKEN/NICK 任一 → enabled=false（daemon 不启监听）。
 * 敏感 token 只在 .env（gitignored）。
 */
export function loadTapdConfig(): TapdConfig {
  const mcpUrl = process.env['TAPD_MCP_URL'] ?? '';
  const token = process.env['TAPD_MCP_TOKEN'] ?? '';
  const nick = process.env['TAPD_NICK'] ?? '';

  const workspaceIds = (process.env['TAPD_WORKSPACE_IDS'] ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  const pollMs = (() => {
    const v = Number(process.env['TAPD_POLL_MS']);
    return Number.isFinite(v) && v >= 60_000 ? v : 300_000; // 默认 5min，最小 1min
  })();

  return {
    mcpUrl,
    token,
    nick,
    workspaceIds,
    pollMs,
    enabled: Boolean(mcpUrl && token && nick),
  };
}
