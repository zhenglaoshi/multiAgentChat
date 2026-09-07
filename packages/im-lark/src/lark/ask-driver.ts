import { sendKeys, sendKeysRaw } from 'multiagent-host-mac';
import { logger } from 'multiagent-orchestrator';
import { buildDownEnterSeq, buildPtyDigit, resolveAskDriveMode, type AskDriveMode } from './ask-drive.js';

export interface AskDriveResult {
  via: AskDriveMode;
  /** 给回执用的简述，如 "pty 数字 2" / "↓×1+⏎" */
  how: string;
}

/**
 * 发送依赖。生产用真实的 host-mac 实现；单测注入假实现——**绝不能**让测试真去写某个 tty
 * （曾经用 vi.mock 拦 workspace 包没生效，真把数字写进了正在跑测试的那个 tab）。
 */
export interface AskDriveDeps {
  sendKeysRaw: (tty: string, text: string) => Promise<boolean>;
  sendKeys: (tty: string, tokens: string | string[]) => Promise<void>;
}

const REAL_DEPS: AskDriveDeps = { sendKeysRaw, sendKeys };

/**
 * 驱动源 shell 里 claude 的原生 AskUserQuestion 菜单选中第 `index`（0-based）项。
 * 默认 pty 直写数字（锁屏可用、无假成功）；`MCHAT_ASK_DRIVE=keys` 或数字越界（index ≥ 9）退回方向键。
 * 失败抛错（tab 不存在等），调用方负责回执。
 */
export async function driveAskSelect(
  tty: string,
  index: number,
  deps: AskDriveDeps = REAL_DEPS,
): Promise<AskDriveResult> {
  const mode = resolveAskDriveMode();
  const digit = mode === 'pty' ? buildPtyDigit(index) : null;
  if (digit !== null) {
    const sent = await deps.sendKeysRaw(tty, digit);
    if (!sent) throw new Error(`tab ${tty} 不存在`);
    logger.info('ask drive (pty digit)', { tty, index, digit });
    return { via: 'pty', how: `pty 数字 ${digit}` };
  }
  if (mode === 'pty') logger.warn('ask drive: index 超出数字快捷键范围，退回方向键', { tty, index });
  await deps.sendKeys(tty, buildDownEnterSeq(index));
  logger.info('ask drive (keys)', { tty, index });
  return { via: 'keys', how: `↓×${index}+⏎` };
}
