/**
 * tty → tmux pane id 的解析（独立成文件，避免 tabs.ts ⇄ keys.ts 互相 import）。
 */

import { runTmuxSoft } from './tmux.js';

/** tty → pane id（`%3`）。找不到返回 null。 */
export async function resolvePane(tty: string): Promise<string | null> {
  const out = await runTmuxSoft(['list-panes', '-a', '-F', '#{pane_tty} #{pane_id}']);
  if (out === null) return null;
  for (const line of out.split('\n')) {
    const [paneTty, paneId] = line.trim().split(/\s+/);
    if (paneTty === tty && paneId) return paneId;
  }
  return null;
}

/** 同上，找不到抛错（写操作用：静默 no-op 比抛错更难排查）。 */
export async function resolvePaneOrThrow(tty: string): Promise<string> {
  const pane = await resolvePane(tty);
  if (!pane) throw new Error(`tab 不存在：${tty}`);
  return pane;
}
