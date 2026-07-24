/**
 * 权限审批细分等级（自治档位）—— 决定"高危拦到哪一层"。
 *
 * 命令按风险分四档 tier：catastrophic(致命) > high(高危) > medium(中危) > none。
 * 用户选的 LEVEL(0-4) 决定拦哪些 tier：
 *   L0 全自动   → 不拦任何（等于关审批，慎用）
 *   L1 仅致命   → 只拦 catastrophic（默认）
 *   L2 标准     → 拦 catastrophic + high（原来的行为）
 *   L3 严格     → 拦 catastrophic + high + medium
 *   L4 偏执     → 每条 Bash 都拦（含 none）
 *
 * tier 判定复用 high-risk 的 stripDataLiterals/EXEC_STRING_RE + isHighRiskCommand，
 * 避免引号/heredoc 里的危险文本误判（同 high-risk 的防误报）。
 */
import { isHighRiskCommand, stripDataLiterals, EXEC_STRING_RE } from './high-risk.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { logger } from '../logger.js';

export type RiskTier = 'catastrophic' | 'high' | 'medium' | 'none';

const STATE_FILE = resolve('./data/guard/perm-level.json');

/** 致命/不可逆：递归删根或家目录、格式化、写裸设备、fork bomb、删库。 */
const CATASTROPHIC_RE =
  /\brm\s+-[a-z]*[rf][a-z]*\s+(?:-\S+\s+)*[~/](?:\s|$)|\bmkfs\b|\bdiskutil\s+(?:erase|reformat)\b|\bdd\b[^\n]*\bof=\/dev\/[a-z]|:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:|\bDROP\s+DATABASE\b/i;

/** 中危：任何 git push、任何 rm、包发布、kill、chmod、删分支、强制切分支。 */
const MEDIUM_RE =
  /\bgit\s+push\b|\brm\s+\S|\b(?:npm|pnpm|yarn)\s+publish\b|\bkill\s+-?\d|\bchmod\s|\bgit\s+branch\s+-D\b|\bgit\s+checkout\s+-\w*f/i;

function matchAny(cmd: string, re: RegExp): boolean {
  const view = stripDataLiterals(cmd);
  const targets = EXEC_STRING_RE.test(view) ? [view, cmd] : [view];
  return targets.some((t) => re.test(t));
}

/** 命令风险分档。 */
export function riskTier(cmd: string): RiskTier {
  if (!cmd || !cmd.trim()) return 'none';
  const high = isHighRiskCommand(cmd);
  if (high.risky) {
    return matchAny(cmd, CATASTROPHIC_RE) ? 'catastrophic' : 'high';
  }
  if (matchAny(cmd, MEDIUM_RE)) return 'medium';
  return 'none';
}

const TIER_RANK: Record<RiskTier, number> = { none: 0, medium: 1, high: 2, catastrophic: 3 };

export const PERM_LEVEL_LABELS: Record<number, string> = {
  0: '全自动（不拦任何，慎用）',
  1: '仅致命（只拦递归删根/格式化/写裸设备/删库/fork bomb）',
  2: '标准（拦全部高危）',
  3: '严格（高危 + 中危：任何 push/rm/publish/kill/chmod）',
  4: '偏执（每条命令都问）',
};

/** 某 tier 在某 level 下是否需要审批。 */
export function tierGatedAtLevel(tier: RiskTier, level: number): boolean {
  if (level <= 0) return false;
  if (level >= 4) return true; // 偏执：全拦
  const minRankGated = level === 1 ? 3 : level === 2 ? 2 : 1; // L1→仅catastrophic, L2→high+, L3→medium+
  return TIER_RANK[tier] >= minRankGated;
}

/** 综合：这条命令在当前等级下要不要拦 + 它的 tier。 */
export function shouldGate(cmd: string, level: number): { gate: boolean; tier: RiskTier } {
  const tier = riskTier(cmd);
  return { gate: tierGatedAtLevel(tier, level), tier };
}

function clampLevel(n: number): number {
  return Number.isInteger(n) && n >= 0 && n <= 4 ? n : 1;
}

/** 当前等级：运行时覆盖(perm-level.json) > env PERM_LEVEL > 默认 L1。 */
export function getPermLevel(): number {
  try {
    if (existsSync(STATE_FILE)) {
      const j = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { level?: number };
      if (typeof j.level === 'number') return clampLevel(j.level);
    }
  } catch {
    /* ignore */
  }
  const env = Number(process.env['PERM_LEVEL']);
  return Number.isFinite(env) ? clampLevel(env) : 1;
}

/** 设置运行时等级(持久化，随时生效，不用重启)。 */
export function setPermLevel(n: number): number {
  const level = clampLevel(n);
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({ level }) + '\n', 'utf8');
  } catch (e) {
    logger.warn('perm-level 持久化失败', { err: (e as Error).message });
  }
  return level;
}
