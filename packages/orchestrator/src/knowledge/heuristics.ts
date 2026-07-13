import type { ExtractionSignal } from './types.js';

/**
 * 判断一段 chunk 是否值得跑 LLM 提取。目标：把 npm install 类噪声挡在门外，
 * 只让"用户在解决问题"的 chunk 通过。宁可多丢也不多花 LLM 钱。
 *
 * 判定条件（任一命中且 charLen ≥ 300 就通过）：
 *   - 含错误关键词（error/exception/traceback/failed/fatal/undefined/...)
 *   - 含成功指示词（fixed/works now/resolved/passing）
 *   - 含决策词（decided/pick/choose/refactor/migrate）
 *   - 含代码块（``` ```）
 *   - 长度 ≥ 1500（够长基本值得看看）
 * charLen < 300 一律 skip（太短没内容）。
 */

const ERROR_KWS = [
  'error', 'exception', 'traceback', 'failed', 'failure', 'fatal',
  'undefined', 'cannot ', 'refused', 'not found', 'permission denied',
  'timeout', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOENT', 'panic',
  'syntax error', 'unexpected', 'invalid', 'stack trace',
  '错误', '失败', '异常', '不存在', '超时',
];

const SUCCESS_KWS = [
  'fixed', 'works now', 'works!', 'resolved', 'passing', 'passed',
  'now it works', '搞定', '修好', '成功', '通过',
];

const DECISION_KWS = [
  'decided', 'let\'s go with', 'let us pick', 'choose', 'chosen',
  'refactor', 'migrate', 'switching to', 'now using',
  '决定', '选定', '重构', '换成',
];

const MIN_CHARS = 300;
const LONG_ENOUGH = 1500;

export function shouldExtract(chunk: string): ExtractionSignal {
  const reasons: string[] = [];
  const lower = chunk.toLowerCase();
  const charLen = chunk.length;

  if (charLen < MIN_CHARS) {
    return { should: false, reasons: ['too-short-' + charLen], charLen };
  }

  if (ERROR_KWS.some((k) => lower.includes(k.toLowerCase()))) reasons.push('has-error-kw');
  if (SUCCESS_KWS.some((k) => lower.includes(k.toLowerCase()))) reasons.push('has-success-kw');
  if (DECISION_KWS.some((k) => lower.includes(k.toLowerCase()))) reasons.push('has-decision-kw');
  if (/```/.test(chunk)) reasons.push('has-code-fence');
  if (charLen >= LONG_ENOUGH) reasons.push('long-enough-' + charLen);

  return {
    should: reasons.length > 0,
    reasons: reasons.length > 0 ? reasons : ['no-signal'],
    charLen,
  };
}

/**
 * 从 chunk 里粗略提命令片段（`$ xxx` 或 `> xxx` 或 `❯ xxx` 之类的 shell prompt 后面
 * 那行）。仅用于 KnowledgeSource.commandsRun 展示，不是精准。
 */
export function extractCommands(chunk: string, limit = 10): string[] {
  const lines = chunk.split('\n');
  const cmds: string[] = [];
  for (const line of lines) {
    const m = /^\s*[$>❯#]\s+(.{2,200})$/.exec(line);
    if (m && m[1]) {
      cmds.push(m[1].trim());
      if (cmds.length >= limit) break;
    }
  }
  return cmds;
}

/**
 * 从 chunk 里 grep 出文件路径（很粗糙的启发式）。
 */
export function extractFilePaths(chunk: string, limit = 10): string[] {
  const set = new Set<string>();
  // 匹配 ./xxx, ~/xxx, /Users/..., src/... 等
  const re = /(?:^|\s|['"`])((?:\.\.?\/|~\/|\/[A-Za-z][^\s'"`]{2,120}|(?:src|apps|packages|docs|tests?|scripts?)\/[^\s'"`]{2,120}))(?=[\s'"`]|$)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    if (m[1]) set.add(m[1]);
    if (set.size >= limit) break;
  }
  return [...set];
}
