import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logger.js';
import type { TapdConfig } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * 幂等把 TAPD MCP 注册到 Claude Code（user scope，所有会话可用）——这样认领 bug 开的
 * 工作 tab 里的 claude 就有 mcp__tapd__* 工具，能读详情/改状态/加评论。
 *
 * 已存在则跳过（不重写 ~/.claude.json）；缺失才 `claude mcp add`。token 若轮换，手动
 * `claude mcp remove tapd -s user` 后重启即可重注册。best-effort，失败只 warn。
 */
export async function ensureTapdMcp(cfg: TapdConfig): Promise<void> {
  if (!cfg.enabled) return;
  try {
    await execFileAsync('claude', ['mcp', 'get', 'tapd'], { timeout: 15_000 });
    logger.info('tapd MCP 已注册（claude user scope）');
    return;
  } catch {
    /* 不存在 → 注册 */
  }
  try {
    await execFileAsync(
      'claude',
      [
        'mcp', 'add', '--transport', 'http', 'tapd', cfg.mcpUrl,
        '--header', `Authorization: Bearer ${cfg.token}`,
        '--scope', 'user',
      ],
      { timeout: 20_000 },
    );
    logger.info('tapd MCP 注册成功（claude user scope，所有会话可用 mcp__tapd__*）');
  } catch (e) {
    logger.warn('tapd MCP 注册失败（手动跑 claude mcp add --transport http tapd <url> --header ... -s user）', {
      err: (e as Error).message,
    });
  }
}
