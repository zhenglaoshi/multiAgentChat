/**
 * 宿主装配根（composition root）—— 全项目**唯一**一处「按平台选宿主实现」的地方。
 *
 * 业务代码只认 `multiagent-host-api` 的契约；具体用 macOS（AppleScript + Terminal.app）还是
 * tmux（Linux / WSL2），在进程启动时由这里决定并 `setHost()` 注入。
 *
 * 有**两个**进程入口需要调它：
 *  1. daemon（`apps/daemon/src/index.ts`）—— watcher / notifier / control server 全靠宿主；
 *  2. `agent` CLI（`control/cli.ts`）—— `agent doctor` 是在 CLI 进程里跑的（daemon 挂了也要能自检）。
 *
 * 实现用**动态 import**：非 macOS 机器上根本不会加载 host-mac 那堆 AppleScript 代码，
 * 没装 tmux 的机器也不会加载 host-tmux。
 * 加新宿主时只改本文件的分支 —— 这就是「换平台只动一处」的兑现点。
 */

import { hasHost, setHost } from 'multiagent-host-api';

/** 强制指定宿主（`mac` / `tmux`）。主要给「在 Mac 上验 tmux 宿主」这种场景用。 */
export type HostChoice = 'mac' | 'tmux';

/** 读 `MCHAT_HOST` 覆盖；没配或值非法 → null（走平台默认）。纯函数。 */
export function resolveHostOverride(env: NodeJS.ProcessEnv = process.env): HostChoice | null {
  const v = (env['MCHAT_HOST'] ?? '').trim().toLowerCase();
  return v === 'mac' || v === 'tmux' ? v : null;
}

async function useMac(): Promise<boolean> {
  const { macHost } = await import('multiagent-host-mac');
  setHost(macHost);
  return true;
}

async function useTmux(): Promise<boolean> {
  const { tmuxHost, tmuxAvailable } = await import('multiagent-host-tmux');
  // 没装 tmux 就装配上去的话，之后每个 tab 操作都会各自炸一次；这里早退让调用方给一句人话提示。
  if (!(await tmuxAvailable())) return false;
  setHost(tmuxHost);
  return true;
}

/** 已装配过就 no-op（两个入口都调、或重复调都安全）。返回是否成功装上。 */
export async function ensureHostRegistered(): Promise<boolean> {
  if (hasHost()) return true;
  const override = resolveHostOverride();
  if (override === 'mac') return useMac();
  if (override === 'tmux') return useTmux();
  if (process.platform === 'darwin') return useMac();
  // 其它平台（Linux / WSL2）目前只有 tmux 宿主；装不上（没装 tmux）由调用方给提示，这里不抛。
  return useTmux();
}

/**
 * 当前平台**可能**有宿主实现（给 doctor / 启动期报错文案用）。
 * ⚠ 非 macOS 返回 true 只表示「有 tmux 宿主这条路」，不代表本机装了 tmux——
 * 真正能不能用以 `ensureHostRegistered()` 的返回值为准。
 */
export function hostSupportedOnThisPlatform(): boolean {
  return true;
}
