/**
 * 飞书表单答案 → 按键计划：驱动终端里**正弹着**的 Claude Code 多问题 / 多选 AskUserQuestion 原生菜单。
 * 纯逻辑，无副作用；执行（锁屏检查 / 发键 / 粘贴 / 回执）在 framework/control/native-ask-drive.ts。
 *
 * 按键规则全部在伪终端里**逐字节**实测过（Claude Code v2.1.280，2026-09-24）：
 *   - 菜单顶部是标签页 `← ☐ Q1 ☐ Q2 ✔ Submit →`，每题一页，最后是 Review 页；单题多选也是这个结构
 *   - 单选题：数字 k = 选中第 k 项并**自动翻到下一页**
 *   - 多选题：数字 k = 翻转第 k 项，**光标不动、不翻页**；Tab = 翻到下一页
 *   - 自由输入：数字 n+1（n = 选项数）把光标移到「Type something」，之后打字 / 粘贴进输入框，Enter 提交并翻页
 *   - Review 页：数字 1 = Submit answers
 *
 * ⚠ 必须是**一键一次写入**（System Events / tmux send-keys）。Terminal 的 `do script` 每次写入尾部都带 \r，
 * 且同一块里的几个键按「块开始时的状态」处理 —— 单选题上 `2\r` 会先选 2、再被那个 \r 按光标项（第 1 项）
 * 覆盖并多翻一页，结果是选中第 1 项、跳过下一题。所以这条路不能走 pty 直写（锁屏时就无法驱动）。
 */

import type { AskAnswerFormItem, AskFormQuestion } from './types.js';

export type NativeAskStep =
  | { kind: 'keys'; tokens: string[] }
  | { kind: 'paste'; text: string };

export type NativeAskPlan =
  | { ok: true; steps: NativeAskStep[] }
  | { ok: false; reason: string };

/** 数字键只有 1-9；AskUserQuestion 每题最多 4 个选项 + Type something，正常到不了上限，越界就 fail-closed。 */
const MAX_DIGIT = 9;

export function buildNativeAskKeyPlan(
  questions: readonly AskFormQuestion[],
  items: readonly AskAnswerFormItem[],
): NativeAskPlan {
  if (questions.length === 0) return { ok: false, reason: '没有问题' };
  const steps: NativeAskStep[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i]!;
    const item = items.find((it) => Number(it.q) === i);
    if (!item) return { ok: false, reason: `第 ${i + 1} 题没有答案` };
    const n = q.options.length;

    if (item.kind === 'text') {
      const text = (item.text ?? '').trim();
      if (!text) return { ok: false, reason: `第 ${i + 1} 题的自由输入是空的` };
      // 多选题的「Type something」是一个可勾选项 + 输入框的组合，交互没实测过 → 不驱动，宁可让人回终端答
      if (q.type === 'multi') return { ok: false, reason: `第 ${i + 1} 题是多选题，自由输入没法自动填进终端菜单` };
      if (n + 1 > MAX_DIGIT) return { ok: false, reason: `第 ${i + 1} 题选项太多，数字键够不着「Type something」` };
      steps.push({ kind: 'keys', tokens: [String(n + 1)] });
      steps.push({ kind: 'paste', text });
      steps.push({ kind: 'keys', tokens: ['enter'] });
      continue;
    }

    if (q.type === 'single') {
      const idx = Number(item.index);
      if (item.kind !== 'single' || !Number.isInteger(idx) || idx < 0 || idx >= n) {
        return { ok: false, reason: `第 ${i + 1} 题的答案不在选项范围内` };
      }
      if (idx + 1 > MAX_DIGIT) return { ok: false, reason: `第 ${i + 1} 题选项太多，数字键够不着` };
      steps.push({ kind: 'keys', tokens: [String(idx + 1)] });
      continue;
    }

    // multi
    const raw = item.kind === 'multi' && Array.isArray(item.indices) ? item.indices.map(Number) : null;
    if (!raw || raw.length === 0) return { ok: false, reason: `第 ${i + 1} 题（多选）一项都没选` };
    const picked = [...new Set(raw)].sort((a, b) => a - b);
    if (picked.some((x) => !Number.isInteger(x) || x < 0 || x >= n)) {
      return { ok: false, reason: `第 ${i + 1} 题的答案不在选项范围内` };
    }
    if (picked.some((x) => x + 1 > MAX_DIGIT)) return { ok: false, reason: `第 ${i + 1} 题选项太多，数字键够不着` };
    // 数字只翻转、不翻页；最后 Tab 翻到下一页
    steps.push({ kind: 'keys', tokens: [...picked.map((x) => String(x + 1)), 'tab'] });
  }
  // 此时停在 Review 页：1 = Submit answers
  steps.push({ kind: 'keys', tokens: ['1'] });
  return { ok: true, steps };
}

/** 在 [0, end) 里从后往前找（target 是 ES2022，没有 Array#findLastIndex）。 */
function lastIndexWhere(arr: readonly string[], end: number, pred: (s: string) => boolean): number {
  for (let i = end - 1; i >= 0; i--) if (pred(arr[i]!)) return i;
  return -1;
}

/** 表单题目标题里带的 `【header】` 前缀（hook 拼的）→ 去掉，还原原生菜单里显示的问题原文。 */
export function questionTextOf(title: string): string {
  return title.replace(/^【[^】]*】/, '').trim();
}

/**
 * 原生选择菜单此刻是否贴底弹着。两种页面：
 *   - 题目页：提示行 `Enter to select` 在**最末尾两条非空行**里（进了「Type something」输入框也还在）
 *   - Review 页：**没有**那行提示，末尾是 `Ready to submit your answers?` / `1. Submit answers` / `2. Cancel`
 *     （真机第二次端到端测试踩过：按到 Review 页后被当成「菜单没了」，差最后一个提交键）
 * 答完 / 关掉后新输出会把这些行顶上去。
 */
export function isNativeMenuShowing(history: string): boolean {
  const lines = history.split('\n').filter((l) => l.trim() !== '');
  if (lines.slice(-2).some((l) => l.includes('Enter to select'))) return true;
  const tail = lines.slice(-3);
  return tail.some((l) => l.includes('Ready to submit your answers?'))
    && tail.some((l) => /\b1\. Submit answers\b/.test(l))
    && /\b2\. Cancel\b/.test(lines[lines.length - 1] ?? '');
}

/**
 * 屏幕尾部是否正是**刚弹出、还没人动过**的那个多问题菜单。按键计划假设从第 1 题、光标在第 1 项开始 ——
 * 人在终端里已经答了一部分（标签页出现 ☒）或菜单已关，再按就是往错的地方打数字，一律拒绝。
 *
 * 判据（都在最末尾一段里找，不看整段 scrollback —— 旧菜单的残影不能算数）：
 *   1. 底部提示行 `Enter to select` 就在**最末尾两条非空行**里（菜单弹着时它是最后一行；
 *      答完后会有新输出把它顶上去 —— 只要求「在尾部 40 行里」会被刚关掉的旧菜单骗过，测试抓到过）
 *   2. 标签页行（含 `✔ Submit`）里没有 ☒（一题都没答）
 *   3. 第 1 题的问题原文在标签页行之后出现（当前停在第 1 页）
 */
export function isFreshNativeAskScreen(history: string, questions: readonly AskFormQuestion[]): boolean {
  if (questions.length === 0) return false;
  const lines = history.split('\n').filter((l) => l.trim() !== '').slice(-40);
  const hintAt = lastIndexWhere(lines, lines.length, (l) => l.includes('Enter to select'));
  if (hintAt < 0 || hintAt < lines.length - 2) return false;
  const tabsAt = lastIndexWhere(lines, hintAt, (l) => l.includes('✔ Submit'));
  if (tabsAt < 0) return false;
  if (lines[tabsAt]!.includes('☒')) return false;
  const first = questionTextOf(questions[0]!.title);
  if (!first) return false;
  // 终端按宽度折行，只要求问题原文的开头（≤30 字）出现在紧跟标签页的那一行
  const head = first.slice(0, 30);
  return (lines[tabsAt + 1] ?? '').includes(head);
}
