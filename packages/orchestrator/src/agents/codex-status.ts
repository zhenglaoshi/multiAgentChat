import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

/** codex 对接（agentType）的运行时状态：CLI 装没装 / 登录没 / notify 钩子装没装。 */
export interface CodexStatus {
  installed: boolean;      // `which codex`
  binPath?: string;
  loggedIn: boolean;       // `codex login status`
  loginDetail?: string;
  notifyHooked: boolean;   // ~/.codex/config.toml 的 notify 指向 mchat-codex-notify
}

export async function codexAgentStatus(): Promise<CodexStatus> {
  const st: CodexStatus = { installed: false, loggedIn: false, notifyHooked: false };
  try {
    const { stdout } = await execFileAsync('which', ['codex'], { timeout: 5000 });
    const p = stdout.trim();
    if (p) { st.installed = true; st.binPath = p; }
  } catch { /* 未安装 */ }

  if (st.installed) {
    try {
      const { stdout } = await execFileAsync('codex', ['login', 'status'], { timeout: 8000 });
      st.loginDetail = (stdout.trim().split('\n')[0] ?? '').slice(0, 120);
      st.loggedIn = /logged\s*in/i.test(stdout);
    } catch {
      st.loginDetail = '未登录 / codex login status 失败';
    }
  }

  try {
    const cfg = join(homedir(), '.codex', 'config.toml');
    if (existsSync(cfg)) st.notifyHooked = /mchat-codex-notify/.test(await readFile(cfg, 'utf8'));
  } catch { /* ignore */ }

  return st;
}

/** 一句话引导：据状态给下一步该干啥。 */
export function codexNextStep(st: CodexStatus): string {
  if (!st.installed) return '装 codex CLI：`npm i -g @openai/codex`（或 `brew install codex`），然后 `codex login`';
  if (!st.loggedIn) return '已装未登录：跑一次 `codex login`';
  if (!st.notifyHooked) return 'CLI 就绪，但 notify 钩子未装：重启 daemon（会自动 upsert ~/.codex/config.toml）';
  return '✅ 就绪：codex tab 可远程调度，响应经 notify 回传飞书';
}
