import { spawnSync } from 'node:child_process';
import { closeTab, forceEnter, listTabs, send } from './tabs.js';
import { sendKeys } from './keys.js';
import type { TerminalTab } from './types.js';
import { detectAgentFromProcs, getAgentAdapter, type AgentKind } from 'multiagent-orchestrator';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 与 status.ts 的判定一致：进程列表里有没有在跑 agent（claude/codex）。走 AgentAdapter registry。 */
export function isClaudeTab(tab: TerminalTab): boolean {
  return detectAgentFromProcs(tab.processes) !== null;
}

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

export interface ExitAgentResult {
  /** agent 已退出（或本来就没 agent）。 */
  exited: boolean;
  /** 关前 tab 里确实在跑 agent。 */
  hadAgent: boolean;
  kind?: AgentKind;
}

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

export interface CloseTabResult {
  ok: boolean;
  closed: boolean;
  hadAgent: boolean;
  agentExited: boolean;
  agentKind?: AgentKind;
  reason?: string;
}

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
