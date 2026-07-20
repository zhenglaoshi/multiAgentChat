import { forceEnter, listTabs, send } from './tabs.js';
import { sendKeys } from './keys.js';
import type { TerminalTab } from './types.js';
import { detectAgentFromProcs, getAgentAdapter, type AgentKind } from 'multiagent-orchestrator';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 与 status.ts 的判定一致：进程列表里有没有在跑 agent（claude/codex）。走 AgentAdapter registry。 */
export function isClaudeTab(tab: TerminalTab): boolean {
  return detectAgentFromProcs(tab.processes) !== null;
}

export interface RestartClaudeOptions {
  /** true → 重启后 `claude --continue` 续上次会话；false → 全新 `claude`（默认，不带历史）。 */
  continueSession?: boolean;
  /** 每次 Ctrl-C 后等多久再查是否退出。默认 700ms。 */
  settleMs?: number;
  /** 最多发几次 Ctrl-C 尝试退出 claude TUI。默认 3。 */
  maxInterrupts?: number;
}

export interface RestartClaudeResult {
  ok: boolean;
  tty: string;
  cwd?: string;
  /** 失败原因；ok 时 undefined */
  reason?: string;
  /** 实际重启用的命令（ok 时有） */
  command?: string;
}

/**
 * 原地重启一个 claude tab：
 *  1. 连发 Ctrl-C（每次后查进程列表，claude 消失即停）退出 TUI 回到 shell
 *  2. 回到 shell 后重跑 `claude` / `claude --continue`
 *
 * 不关窗、不新开 tab —— 窗口/tab/cwd 全保留。
 * claude 彻底卡死（Ctrl-C 也退不出）时返回 ok:false，由调用方决定是否降级处理。
 */
export async function restartClaudeInPlace(
  tty: string,
  opts: RestartClaudeOptions = {},
): Promise<RestartClaudeResult> {
  const continueSession = opts.continueSession ?? false;
  const settleMs = opts.settleMs ?? 700;
  const maxInterrupts = opts.maxInterrupts ?? 3;

  const before = (await listTabs()).find((t) => t.tty === tty);
  if (!before) return { ok: false, tty, reason: `tab 不存在：${tty}` };
  const cwd = before.cwd;
  if (!isClaudeTab(before)) {
    return { ok: false, tty, cwd, reason: '该 tab 没在跑 claude，跳过' };
  }

  // 1. 退出 claude TUI。claude 的退出需要「快速连按两次 Ctrl-C」——两次间隔过久
  //    （> ~1s）claude 会重置"再按一次退出"计时，导致永远退不出。所以每次尝试用
  //    单个 sendKeys 一口气发两个 ctrl+c（默认 50ms 间隔），再查进程；不行再重试。
  let exited = false;
  for (let i = 0; i < maxInterrupts && !exited; i++) {
    await sendKeys(tty, 'ctrl+c ctrl+c');
    await delay(settleMs);
    const cur = (await listTabs()).find((t) => t.tty === tty);
    if (cur && !isClaudeTab(cur)) exited = true;
  }
  if (!exited) {
    return {
      ok: false,
      tty,
      cwd,
      reason: `Ctrl-C ${maxInterrupts} 次仍未退出 claude（可能卡死）；建议手动或关窗重开`,
    };
  }

  // 2. 回到 shell 后重跑 claude（默认纯 `claude`，不带历史）+ 自动过 trust 弹窗
  const launched = await launchClaudeInTab(tty, { continueSession });
  if (!launched.ok) {
    return { ok: false, tty, cwd, reason: `重启命令未发出：${launched.reason ?? '未知'}` };
  }
  return { ok: true, tty, cwd, command: launched.command };
}

export interface LaunchClaudeOptions {
  /** true → `claude --continue`；false → 纯 `claude`（默认，不带历史）。 */
  continueSession?: boolean;
  /** 启动后自动按 Return 接受首次的 trust 弹窗。默认 true。 */
  acceptTrust?: boolean;
}

/**
 * 在一个已停在 shell prompt 的 tab 里启动指定 agent（claude/codex），并自动过掉首次的
 * "Do you trust the files in this folder?" 弹窗。
 *
 * 该弹窗默认高亮"信任本目录"，一个真 Return（key code 36）即接受。agent 进 alt-screen 后
 * 我们读不到屏幕内容，只能按时序补 Return —— 发两次、错开时序，覆盖启动快/慢两种情况；
 * 目录已信任（无弹窗）时 Return 落到 agent 空 prompt，无副作用。codex 首跑同样有信任提示，
 * 复用同一套时序。
 */
export async function launchAgentInTab(
  tty: string,
  kind: AgentKind,
  opts: LaunchClaudeOptions = {},
): Promise<{ ok: boolean; command?: string; reason?: string }> {
  const continueSession = opts.continueSession ?? false;
  const acceptTrust = opts.acceptTrust ?? true;
  const adapter = getAgentAdapter(kind);
  if (!adapter) return { ok: false, reason: `未知 agent 种类：${kind}` };
  const command = adapter.launchCommand({ continueSession });

  const res = await send(tty, command);
  if (!res.ok) return { ok: false, reason: res.reason ?? '未知' };

  if (acceptTrust) {
    await delay(2000);
    await forceEnter(tty).catch(() => {});
    await delay(1800);
    await forceEnter(tty).catch(() => {});
  }
  return { ok: true, command };
}

/** launchAgentInTab 的 claude 特化（历史调用点保持不变）。 */
export async function launchClaudeInTab(
  tty: string,
  opts: LaunchClaudeOptions = {},
): Promise<{ ok: boolean; command?: string; reason?: string }> {
  return launchAgentInTab(tty, 'claude', opts);
}
