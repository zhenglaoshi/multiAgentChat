/**
 * 执行层：拿飞书表单答案，用真按键把终端里**正弹着**的 AskUserQuestion 多问题 / 多选原生菜单按完。
 * 按键规则与为什么只能走 System Events / tmux send-keys，见 orchestrator/ask/native-drive.ts 顶部。
 *
 * 闸门（任一不过就不按，fail-closed —— 往错的地方打数字比不按更糟）：
 *   1. 按键计划能完整生成（答案都在选项范围内、没有多选题的自由输入等）
 *   2. 目标 tab 当前跑的确实是 claude（不是裸 shell / 别的程序）
 *   3. 宿主按键会被锁屏挡住（macOS）时，确认**没锁屏**；判断不了也不按（锁屏下 System Events 会假成功）
 *   4. 屏幕尾部正是那个菜单、且一题都还没答（人可能已经在终端里答了一部分）
 *   5. **每一步发键前**再确认菜单还贴底弹着 —— 中途人按了 Esc / claude 崩回裸 shell 时，后面的
 *      「粘贴自由文本 + Enter」会落进 shell 被当命令执行（安全评审 2026-09-24；与公函「写终端前确认 tab 跑的还是 agent」同源）
 *
 * 依赖全部注入：单测**绝不能**真去写某个 tty（曾用 vi.mock 拦 workspace 包没生效，真把数字写进了跑测试的 tab）。
 */

import {
  buildNativeAskKeyPlan,
  detectAgentFromProcs,
  isFreshNativeAskScreen,
  isNativeMenuShowing,
  logger,
  type AskAnswerForm,
  type AskFormQuestion,
} from 'multiagent-orchestrator';
import { getHistory, hostCapabilities, isScreenLocked, listTabsRaw, pasteText, sendKeys } from 'multiagent-host-api';

export interface NativeAskDriveDeps {
  getHistory: (tty: string) => Promise<string>;
  /** 目标 tab 当前是否在跑 claude（原生多问题菜单只有 claude 有） */
  tabRunsClaude: (tty: string) => Promise<boolean>;
  isScreenLocked: () => Promise<boolean | null>;
  keyInjectionBlockedWhenLocked: () => boolean;
  sendKeys: (tty: string, tokens: string[]) => Promise<void>;
  pasteText: (tty: string, text: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

const REAL_DEPS: NativeAskDriveDeps = {
  getHistory,
  tabRunsClaude: async (tty) => {
    const tab = (await listTabsRaw()).find((t) => t.tty === tty);
    return !!tab && detectAgentFromProcs(tab.processes)?.kind === 'claude';
  },
  isScreenLocked: () => isScreenLocked(),
  keyInjectionBlockedWhenLocked: () => hostCapabilities().keyInjectionBlockedWhenLocked,
  // 120ms 间隔：claude TUI 每个键都要重绘一次，太快会被合并读取（合并后按「块开始时的状态」处理，见 native-drive.ts）
  sendKeys: (tty, tokens) => sendKeys(tty, tokens, { intervalMs: 120 }),
  pasteText,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * 菜单是否还弹着 —— 给重绘留时间再下结论。每按一个键 claude 都会清屏重绘一次（单选翻页尤其明显），
 * 恰好读在重绘中间时尾部不是提示行：真机首测就是这样被误判成「菜单没了」、按了一个键就停手的
 * （同一毫秒 watcher 报了「屏幕缓冲区回缩」）。连续 ~2s 都看不到才算真没了。
 */
async function menuStillShowing(tty: string, deps: NativeAskDriveDeps): Promise<boolean> {
  for (let i = 0; i < MENU_RECHECK_TRIES; i++) {
    if (isNativeMenuShowing(await deps.getHistory(tty))) return true;
    await deps.sleep(MENU_RECHECK_INTERVAL_MS);
  }
  return false;
}
const MENU_RECHECK_TRIES = 8;
const MENU_RECHECK_INTERVAL_MS = 250;

export type NativeAskDriveResult = { ok: true } | { ok: false; reason: string; sent: boolean };

export async function driveNativeAsk(
  tty: string,
  questions: readonly AskFormQuestion[],
  answer: AskAnswerForm,
  deps: NativeAskDriveDeps = REAL_DEPS,
): Promise<NativeAskDriveResult> {
  const plan = buildNativeAskKeyPlan(questions, answer.items);
  if (!plan.ok) return { ok: false, reason: plan.reason, sent: false };
  if (!(await deps.tabRunsClaude(tty))) {
    return { ok: false, sent: false, reason: '那个终端 tab 里已经不是 claude 在跑了' };
  }

  if (deps.keyInjectionBlockedWhenLocked()) {
    const locked = await deps.isScreenLocked();
    if (locked !== false) {
      return {
        ok: false,
        sent: false,
        reason: locked ? '电脑锁屏了，按键送不进终端' : '判断不了电脑是否锁屏，为免假成功没有按键',
      };
    }
  }

  if (!isFreshNativeAskScreen(await deps.getHistory(tty), questions)) {
    return { ok: false, sent: false, reason: '终端里的菜单已经关了，或已经在电脑上答了一部分' };
  }

  let first = true;
  for (const step of plan.steps) {
    // 第一步前刚做过完整检查；之后每步前确认菜单还弹着（中途被关 / 崩回 shell → 立刻停手）
    if (!first && !(await menuStillShowing(tty, deps))) {
      return { ok: false, sent: true, reason: '按到一半终端里的菜单没了，已停止按键，请到电脑上看一眼' };
    }
    first = false;
    if (step.kind === 'keys') await deps.sendKeys(tty, step.tokens);
    else await deps.pasteText(tty, step.text);
    // 等这一键的重绘落定再发下一步（太快会被 TUI 合并读取，见 native-drive.ts 顶部）
    await deps.sleep(300);
  }
  logger.info('native ask drive: keys sent', { tty, steps: plan.steps.length });

  // 提交后菜单应当消失；还在说明某一步没按进去（焦点被抢 / 菜单版本变了），如实告诉人去看一眼
  await deps.sleep(1200);
  if (isNativeMenuShowing(await deps.getHistory(tty))) {
    return { ok: false, sent: true, reason: '按键已发出，但终端里的菜单好像还在，请到电脑上看一眼' };
  }
  return { ok: true };
}
