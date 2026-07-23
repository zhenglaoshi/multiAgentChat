/**
 * Dogfood 自审 —— 让项目定期用 `claude -p` 审自己，产结构化"发现清单"。v1：只报告、不改仓库。
 *
 * 安全设计：**单轮、数据喂进 prompt**（不给工具、不让它读全码/写文件），复用知识提炼那套
 * （`claude -p <prompt> --max-turns 1` → JSON）。Node 侧先采集高信号输入：
 *   - CHANGELOG 的 [未发布] 段（近期改了啥）
 *   - `git log --oneline -30`（近期提交）
 *   - daemon.err.log 尾部（反复报错）
 *   - TODO/FIXME grep（散落待办）
 *   - docs/ 清单 + mtime（判文档是否跟得上）
 * 让 claude 对照 CHANGELOG↔docs 找 drift、从 err 日志找反复报错、列 TODO、提改进。
 * 深读全码验 drift 是 phase 2（需开工具/多轮，风险更高）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../logger.js';

export interface AuditFinding {
  severity: 'high' | 'medium' | 'low';
  category: string;
  title: string;
  detail?: string;
}

export interface AuditResult {
  ok: boolean;
  findings: AuditFinding[];
  error?: string;
  inputChars: number;
}

const MAX_SECTION = 6000;

function readTop(file: string, max = MAX_SECTION): string {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8').slice(0, max) : '';
  } catch {
    return '';
  }
}

/** CHANGELOG 的 [未发布] 段（到下一个 `## ` 版本标题为止）。 */
function unreleasedSection(root: string): string {
  const raw = readTop(join(root, 'CHANGELOG.md'), 20000);
  const start = raw.indexOf('## [未发布]');
  if (start < 0) return raw.slice(0, MAX_SECTION);
  const rest = raw.slice(start + 1);
  const next = rest.indexOf('\n## ');
  return (next < 0 ? rest : rest.slice(0, next)).slice(0, MAX_SECTION);
}

function sh(cmd: string, args: string[], cwd: string, timeout = 15_000): string {
  try {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout });
    return (r.stdout ?? '').slice(0, MAX_SECTION);
  } catch {
    return '';
  }
}

function docsInventory(root: string): string {
  const dir = join(root, 'docs');
  if (!existsSync(dir)) return '(无 docs/)';
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const st = statSync(join(dir, f));
        const days = Math.floor((Date.now() - st.mtimeMs) / 86_400_000);
        return `${f} (改于 ${days} 天前)`;
      })
      .join('\n');
  } catch {
    return '(读 docs/ 失败)';
  }
}

/** 采集自审输入（Node 侧，只读）。 */
export function gatherAuditInputs(root = process.cwd()): string {
  const errLog = join(homedir(), '.multiagent-chat', 'logs', 'daemon.err.log');
  const errTail = (() => {
    const raw = readTop(errLog, 20000);
    return raw.split('\n').slice(-60).join('\n').slice(0, MAX_SECTION);
  })();
  const todos = sh(
    'grep',
    ['-rn', '-E', 'TODO|FIXME|待做|待办', 'packages', 'apps', '--include=*.ts'],
    root,
  )
    .split('\n')
    .slice(0, 40)
    .join('\n');

  return [
    '=== CHANGELOG [未发布] ===',
    unreleasedSection(root) || '(空)',
    '',
    '=== git log --oneline -30 ===',
    sh('git', ['log', '--oneline', '-30'], root) || '(空)',
    '',
    '=== daemon.err.log 尾部 60 行 ===',
    errTail || '(无 / 空)',
    '',
    '=== docs/ 清单 + 最后修改 ===',
    docsInventory(root),
    '',
    '=== TODO/FIXME/待办 (前 40 条) ===',
    todos || '(无)',
  ].join('\n');
}

function buildPrompt(inputs: string): string {
  return [
    '你在给「multiAgentChat」项目做自审（dogfood self-audit）。下面是采集到的项目现状。',
    '请找出值得处理的问题，重点：',
    '1. CHANGELOG 近期声称的改动 vs docs/ 是否跟上（新命令/功能有没有文档；哪些 docs 很久没改但 CHANGELOG 有相关改动 → 可能过期）',
    '2. daemon.err.log 里反复出现的报错/警告（给出错误特征 + 可能原因）',
    '3. 散落的 TODO/FIXME/待办里重要的',
    '4. 其它明显的改进点',
    '',
    '**只输出一个 JSON 数组**，每项 {"severity":"high|medium|low","category":"drift|error|todo|improve","title":"一句话","detail":"简短说明/建议"}。',
    '最多 10 条，按重要性降序。别输出数组以外的任何文字。',
    '',
    '=== 项目现状 ===',
    inputs,
  ].join('\n');
}

/** 从 claude -p stdout 里提第一个 JSON 数组。 */
export function extractJsonArray(text: string): unknown[] | null {
  const start = text.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) {
        try {
          const arr = JSON.parse(text.slice(start, i + 1));
          return Array.isArray(arr) ? arr : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function coerceFindings(arr: unknown[]): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const title = typeof o['title'] === 'string' ? o['title'] : '';
    if (!title) continue;
    const sev = o['severity'];
    out.push({
      severity: sev === 'high' || sev === 'low' ? sev : 'medium',
      category: typeof o['category'] === 'string' ? o['category'] : 'improve',
      title: title.slice(0, 120),
      ...(typeof o['detail'] === 'string' ? { detail: o['detail'].slice(0, 400) } : {}),
    });
  }
  return out;
}

/** 跑一次自审。**异步** spawn `claude -p` 单轮(不阻塞 daemon 事件循环)，超时 180s。 */
export async function runSelfAudit(root = process.cwd()): Promise<AuditResult> {
  const inputs = gatherAuditInputs(root);
  const prompt = buildPrompt(inputs);
  return await new Promise<AuditResult>((resolve) => {
    let out = '';
    let done = false;
    const finish = (r: AuditResult) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    try {
      const proc = spawn('claude', ['-p', prompt, '--max-turns', '1'], {
        env: { ...process.env, MCHAT_INTERNAL_SESSION: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        finish({ ok: false, findings: [], error: 'claude -p 超时(180s)', inputChars: inputs.length });
      }, 180_000);
      timer.unref?.();
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (c) => {
        out += c;
        if (out.length > 8 * 1024 * 1024) out = out.slice(-4 * 1024 * 1024);
      });
      proc.on('error', (e) => {
        clearTimeout(timer);
        finish({ ok: false, findings: [], error: e.message, inputChars: inputs.length });
      });
      proc.on('close', () => {
        clearTimeout(timer);
        const arr = extractJsonArray(out);
        if (!arr) {
          finish({ ok: false, findings: [], error: '未能从输出解析 JSON 数组', inputChars: inputs.length });
          return;
        }
        const findings = coerceFindings(arr);
        logger.info('self-audit done', { findings: findings.length });
        finish({ ok: true, findings, inputChars: inputs.length });
      });
    } catch (e) {
      finish({ ok: false, findings: [], error: (e as Error).message, inputChars: inputs.length });
    }
  });
}
