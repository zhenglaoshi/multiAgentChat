import { readFile, writeFile, rename, mkdir, stat, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { logger } from '../logger.js';
import type { Integration } from './registry.js';

/**
 * claudeMd 型对接：对接=往用户全局 `~/.claude/CLAUDE.md` 写一段带 sentinel 标记的规则块
 * （覆盖任意项目的每个 claude session）；断开=按 sentinel 把该块整段删掉。
 * 与 env 型「停用」不同——这是真删除，不进 .env 停用列表，也不触发 daemon 重启。
 *
 * 文本变换（sentinel 定位/拼接/剥离）抽成纯函数导出，便于单测；I/O 函数带可选 path 便于测试。
 */
export function claudeMdPath(): string {
  return join(homedir(), '.claude', 'CLAUDE.md');
}

/** 某 claudeMd 型对接的 sentinel 标记（按 key 派生，用于幂等定位/删除）。 */
export function claudeMdSentinels(key: string): { start: string; end: string } {
  return { start: `<!-- mchat:${key}:start -->`, end: `<!-- mchat:${key}:end -->` };
}

/** 文本里是否已含某 key 的规则块（只看 start sentinel）。 */
export function hasClaudeMdBlock(text: string, key: string): boolean {
  return text.includes(claudeMdSentinels(key).start);
}

/** 剥掉一处（首个）完整 sentinel 块（含标记本身与紧邻空行）。找不到/残缺则原样返回。 */
function stripOnce(text: string, key: string): string {
  const { start, end } = claudeMdSentinels(key);
  const s = text.indexOf(start);
  if (s < 0) return text;
  const e = text.indexOf(end, s);
  if (e < 0) return text; // 只有 start 没 end：结构异常，不动以免误删用户内容
  let from = s;
  let to = e + end.length;
  while (from > 0 && text[from - 1] === '\n') from--;   // 吃掉块前多余空行
  while (to < text.length && text[to] === '\n') to++;    // 吃掉块后多余空行
  const before = text.slice(0, from);
  const after = text.slice(to);
  if (before && after) return `${before}\n\n${after}`;
  return before + after;
}

/** 剥掉某 key 的**所有**完整 sentinel 块（历史遗留多份也一并清掉）。残缺块保留。 */
export function stripClaudeMdBlock(text: string, key: string): string {
  let out = text;
  for (;;) {
    const next = stripOnce(out, key);
    if (next === out) return out; // 无更多可剥（含"只有 start 没 end"的残缺块）
    out = next;
  }
}

/** 把规则块写进文本（幂等——已有则先剥所有旧块再追加，保证只有一份）。返回新文本。 */
export function applyClaudeMdBlock(text: string, key: string, rule: string): string {
  const clean = rule.trim();
  if (!clean) throw new Error(`对接 ${key} 未定义 claudeMdRule`);
  const { start, end } = claudeMdSentinels(key);
  const block = `${start}\n${clean}\n${end}`;
  const base = stripClaudeMdBlock(text, key).replace(/\s+$/, '');
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

/** 删掉规则块后规范化尾部（空文件→''，否则单个末尾换行）。返回新文本。 */
export function removeClaudeMdBlockText(text: string, key: string): string {
  const stripped = stripClaudeMdBlock(text, key).replace(/\s+$/, '');
  return stripped ? `${stripped}\n` : '';
}

/**
 * 读全局 CLAUDE.md。仅 ENOENT（文件不存在）当空串；其它错误（EACCES/EIO 等）rethrow，
 * 绝不能把读失败当"空文件"——否则 install 会用空内容整份覆盖用户全局配置（数据丢失）。
 */
async function readClaudeMd(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw e;
  }
}

/** 原子写（tmp + rename），确保目录存在，并尽量保留原文件权限位（多用户机器上不放宽）。 */
async function writeClaudeMdAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let mode: number | undefined;
  try { mode = (await stat(path)).mode; } catch { /* 原文件不存在则用默认 umask */ }
  const tmp = path + '.tmp';
  await writeFile(tmp, text, 'utf8');
  if (mode !== undefined) { try { await chmod(tmp, mode); } catch { /* 保权限失败不阻塞写入 */ } }
  await rename(tmp, path);
}

/**
 * 序列化对同一文件的读改写，避免并发 install/remove 相互覆盖（lost update）。
 * 飞书卡片按钮是 fire-and-forget，双击/连点可能并发触发。
 */
const writeChains = new Map<string, Promise<unknown>>();
function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(path) ?? Promise.resolve();
  const next = prev.then(fn, fn); // 无论上一次成功/失败都接着跑
  writeChains.set(path, next.catch(() => { /* 吞掉以免链上累积 rejection */ }));
  return next;
}

/** 该对接的规则块是否已写入全局 CLAUDE.md（connected 判定）。 */
export async function claudeMdBlockPresent(it: Integration, path = claudeMdPath()): Promise<boolean> {
  return hasClaudeMdBlock(await readClaudeMd(path), it.key);
}

/** 对接：把规则块写入全局 CLAUDE.md（幂等——已存在则用最新规则替换，避免重复）。 */
export async function installClaudeMdBlock(it: Integration, path = claudeMdPath()): Promise<void> {
  return withFileLock(path, async () => {
    const next = applyClaudeMdBlock(await readClaudeMd(path), it.key, it.claudeMdRule ?? '');
    await writeClaudeMdAtomic(path, next);
    logger.info('claudeMd 规则块已写入全局 CLAUDE.md', { key: it.key });
  });
}

/** 断开：从全局 CLAUDE.md 删掉该对接的规则块（不存在则 no-op；结构异常删不掉则抛错）。 */
export async function removeClaudeMdBlock(it: Integration, path = claudeMdPath()): Promise<void> {
  return withFileLock(path, async () => {
    const cur = await readClaudeMd(path);
    if (!hasClaudeMdBlock(cur, it.key)) return;
    const next = removeClaudeMdBlockText(cur, it.key);
    if (hasClaudeMdBlock(next, it.key)) {
      throw new Error(`CLAUDE.md 中 ${it.key} 规则块结构异常（缺 end 标记），未自动删除，请手动检查`);
    }
    await writeClaudeMdAtomic(path, next);
    logger.info('claudeMd 规则块已从全局 CLAUDE.md 移除', { key: it.key });
  });
}
