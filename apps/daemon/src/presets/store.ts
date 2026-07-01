import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../logger.js';

export interface LoopRule {
  /** 哪个 stage 失败时触发 */
  on: string;
  /** 从哪个 stage 重新跑（必须早于 on，且都在 stages 里） */
  retryFrom: string;
  /** 最大重试次数；默认 2 */
  maxRetries?: number;
}

export interface Preset {
  name: string;
  description?: string;
  target?: string;           // @target 字符串（tty/title/cwd basename）
  prompt: string;            // 支持 {1} {2} {N}（位置）和 {topic} {slug}（命名）占位符
  /**
   * SOP 模式：有序 subagent_type 列表，主 claude 按序调 Task()。
   * 例：['Explore', 'requirement-analyzer', 'architect', 'coder', 'tester', 'regression-checker']
   * 留空 / 不存在 = 非 SOP 模板，走原路径
   */
  stages?: string[];
  /**
   * SOP 模式的 gate 列表，格式 `after-<stage>`。stage 必须在 stages 里。
   * 主 claude 跑完该 stage 后必须 `agent request-approval`，等批准再下一步。
   */
  gates?: string[];
  /**
   * SOP 失败回环规则：哪些 stage 失败时回到哪里重跑。
   * 比如 tester 失败回到 coder（典型 SDLC 模式）。
   */
  loops?: LoopRule[];
  /**
   * SOP artifact 落盘目录，相对 task tab 的 cwd。默认 `./docs/tasks/<task-id>/`。
   */
  artifactDir?: string;
  createdAt?: number;
  updatedAt?: number;
}

/** `--sop` flag 触发时使用的默认 stage 序列 */
export const DEFAULT_SDLC_STAGES: readonly string[] = [
  'Explore',
  'requirement-analyzer',
  'architect',
  'coder',
  'tester',
  'regression-checker',
];

/** `--sop` flag 触发时使用的默认 gate（编码前人工 review 架构） */
export const DEFAULT_SDLC_GATES: readonly string[] = ['after-architect'];

/** `--sop` flag 触发时使用的默认失败回环规则 */
export const DEFAULT_SDLC_LOOPS: readonly LoopRule[] = [
  { on: 'tester', retryFrom: 'coder', maxRetries: 2 },
  { on: 'regression-checker', retryFrom: 'coder', maxRetries: 1 },
];

/** SOP 运行时配置 — handlers 决定要不要包装 SOP prompt 用 */
export interface SopConfig {
  stages: string[];
  gates: string[];
  loops: LoopRule[];
  artifactDir?: string;
}

/**
 * 决定一次 /run 调用是否进 SOP 模式，以及用什么 stages/gates。
 * 规则（per "/run + 内容触发，没有/run 则不触发" 决策）：
 *   - preset.stages 非空 → 用 preset
 *   - flags 含 'sop' → 用 DEFAULT_SDLC_*
 *   - 两者皆有 → preset 优先（用户显式声明的 stages 比 default 更精确）
 *   - 都没有 → null（非 SOP，走原路径）
 */
export function resolveSopConfig(
  preset: Preset,
  flags: string[] = [],
): SopConfig | null {
  if (preset.stages && preset.stages.length > 0) {
    return {
      stages: [...preset.stages],
      gates: preset.gates ? [...preset.gates] : [],
      loops: preset.loops ? preset.loops.map((l) => ({ ...l })) : [],
      ...(preset.artifactDir ? { artifactDir: preset.artifactDir } : {}),
    };
  }
  if (flags.includes('sop')) {
    return {
      stages: [...DEFAULT_SDLC_STAGES],
      gates: [...DEFAULT_SDLC_GATES],
      loops: DEFAULT_SDLC_LOOPS.map((l) => ({ ...l })),
    };
  }
  return null;
}

function presetDir(): string {
  return join(homedir(), '.multiagent-chat', 'presets');
}

export async function ensurePresetDir(): Promise<string> {
  const dir = presetDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

const NAME_RE = /^[a-zA-Z0-9_-]+$/;

export function isValidName(name: string): boolean {
  return NAME_RE.test(name) && name.length <= 64;
}

export async function listPresets(): Promise<Preset[]> {
  const dir = presetDir();
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  const out: Preset[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(dir, f), 'utf8');
      const p = JSON.parse(raw) as Preset;
      out.push(p);
    } catch (e) {
      logger.warn('preset load failed', { file: f, err: (e as Error).message });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function getPreset(name: string): Promise<Preset | null> {
  const all = await listPresets();
  return all.find((p) => p.name === name) ?? null;
}

export async function savePreset(p: Preset): Promise<Preset> {
  if (!isValidName(p.name)) {
    throw new Error(`非法名字 "${p.name}"：只允许 a-z A-Z 0-9 _ -，最长 64`);
  }
  // SOP 字段校验
  if (p.stages !== undefined) {
    if (!Array.isArray(p.stages) || p.stages.some((s) => typeof s !== 'string' || s.trim() === '')) {
      throw new Error(`stages 必须是非空字符串数组`);
    }
    const dups = p.stages.filter((s, i) => p.stages!.indexOf(s) !== i);
    if (dups.length > 0) throw new Error(`stages 含重复项：${dups.join(', ')}`);
  }
  if (p.gates !== undefined) {
    if (!Array.isArray(p.gates) || p.gates.some((g) => typeof g !== 'string')) {
      throw new Error(`gates 必须是字符串数组`);
    }
    const stageSet = new Set(p.stages ?? []);
    for (const g of p.gates) {
      const m = g.match(/^after-(.+)$/);
      if (!m) throw new Error(`gate "${g}" 必须形如 "after-<stage>"`);
      if (!stageSet.has(m[1]!)) {
        throw new Error(`gate "${g}" 引用了不在 stages 里的 stage "${m[1]}"`);
      }
    }
  }
  if (p.loops !== undefined) {
    if (!Array.isArray(p.loops)) throw new Error('loops 必须是数组');
    const stageList = p.stages ?? [];
    const stageIdx = new Map(stageList.map((s, i) => [s, i] as const));
    for (const l of p.loops) {
      if (!l || typeof l !== 'object') throw new Error('loop 必须是对象');
      if (typeof l.on !== 'string' || !stageIdx.has(l.on)) {
        throw new Error(`loop.on "${l.on}" 不在 stages 里`);
      }
      if (typeof l.retryFrom !== 'string' || !stageIdx.has(l.retryFrom)) {
        throw new Error(`loop.retryFrom "${l.retryFrom}" 不在 stages 里`);
      }
      if (stageIdx.get(l.retryFrom)! >= stageIdx.get(l.on)!) {
        throw new Error(`loop.retryFrom "${l.retryFrom}" 必须早于 loop.on "${l.on}"`);
      }
      if (l.maxRetries !== undefined && (!Number.isFinite(l.maxRetries) || l.maxRetries < 1)) {
        throw new Error(`loop.maxRetries 必须是 ≥1 的整数`);
      }
    }
  }
  const dir = await ensurePresetDir();
  const file = join(dir, `${p.name}.json`);
  const existing = existsSync(file)
    ? ((JSON.parse(await readFile(file, 'utf8')) as Preset) ?? null)
    : null;
  const now = Date.now();
  const merged: Preset = {
    ...p,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(merged, null, 2), 'utf8');
  await rename(tmp, file);
  return merged;
}

export async function deletePreset(name: string): Promise<boolean> {
  // 不强制 isValidName（兼容已有中文等老 preset）；只防路径穿越
  if (!name || name.includes('/') || name.includes('..') || name.includes('\0')) {
    return false;
  }
  const file = join(presetDir(), `${name}.json`);
  if (!existsSync(file)) return false;
  await unlink(file);
  return true;
}

/**
 * 抽取 prompt 中的所有占位符（命名 {key} 或 数字 {N}），去重 + 保持顺序。
 */
export function extractPlaceholders(prompt: string): string[] {
  const re = /\{([a-zA-Z_][a-zA-Z0-9_-]*|\d+)\}/g;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    const k = m[1]!;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

/**
 * 解析 `/run name --sop k="v with space" k2=v2 positional1 positional2`。
 * 返回 { positional, named, flags }。
 * - `--flag` 进 flags（不带值的开关）
 * - `key=value` 进 named
 * - 其它进 positional
 */
export function parseRunArgs(s: string): {
  positional: string[];
  named: Record<string, string>;
  flags: string[];
} {
  const positional: string[] = [];
  const named: Record<string, string> = {};
  const flags: string[] = [];
  // --flag | key="value" | key='value' | key=value | "bare quoted" | bareword
  const re =
    /--([a-zA-Z][a-zA-Z0-9_-]*)|([a-zA-Z_][a-zA-Z0-9_-]*)=(?:"([^"]*)"|'([^']*)'|(\S+))|("([^"]*)"|'([^']*)'|\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[1] !== undefined) {
      // --flag
      if (!flags.includes(m[1])) flags.push(m[1]);
    } else if (m[2] !== undefined) {
      // key=value
      const key = m[2];
      const val = m[3] ?? m[4] ?? m[5] ?? '';
      named[key] = val;
    } else {
      // bareword
      const v = m[7] ?? m[8] ?? m[6] ?? '';
      if (v) positional.push(v);
    }
  }
  return { positional, named, flags };
}

/**
 * 把 prompt 里的 {1} {2} {N}（位置）和 {key}（命名）占位符替换。
 * - 命名优先：先匹配命名占位符，剩下的数字占位符按 positional 替换
 * - {0} = 全部 positional 拼起来
 * - 未匹配的占位符替换为空字符串
 */
export function expandPrompt(
  prompt: string,
  positional: string[],
  named: Record<string, string> = {},
): string {
  let out = prompt;
  // 命名替换
  out = out.replace(/\{([a-zA-Z_][a-zA-Z0-9_-]*)\}/g, (_full, key: string) =>
    Object.prototype.hasOwnProperty.call(named, key) ? named[key]! : '',
  );
  // 位置替换
  out = out.replace(/\{0\}/g, positional.join(' '));
  for (let i = 0; i < positional.length; i++) {
    const re = new RegExp(`\\{${i + 1}\\}`, 'g');
    out = out.replace(re, positional[i] ?? '');
  }
  // 剩下未替换的 {N} 留空
  out = out.replace(/\{\d+\}/g, '');
  return out;
}
