import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CODEX_HOOKS_BEGIN } from './hook-install.js';

const execFileAsync = promisify(execFile);

/** codex 对接（agentType）的运行时状态：CLI 装没装 / 登录没 / 两条回传通道装没装。 */
export interface CodexStatus {
  installed: boolean;      // `which codex`
  binPath?: string;
  loggedIn: boolean;       // `codex login status`
  loginDetail?: string;
  notifyHooked: boolean;   // ~/.codex/config.toml 的 notify 指向 mchat-codex-notify（兜底通道）
  /**
   * ~/.codex/config.toml 里有本项目托管的 [[hooks.*]] 区块（主通道：与 claude 同构的
   * Stop 回传 + PreToolUse 高危审批闸）。
   * ⚠ 只表示**配置写进去了**，不代表已生效 —— codex 首次需要用户在 TUI 里 `/hooks` 批准信任。
   */
  lifecycleHooked: boolean;
}

export async function codexAgentStatus(): Promise<CodexStatus> {
  const st: CodexStatus = { installed: false, loggedIn: false, notifyHooked: false, lifecycleHooked: false };
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
    if (existsSync(cfg)) {
      const raw = await readFile(cfg, 'utf8');
      st.notifyHooked = /mchat-codex-notify/.test(raw);
      st.lifecycleHooked = raw.includes(CODEX_HOOKS_BEGIN) && /\[\[hooks\.Stop\]\]/.test(raw);
    }
  } catch { /* ignore */ }

  return st;
}

/** 一句话引导：据状态给下一步该干啥。 */
export function codexNextStep(st: CodexStatus): string {
  if (!st.installed) return '装 codex CLI：`npm i -g @openai/codex`（或 `brew install codex`），然后 `codex login`';
  if (!st.loggedIn) return '已装未登录：跑一次 `codex login`';
  if (!st.lifecycleHooked && !st.notifyHooked) {
    return 'CLI 就绪，但回传钩子未装：重启 daemon（会自动 upsert ~/.codex/config.toml）';
  }
  if (!st.lifecycleHooked) {
    return '回传走的还是 legacy notify。要拿到与 claude 一样的「结果回传 + 高危命令飞书审批」，重启 daemon 装 lifecycle hooks（需 codex ≥ 0.154）';
  }
  return '✅ 就绪：codex tab 可远程调度。hooks 已写入 —— **首次要在 codex TUI 里跑 `/hooks` 批准信任**后回传与审批闸才生效';
}
