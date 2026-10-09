import { forceEnter, readScreen, type ForceEnterResult } from 'multiagent-host-api';
import { awaitingConfirmEnter, logger, promptStillInInput, screenUnchanged, submitProbe } from 'multiagent-orchestrator';

/**
 * 把已经 `send()` 进 agent TUI 输入框的文本**真正提交**：等粘贴落定 → 补回车 → 读屏校验 → 没提交再补。
 *
 * 背景见 orchestrator/agents/prompt-submit.ts：Claude Code 2.1.280 粘贴后补的第一个 `\r` 只会触发
 * 「review and press Enter to send」确认提示，原来「send → 等 400/600ms → forceEnter 一次」的写法
 * 在文本稍长（实测 ≥143 字）时就整段挂在输入框里。
 */

export interface SubmitPromptDeps {
  forceEnter: (tty: string) => Promise<ForceEnterResult>;
  readScreen: (tty: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
}

/**
 * 发送依赖。生产用真实宿主；单测注入假实现——**绝不能**让测试真去写某个 tty
 * （见 ask-driver.ts 的教训：vi.mock 没拦住，真把字节写进了跑测试的 tab）。
 */
const REAL_DEPS: SubmitPromptDeps = {
  forceEnter: (tty) => forceEnter(tty),
  readScreen,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** 回车总次数上限（首发 + 补发）。实测大块文本最多要 3 个。 */
const MAX_ENTERS = 3;
/** 等粘贴落定：轮询屏幕直到正文末尾出现在屏幕上，避免回车被并进粘贴读取 */
const SETTLE_POLL_MS = 250;
const SETTLE_MAX_MS = 3000;
/** 两块写入之间的最小间隔（两块若被合并读取会整体当粘贴不提交） */
const MIN_GAP_MS = 400;
/** 回车后等 TUI 重绘再读屏 */
const VERIFY_DELAY_MS = 900;

export interface SubmitPromptResult {
  /** 最后一次 forceEnter 的结果（blocked / !ok 时调用方照旧告警） */
  fe: ForceEnterResult;
  /** 实际送了几个回车 */
  enters: number;
  /** 补满 MAX_ENTERS 次后屏幕上仍挂着文本 → 调用方应告知用户 */
  stuck: boolean;
}

async function screenOrNull(deps: SubmitPromptDeps, tty: string): Promise<string | null> {
  try {
    return await deps.readScreen(tty);
  } catch (e) {
    logger.warn('submitPrompt: 读屏失败，跳过校验', { tty, err: (e as Error).message });
    return null;
  }
}

export async function submitPrompt(
  tty: string,
  sentText: string,
  deps: SubmitPromptDeps = REAL_DEPS,
): Promise<SubmitPromptResult> {
  // 1) 等粘贴落定：正文末尾出现在屏幕上再回车（大块文本 TUI 要消化好一会儿）
  await deps.sleep(MIN_GAP_MS);
  const probe = submitProbe(sentText);
  let prev: string | null = null;
  if (probe) {
    for (let waited = MIN_GAP_MS; waited < SETTLE_MAX_MS; waited += SETTLE_POLL_MS) {
      prev = await screenOrNull(deps, tty);
      if (prev === null || prev.replace(/\s+/g, '').includes(probe)) break;
      await deps.sleep(SETTLE_POLL_MS);
    }
  }

  // 2) 回车 → 校验 → 没提交再补
  let fe: ForceEnterResult = { ok: false, blocked: false };
  for (let enters = 1; enters <= MAX_ENTERS; enters++) {
    fe = await deps.forceEnter(tty);
    if (!fe.ok || fe.blocked) return { fe, enters, stuck: false };
    await deps.sleep(VERIFY_DELAY_MS);
    const screen = await screenOrNull(deps, tty);
    // 补发只在两种情况下：claude 明确提示「press Enter to send」，或回车后屏幕底部毫无变化；
    // 两者都还要求正文仍在输入框。读不到 / 判断不了 / 有别的变化 → 都不再补
    // （宁可漏补，不能误补：提交后可能已弹出权限菜单，多补的 \r 等于替人点了默认项）
    const retryable = screen !== null && (awaitingConfirmEnter(screen) || (prev !== null && screenUnchanged(prev, screen)));
    prev = screen;
    if (!retryable || promptStillInInput(screen, sentText) !== true) {
      if (enters > 1) logger.info('submitPrompt: 补回车后已提交', { tty, enters });
      return { fe, enters, stuck: false };
    }
    logger.warn('submitPrompt: 回车后文本仍挂在输入框，补发回车', { tty, enters });
  }
  return { fe, enters: MAX_ENTERS, stuck: true };
}
