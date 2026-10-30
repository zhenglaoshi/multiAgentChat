import { spawn as nodeSpawn } from 'node:child_process';
import { logger } from 'multiagent-orchestrator';

export type SpawnLike = typeof nodeSpawn;

/** 已经排了队的重启定时器：同一个进程生命周期内只保留最后一次触发，防止连发几条 /reload 堆出好几个 kickstart 互相打架 */
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 飞书「一键重启 daemon」的共享实现：被主 bot 的 `/reload`/`/restart` 命令
 * （commands.ts）和数字员工 bot 的同名命令（digital-staff.ts）共用，别各写一份。
 *
 * launchd 的 KeepAlive（SuccessfulExit: false）负责在进程退出后立刻拉起新的，
 * 新进程会重新加载 .env / 最新代码、重新建立所有 bot 的 WS 长连接。
 * 延迟 1.5s 再 kickstart：让调用方先把「重启中」的回复发出去，不被进程退出打断。
 * dev（tsx watch）/ 未托管 launchd 时没有这个 launchd label，kickstart 会静默失败——
 * 这种情况下改文件本来就会被 tsx watch 自动 reload，不需要这条命令。
 *
 * @param deps 测试用依赖注入：spawnImpl 替换真实 spawn（不然单测会真的拉起 launchctl）；
 *   delayMs 配合 vi.useFakeTimers() 做确定性断言，默认 1500 和生产一致。
 */
export function requestDaemonRestart(deps: { spawnImpl?: SpawnLike; delayMs?: number } = {}): { text: string } {
  const spawnImpl = deps.spawnImpl ?? nodeSpawn;
  const delayMs = deps.delayMs ?? 1500;
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  // 连续触发（老板连发几条 /reload）只保留最后一次：避免多个定时器各自 kickstart 一次，
  // 新进程刚起来又被下一次 kickstart 杀掉，反复抖动还可能撞上 launchd 对频繁崩溃的节流
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    try {
      const child = spawnImpl('launchctl', ['kickstart', '-k', `gui/${uid}/com.multiagent-chat.daemon`], {
        stdio: 'ignore',
        detached: true,
      });
      // spawn 本身不抛错不代表进程起得来：launchctl 不存在（非 launchd 托管）时错误是异步的 'error' 事件，
      // 不接住会变成未捕获异常，把整个 daemon 直接干崩——比注释里说的「静默忽略」严重得多
      child.on('error', (err) => logger.warn('daemon-restart: launchctl kickstart 失败（忽略，可能是 dev / 非 launchd 托管）', { err: err.message }));
      child.unref();
    } catch (err) {
      logger.warn('daemon-restart: 调用 spawn 失败（忽略，可能是 dev / 非 launchd 托管）', { err: (err as Error).message });
    }
  }, delayMs);
  return {
    text: '🔄 正在重启 daemon…（约 5 秒，launchd 自动拉起新进程、加载最新代码 + 重装 hooks）。\n若长时间无响应，可能是 dev 模式（tsx watch 改文件即自动 reload，无需本命令）。',
  };
}

/** 仅测试用：清掉模块级的去抖定时器，避免跨用例互相干扰（尤其是切换 vi.useFakeTimers()/useRealTimers() 之间） */
export function __resetDaemonRestartForTest(): void {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = null;
}
