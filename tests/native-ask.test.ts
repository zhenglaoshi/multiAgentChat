import { describe, expect, it } from 'vitest';
// @ts-expect-error — 纯 JS 的 hook 共用模块，无类型声明
import { answersFromForm, isAway, isMultiAsk, parseHidIdleSec, parseScreenLocked, toFormSpec } from '../bin/lib/native-ask.mjs';
import {
  buildNativeAskKeyPlan,
  isFreshNativeAskScreen,
  isNativeMenuShowing,
  questionTextOf,
  type AskFormQuestion,
} from '../packages/orchestrator/src/ask/index.js';
import { driveNativeAsk, type NativeAskDriveDeps } from '../packages/framework/src/control/native-ask-drive.js';

const TOOL_INPUT = {
  questions: [
    { header: 'Color', question: 'Pick a color?', multiSelect: false, options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }] },
    { header: 'Fruits', question: 'Pick fruits?', multiSelect: true, options: [{ label: 'Apple' }, { label: 'Banana' }, { label: 'Cherry' }] },
  ],
};
const QUESTIONS: AskFormQuestion[] = [
  { title: '【Color】Pick a color?', type: 'single', options: ['Red', 'Green', 'Blue'], allowText: true },
  { title: '【Fruits】Pick fruits?', type: 'multi', options: ['Apple', 'Banana', 'Cherry'], allowText: true },
];

// 真机截下来的屏幕（Claude Code v2.1.280，Terminal history 尾部）
const FRESH_SCREEN = [
  '❯ Call the same AskUserQuestion again with the same 2 questions, nothing else.',
  '────────────────────────────────────────',
  '←  ☐ Color  ☐ Fruits  ✔ Submit  →',
  'Pick a color?',
  '❯ 1. Red',
  '     Vibrant',
  '  2. Green',
  '     Fresh',
  '  3. Blue',
  '     Cool',
  '  4. Type something.',
  '────────────────────────────────────────',
  '  5. Chat about this',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
].join('\n');
// Review 页（真机截的）：底部没有 Enter to select
const REVIEW_SCREEN = [
  '←  ☒ Color  ☒ Fruits  ✔ Submit  →',
  'Review your answers',
  ' ● Pick a color?',
  '   → Green',
  ' ● Pick fruits?',
  '   → Apple, Banana, Cherry',
  'Ready to submit your answers?',
  '❯ 1. Submit answers',
  '  2. Cancel',
].join('\n');
const PARTLY_ANSWERED = FRESH_SCREEN.replace('☐ Color', '☒ Color').replace('Pick a color?', 'Pick fruits?');
const MENU_GONE = [
  '⏺ User answered Claude\'s questions:',
  '  ⎿  · Pick a color? → Green',
  '     · Pick fruits? → Apple, Cherry',
  '❯ ',
].join('\n');

describe('hook 侧纯逻辑（bin/lib/native-ask.mjs）', () => {
  it('只接管多问题 / 含多选；单问题单选仍走原来的按钮卡', () => {
    expect(isMultiAsk(TOOL_INPUT)).toBe(true);
    expect(isMultiAsk({ questions: [TOOL_INPUT.questions[1]] })).toBe(true);
    expect(isMultiAsk({ questions: [TOOL_INPUT.questions[0]] })).toBe(false);
    expect(isMultiAsk({})).toBe(false);
  });

  it('toFormSpec：标题带 header，每题允许自由输入；缺选项的题不接管', () => {
    expect(toFormSpec(TOOL_INPUT)).toEqual({ questions: QUESTIONS });
    expect(toFormSpec({ questions: [{ question: 'x', options: [] }, TOOL_INPUT.questions[1]] })).toBeNull();
  });

  it('answersFromForm：单选取值、多选用 ", " 连接、自由输入取文字（与原生菜单提交格式一致）', () => {
    expect(answersFromForm(TOOL_INPUT, [
      { q: 0, kind: 'single', index: 1, value: 'Green' },
      { q: 1, kind: 'multi', indices: [0, 2], values: ['Apple', 'Cherry'] },
    ])).toEqual({ 'Pick a color?': 'Green', 'Pick fruits?': 'Apple, Cherry' });
    expect(answersFromForm(TOOL_INPUT, [
      { q: 0, kind: 'text', text: ' 紫色 ' },
      { q: 1, kind: 'multi', indices: [1], values: ['Banana'] },
    ])).toEqual({ 'Pick a color?': '紫色', 'Pick fruits?': 'Banana' });
  });

  it('answersFromForm：有题没答 / 空答案 → null（宁可退回原生菜单，不替人编答案）', () => {
    expect(answersFromForm(TOOL_INPUT, [{ q: 0, kind: 'single', index: 0, value: 'Red' }])).toBeNull();
    expect(answersFromForm(TOOL_INPUT, [
      { q: 0, kind: 'text', text: '   ' },
      { q: 1, kind: 'multi', indices: [0], values: ['Apple'] },
    ])).toBeNull();
    expect(answersFromForm(TOOL_INPUT, undefined)).toBeNull();
  });

  it('在场判断：锁屏或闲置超阈值 = 不在；信号拿不到按「在」处理（不阻塞会话）', () => {
    expect(isAway({ locked: true, idleSec: 0 }, 180)).toBe(true);
    expect(isAway({ locked: false, idleSec: 200 }, 180)).toBe(true);
    expect(isAway({ locked: false, idleSec: 5 }, 180)).toBe(false);
    expect(isAway({}, 180)).toBe(false);
  });

  it('ioreg 解析', () => {
    expect(parseScreenLocked('<key>CGSSessionScreenIsLocked</key>\n\t<true/>')).toBe(true);
    expect(parseScreenLocked('<key>Other</key><true/>')).toBe(false);
    expect(parseHidIdleSec('    | |     "HIDIdleTime" = 4679618043')).toBeCloseTo(4.68, 2);
    expect(parseHidIdleSec('nothing')).toBeNull();
  });
});

describe('按键计划（真机逐键验证过的序列）', () => {
  it('单选 2 + 多选 1、3 → 2 / 1 3 tab / 1（提交）', () => {
    const plan = buildNativeAskKeyPlan(QUESTIONS, [
      { q: 0, kind: 'single', index: 1, value: 'Green' },
      { q: 1, kind: 'multi', indices: [2, 0], values: ['Cherry', 'Apple'] },
    ]);
    expect(plan).toEqual({
      ok: true,
      steps: [
        { kind: 'keys', tokens: ['2'] },
        { kind: 'keys', tokens: ['1', '3', 'tab'] },
        { kind: 'keys', tokens: ['1'] },
      ],
    });
  });

  it('单选题自由输入 → n+1 进 Type something、粘贴文字、回车', () => {
    const plan = buildNativeAskKeyPlan(QUESTIONS, [
      { q: 0, kind: 'text', text: '紫色 带空格' },
      { q: 1, kind: 'multi', indices: [0], values: ['Apple'] },
    ]);
    expect(plan.ok && plan.steps.slice(0, 3)).toEqual([
      { kind: 'keys', tokens: ['4'] },
      { kind: 'paste', text: '紫色 带空格' },
      { kind: 'keys', tokens: ['enter'] },
    ]);
  });

  it('fail-closed：多选题的自由输入 / 越界下标 / 多选一项没选 / 缺题', () => {
    expect(buildNativeAskKeyPlan(QUESTIONS, [
      { q: 0, kind: 'single', index: 0 },
      { q: 1, kind: 'text', text: 'Mango' },
    ]).ok).toBe(false);
    expect(buildNativeAskKeyPlan(QUESTIONS, [
      { q: 0, kind: 'single', index: 7 },
      { q: 1, kind: 'multi', indices: [0] },
    ]).ok).toBe(false);
    expect(buildNativeAskKeyPlan(QUESTIONS, [
      { q: 0, kind: 'single', index: 0 },
      { q: 1, kind: 'multi', indices: [] },
    ]).ok).toBe(false);
    expect(buildNativeAskKeyPlan(QUESTIONS, [{ q: 0, kind: 'single', index: 0 }]).ok).toBe(false);
  });
});

describe('屏幕检查：只对「刚弹出、没人动过」的菜单按键', () => {
  it('新弹出的菜单 → 通过', () => {
    expect(isFreshNativeAskScreen(FRESH_SCREEN, QUESTIONS)).toBe(true);
    expect(questionTextOf('【Color】Pick a color?')).toBe('Pick a color?');
  });
  it('已在终端答了一部分（标签页出现 ☒）→ 拒绝', () => {
    expect(isFreshNativeAskScreen(PARTLY_ANSWERED, QUESTIONS)).toBe(false);
  });
  it('isNativeMenuShowing：题目页 / Review 页算弹着；已关、以及 Review 残影被新输出顶上去都不算', () => {
    expect(isNativeMenuShowing(FRESH_SCREEN)).toBe(true);
    expect(isNativeMenuShowing(REVIEW_SCREEN)).toBe(true);
    expect(isNativeMenuShowing(MENU_GONE)).toBe(false);
    expect(isNativeMenuShowing(`${REVIEW_SCREEN}\n${MENU_GONE}`)).toBe(false);
  });

  it('菜单已关（只剩 scrollback 里的旧菜单残影也不算）→ 拒绝', () => {
    expect(isFreshNativeAskScreen(MENU_GONE, QUESTIONS)).toBe(false);
    expect(isFreshNativeAskScreen(`${FRESH_SCREEN}\n${MENU_GONE}`, QUESTIONS)).toBe(false);
  });
  it('屏幕上是别的菜单（第 1 题对不上）→ 拒绝', () => {
    expect(isFreshNativeAskScreen(FRESH_SCREEN.replace('Pick a color?', 'Something else?'), QUESTIONS)).toBe(false);
  });
});

describe('driveNativeAsk 执行器（依赖全注入，绝不碰真 tty）', () => {
  const ANSWER = {
    kind: 'form' as const,
    items: [
      { q: 0, kind: 'single' as const, index: 1, value: 'Green' },
      { q: 1, kind: 'multi' as const, indices: [0, 2], values: ['Apple', 'Cherry'] },
    ],
  };

  function fake(over: Partial<NativeAskDriveDeps> & { screens?: string[] } = {}) {
    const sent: string[][] = [];
    const pasted: string[] = [];
    const screens = over.screens ?? [FRESH_SCREEN, MENU_GONE];
    let n = 0;
    const deps: NativeAskDriveDeps = {
      getHistory: async () => screens[Math.min(n++, screens.length - 1)]!,
      tabRunsClaude: async () => true,
      isScreenLocked: async () => false,
      keyInjectionBlockedWhenLocked: () => true,
      sendKeys: async (_tty, tokens) => { sent.push(tokens); },
      pasteText: async (_tty, text) => { pasted.push(text); },
      sleep: async () => undefined,
      ...over,
    };
    return { deps, sent, pasted };
  }

  it('正常：按计划发键，菜单消失 → ok', async () => {
    // 首检 + 第 2、3 步前复查都看到菜单，最后一次看到菜单已关
    const { deps, sent } = fake({ screens: [FRESH_SCREEN, FRESH_SCREEN, FRESH_SCREEN, MENU_GONE] });
    expect(await driveNativeAsk('/dev/ttys009', QUESTIONS, ANSWER, deps)).toEqual({ ok: true });
    expect(sent).toEqual([['2'], ['1', '3', 'tab'], ['1']]);
  });

  it('锁屏 / 判断不了是否锁屏 → 一个键都不发', async () => {
    for (const locked of [true, null]) {
      const { deps, sent } = fake({ isScreenLocked: async () => locked });
      const r = await driveNativeAsk('/dev/ttys009', QUESTIONS, ANSWER, deps);
      expect(r.ok).toBe(false);
      expect(sent).toEqual([]);
    }
  });

  it('宿主锁屏不挡按键（tmux）→ 不查锁屏也照发', async () => {
    const { deps, sent } = fake({ keyInjectionBlockedWhenLocked: () => false, isScreenLocked: async () => null, screens: [FRESH_SCREEN, FRESH_SCREEN, FRESH_SCREEN, MENU_GONE] });
    expect((await driveNativeAsk('/dev/ttys009', QUESTIONS, ANSWER, deps)).ok).toBe(true);
    expect(sent.length).toBe(3);
  });

  it('终端里已答了一部分 → 一个键都不发', async () => {
    const { deps, sent } = fake({ screens: [PARTLY_ANSWERED] });
    const r = await driveNativeAsk('/dev/ttys009', QUESTIONS, ANSWER, deps);
    expect(r).toMatchObject({ ok: false, sent: false });
    expect(sent).toEqual([]);
  });

  it('tab 里已经不是 claude（崩回裸 shell 等）→ 一个键都不发', async () => {
    const { deps, sent } = fake({ tabRunsClaude: async () => false });
    expect(await driveNativeAsk('/dev/ttys009', QUESTIONS, ANSWER, deps)).toMatchObject({ ok: false, sent: false });
    expect(sent).toEqual([]);
  });

  it('按到一半菜单没了 → 立刻停手，后面的键（含粘贴文本 + 回车）不再发', async () => {
    const { deps, sent, pasted } = fake({ screens: [FRESH_SCREEN, '❯ ', '❯ '] });
    const r = await driveNativeAsk('/dev/ttys009', QUESTIONS, {
      kind: 'form',
      items: [{ q: 0, kind: 'text', text: 'rm -rf ~' }, { q: 1, kind: 'multi', indices: [0] }],
    }, deps);
    expect(r).toMatchObject({ ok: false, sent: true });
    expect(sent).toEqual([['4']]);
    expect(pasted).toEqual([]);
  });

  it('复查恰好读在重绘中间（一两帧看不到提示行）→ 等菜单重新出现后继续，不误判（真机首测踩过）', async () => {
    const REDRAWING = '❯ Call the same AskUserQuestion again';
    const { deps, sent } = fake({ screens: [FRESH_SCREEN, REDRAWING, REDRAWING, FRESH_SCREEN, FRESH_SCREEN, MENU_GONE] });
    expect(await driveNativeAsk('/dev/ttys009', QUESTIONS, ANSWER, deps)).toEqual({ ok: true });
    expect(sent).toEqual([['2'], ['1', '3', 'tab'], ['1']]);
  });

  it('最后一步前停在 Review 页（没有 Enter to select 提示行）→ 仍认作菜单弹着、按下提交（真机第二次测试踩过）', async () => {
    const { deps, sent } = fake({ screens: [FRESH_SCREEN, FRESH_SCREEN, REVIEW_SCREEN, MENU_GONE] });
    expect(await driveNativeAsk('/dev/ttys009', QUESTIONS, ANSWER, deps)).toEqual({ ok: true });
    expect(sent).toEqual([['2'], ['1', '3', 'tab'], ['1']]);
  });

  it('发完还停在 Review 页 → 也算「菜单还在」如实报', async () => {
    const { deps } = fake({ screens: [FRESH_SCREEN, FRESH_SCREEN, REVIEW_SCREEN, REVIEW_SCREEN] });
    expect(await driveNativeAsk('/dev/ttys009', QUESTIONS, ANSWER, deps)).toMatchObject({ ok: false, sent: true });
  });

  it('发完菜单还在 → 如实报「已发出但菜单还在」', async () => {
    const { deps } = fake({ screens: [FRESH_SCREEN, FRESH_SCREEN] });
    expect(await driveNativeAsk('/dev/ttys009', QUESTIONS, ANSWER, deps)).toMatchObject({ ok: false, sent: true });
  });

  it('自由输入走 pasteText', async () => {
    const { deps, pasted } = fake({ screens: [FRESH_SCREEN, FRESH_SCREEN, FRESH_SCREEN, FRESH_SCREEN, FRESH_SCREEN, MENU_GONE] });
    await driveNativeAsk('/dev/ttys009', QUESTIONS, {
      kind: 'form',
      items: [{ q: 0, kind: 'text', text: '紫色' }, { q: 1, kind: 'multi', indices: [1] }],
    }, deps);
    expect(pasted).toEqual(['紫色']);
  });
});
