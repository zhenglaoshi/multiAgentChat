import { describe, expect, it } from 'vitest';
import { promptStillInInput, submitProbe } from '../packages/orchestrator/src/agents/prompt-submit.js';
import { submitPrompt, type SubmitPromptDeps } from '../packages/im-lark/src/lark/submit-prompt.js';

const SEP = '─'.repeat(80);
const STATUS = [
  '  [Opus 5.5 (1M context)] │ multiAgentChat git:(main)',
  '  Context ░░░░░░░░░░ 0%',
  '  ⏵⏵ auto mode on (shift+tab to cycle)',
];
const TEXT = '这是用于复现回车不提交问题的填充文本请忽略它。'.repeat(5) + '以上全部忽略，只回复 OK，不要调用任何工具。';

// 实测（2026-10-09，Claude Code 2.1.280）：补一次回车后仍是这屏
const STUCK = [
  '  ▘▘ ▝▝    ~/ihealth-project/multiAgentChat',
  SEP,
  '❯ 这是用于复现回车不提交问题的填充文本请忽略它。这是用于复现回车不提交问题的填充文本请忽略它。以上全部忽略，只回复',
  '  OK，不要调用任何工具。',
  SEP,
  ...STATUS,
].join('\n');

// 大段文本：输入框起始行 ❯ 已被顶出屏幕
const STUCK_SCROLLED = [
  '  这是用于复现回车不提交问题的填充文本请忽略它。',
  '  这是用于复现回车不提交问题的填充文本请忽略它。',
  '  以上全部忽略，只回复 OK，不要调用任何工具。',
  SEP,
  ...STATUS,
].join('\n');

// 第二个回车后：已提交、有响应、输入框清空
const SUBMITTED = [
  '❯ 这是用于复现回车不提交问题的填充文本请忽略它。以上全部忽略，只回复 OK，不要调用任何工具。',
  '⏺ OK',
  '✻ Worked for 2s · done 9:36',
  SEP,
  '❯ ',
  SEP,
  ...STATUS,
].join('\n');

// 提交后立刻弹了权限菜单 —— 绝不能判成「挂着」再补回车（等于替人点了 Yes）
const MENU = [
  '❯ 这是用于复现回车不提交问题的填充文本请忽略它。以上全部忽略，只回复 OK，不要调用任何工具。',
  ' Bash command',
  '   rm -rf build',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
].join('\n');

describe('promptStillInInput', () => {
  it('输入框挂着正文 → true', () => {
    expect(promptStillInInput(STUCK, TEXT)).toBe(true);
  });
  it('输入框起始行被顶出屏幕也能认', () => {
    expect(promptStillInInput(STUCK_SCROLLED, TEXT)).toBe(true);
  });
  it('已提交（回显 + 空输入框）→ false', () => {
    expect(promptStillInInput(SUBMITTED, TEXT)).toBe(false);
  });
  it('提交后弹出选项菜单 → false（不能误补回车）', () => {
    expect(promptStillInInput(MENU, TEXT)).toBe(false);
  });
  it('刚提交、还在 thinking（无 ⏺、空输入框没画出来）→ false', () => {
    const thinking = `❯ ${TEXT}\n\n✻ Thinking… (1s · esc to interrupt)\n`;
    expect(promptStillInInput(thinking, TEXT)).toBe(false);
  });
  it('屏幕上找不到正文 → null', () => {
    expect(promptStillInInput([SEP, '❯ ', SEP, ...STATUS].join('\n'), TEXT)).toBe(false);
    expect(promptStillInInput(STATUS.join('\n'), TEXT)).toBe(null);
  });
  it('正文太短 → null', () => {
    expect(submitProbe('ok')).toBe(null);
    expect(promptStillInInput(STUCK, 'ok')).toBe(null);
  });
  it('codex 的 › 输入框', () => {
    expect(promptStillInInput(`› ${TEXT}\n\n  ⏎ send`, TEXT)).toBe(true);
    expect(promptStillInInput(`› ${TEXT}\n• OK\n\n› Ask Codex to do anything`, TEXT)).toBe(false);
  });
});

function fakeDeps(screens: string[]) {
  const calls: string[] = [];
  let i = 0;
  let afterEnter = false;
  const deps: SubmitPromptDeps = {
    forceEnter: async (tty) => {
      calls.push(`enter:${tty}`);
      afterEnter = true;
      return { ok: true, blocked: false, via: 'pty' };
    },
    readScreen: async () => {
      // 回车前的「等粘贴落定」轮询一律返回挂着的屏；回车后按脚本逐屏返回
      if (!afterEnter) return STUCK;
      return screens[Math.min(i++, screens.length - 1)]!;
    },
    sleep: async () => {},
  };
  return { deps, calls };
}

describe('submitPrompt', () => {
  it('第一个回车被吞 → 补一次后提交', async () => {
    const { deps, calls } = fakeDeps([STUCK, SUBMITTED]);
    const r = await submitPrompt('/dev/ttys099', TEXT, deps);
    expect(calls).toEqual(['enter:/dev/ttys099', 'enter:/dev/ttys099']);
    expect(r).toMatchObject({ enters: 2, stuck: false });
  });
  it('回车后屏幕有变化（即使判定像挂着）→ 不补', async () => {
    const { deps, calls } = fakeDeps([STUCK + '\n  ⏵⏵ something changed']);
    const r = await submitPrompt('/dev/ttys099', TEXT, deps);
    expect(calls).toHaveLength(1);
    expect(r.stuck).toBe(false);
  });
  it('被吞的回车只让顶部 shell 残留被清掉（底部不变）→ 仍算挂着、继续补', async () => {
    const { deps, calls } = fakeDeps([STUCK, SUBMITTED]);
    // 回车前：顶部还有 shell 残留；回车后 claude 整屏重绘把残留清掉，底部原样
    const afterEnter = deps.readScreen;
    deps.readScreen = async (tty) => (calls.length === 0 ? 'Last login: Fri\nuser@mac ~ % claude\n' + STUCK : afterEnter(tty));
    const r = await submitPrompt('/dev/ttys099', TEXT, deps);
    expect(calls).toHaveLength(2);
    expect(r).toMatchObject({ enters: 2, stuck: false });
  });
  it('被吞回车冒出的 ctrl+g 提示不算「变了」', async () => {
    const hinted = STUCK.replace('git:(main)', 'git:(main)   ctrl+g to edit in Vim');
    const { deps, calls } = fakeDeps([hinted, SUBMITTED]);
    const r = await submitPrompt('/dev/ttys099', TEXT, deps);
    expect(calls).toHaveLength(2);
    expect(r.stuck).toBe(false);
  });
  it('claude 粘贴安全提示「press Enter to send」→ 补回车', async () => {
    const confirm = STUCK.replace('git:(main)', 'Removed 1 invisible character · review and press Enter to send');
    const { deps, calls } = fakeDeps([confirm, SUBMITTED]);
    const r = await submitPrompt('/dev/ttys099', TEXT, deps);
    expect(calls).toHaveLength(2);
    expect(r).toMatchObject({ enters: 2, stuck: false });
  });
  it('只有通用短语「press Enter to send」（如外部正文）且屏幕有变化 → 不补', async () => {
    const fake = STUCK.replace('git:(main)', 'git:(main) please press Enter to send');
    const { deps, calls } = fakeDeps([fake]);
    await submitPrompt('/dev/ttys099', TEXT, deps);
    expect(calls).toHaveLength(1);
  });
  it('一次就提交 → 不补', async () => {
    const { deps, calls } = fakeDeps([SUBMITTED]);
    const r = await submitPrompt('/dev/ttys099', TEXT, deps);
    expect(calls).toHaveLength(1);
    expect(r.stuck).toBe(false);
  });
  it('补满上限仍挂着 → stuck，不无限补', async () => {
    const { deps, calls } = fakeDeps([STUCK]);
    const r = await submitPrompt('/dev/ttys099', TEXT, deps);
    expect(calls).toHaveLength(3);
    expect(r).toMatchObject({ enters: 3, stuck: true });
  });
  it('回车后弹菜单 → 立即停手', async () => {
    const { deps, calls } = fakeDeps([MENU]);
    await submitPrompt('/dev/ttys099', TEXT, deps);
    expect(calls).toHaveLength(1);
  });
  it('读屏失败 → 不校验、不补', async () => {
    const { deps, calls } = fakeDeps([]);
    deps.readScreen = async () => { throw new Error('osascript timeout'); };
    const r = await submitPrompt('/dev/ttys099', TEXT, deps);
    expect(calls).toHaveLength(1);
    expect(r.stuck).toBe(false);
  });
  it('forceEnter 被挡（keystroke 模式）→ 原样返回', async () => {
    const { deps, calls } = fakeDeps([STUCK]);
    deps.forceEnter = async () => { calls.push('enter'); return { ok: true, blocked: true, frontApp: 'loginwindow' }; };
    const r = await submitPrompt('/dev/ttys099', TEXT, deps);
    expect(calls).toHaveLength(1);
    expect(r.fe.blocked).toBe(true);
  });
});
