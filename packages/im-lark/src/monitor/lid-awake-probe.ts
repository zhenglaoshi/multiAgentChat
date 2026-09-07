import { platform } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';
import { logger } from 'multiagent-orchestrator';
import { detectLidAwake, LID_AWAKE_INSTALL_CMD } from 'multiagent-host-mac';
import { listAllChats } from '../chats/store.js';
import { sendTextMessage } from '../lark/api.js';

/**
 * 启动时探一次「插电合盖也能远程」守护装没装（笔记本才关心）。没装 → 推一条飞书提示，附一行安装命令。
 *
 * 为什么只能「提示」不能「自动装」：装守护要 sudo（改 pmset disablesleep 需要 root），daemon 以普通用户跑，拿不到。
 * 所以做成：首次装项目时 `scripts/launchd-setup.sh install` 会顺带问要不要装；漏了的话这里每 3 天在飞书提醒一次。
 *
 * 节流状态落 ./data/lid-awake-nudge.json（跟 fleet-monitor 同款 cwd 相对路径）。`LID_AWAKE_NUDGE=0` 关闭。
 */
const STATE_FILE = resolve('./data/lid-awake-nudge.json');
const NUDGE_INTERVAL_MS = 3 * 24 * 60 * 60_000;
const STARTUP_DELAY_MS = 30_000;

interface NudgeState {
  lastAt: number;
}

function readState(): NudgeState {
  try {
    if (!existsSync(STATE_FILE)) return { lastAt: 0 };
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Partial<NudgeState>;
    return { lastAt: typeof raw.lastAt === 'number' ? raw.lastAt : 0 };
  } catch {
    return { lastAt: 0 };
  }
}

function writeState(s: NudgeState): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(s), 'utf8');
  } catch (e) {
    logger.warn('lid-awake nudge 状态落盘失败', { err: (e as Error).message });
  }
}

/** 提示文案。纯函数，便于单测/复用。 */
export function buildLidAwakeNudge(sleepDisabled: boolean | null): string {
  const head = sleepDisabled
    ? '🔌 检测到你手动开了全局 disablesleep=1（合盖不睡），但没装随电源自动切换的守护——**拔电放包里也不会睡**，会发热耗电。'
    : '🔌 这台是笔记本，还没装「插电合盖也能远程」守护——**合盖就睡、Wi-Fi 断，手机发的命令收不到**。';
  return (
    `${head}\n` +
    `一次性装好（需要在 Mac 前输一次 sudo 密码，之后开机自启）：\n` +
    `${LID_AWAKE_INSTALL_CMD}\n` +
    `效果：插电合盖只灭屏锁屏、不睡（配合回车 pty 直写，锁屏也照常执行）；拔电自动恢复默认合盖睡眠。\n` +
    `不想再看到这条：.env 里 LID_AWAKE_NUDGE=0`
  );
}

export function startLidAwakeProbe(client: Lark.Client): void {
  if (platform() !== 'darwin') {
    logger.info('lid-awake probe skipped (non-darwin)');
    return;
  }
  if (process.env['LID_AWAKE_NUDGE'] === '0') {
    logger.info('lid-awake probe disabled by LID_AWAKE_NUDGE=0');
    return;
  }
  const timer = setTimeout(async () => {
    try {
      const st = await detectLidAwake();
      if (!st.isLaptop) {
        logger.info('lid-awake probe：非笔记本，跳过');
        return;
      }
      if (st.installed) {
        if (st.running) {
          logger.info('lid-awake probe：守护在跑', { powerSource: st.powerSource, sleepDisabled: st.sleepDisabled });
        } else {
          logger.warn('lid-awake probe：守护 plist 在但没在跑（agent doctor 会标 warn）', { powerSource: st.powerSource });
        }
        return;
      }
      const state = readState();
      const now = Date.now();
      if (now - state.lastAt < NUDGE_INTERVAL_MS) {
        logger.info('lid-awake probe：守护未装，3 天内已提醒过，本次静默');
        return;
      }
      logger.warn('lid-awake probe：笔记本且守护未装 → 推飞书提示', { sleepDisabled: st.sleepDisabled });
      const chats = await listAllChats();
      if (chats.length === 0) {
        logger.warn('lid-awake probe：无 chat 可推送（下次启动再试）');
        return;
      }
      const text = buildLidAwakeNudge(st.sleepDisabled);
      for (const chat of chats) {
        try {
          await sendTextMessage(client, chat.chatId, text);
        } catch (e) {
          logger.warn('lid-awake 提示单 chat 推送失败', { chatId: chat.chatId, err: (e as Error).message });
        }
      }
      writeState({ lastAt: now });
    } catch (e) {
      logger.warn('lid-awake probe 失败（忽略）', { err: (e as Error).message });
    }
  }, STARTUP_DELAY_MS);
  timer.unref();
}
