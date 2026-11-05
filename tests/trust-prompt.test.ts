import { describe, expect, it } from 'vitest';
import { acceptTrustPrompt, agentInputReady, parseTrustPrompt } from '../packages/orchestrator/src/agents/trust-prompt.js';

const BORDER = '─'.repeat(120);

// 2026-11-05 Claude Code 2.1.280 在未信任目录里的真实屏幕（readScreen 抓取，节选）
const CLAUDE_TRUST_NO = [
  'zhengjiquan@MacBook-Pro untrusted-dir % claude',
  BORDER,
  ' Accessing workspace:',
  '',
  ' /private/tmp/untrusted-dir',
  '',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what\'s in this folder first.',
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' Security guide',
  '',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel',
  '',
].join('\n');

const CLAUDE_TRUST_YES = CLAUDE_TRUST_NO
  .replace(' ❯ No, exit', '   No, exit')
  .replace('   Yes, I trust this folder', ' ❯ Yes, I trust this folder');

// 选完 Yes 后：contents 里还留着旧提示的残影，下面是 claude 主界面
const CLAUDE_MAIN_AFTER_TRUST = [
  CLAUDE_TRUST_NO,
  '▗ ▗   ▖ ▖  Claude Code v2.1.280',
  BORDER,
  '❯ ',
  BORDER,
  '  [Opus 5.5 (1M context)] │ untrusted-dir',
  '  ⏵⏵ auto mode on (shift+tab to cycle)',
].join('\n');

const OLD_NUMBERED = [
  ' Do you trust the files in this folder?',
  ' ❯ 1. Yes, proceed',
  '   2. No, exit',
  ' Enter to confirm · Esc to exit',
].join('\n');

describe('parseTrustPrompt', () => {
  it('2.1.280 默认高亮 No', () => {
    expect(parseTrustPrompt(CLAUDE_TRUST_NO)).toEqual({ cursor: 'no' });
  });
  it('光标在 Yes', () => {
    expect(parseTrustPrompt(CLAUDE_TRUST_YES)).toEqual({ cursor: 'yes' });
  });
  it('老版本带编号的选项', () => {
    expect(parseTrustPrompt(OLD_NUMBERED)).toEqual({ cursor: 'yes' });
  });
  it('提示残影上方、主界面输入框在下 → 不算提示（防往输入框里按「下+回车」）', () => {
    expect(parseTrustPrompt(CLAUDE_MAIN_AFTER_TRUST)).toBeNull();
  });
  it('命令审批菜单即使上方出现 trust 字样也不算（防替人批准高危命令）', () => {
    const approval = [
      ' I will trust this folder config and run the cleanup.',
      ' Bash command: rm -rf build',
      ' Do you want to proceed?',
      ' ❯ 1. Yes',
      "   2. Yes, and don't ask again for rm commands",
      '   3. No, and tell Claude what to do differently (esc)',
    ].join('\n');
    expect(parseTrustPrompt(approval)).toBeNull();
    const approvalNoCursor = approval.replace(' ❯ 1. Yes', '   1. Yes').replace('   3. No, and tell', ' ❯ 3. No, and tell');
    expect(parseTrustPrompt(approvalNoCursor)).toBeNull();
  });
  it('只有一个已知选项、没有另一个选项 → null', () => {
    expect(parseTrustPrompt(' Is this a project you created or one you trust?\n ❯ No, exit\n')).toBeNull();
  });
  it('正文离光标行太远（scrollback 里的旧字样）→ null', () => {
    const far = [' one you trust', ...Array(20).fill(' 无关输出'), ' ❯ No, exit', '   Yes, I trust this folder'].join('\n');
    expect(parseTrustPrompt(far)).toBeNull();
  });
  it('裸 shell / 没有信任正文的菜单 → null', () => {
    expect(parseTrustPrompt('user@mac ~ % claude\n')).toBeNull();
    expect(parseTrustPrompt(' Allow this command?\n ❯ 1. Yes\n   2. No\n')).toBeNull();
  });
});

describe('agentInputReady', () => {
  it('主界面空输入框', () => {
    expect(agentInputReady(CLAUDE_MAIN_AFTER_TRUST)).toBe(true);
  });
  it('输入框里有占位文字也算（下方紧跟边框）', () => {
    expect(agentInputReady(`${BORDER}\n❯ Try "fix lint errors"\n${BORDER}\n`)).toBe(true);
  });
  it('停在信任提示上不算', () => {
    expect(agentInputReady(CLAUDE_TRUST_NO)).toBe(false);
  });
});

function fakeIO(screens: string[]) {
  const presses: string[] = [];
  let i = 0;
  let current = screens[0]!;
  return {
    presses,
    io: {
      readScreen: async () => {
        current = screens[Math.min(i++, screens.length - 1)]!;
        return current;
      },
      pressEnter: async () => { presses.push('enter'); },
      pressDownEnter: async () => { presses.push('down+enter'); },
      sleep: async () => {},
    },
  };
}

describe('acceptTrustPrompt', () => {
  it('光标在 No → 下+回车，之后提示消失 → accepted', async () => {
    const { io, presses } = fakeIO(['user % claude', CLAUDE_TRUST_NO, CLAUDE_MAIN_AFTER_TRUST]);
    expect(await acceptTrustPrompt(io)).toBe('accepted');
    expect(presses).toEqual(['down+enter']);
  });
  it('光标在 Yes → 只按回车', async () => {
    const { io, presses } = fakeIO([CLAUDE_TRUST_YES, CLAUDE_MAIN_AFTER_TRUST]);
    expect(await acceptTrustPrompt(io)).toBe('accepted');
    expect(presses).toEqual(['enter']);
  });
  it('目录已信任（直接进主界面）→ none，一个键都不按', async () => {
    const { io, presses } = fakeIO([CLAUDE_MAIN_AFTER_TRUST]);
    expect(await acceptTrustPrompt(io)).toBe('none');
    expect(presses).toEqual([]);
  });
  it('作答没生效、提示一直在 → 最多按 2 次后 stuck', async () => {
    const { io, presses } = fakeIO([CLAUDE_TRUST_NO]);
    expect(await acceptTrustPrompt(io)).toBe('stuck');
    expect(presses).toEqual(['down+enter', 'down+enter']);
  });
  it('shell 提示符本身是 ❯ 的主题：最短等待前不早退，等到信任提示再作答', async () => {
    const { io, presses } = fakeIO(['❯ ', '❯ claude', '❯ claude', CLAUDE_TRUST_NO, CLAUDE_MAIN_AFTER_TRUST]);
    expect(await acceptTrustPrompt(io, { pollMs: 600, minReadyMs: 3000 })).toBe('accepted');
    expect(presses).toEqual(['down+enter']);
  });
  it('屏幕读不到 → unreadable，不按键', async () => {
    const presses: string[] = [];
    const out = await acceptTrustPrompt({
      readScreen: async () => { throw new Error('osascript failed'); },
      pressEnter: async () => { presses.push('enter'); },
      pressDownEnter: async () => { presses.push('down+enter'); },
      sleep: async () => {},
    });
    expect(out).toBe('unreadable');
    expect(presses).toEqual([]);
  });
});
