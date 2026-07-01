import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../logger.js';
import type { SubagentDef, WriteSubagentInput } from './types.js';

const NAME_RE = /^[a-z][a-z0-9-]*$/;

export function isValidSubagentName(name: string): boolean {
  return NAME_RE.test(name) && name.length <= 64;
}

function userAgentsDir(): string {
  return join(homedir(), '.claude', 'agents');
}

function projectAgentsDir(projectRoot: string): string {
  return join(projectRoot, '.claude', 'agents');
}

/**
 * 极简 YAML frontmatter 解析：
 *   ---
 *   name: xxx
 *   description: |
 *     multi-line
 *   tools: A, B, C
 *   ---
 *
 * 支持 key: value 单行，`key: |` 后续缩进多行块。不支持 nested map / list-of-map。
 */
function parseFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
  if (!raw.startsWith('---\n')) return { fm: {}, body: raw };
  const end = raw.indexOf('\n---\n', 4);
  if (end < 0) return { fm: {}, body: raw };
  const fmText = raw.slice(4, end);
  const body = raw.slice(end + 5).replace(/^\n+/, '');
  const fm: Record<string, string> = {};
  const lines = fmText.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1]!;
    let val = m[2]!;
    if (val === '|' || val === '>-' || val === '>') {
      // block scalar，收集缩进后续行
      const collected: string[] = [];
      i++;
      while (i < lines.length && /^(\s{2,}|\t)/.test(lines[i]!)) {
        collected.push(lines[i]!.replace(/^(\s{2}|\t)/, ''));
        i++;
      }
      fm[key] = collected.join('\n').trim();
      continue;
    }
    // 去掉可能的行尾注释和引号
    val = val.replace(/\s+#.*$/, '').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[key] = val;
    i++;
  }
  return { fm, body: body.trim() };
}

function serializeFrontmatter(input: WriteSubagentInput): string {
  const lines: string[] = ['---'];
  lines.push(`name: ${input.name}`);
  if (input.description) {
    if (input.description.includes('\n')) {
      lines.push('description: |');
      for (const l of input.description.split('\n')) lines.push('  ' + l);
    } else {
      lines.push(`description: ${input.description}`);
    }
  }
  if (input.tools && input.tools.length > 0) {
    lines.push(`tools: ${input.tools.join(', ')}`);
  }
  if (input.model) lines.push(`model: ${input.model}`);
  if (input.color) lines.push(`color: ${input.color}`);
  lines.push('---');
  return lines.join('\n');
}

function parseToolsCsv(val: string | undefined): string[] | undefined {
  if (!val) return undefined;
  return val
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function loadFromDir(
  dir: string,
  location: 'user' | 'project',
): Promise<SubagentDef[]> {
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  const out: SubagentDef[] = [];
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const path = join(dir, f);
    try {
      const raw = await readFile(path, 'utf8');
      const { fm, body } = parseFrontmatter(raw);
      const name = fm['name'] ?? f.replace(/\.md$/, '');
      if (!name) continue;
      const def: SubagentDef = { name, body, location, filePath: path };
      if (fm['description']) def.description = fm['description'];
      const tools = parseToolsCsv(fm['tools']);
      if (tools) def.tools = tools;
      if (fm['model']) def.model = fm['model'];
      if (fm['color']) def.color = fm['color'];
      out.push(def);
    } catch (e) {
      logger.warn('subagent load skip', { file: path, err: (e as Error).message });
    }
  }
  return out;
}

/**
 * List all subagents from user + project dirs (project overrides user on same name).
 */
export async function listSubagents(opts?: {
  projectRoot?: string;
}): Promise<SubagentDef[]> {
  const [userDefs, projectDefs] = await Promise.all([
    loadFromDir(userAgentsDir(), 'user'),
    opts?.projectRoot ? loadFromDir(projectAgentsDir(opts.projectRoot), 'project') : Promise.resolve([]),
  ]);
  // project 优先：同名的 project 覆盖 user
  const byName = new Map<string, SubagentDef>();
  for (const d of userDefs) byName.set(d.name, d);
  for (const d of projectDefs) byName.set(d.name, d);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSubagent(
  name: string,
  opts?: { projectRoot?: string },
): Promise<SubagentDef | null> {
  const all = await listSubagents(opts);
  return all.find((d) => d.name === name) ?? null;
}

export async function writeSubagent(
  input: WriteSubagentInput,
  opts?: { projectRoot?: string },
): Promise<SubagentDef> {
  if (!isValidSubagentName(input.name)) {
    throw new Error(`非法 subagent 名 "${input.name}"：只允许 [a-z][a-z0-9-]* 最长 64`);
  }
  const location: 'user' | 'project' = input.location ?? 'user';
  const dir =
    location === 'project'
      ? (opts?.projectRoot
          ? projectAgentsDir(opts.projectRoot)
          : (() => {
              throw new Error('写入 project subagent 需要 projectRoot');
            })())
      : userAgentsDir();
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${input.name}.md`);
  const content = serializeFrontmatter(input) + '\n\n' + input.body.trim() + '\n';
  await writeFile(filePath, content, 'utf8');
  logger.info('subagent written', { name: input.name, location, path: filePath });
  const def: SubagentDef = {
    name: input.name,
    body: input.body,
    location,
    filePath,
  };
  if (input.description) def.description = input.description;
  if (input.tools) def.tools = input.tools;
  if (input.model) def.model = input.model;
  if (input.color) def.color = input.color;
  return def;
}

export async function deleteSubagent(
  name: string,
  opts?: { projectRoot?: string },
): Promise<boolean> {
  const existing = await getSubagent(name, opts);
  if (!existing) return false;
  await rm(existing.filePath, { force: true });
  logger.info('subagent deleted', { name, path: existing.filePath });
  return true;
}
