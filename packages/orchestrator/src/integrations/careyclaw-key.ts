import { readEnvKeys, upsertEnvKeys } from './envfile.js';

/** CareyClaw 本地调试密钥（oct_dev_）+ 访问权限到期日，存 multiAgentChat 的 .env。 */
export const CAREYCLAW_KEY_ENV = 'CAREYCLAW_DEV_KEY';
export const CAREYCLAW_KEY_EXPIRES_ENV = 'CAREYCLAW_DEV_KEY_EXPIRES';

export interface CareyclawKeyStatus {
  hasKey: boolean;
  keyMasked?: string;       // 脱敏展示
  expiresAt?: string;       // ISO 日期（访问权限到期，短的那个）
  daysLeft?: number;        // 距到期天数（负=已过期）
}

function maskKey(k: string): string {
  if (k.length <= 8) return '****';
  return k.slice(0, 8) + '····' + k.slice(-2);
}

/** 从 .env 读调试密钥状态（含剩余天数）。 */
export async function getCareyclawKeyStatus(): Promise<CareyclawKeyStatus> {
  const env = await readEnvKeys();
  const key = (env[CAREYCLAW_KEY_ENV] ?? '').trim();
  if (!key) return { hasKey: false };
  const out: CareyclawKeyStatus = { hasKey: true, keyMasked: maskKey(key) };
  const exp = (env[CAREYCLAW_KEY_EXPIRES_ENV] ?? '').trim();
  if (exp) {
    const t = Date.parse(exp);
    if (Number.isFinite(t)) {
      out.expiresAt = exp;
      out.daysLeft = Math.floor((t - Date.now()) / 86_400_000);
    }
  }
  return out;
}

/** 更新调试密钥（+ 可选到期日）。写 multiAgentChat 的 .env。 */
export async function setCareyclawKey(key: string, expiresAt?: string): Promise<void> {
  const kv: Record<string, string> = { [CAREYCLAW_KEY_ENV]: key.trim() };
  if (expiresAt && expiresAt.trim()) kv[CAREYCLAW_KEY_EXPIRES_ENV] = expiresAt.trim();
  await upsertEnvKeys(kv);
}
