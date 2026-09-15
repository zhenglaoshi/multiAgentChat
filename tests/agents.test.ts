import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  detectAgentFromProcs,
  getAgentAdapter,
  claudeAdapter,
  codexAdapter,
  shouldSubmitPromptAfterSend,
  resolveDefaultAgentKind,
  inferTabStatusFrom,
} from '../packages/orchestrator/src/agents/index.js';

describe('adapter.detect', () => {
  it('claude 进程名', () => {
    expect(claudeAdapter.detect('claude')).toBe(true);
    expect(claudeAdapter.detect('claude-code')).toBe(true);
    expect(claudeAdapter.detect('/usr/local/bin/claude')).toBe(true);
    expect(claudeAdapter.detect('-zsh')).toBe(false);
    expect(claudeAdapter.detect('codex')).toBe(false);
  });

  it('codex 进程名', () => {
    expect(codexAdapter.detect('codex')).toBe(true);
    expect(codexAdapter.detect('codex-cli')).toBe(true);
    expect(codexAdapter.detect('/opt/homebrew/bin/codex')).toBe(true);
    expect(codexAdapter.detect('claude')).toBe(false);
  });
});

describe('detectAgentFromProcs', () => {
  it('识别 claude / codex / 无', () => {
    expect(detectAgentFromProcs(['-zsh', 'claude'])?.kind).toBe('claude');
    expect(detectAgentFromProcs(['node', 'codex'])?.kind).toBe('codex');
    expect(detectAgentFromProcs(['-zsh', 'login'])).toBeNull();
  });

  it('claude 优先级在 codex 之前（都在时取 claude）', () => {
    expect(detectAgentFromProcs(['claude', 'codex'])?.kind).toBe('claude');
  });

  it('大小写混入路径也能识别', () => {
    expect(detectAgentFromProcs(['/Users/x/.local/bin/claude'])?.kind).toBe('claude');
  });
});

describe('shouldSubmitPromptAfterSend', () => {
  it('codex TUI 发送文本后需要补回车', () => {
    expect(shouldSubmitPromptAfterSend(['-zsh', 'codex'])).toBe(true);
  });

  it('claude 保持发送文本后补回车的行为', () => {
    expect(shouldSubmitPromptAfterSend(['-zsh', 'claude'])).toBe(true);
  });

  it('裸 shell 不补回车', () => {
    expect(shouldSubmitPromptAfterSend(['-zsh'])).toBe(false);
  });
});

describe('resolveDefaultAgentKind', () => {
  it('未设 → claude（保持历史行为）', () => {
    expect(resolveDefaultAgentKind({})).toBe('claude');
  });

  it('MCHAT_DEFAULT_AGENT=codex → codex', () => {
    expect(resolveDefaultAgentKind({ MCHAT_DEFAULT_AGENT: 'codex' })).toBe('codex');
    expect(resolveDefaultAgentKind({ MCHAT_DEFAULT_AGENT: '  CODEX ' })).toBe('codex');
  });

  it('值非法 → 回落 claude，不抛', () => {
    expect(resolveDefaultAgentKind({ MCHAT_DEFAULT_AGENT: 'gemini' })).toBe('claude');
    expect(resolveDefaultAgentKind({ MCHAT_DEFAULT_AGENT: '' })).toBe('claude');
  });
});

describe('systemGuidance / tuiReminder 按 agent 分流', () => {
  // codex 没有 AskUserQuestion 这个工具，也没有对应的飞书镜像通道；
  // 一旦文案漏进 codex，agent 会去调一个不存在的东西，用户在手机端就收不到选项。
  it('claude 版教用原生 AskUserQuestion', () => {
    expect(claudeAdapter.systemGuidance).toContain('AskUserQuestion');
    expect(claudeAdapter.tuiReminder).toContain('AskUserQuestion');
  });

  it('codex 版**完全不提** AskUserQuestion，改成一律走 agent lark ask', () => {
    expect(codexAdapter.systemGuidance).not.toContain('AskUserQuestion');
    expect(codexAdapter.tuiReminder).not.toContain('AskUserQuestion');
    expect(codexAdapter.systemGuidance).toContain('agent lark ask');
    expect(codexAdapter.tuiReminder).toContain('agent lark ask');
  });

  it('两版都保留「先在 TUI 回答、再推飞书」的首要原则', () => {
    for (const a of [claudeAdapter, codexAdapter]) {
      expect(a.systemGuidance).toContain('agent lark send-text');
      expect(a.systemGuidance).toContain('两个渠道并行输出');
      expect(a.tuiReminder).toContain('agent lark send-text');
    }
  });
});

describe('hookInstall 规格', () => {
  it('claude 的 5 条 hook 与历史安装逐条一致（顺序也一致）', () => {
    // 这组值就是过去写死在 daemon installClaudeCodeHooks 里的那五条。
    // 改动会直接改变用户 ~/.claude/settings.json 的内容，所以钉死。
    expect(claudeAdapter.hookInstall.configPathFromHome).toBe('.claude/settings.json');
    expect(claudeAdapter.hookInstall.format).toBe('claude-settings-json');
    expect(
      claudeAdapter.hookInstall.specs.map((s) => [s.event, s.matcher, s.script]),
    ).toEqual([
      ['Stop', '*', 'mchat-stop-hook'],
      ['PreToolUse', 'AskUserQuestion', 'mchat-pretooluse-hook'],
      ['PostToolUse', 'AskUserQuestion', 'mchat-posttooluse-hook'],
      ['PreToolUse', 'Bash', 'mchat-permission-hook'],
      ['PreToolUse', 'Task', 'mchat-task-hook'],
    ]);
  });

  it('claude 侧不落 timeout（保持既有 settings.json 写法）', () => {
    for (const s of claudeAdapter.hookInstall.specs) {
      expect(s.timeoutSec).toBeUndefined();
    }
  });

  it('codex 装 Stop 回传 + PreToolUse 审批闸，复用同一批脚本', () => {
    expect(codexAdapter.hookInstall.configPathFromHome).toBe('.codex/config.toml');
    expect(codexAdapter.hookInstall.format).toBe('codex-config-toml');
    expect(
      codexAdapter.hookInstall.specs.map((s) => [s.event, s.matcher, s.script]),
    ).toEqual([
      ['Stop', '.*', 'mchat-stop-hook'],
      ['PreToolUse', '.*', 'mchat-permission-hook'],
    ]);
  });

  it('codex 的 matcher 必须是合法正则，且不能写成 claude 的字面量 *', () => {
    for (const s of codexAdapter.hookInstall.specs) {
      // codex 把 matcher 包成 \A(?:…)\z 全值匹配；裸 '*' 是非法正则，会让这条 hook 直接失效
      expect(s.matcher).not.toBe('*');
      expect(() => new RegExp(`^(?:${s.matcher})$`)).not.toThrow();
    }
  });

  it('codex 的审批闸是阻塞型 → timeout 必须盖得住 5min 的审批等待', () => {
    const gate = codexAdapter.hookInstall.specs.find((s) => s.script === 'mchat-permission-hook');
    expect(gate?.timeoutSec).toBeGreaterThanOrEqual(300);
  });
});

describe('getAgentAdapter + launchCommand', () => {
  it('codex 启动/续接命令', () => {
    expect(getAgentAdapter('codex')!.launchCommand()).toBe('codex');
    expect(getAgentAdapter('codex')!.launchCommand({ continueSession: true })).toBe('codex resume --last');
  });

  it('claude 启动/续接命令', () => {
    expect(getAgentAdapter('claude')!.launchCommand()).toBe('claude');
    expect(getAgentAdapter('claude')!.launchCommand({ continueSession: true })).toBe('claude --continue');
  });

  it('未知 kind 返回 undefined', () => {
    // @ts-expect-error 故意传非法 kind
    expect(getAgentAdapter('bogus')).toBeUndefined();
  });
});

describe('claude guidance 防回归（byte-identical 锁）', () => {
  // 这两段文案是**注入进线上 claude 会话的 prompt**，此前写死在 im-lark/lark/handlers.ts。
  // C5 把它们搬进 orchestrator/agents/guidance.ts 时要求逐字节不变（已用 git HEAD 版本实测比对通过）。
  // 这里用长度 + sha256 钉住：不是为了禁止修改，而是**让修改必须是有意的** ——
  // 改文案 = 改所有 claude 会话的行为，顺手"优化"措辞不该悄悄溜过去。
  // 真要改：确认是有意的，然后把下面两个值一起更新，并在 CHANGELOG 里写清改了什么、为什么。
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');

  it('SYSTEM_GUIDANCE 未被无意改动', () => {
    expect(claudeAdapter.systemGuidance).toHaveLength(2174);
    expect(sha(claudeAdapter.systemGuidance)).toBe(
      '5322032ca570b99c8fa6bcf7f263589ad7f175b8303d4a2c0f1c38c2bb3e4c73',
    );
  });

  it('短提醒未被无意改动', () => {
    expect(claudeAdapter.tuiReminder).toHaveLength(242);
    expect(sha(claudeAdapter.tuiReminder)).toBe(
      '3d876f178c84d2700aec002babadb359e6ebadbf962fe4c2e2c8fb1d52552379',
    );
  });
});

describe('detectAgentFromProcs · 真实 listTabs 样本（防收窄回归）', () => {
  // C5 把 handlers/watcher/notifier 里原本各自内联的**宽松**判定
  //   /(^|\/)claude(-code)?$/i.test(p) || p.toLowerCase().includes('claude')
  // 统一换成了 adapter 的**精确**匹配。code review 提醒这是一次收窄，可能让某些 tab
  // 被误判成裸 shell（guidance 不注入、回车不补）。
  //
  // 下面是 2026-09-14 本机 `listTabs()` 的真实输出（7 个 claude tab + 3 个裸 shell），
  // 实测精确匹配全部命中 —— 收窄不影响真实进程名。样本钉在这里防以后再收窄出问题。
  const REAL_SAMPLES: Array<[string[], 'claude' | null]> = [
    [['login', '-zsh', 'claude', 'uv', 'Python'], 'claude'],
    [['login', '-zsh', 'claude', 'uv', 'Python', 'node'], 'claude'],
    [['login', '-zsh', 'claude', 'uv', 'Python', 'caffeinate'], 'claude'],
    [['login', '-zsh'], null],
  ];

  it('claude tab 的进程列表里 claude 不在末位也要认出来', () => {
    for (const [procs, expected] of REAL_SAMPLES) {
      expect(detectAgentFromProcs(procs)?.kind ?? null).toBe(expected);
    }
  });

  it('codex tab 同理（codex 也会被 uv/node 等子进程跟在后面）', () => {
    expect(detectAgentFromProcs(['login', '-zsh', 'codex', 'node'])?.kind).toBe('codex');
    expect(detectAgentFromProcs(['login', '-zsh', 'codex'])?.kind).toBe('codex');
  });

  it('不能把只是名字里含 claude 的无关进程当成 agent', () => {
    // 旧的宽松正则有 .includes('claude') 兜底，会把这些也算上
    expect(detectAgentFromProcs(['login', '-zsh', 'claude-hud'])).toBeNull();
    expect(detectAgentFromProcs(['login', '-zsh', 'my-claude-wrapper.py'])).toBeNull();
  });
});

describe('codex 原生审批菜单必须被认成「等输入」（2026-09-14 真机截图回归）', () => {
  // 用户截图里的真实屏幕：7 条通用判据当时一条都不命中 → 飞书连"在等你选"的提示都收不到
  const CODEX_APPROVAL_SCREEN = [
    'Would you like to run the following command?',
    '',
    'Environment: local',
    '',
    'Reason: 允许我继续使用一个独立命名的临时 tmux server',
    '',
    '$ set -e',
    'sock="mchat-review-$$"',
    '',
    '› 1. Yes, proceed (y)',
    '  2. No, and tell Codex what to do differently (esc)',
    '',
    'Press enter to confirm or esc to cancel',
  ].join('\n');

  it('跑着 codex 时识别为 claude-waiting', () => {
    const st = inferTabStatusFrom({ processes: ['-zsh', 'codex'], busy: true }, CODEX_APPROVAL_SCREEN);
    expect(st.kind).toBe('claude-waiting');
  });

  it('三条特征各自都能单独命中（任一行被截断也不至于漏判）', () => {
    for (const line of [
      'Would you like to run the following command?',
      '› 1. Yes, proceed (y)',
      'Press enter to confirm or esc to cancel',
    ]) {
      expect(inferTabStatusFrom({ processes: ['codex'], busy: true }, line).kind).toBe('claude-waiting');
    }
  });

  it('小写 press enter 也要认（原来只认大写 Enter，这正是漏判的根因之一）', () => {
    expect(inferTabStatusFrom({ processes: ['codex'], busy: true }, 'press enter to continue').kind)
      .toBe('claude-waiting');
  });

  it('普通输出不误判成等输入（假阳性在本项目有前科）', () => {
    const normal = '正在安装依赖...\nAdded 12 packages.\n1. 先跑 typecheck\n2. 再跑测试\nDone in 3.2s';
    expect(inferTabStatusFrom({ processes: ['codex'], busy: true }, normal).kind).toBe('claude-active');
  });
});

describe('状态判据的取景框必须有界（评审 2026-09-15 medium 回归）', () => {
  // fleet-monitor 传的是 watcher 缓存的**完整历史**，tmux 的 capture-pane 还可能带很长 scrollback。
  // 一次早已答完的审批若永远留在历史里，会让该 tab 长期显示"codex 等输入"——
  // /shells 状态错，fleet-monitor 也不再按 claude-active 处理它、漏掉卡住检测。
  const OLD_APPROVAL = [
    'Would you like to run the following command?',
    '› 1. Yes, proceed (y)',
    '  2. No (esc)',
    'Press enter to confirm or esc to cancel',
    'yes',
    '(command finished)',
  ].join('\n');

  it('陈旧审批 + 大量后续输出 → 不再误判成等输入', () => {
    const hist = [OLD_APPROVAL, ...Array(120).fill('... 正常构建输出 ...')].join('\n');
    expect(inferTabStatusFrom({ processes: ['codex'], busy: true }, hist).kind).toBe('claude-active');
  });

  it('审批就在尾部时仍然正确判为等输入（没有误伤真实场景）', () => {
    const hist = [...Array(120).fill('... 正常构建输出 ...'), OLD_APPROVAL.split('\n').slice(0, 4).join('\n')].join('\n');
    expect(inferTabStatusFrom({ processes: ['codex'], busy: true }, hist).kind).toBe('claude-waiting');
  });
});
