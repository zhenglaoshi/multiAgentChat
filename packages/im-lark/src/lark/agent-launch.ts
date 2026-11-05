import { launchDefaultAgentInTab, listTabs } from 'multiagent-host-api';
import { detectAgentFromProcs } from 'multiagent-orchestrator';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type LaunchAndWaitResult =
  | { ok: true; kind: string }
  | { ok: false; kind: string; reason: string };

/**
 * 在新开的 tab 里起默认 agent，并**确认进程真的起来了**才返回 ok —— 之后才能往里写任务 prompt。
 *
 * 为什么不能「launch 完固定等 1.5s 就发」：launch 的 ok 只说明命令写进了 shell；trust 提示卡住 /
 * 选错退出 / 登录态 / 机器负载都会让 agent 没起来，此时照发 = prompt 连同回车落进**裸 shell**
 * 当命令执行（TAPD / perf 认领开在全新 worktree 目录里，正是必弹 trust 提示的场景）。
 * 与公函开工（handlers.ts openLetterWorkspace）同一道闸。判据用进程名（hasTUI 不认 claude/codex）。
 */
export async function launchDefaultAgentAndWait(
  tty: string,
  opts: { attempts?: number; pollMs?: number; settleMs?: number } = {},
): Promise<LaunchAndWaitResult> {
  const attempts = opts.attempts ?? 12;
  const pollMs = opts.pollMs ?? 1500;
  const settleMs = opts.settleMs ?? 2500;
  const launched = await launchDefaultAgentInTab(tty, { continueSession: false });
  if (!launched.ok) return { ok: false, kind: launched.kind, reason: launched.reason ?? '未知' };
  for (let i = 0; i < attempts; i++) {
    const t = (await listTabs().catch(() => [])).find((x) => x.tty === tty);
    if (t && detectAgentFromProcs(t.processes)) {
      await delay(settleMs); // 让它进完主界面，别撞启动画面
      return { ok: true, kind: launched.kind };
    }
    await delay(pollMs);
  }
  return { ok: false, kind: launched.kind, reason: `${tty} 的 ${launched.kind} 没起来（可能卡在 trust/登录），任务没发 —— 去那个 tab 看一眼` };
}
