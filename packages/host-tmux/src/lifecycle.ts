/**
 * agent 生命周期（退出 / 关 pane / 原地重启 / 启动）—— 与 host-mac 的 restart.ts 同构。
 *
 * 判定与时序**刻意与 macOS 宿主保持一致**（连发两个 Ctrl-C 退 TUI、启动后错开两次回车过 trust 提示），
 * 这样"同一条 /new 或重启命令在两个宿主上行为不同"这类问题不会出现。
 * 差异只在最后一跳怎么发按键：这里是 tmux send-keys（不抢焦点、锁屏可用）。
 */

import type {
  CloseTabOptions,
  CloseTabResult,
  ExitAgentOptions,
  ExitAgentResult,
  LaunchAgentOptions,
  LaunchAgentResult,
  LaunchDefaultAgentResult,
  RestartAgentOptions,
  RestartAgentResult,
  TerminalTab,
} from 'multiagent-host-api';
import {
  detectAgentFromProcs,
  getAgentAdapter,
  resolveDefaultAgentKind,
  type AgentKind,
} from 'multiagent-orchestrator';
import { closeTab, forceEnter, listTabs, send } from './tabs.js';
import { sendKeys } from './keys.js';
import { detectSelfTty } from './procs.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 进程列表里有没有在跑 agent（claude/codex）。走 AgentAdapter registry，判据与 macOS 宿主同源。 */
export function isAgentTab(tab: TerminalTab): boolean {
  return detectAgentFromProcs(tab.processes) !== null;
}

/** 优雅退出 pane 里的 agent（连发 Ctrl-C 直到进程消失）。 */
export async function exitAgentInTab(tty: string, opts: ExitAgentOptions = {}): Promise<ExitAgentResult> {
  const settleMs = opts.settleMs ?? 700;
  const maxInterrupts = opts.maxInterrupts ?? 3;
  const before = (await listTabs()).find((t) => t.tty === tty);
  if (!before) return { exited: true, hadAgent: false };
  const adapter = detectAgentFromProcs(before.processes);
  if (!adapter) return { exited: true, hadAgent: false };
  const kind = adapter.kind;
  for (let i = 0; i < maxInterrupts; i++) {
    await sendKeys(tty, 'ctrl+c ctrl+c');
    await delay(settleMs);
    const cur = (await listTabs()).find((t) => t.tty === tty);
    if (!cur || !detectAgentFromProcs(cur.processes)) return { exited: true, hadAgent: true, kind };
  }
  return { exited: false, hadAgent: true, kind };
}

/**
 * 先退 agent 再关 pane。**拒绝关 daemon 自己那个**（否则把整套服务关了）。
 * 与 macOS 版的差异：那边 `closeTab` 走 System Events 发 Cmd-W、会因 Accessibility 未授权抛错，
 * 需要把错误翻译成人话；tmux 的 `kill-pane` 没有授权这一层，失败只可能是 pane 不在了。
 */
export async function closeTabGracefully(tty: string, opts: CloseTabOptions = {}): Promise<CloseTabResult> {
  const self = detectSelfTty();
  if (self && self === tty) {
    return {
      ok: false, closed: false, hadAgent: false, agentExited: false,
      reason: '拒绝关闭 daemon 自己所在的 tab（会把整套服务关掉）',
    };
  }
  let hadAgent = false;
  let agentExited = true;
  let agentKind: AgentKind | undefined;
  if (!opts.skipAgentExit) {
    const ex = await exitAgentInTab(tty);
    hadAgent = ex.hadAgent;
    agentExited = ex.exited;
    agentKind = ex.kind;
  }
  let closed = false;
  let reason: string | undefined;
  try {
    closed = await closeTab(tty);
    if (!closed) reason = `tab ${tty} 未找到或关闭失败`;
  } catch (e) {
    reason = `关闭 ${tty} 失败：${(e as Error).message}`;
  }
  return {
    ok: closed, closed, hadAgent, agentExited,
    ...(agentKind ? { agentKind } : {}),
    ...(closed ? {} : { reason }),
  };
}

/**
 * 在已停在 shell prompt 的 pane 里启动指定 agent，并过掉首次的
 * "Do you trust the files in this folder?" 提示。
 *
 * 进 alt-screen 后读不到屏幕，只能按时序补两次回车（覆盖启动快/慢两种情况）；
 * 目录已信任时回车落到 agent 空 prompt，无副作用。时序与 macOS 宿主一致。
 */
export async function launchAgentInTab(
  tty: string,
  kind: AgentKind,
  opts: LaunchAgentOptions = {},
): Promise<LaunchAgentResult> {
  const continueSession = opts.continueSession ?? false;
  const acceptTrust = opts.acceptTrust ?? true;
  const adapter = getAgentAdapter(kind);
  if (!adapter) return { ok: false, reason: `未知 agent 种类：${kind}` };
  const command = adapter.launchCommand({ continueSession });

  // send 写的是「命令 + \r」一整块，裸 shell 直接执行（与 macOS 的 do script 同义），不用额外补回车
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

/** 按 `MCHAT_DEFAULT_AGENT` 决定种类再启动。 */
export async function launchDefaultAgentInTab(
  tty: string,
  opts: LaunchAgentOptions = {},
): Promise<LaunchDefaultAgentResult> {
  const kind = resolveDefaultAgentKind();
  return { ...(await launchAgentInTab(tty, kind, opts)), kind };
}

/**
 * 原地重启 pane 里的 agent：连发 Ctrl-C 退 TUI → 按**重启前检测到的那个 agent** 原样拉起。
 * 不关 pane、保留 cwd。
 */
export async function restartAgentInPlace(
  tty: string,
  opts: RestartAgentOptions = {},
): Promise<RestartAgentResult> {
  const continueSession = opts.continueSession ?? false;
  const settleMs = opts.settleMs ?? 700;
  const maxInterrupts = opts.maxInterrupts ?? 3;

  const before = (await listTabs()).find((t) => t.tty === tty);
  if (!before) return { ok: false, tty, reason: `tab 不存在：${tty}` };
  const cwd = before.cwd;
  const agent = detectAgentFromProcs(before.processes);
  if (!agent) return { ok: false, tty, cwd, reason: '该 tab 没在跑 agent（claude/codex），跳过' };

  let exited = false;
  for (let i = 0; i < maxInterrupts && !exited; i++) {
    await sendKeys(tty, 'ctrl+c ctrl+c');
    await delay(settleMs);
    const cur = (await listTabs()).find((t) => t.tty === tty);
    if (cur && !isAgentTab(cur)) exited = true;
  }
  if (!exited) {
    return {
      ok: false, tty, cwd,
      reason: `Ctrl-C ${maxInterrupts} 次仍未退出 ${agent.displayName}（可能卡死）；建议手动或关窗重开`,
    };
  }

  const launched = await launchAgentInTab(tty, agent.kind, { continueSession });
  if (!launched.ok) return { ok: false, tty, cwd, reason: `重启命令未发出：${launched.reason ?? '未知'}` };
  return { ok: true, tty, cwd, command: launched.command };
}
