import type { TapdConfig, TapdSystem } from './types.js';
import { isIntegrationDisabled } from '../integrations/envfile.js';

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
    return Number.isFinite(v) && v >= 60_000 ? v : 900_000; // 默认 15min，最小 1min（降频省限流额度）
  })();

  const systems = ((process.env['TAPD_SYSTEMS'] ?? 'bug,story')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s === 'bug' || s === 'story') as TapdSystem[]);

  return {
    mcpUrl,
    token,
    nick,
    workspaceIds,
    systems: systems.length ? systems : (['bug', 'story'] as TapdSystem[]),
    pollMs,
    enabled: Boolean(mcpUrl && token && nick) && !isIntegrationDisabled('tapd'),
  };
}
