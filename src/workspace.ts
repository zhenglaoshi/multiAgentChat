import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const WORKSPACE_ROOT = resolve('./workspaces');

export function defaultWorkspaceDir(chatId: string): string {
  return join(WORKSPACE_ROOT, chatId);
}

export async function ensureWorkspaceDir(chatId: string): Promise<string> {
  const dir = defaultWorkspaceDir(chatId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export type ResolveCdResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

export async function resolveCdTarget(
  input: string,
  currentCwd: string,
): Promise<ResolveCdResult> {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: '路径不能为空' };

  let p = trimmed;
  if (p === '~') p = homedir();
  else if (p.startsWith('~/')) p = join(homedir(), p.slice(2));

  const abs = isAbsolute(p) ? p : resolve(currentCwd, p);

  try {
    const s = await stat(abs);
    if (!s.isDirectory()) return { ok: false, error: `不是目录：${abs}` };
    return { ok: true, path: abs };
  } catch {
    return { ok: false, error: `目录不存在：${abs}` };
  }
}
