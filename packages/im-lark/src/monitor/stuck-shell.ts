import { getHistory, sendCtrlC } from 'multiagent-host-mac';
import { detectWedge, logger } from 'multiagent-orchestrator';

/**
 * 一次性解卡：若目标 tab 卡在 zsh 续行提示（`dquote>`/`quote>`/…），发 Ctrl-C 放弃当前输入、回到干净 prompt。
 * 用于「刚往裸 shell 发过内容、立即自查」的场景（bare-shell-raw 逃生路径）。
 * watcher 的后台自愈另有一套**带稳定性判断 + 去重**的逻辑（见 watcher.maybeHealStuckShell），
 * 因为它要区分"卡死"和"用户正手打多行"，不能一见续行就按——所以两者没合并成一个。
 *
 * @returns healed=true 表示确实检测到卡死并已 Ctrl-C；getHistory 失败 / 没卡 → healed=false。
 */
export async function healIfWedged(tty: string): Promise<{ healed: boolean; prompt?: string }> {
  let hist: string;
  try {
    hist = await getHistory(tty);
  } catch {
    return { healed: false };
  }
  const { wedged, prompt } = detectWedge(hist);
  if (!wedged) return { healed: false };
  try {
    await sendCtrlC(tty);
    logger.info('healIfWedged: Ctrl-C sent to stuck shell', { tty, prompt });
    return prompt ? { healed: true, prompt } : { healed: true };
  } catch (e) {
    logger.warn('healIfWedged: Ctrl-C failed', { tty, err: (e as Error).message });
    return { healed: false };
  }
}
