/**
 * `HostController.snapshotTabs` 的 tmux 实现：列 pane + 并发 capture 需要的 history。
 *
 * macOS 宿主把这一步合成单个 osascript 是为了省 tccd 签名校验；tmux 没有 TCC，
 * 每次 capture-pane 只是一次便宜的 CLI 调用 → 直接复用 listTabsRaw + getHistory，不另写合并逻辑。
 */

import type { SnapshotTabsOptions, TabsSnapshot } from 'multiagent-host-api';

import { getHistory, listTabsRaw } from './tabs.js';

export async function snapshotTabs(opts: SnapshotTabsOptions = {}): Promise<TabsSnapshot> {
  const tabs = await listTabsRaw();
  const extra = new Set(opts.historyTtys ?? []);
  const targets = tabs.filter((t) => t.busy || extra.has(t.tty));
  const histories = new Map<string, string>();
  await Promise.all(
    targets.map(async (t) => {
      try {
        histories.set(t.tty, await getHistory(t.tty));
      } catch {
        /* 取失败的 tab 不进 map（契约语义），调用方按「这轮没拿到」处理 */
      }
    }),
  );
  return { tabs, histories };
}
