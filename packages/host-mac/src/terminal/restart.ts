import { spawnSync } from 'node:child_process';
import { closeTab, forceEnter, listTabs, send } from './tabs.js';
import { sendKeys } from './keys.js';
import type { TerminalTab } from './types.js';
import { detectAgentFromProcs, getAgentAdapter, resolveDefaultAgentKind, type AgentKind } from 'multiagent-orchestrator';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 与 status.ts 的判定一致：进程列表里有没有在跑 agent（claude/codex）。走 AgentAdapter registry。 */
export function isAgentTab(tab: TerminalTab): boolean {
  return detectAgentFromProcs(tab.processes) !== null;
}

/**
 * 历史别名 —— 老调用点保持不变。**名字有误导性**：它认的是任意 agent（claude + codex），
 * 不只 claude。新代码请用 `isAgentTab`。
 */
export const isClaudeTab = isAgentTab;

/**
 * daemon/CLI 自己跑在哪个 tab（controlling tty）—— 沿 pid→ppid 上溯找第一个持真 ctty 的祖先
 * （claude/工具子进程可能没 ctty，故要往上走）。关 tab 时用来**禁止关自己**：daemon 若被关，
 * 整套服务就没了。整条链都无 ctty（无控制终端的守护/沙箱）返回 undefined。
 */
export function detectSelfTty(): string | undefined {
  let pid: number | undefined = process.pid;
  for (let i = 0; i < 12 && pid && pid > 1; i++) {
    try {
      const r = spawnSync('ps', ['-o', 'tty=,ppid=', '-p', String(pid)], { encoding: 'utf8' });
      const line = r.stdout.trim();
      const m = /^(\S+)\s+(\d+)$/.exec(line);
      if (!m) break;
      const tty = m[1]!;
      if (tty !== '??' && tty !== '?') return tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
      pid = Number(m[2]);
    } catch {
      break;
    }
  }
  return undefined;
}

export type { ExitAgentResult } from 'multiagent-host-api';
import type { ExitAgentResult } from 'multiagent-host-api';

/**
 * 优雅退出 tab 里在跑的 agent（claude/codex）：连发 Ctrl-C（每次两下 —— claude 需"快速连按两次"
 * 才退，两次间隔过久会重置计时；codex 同法通用），每次后查进程列表，agent 消失即停。
 * 没在跑 agent → 直接 hadAgent:false 返回。卡死退不出 → exited:false，由调用方决定是否仍强关。
 * 用于**关 tab 前先清掉 agent**，避免残留进程占 CPU/内存。
 */
export async function exitAgentInTab(
  tty: string,
  opts: { settleMs?: number; maxInterrupts?: number } = {},
): Promise<ExitAgentResult> {
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

export type { CloseTabResult } from 'multiagent-host-api';
import type { CloseTabResult } from 'multiagent-host-api';

/**
 * 优雅关闭一个 tab：先退出 agent(claude/codex) 避免残留 CPU/内存，再关**单个** tab。
 * **拒绝关 daemon 自己所在的 tab**（否则把整套服务关了）。agent 没退干净也继续关
 * （Terminal 关 tab 会终止其进程），但把 agentExited=false 标出来让上层提示。
 */
export async function closeTabGracefully(
  tty: string,
  opts: { skipAgentExit?: boolean } = {},
): Promise<CloseTabResult> {
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
  // closeTab 走 System Events 发 Cmd-W（需 Accessibility 授权）。osascript 非零退出会**抛**
  // （如权限 1002「不允许发送按键」）——这里必须 catch，否则异常穿透到 cardAction 的
  // fire-and-forget IIFE 被 void 吞掉，飞书零反馈。转成结构化 { closed:false, reason } 让上层能提示。
  let closed = false;
  let reason: string | undefined;
  try {
    closed = await closeTab(tty);
    if (!closed) reason = `tab ${tty} 未找到或关闭失败`;
  } catch (e) {
    reason = describeCloseErr(e, tty);
  }
  return {
    ok: closed, closed, hadAgent, agentExited,
    ...(agentKind ? { agentKind } : {}),
    ...(closed ? {} : { reason }),
  };
}

/** 把 closeTab 的 osascript 抛错翻译成可行动的中文提示（重点识别 Accessibility 未授权）。 */
function describeCloseErr(e: unknown, tty: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  // 1002 = System Events「不允许发送按键」= 辅助功能(Accessibility)未授权
  if (msg.includes('(1002)') || msg.includes('不允许发送按键') || msg.includes('not allowed to send keystrokes')) {
    return `关闭 ${tty} 失败：辅助功能(Accessibility)未授权 —— 运行 daemon 的进程(node)不能发按键(Cmd-W)。`
      + `到「系统设置 → 隐私与安全性 → 辅助功能」勾选 node，再重启 daemon。`;
  }
  return `关闭 ${tty} 失败：${msg}`;
}

export type { RestartAgentOptions as RestartClaudeOptions } from 'multiagent-host-api';
export type { RestartAgentResult as RestartClaudeResult } from 'multiagent-host-api';
import type {
  RestartAgentOptions as RestartClaudeOptions,
  RestartAgentResult as RestartClaudeResult,
} from 'multiagent-host-api';

/**
 * 原地重启一个 agent tab（claude / codex 都走这条）：
 *  1. 连发 Ctrl-C（每次后查进程列表，agent 消失即停）退出 TUI 回到 shell
 *  2. 回到 shell 后按**重启前检测到的那个 agent** 重跑（`claude` / `codex` / 各自的续接命令）
 *
 * 不关窗、不新开 tab —— 窗口/tab/cwd 全保留。
 * agent 彻底卡死（Ctrl-C 也退不出）时返回 ok:false，由调用方决定是否降级处理。
 */
export async function restartAgentInPlace(
  tty: string,
  opts: RestartClaudeOptions = {},
): Promise<RestartClaudeResult> {
  const continueSession = opts.continueSession ?? false;
  const settleMs = opts.settleMs ?? 700;
  const maxInterrupts = opts.maxInterrupts ?? 3;

  const before = (await listTabs()).find((t) => t.tty === tty);
  if (!before) return { ok: false, tty, reason: `tab 不存在：${tty}` };
  const cwd = before.cwd;
  // 记住**原来跑的是哪个 agent**，退出后要按原样重启。
  // （曾经这里写死 launchClaudeInTab → 重启一个 codex tab 会把它变成 claude。）
  const agent = detectAgentFromProcs(before.processes);
  if (!agent) {
    return { ok: false, tty, cwd, reason: '该 tab 没在跑 agent（claude/codex），跳过' };
  }

  // 1. 退出 agent TUI。claude 的退出需要「快速连按两次 Ctrl-C」——两次间隔过久
  //    （> ~1s）claude 会重置"再按一次退出"计时，导致永远退不出。所以每次尝试用
  //    单个 sendKeys 一口气发两个 ctrl+c（默认 50ms 间隔），再查进程；不行再重试。
  //    codex 按同一手势处理（用户 2026-09-14 拍板共用这段）。⚠ 未做真机实测：
  //    若发现 codex tab 退不出去（restartAgentInPlace 返回"Ctrl-C N 次仍未退出"），
  //    先怀疑这里 —— codex 可能需要不同次数/间隔，或只认 /quit。
  let exited = false;
  for (let i = 0; i < maxInterrupts && !exited; i++) {
    await sendKeys(tty, 'ctrl+c ctrl+c');
    await delay(settleMs);
    const cur = (await listTabs()).find((t) => t.tty === tty);
    if (cur && !isAgentTab(cur)) exited = true;
  }
  if (!exited) {
    return {
      ok: false,
      tty,
      cwd,
      reason: `Ctrl-C ${maxInterrupts} 次仍未退出 ${agent.displayName}（可能卡死）；建议手动或关窗重开`,
    };
  }

  // 2. 回到 shell 后按**原来那个 agent** 重跑（默认不带历史）+ 自动过 trust 弹窗
  const launched = await launchAgentInTab(tty, agent.kind, { continueSession });
  if (!launched.ok) {
    return { ok: false, tty, cwd, reason: `重启命令未发出：${launched.reason ?? '未知'}` };
  }
  return { ok: true, tty, cwd, command: launched.command };
}

export type { LaunchAgentOptions as LaunchClaudeOptions } from 'multiagent-host-api';
import type { LaunchAgentOptions as LaunchClaudeOptions } from 'multiagent-host-api';

/**
 * 在一个已停在 shell prompt 的 tab 里启动指定 agent（claude/codex），并自动过掉首次的
 * "Do you trust the files in this folder?" 弹窗。
 *
 * 该弹窗默认高亮"信任本目录"，一次回车即接受——走 forceEnter（默认 pty 直写：空 do script 送单独一个 \r；
 * `MCHAT_ENTER_MODE=keystroke` 时为 key code 36 键盘事件）。⚠ pty 路径过 trust 弹窗尚未真机验证，
 * 若发现 trust 弹窗过不去，先试 keystroke 模式定位。agent 进 alt-screen 后
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

/**
 * launchAgentInTab 的 claude 特化。
 * @deprecated 调用点已全部改走 HostController.launchAgentInTab；保留仅为兼容外部脚本。
 */
export async function launchClaudeInTab(
  tty: string,
  opts: LaunchClaudeOptions = {},
): Promise<{ ok: boolean; command?: string; reason?: string }> {
  return launchAgentInTab(tty, 'claude', opts);
}

/**
 * 在新开的 tab 里启动**默认 agent**（`MCHAT_DEFAULT_AGENT`，未设=claude）。
 *
 * 所有"开个新 tab 干活"的入口（公函开工 / TAPD 认领 / perf 认领 / `/new`）都该走这个，
 * 而不是写死 `launchClaudeInTab` —— 否则把默认 agent 切成 codex 的用户，
 * 点一次「确认，开工」还是会被塞一个 claude。
 */
export async function launchDefaultAgentInTab(
  tty: string,
  opts: LaunchClaudeOptions = {},
): Promise<{ ok: boolean; command?: string; reason?: string; kind: AgentKind }> {
  const kind = resolveDefaultAgentKind();
  const r = await launchAgentInTab(tty, kind, opts);
  return { ...r, kind };
}

/**
 * 历史别名。行为已按 tab 实际跑的 agent 分流，不再写死 claude。
 * @deprecated 调用点已全部改走 HostController.restartAgentInPlace；保留仅为兼容外部脚本。
 */
export const restartClaudeInPlace = restartAgentInPlace;
