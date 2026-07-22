/**
 * 静态文件脱敏（at-rest）—— 扫 claude / codex 的会话历史文件，就地把明文凭证脱成
 * [REDACTED-X]。用与回显脱敏同一套 redact() 引擎（单一事实源）。
 *
 * 覆盖 .jsonl 文本会话（claude projects/history、codex sessions/history）。
 * **不碰**：
 *   - `~/.codex/auth.json` —— 那是凭证存储本身，脱了会破坏登录（只在报告里点名提醒）。
 *   - codex 的 sqlite 库（logs_2/memories_1）—— 需 sqlite 读写，v1 暂不覆盖（报告里标注）。
 *
 * 安全默认：
 *   - dry-run（apply=false）只报告不改。
 *   - skipRecentMin（默认 60）跳过最近改动的文件，**绝不损坏正在进行的会话**。
 *   - 默认**不留 .bak**（.bak 会含明文，违背脱敏初衷）。
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile, readdir, stat, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redact } from './redactor.js';

export interface ScrubRoot {
  label: string;
  /** 绝对路径：单文件 或 目录（目录则递归找 *.jsonl） */
  path: string;
  kind: 'file' | 'dir-jsonl';
}

export interface ScrubOptions {
  /** true = 就地写回；false（默认）= 只报告 */
  apply?: boolean;
  /** 跳过最近 N 分钟内改过的文件（默认 60，0 = 不跳过）。保护活跃会话。 */
  skipRecentMin?: number;
  /** 自定义扫描根（默认 claude + codex） */
  roots?: ScrubRoot[];
  /** apply 时是否留 .bak（默认 false —— .bak 含明文，不留） */
  backup?: boolean;
}

export interface ScrubFileResult {
  path: string;
  hits: Record<string, number>;
}

export interface ScrubReport {
  scanned: number;
  skipped: number;
  dirtyFiles: number;
  applied: boolean;
  totalHits: Record<string, number>;
  files: ScrubFileResult[];
  /** 已知未覆盖但可能含密文的目标（提醒用户手动处理） */
  notes: string[];
}

/** claude + codex 默认扫描根。只列存在的。 */
export function defaultRoots(home = homedir()): ScrubRoot[] {
  const candidates: ScrubRoot[] = [
    { label: 'claude/projects', path: join(home, '.claude', 'projects'), kind: 'dir-jsonl' },
    { label: 'claude/history', path: join(home, '.claude', 'history.jsonl'), kind: 'file' },
    { label: 'claude/backups', path: join(home, '.claude', 'backups'), kind: 'dir-jsonl' },
    { label: 'codex/sessions', path: join(home, '.codex', 'sessions'), kind: 'dir-jsonl' },
    { label: 'codex/history', path: join(home, '.codex', 'history.jsonl'), kind: 'file' },
  ];
  return candidates.filter((r) => existsSync(r.path));
}

/** 已知含密文但本工具不动的目标 —— 报告里提醒。 */
export function untouchedNotes(home = homedir()): string[] {
  const notes: string[] = [];
  if (existsSync(join(home, '.codex', 'auth.json'))) {
    notes.push('~/.codex/auth.json 是 codex 凭证存储本身（不脱，脱了会掉登录）——确认权限为 600 即可');
  }
  for (const db of ['logs_2.sqlite', 'memories_1.sqlite']) {
    if (existsSync(join(home, '.codex', db))) {
      notes.push(`~/.codex/${db} 是 sqlite 库（v1 未覆盖）——如含敏感调试数据，考虑清理或缩短保留`);
    }
  }
  return notes;
}

async function collectFiles(root: ScrubRoot): Promise<string[]> {
  if (root.kind === 'file') return existsSync(root.path) ? [root.path] : [];
  if (!existsSync(root.path)) return [];
  try {
    const entries = await readdir(root.path, { recursive: true, withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      // node20+ Dirent.parentPath / 兼容旧 path
      const parent = (e as { parentPath?: string; path?: string }).parentPath ??
        (e as { path?: string }).path ?? root.path;
      out.push(join(parent, e.name));
    }
    return out;
  } catch {
    return [];
  }
}

function bumpInto(target: Record<string, number>, k: string, n: number): void {
  target[k] = (target[k] ?? 0) + n;
}

/**
 * 扫描/脱敏。返回报告。apply=false 时不改任何文件。
 * 逐行 redact（保持 jsonl 每行独立合法），只有产生命中的文件才在 apply 时写回。
 */
export async function scrubSecrets(opts: ScrubOptions = {}): Promise<ScrubReport> {
  const apply = opts.apply === true;
  const skipRecentMin = opts.skipRecentMin ?? 60;
  const backup = opts.backup === true;
  const roots = opts.roots ?? defaultRoots();
  const home = homedir();
  const nowMs = Date.now();

  const report: ScrubReport = {
    scanned: 0,
    skipped: 0,
    dirtyFiles: 0,
    applied: apply,
    totalHits: {},
    files: [],
    notes: untouchedNotes(home),
  };

  const seen = new Set<string>();
  for (const root of roots) {
    const files = await collectFiles(root);
    for (const f of files) {
      if (seen.has(f)) continue;
      seen.add(f);
      report.scanned++;
      try {
        if (skipRecentMin > 0) {
          const st = await stat(f);
          if (nowMs - st.mtimeMs < skipRecentMin * 60_000) {
            report.skipped++;
            continue;
          }
        }
        const raw = await readFile(f, 'utf8');
        const lines = raw.split('\n');
        const fileHits: Record<string, number> = {};
        let dirty = false;
        const out = lines.map((line) => {
          if (!line) return line;
          const r = redact(line);
          if (r.redactedCount > 0) {
            dirty = true;
            for (const h of r.hits) {
              bumpInto(fileHits, h.kind, h.count);
              bumpInto(report.totalHits, h.kind, h.count);
            }
            return r.clean;
          }
          return line;
        });
        if (dirty) {
          report.dirtyFiles++;
          report.files.push({ path: f.replace(home, '~'), hits: fileHits });
          if (apply) {
            if (backup) await copyFile(f, f + '.bak');
            await writeFile(f, out.join('\n'), 'utf8');
          }
        }
      } catch {
        /* 单文件读/写失败 → 跳过，不影响整体 */
      }
    }
  }
  return report;
}

/** 报告转成一行摘要（给 CLI / 飞书用）。 */
export function summarizeScrub(r: ScrubReport): string {
  const kinds = Object.entries(r.totalHits)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(', ');
  const head = `${r.applied ? '已脱敏' : '扫描'}：${r.scanned} 文件，${r.dirtyFiles} 含密文，${r.skipped} 跳过(近期活跃)`;
  return kinds ? `${head}\n命中：${kinds}` : `${head}\n未发现明文凭证 ✓`;
}
