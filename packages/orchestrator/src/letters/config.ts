import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isIntegrationDisabled } from '../integrations/envfile.js';
import type { LettersConfig } from './types.js';

/** CareyClaw 开发者令牌的默认位置（careyclaw skill 系列写在这）。 */
const TOKEN_FILE = join(homedir(), '.careyclaw', 'token-prod');
const DEFAULT_MCP_URL = 'https://bot.ihealthcn.com/mcp';
/** 轮询下限：公函是人写的，比这更密没意义，只会白打平台。 */
const MIN_POLL_MS = 60_000;
const DEFAULT_POLL_MS = 120_000;

/**
 * 读开发者令牌：优先 env（便于容器/临时覆盖），否则读 `~/.careyclaw/token-prod`。
 * 读不到不是异常——没配过 careyclaw 的机器就该静默不启用。
 */
export function readCareyclawToken(): string {
  const fromEnv = (process.env['CAREYCLAW_TOKEN'] ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 公函监听配置。没令牌 → enabled=false（daemon 不启监听）。
 *
 * 默认**开启**（与 TAPD 等需要显式配 URL/密钥的对接不同）：令牌本来就躺在
 * `~/.careyclaw/token-prod`，装过 careyclaw skill 的机器天然具备条件，
 * 不该再要求额外配一遍。不想要就 `/connect` 停用，或 `LETTERS_ENABLED=0`。
 */
export function loadLettersConfig(): LettersConfig {
  const token = readCareyclawToken();
  const pollMs = (() => {
    const v = Number(process.env['LETTERS_POLL_MS']);
    return Number.isFinite(v) && v >= MIN_POLL_MS ? v : DEFAULT_POLL_MS;
  })();
  const explicitOff = process.env['LETTERS_ENABLED'] === '0';
  return {
    mcpUrl: (process.env['LETTERS_MCP_URL'] ?? '').trim() || DEFAULT_MCP_URL,
    token,
    pollMs,
    workRoot: (process.env['LETTERS_WORK_ROOT'] ?? '').trim() || join(homedir(), 'ihealth-work'),
    enabled: Boolean(token) && !explicitOff && !isIntegrationDisabled('letters'),
  };
}
