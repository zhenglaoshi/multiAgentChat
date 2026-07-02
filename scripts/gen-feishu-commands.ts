#!/usr/bin/env tsx
/**
 * gen-feishu-commands
 *
 * 从 scripts/feishu-command-manifest.ts 生成飞书斜杠命令清单。
 * 用途：飞书开放平台 → 应用 → 机器人 → 配置指令 对着输出手动加。
 *
 * Usage:
 *   pnpm gen:feishu-commands                   # md 表格 → stdout
 *   pnpm gen:feishu-commands --format json     # JSON → stdout
 *   pnpm gen:feishu-commands --format csv      # CSV → stdout
 *   pnpm gen:feishu-commands --format md-full  # 分组 md（含详细段）
 *   pnpm gen:feishu-commands --include-hidden  # 也输出 hidden 命令
 *   pnpm gen:feishu-commands --out out.md      # 写文件
 *   pnpm gen:feishu-commands --verify          # 只校验，不输出
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { COMMAND_MANIFEST, GROUP_LABELS, type CommandMeta, type CommandGroup } from './feishu-command-manifest.js';

// ── args ──────────────────────────────────────────
type Format = 'md' | 'md-full' | 'json' | 'csv';

interface Args {
  format: Format;
  includeHidden: boolean;
  out?: string;
  verify: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { format: 'md', includeHidden: false, verify: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--format') {
      const next = argv[++i];
      if (next !== 'md' && next !== 'md-full' && next !== 'json' && next !== 'csv') {
        die(`--format 只能是 md / md-full / json / csv，收到：${next}`);
      }
      a.format = next;
    } else if (v === '--include-hidden') {
      a.includeHidden = true;
    } else if (v === '--out') {
      a.out = argv[++i];
    } else if (v === '--verify') {
      a.verify = true;
    } else if (v === '-h' || v === '--help') {
      printHelp();
      process.exit(0);
    } else if (v !== undefined) {
      die(`未知参数：${v}`);
    }
  }
  return a;
}

function printHelp(): void {
  console.log(`gen-feishu-commands — 生成飞书斜杠命令清单

用法：
  --format md         默认，紧凑 markdown 表格（copy-paste 用）
  --format md-full    分组 markdown，含 note / alias 详情
  --format json       结构化 JSON（未来若飞书出 API）
  --format csv        CSV
  --include-hidden    输出 hidden 命令（默认不输出）
  --out <path>        写到文件（默认 stdout）
  --verify            只做校验（描述长度、name 合法、alias 冲突）
  -h / --help         本帮助
`);
}

function die(msg: string): never {
  console.error(`错：${msg}`);
  process.exit(1);
}

// ── validation ─────────────────────────────────────
const NAME_RE = /^[a-z][a-z0-9-]*$|^\?$/;
const MAX_DESC_LEN = 50;   // 飞书后台限制

interface ValidationIssue {
  cmd: string;
  level: 'error' | 'warn';
  msg: string;
}

function validate(manifest: CommandMeta[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenNames = new Map<string, string>();      // name → owning cmd

  for (const c of manifest) {
    // name
    if (!NAME_RE.test(c.name)) {
      issues.push({ cmd: c.name, level: 'error', msg: `name "${c.name}" 不合法（只允许小写字母/数字/短横线）` });
    }
    if (seenNames.has(c.name)) {
      issues.push({ cmd: c.name, level: 'error', msg: `name "${c.name}" 重复，也被 ${seenNames.get(c.name)} 用` });
    }
    seenNames.set(c.name, c.name);

    // aliases
    for (const alias of c.aliases ?? []) {
      if (!NAME_RE.test(alias)) {
        issues.push({ cmd: c.name, level: 'error', msg: `alias "${alias}" 不合法` });
      }
      if (seenNames.has(alias)) {
        issues.push({ cmd: c.name, level: 'error', msg: `alias "${alias}" 与 ${seenNames.get(alias)} 的 name 冲突` });
      }
      seenNames.set(alias, c.name);
    }

    // description
    const len = [...c.description].length;
    if (len > MAX_DESC_LEN) {
      issues.push({ cmd: c.name, level: 'error', msg: `描述 ${len} 字（> ${MAX_DESC_LEN}）：${c.description}` });
    }
    if (!c.description.trim()) {
      issues.push({ cmd: c.name, level: 'error', msg: '描述为空' });
    }

    // example
    if (!c.example.trim()) {
      issues.push({ cmd: c.name, level: 'warn', msg: '缺 example' });
    }
  }
  return issues;
}

// ── drift check ────────────────────────────────────
/**
 * 扫 commands.ts 里两处命令定义，与 manifest 对比：
 *   1. `if (name === 'xxx' || name === 'yy')` — canonical handlers
 *   2. `const ALIAS: Record<...> = { d: 'dashboard', ... }` — alias map（键 = 别名，值 = canonical）
 */
function checkDrift(manifest: CommandMeta[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const here = dirname(fileURLToPath(import.meta.url));
  const src = join(here, '..', 'packages', 'im-lark', 'src', 'lark', 'commands.ts');
  let content: string;
  try {
    content = readFileSync(src, 'utf-8');
  } catch {
    issues.push({ cmd: '(drift)', level: 'warn', msg: `读不到 commands.ts (${src})，跳过 drift 检查` });
    return issues;
  }

  // (1) canonical names from `if (name === 'xxx')`
  const canonicals = new Set<string>();
  const canonRe = /name === '([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = canonRe.exec(content)) !== null) canonicals.add(m[1]!);

  // (2) alias map: 抓 `const ALIAS: Record<string, string> = { ... };` 内的 `key: 'value'`
  const aliasMap = new Map<string, string>();
  const aliasBlockRe = /const ALIAS[^{]*\{([\s\S]*?)\};/;
  const block = aliasBlockRe.exec(content)?.[1];
  if (block) {
    const entryRe = /['"]?([a-z?_-][a-z0-9?_-]*)['"]?\s*:\s*['"]([^'"]+)['"]/gi;
    let e: RegExpExecArray | null;
    while ((e = entryRe.exec(block)) !== null) aliasMap.set(e[1]!, e[2]!);
  } else {
    issues.push({ cmd: '(drift)', level: 'warn', msg: '没在 commands.ts 找到 ALIAS map（可能被重构了）' });
  }

  // ── build source truth
  const inSource = new Set<string>([...canonicals, ...aliasMap.keys()]);

  // manifest flat set
  const canonicalInManifest = new Set<string>();
  const aliasesInManifest = new Set<string>();
  const canonicalOwner = new Map<string, string>(); // alias → canonical it points to
  for (const c of manifest) {
    canonicalInManifest.add(c.name);
    for (const a of c.aliases ?? []) {
      aliasesInManifest.add(a);
      canonicalOwner.set(a, c.name);
    }
  }
  const allInManifest = new Set<string>([...canonicalInManifest, ...aliasesInManifest]);

  // canonicals in source but not in manifest.name
  for (const c of canonicals) {
    if (!canonicalInManifest.has(c)) {
      // 也许被 manifest 挂成 alias 了？那不算错
      if (aliasesInManifest.has(c)) continue;
      issues.push({ cmd: c, level: 'warn', msg: `commands.ts 有 canonical "${c}" 但 manifest 里既非 name 也非 alias` });
    }
  }
  // aliases in source but not in manifest
  for (const [alias, canonical] of aliasMap) {
    if (!allInManifest.has(alias)) {
      issues.push({ cmd: alias, level: 'warn', msg: `commands.ts ALIAS 有 "${alias}" → "${canonical}"，但 manifest 里没有` });
      continue;
    }
    // if in manifest as alias, check it points to same canonical
    const mfCanon = canonicalOwner.get(alias);
    if (mfCanon !== undefined && mfCanon !== canonical) {
      issues.push({
        cmd: alias,
        level: 'warn',
        msg: `alias "${alias}"：manifest 说指向 "${mfCanon}"，但 ALIAS 里指向 "${canonical}"`,
      });
    }
  }
  // manifest has stuff source doesn't
  for (const m of allInManifest) {
    if (!inSource.has(m)) {
      issues.push({ cmd: m, level: 'warn', msg: `manifest 有 "${m}" 但 commands.ts 里既没 name === '${m}' 也没 ALIAS['${m}']` });
    }
  }
  return issues;
}

// ── formatters ─────────────────────────────────────
function fmtMd(list: CommandMeta[]): string {
  const rows: string[] = [];
  rows.push('| # | 指令名称 | 指令描述 | 示例 | 隐藏 |');
  rows.push('|---|---|---|---|---|');
  list.forEach((c, i) => {
    rows.push(`| ${i + 1} | ${c.name} | ${c.description} | ${c.example} | ${c.hidden ? '是' : '否'} |`);
  });
  return rows.join('\n');
}

function fmtMdFull(list: CommandMeta[]): string {
  const out: string[] = [];
  out.push('# 飞书斜杠命令清单');
  out.push('');
  out.push('_由 `pnpm gen:feishu-commands --format md-full` 自动生成，请勿手改_');
  out.push('');

  // group order
  const groupOrder: CommandGroup[] = ['nav', 'dispatch', 'sop', 'subagent', 'query', 'other'];
  for (const g of groupOrder) {
    const items = list.filter((c) => c.group === g);
    if (items.length === 0) continue;
    out.push(`## ${GROUP_LABELS[g]} (${items.length})`);
    out.push('');
    for (const c of items) {
      const aliasStr = c.aliases && c.aliases.length > 0 ? ` (alias: ${c.aliases.map((a) => '`/' + a + '`').join(', ')})` : '';
      out.push(`### \`/${c.name}\`${aliasStr}`);
      out.push(`- **描述**：${c.description}`);
      out.push(`- **示例**：\`${c.example}\``);
      if (c.hidden) out.push(`- **隐藏**：是`);
      if (c.note) out.push(`- **备注**：${c.note}`);
      out.push('');
    }
  }
  return out.join('\n');
}

function fmtJson(list: CommandMeta[]): string {
  return JSON.stringify(list, null, 2);
}

function fmtCsv(list: CommandMeta[]): string {
  const esc = (s: string) => (s.includes(',') || s.includes('"') ? `"${s.replaceAll('"', '""')}"` : s);
  const rows = [['name', 'aliases', 'description', 'example', 'group', 'hidden'].join(',')];
  for (const c of list) {
    rows.push([
      esc(c.name),
      esc((c.aliases ?? []).join('|')),
      esc(c.description),
      esc(c.example),
      esc(c.group),
      c.hidden ? 'true' : 'false',
    ].join(','));
  }
  return rows.join('\n');
}

// ── main ──────────────────────────────────────────
function main(): void {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  // validate always
  const vIssues = validate(COMMAND_MANIFEST);
  const dIssues = checkDrift(COMMAND_MANIFEST);
  const allIssues = [...vIssues, ...dIssues];
  const errors = allIssues.filter((i) => i.level === 'error');
  const warns = allIssues.filter((i) => i.level === 'warn');

  if (allIssues.length > 0) {
    console.error(`\n═══ 校验报告 ═══`);
    for (const i of allIssues) {
      const badge = i.level === 'error' ? '❌' : '⚠️';
      console.error(`${badge} [${i.cmd}] ${i.msg}`);
    }
    console.error(`\n共 ${errors.length} error / ${warns.length} warn\n`);
  }

  if (errors.length > 0) {
    console.error('❌ 有 error，退出（先修 error 再生成）');
    process.exit(2);
  }

  if (args.verify) {
    if (warns.length > 0) process.exit(1);
    console.log('✅ 校验通过');
    return;
  }

  const list = COMMAND_MANIFEST.filter((c) => args.includeHidden || !c.hidden);

  let output: string;
  switch (args.format) {
    case 'md':      output = fmtMd(list); break;
    case 'md-full': output = fmtMdFull(list); break;
    case 'json':    output = fmtJson(list); break;
    case 'csv':     output = fmtCsv(list); break;
  }

  if (args.out) {
    let content = output;
    // 写文件时给 markdown 加个"自动生成"banner
    if (args.format === 'md') {
      content =
        '<!-- 自动生成：pnpm gen:feishu-commands --format md --out ' + args.out + ' -->\n' +
        '<!-- 请勿手改；改 scripts/feishu-command-manifest.ts -->\n\n' +
        output;
    }
    writeFileSync(args.out, content + '\n', 'utf-8');
    console.error(`✅ 已写到 ${args.out}（${list.length} 条命令）`);
  } else {
    process.stdout.write(output + '\n');
  }
}

try {
  main();
} catch (e) {
  console.error('未捕获错：', e);
  process.exit(1);
}
