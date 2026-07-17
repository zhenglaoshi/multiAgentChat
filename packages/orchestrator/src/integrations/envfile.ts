import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { INTEGRATIONS, type Integration } from './registry.js';

const ENV_PATH = resolve('./.env');

/** 解析 .env 文件 → { KEY: value }（只读文件，不碰 process.env）。 */
export async function readEnvKeys(): Promise<Record<string, string>> {
  let text = '';
  try { text = await readFile(ENV_PATH, 'utf8'); } catch { return {}; }
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = (m[2] ?? '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

/**
 * upsert 若干 env（保留其余行 + 注释）。已存在的键就地替换值，不存在的追加到末尾。
 * 值含空格/特殊字符时加双引号。原子写（tmp + rename）。
 */
export async function upsertEnvKeys(kv: Record<string, string>): Promise<void> {
  let text = '';
  try { text = await readFile(ENV_PATH, 'utf8'); } catch { text = ''; }
  const lines = text.split('\n');
  const quote = (v: string) => (/[\s#"']/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v);
  const remaining = new Map(Object.entries(kv));
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(lines[i] ?? '');
    if (m && remaining.has(m[1]!)) {
      lines[i] = `${m[1]}=${quote(remaining.get(m[1]!)!)}`;
      remaining.delete(m[1]!);
    }
  }
  if (remaining.size > 0) {
    if (lines.length && lines[lines.length - 1]!.trim() !== '') lines.push('');
    for (const [k, v] of remaining) lines.push(`${k}=${quote(v)}`);
  }
  const tmp = ENV_PATH + '.tmp';
  await writeFile(tmp, lines.join('\n'), 'utf8');
  await rename(tmp, ENV_PATH);
}

/** 停用列表的元键（独立于各对接自己的配置 env；停用不动配置，仅软关闭）。 */
export const DISABLED_ENV_KEY = 'MCHAT_DISABLED_INTEGRATIONS';

function parseList(v?: string): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** 运行时判定某对接是否被手动停用（gate 用，读 process.env）。 */
export function isIntegrationDisabled(key: string): boolean {
  return parseList(process.env[DISABLED_ENV_KEY]).includes(key);
}

/** 停用/启用某对接（改 .env 的停用列表，不动该对接的配置 env）。改完需重启生效。 */
export async function setIntegrationDisabled(key: string, disabled: boolean): Promise<void> {
  const env = await readEnvKeys();
  const set = new Set(parseList(env[DISABLED_ENV_KEY]));
  if (disabled) set.add(key); else set.delete(key);
  await upsertEnvKeys({ [DISABLED_ENV_KEY]: [...set].join(',') });
}

export interface IntegrationStatus {
  key: string;
  name: string;
  group: Integration['group'];
  desc: string;
  connected: boolean;  // 配置齐全（env 都有值）
  disabled: boolean;   // 配置齐全但被手动停用（软关闭）
  core: boolean;
  missing: string[];   // 缺哪些 env
}

/** 读 .env 判定每个对接：配置齐全否 + 是否被停用。 */
export async function integrationStatuses(): Promise<IntegrationStatus[]> {
  const env = await readEnvKeys();
  const has = (k: string) => !!(env[k] && env[k]!.trim());
  const disabledSet = new Set(parseList(env[DISABLED_ENV_KEY]));
  return INTEGRATIONS.map((it) => {
    const present = it.fields.filter((f) => has(f.env)).map((f) => f.env);
    const connected = it.anyOf ? present.length > 0 : present.length === it.fields.length;
    const missing = it.fields.filter((f) => !has(f.env)).map((f) => f.env);
    return { key: it.key, name: it.name, group: it.group, desc: it.desc, connected, disabled: disabledSet.has(it.key), core: !!it.core, missing };
  });
}
