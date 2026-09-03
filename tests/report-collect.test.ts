import { describe, it, expect, beforeEach } from 'vitest';
import { isNoiseText, isReportableTask, parsePorcelainZ, dedupeReportTasks } from '../packages/orchestrator/src/report/collect.js';
import { recordHookSummary, getHookSummary } from '../packages/orchestrator/src/memory/hook-summary.js';
import type { TaskMemory } from '../packages/orchestrator/src/memory/types.js';

function mem(partial: Partial<TaskMemory>): TaskMemory {
  return {
    id: 'mem-x',
    chatId: '',
    tty: '/dev/ttys001',
    cwd: '',
    prompt: '',
    outputPreview: '',
    tags: [],
    startedAt: 0,
    endedAt: 0,
    durationMs: 0,
    source: 'local',
    ...partial,
  };
}

describe('isNoiseText —— 报告采集期 TUI 噪音判定', () => {
  it('空 / 纯空白 / 纯 box-drawing → 噪音', () => {
    expect(isNoiseText(undefined)).toBe(true);
    expect(isNoiseText('')).toBe(true);
    expect(isNoiseText('     ')).toBe(true);
    expect(isNoiseText('─'.repeat(50))).toBe(true);
  });

  it('Claude TUI 菜单 / 状态栏 chrome → 噪音', () => {
    expect(isNoiseText('6. Chat about this\nEnter to select · ↑/↓ to navigate')).toBe(true);
    expect(isNoiseText('⏵⏵ auto mode on (shift+tab to cycle) ← 3 agents')).toBe(true);
    expect(isNoiseText('❯ ⧉ dezhu-voice-call-pre.ts')).toBe(true);
    expect(isNoiseText('Type something.')).toBe(true);
  });

  it('短但真实的确认不被误杀（Low #4 回归）', () => {
    expect(isNoiseText('已完成')).toBe(false);
    expect(isNoiseText('改完了，无需再动')).toBe(false);
    expect(isNoiseText('给 AOM 容器指标加重启/CrashLoop 采集，写入时序库')).toBe(false);
  });
});

describe('isReportableTask —— 条目是否进报告', () => {
  it('有真实 prompt（飞书/note）一律保留，即便 summary 空', () => {
    expect(isReportableTask(mem({ prompt: '得助账号开通 + AOM 数据对接', source: 'note' }))).toBe(true);
    expect(isReportableTask(mem({ prompt: '跑 npm test', source: 'feishu', summary: undefined }))).toBe(true);
  });

  it('占位 prompt + 噪音 summary → 剔除', () => {
    expect(isReportableTask(mem({ prompt: '🏠 本地', summary: 'Enter to select' }))).toBe(false);
    expect(isReportableTask(mem({ prompt: '🏠 本地 @multiAgentChat', summary: '─'.repeat(40) }))).toBe(false);
    expect(isReportableTask(mem({ prompt: '🏠 本地', summary: undefined }))).toBe(false);
  });

  it('占位 prompt + 真实 summary（hook 抓到的回答）→ 保留', () => {
    expect(isReportableTask(mem({ prompt: '🏠 本地', summary: '给 AOM 加容器重启指标采集，打通拓扑图' }))).toBe(true);
  });
});

describe('parsePorcelainZ —— git status --porcelain -z 解析（High：中文/特殊名不丢）', () => {
  it('普通改动 / 新增 / 未跟踪：取路径', () => {
    // -z 无行尾换行，条目以 NUL 结尾
    expect(parsePorcelainZ(' M src/a.ts\0?? b.txt\0A  c/d.ts\0')).toEqual(['src/a.ts', 'b.txt', 'c/d.ts']);
  });

  it('中文 / 含空格文件名原样保留（不像默认 porcelain 被 octal 转义 → stat ENOENT）', () => {
    expect(parsePorcelainZ('?? 截屏2026-09-03 下午3.14.15.png\0 M 文档/需求.md\0'))
      .toEqual(['截屏2026-09-03 下午3.14.15.png', '文档/需求.md']);
  });

  it('rename/copy：跳过紧跟的旧路径，只取新路径', () => {
    // R  new\0old\0  —— new 是状态条目的路径，old 是随后的独立 NUL 字段
    expect(parsePorcelainZ('R  newname.ts\0oldname.ts\0 M other.ts\0')).toEqual(['newname.ts', 'other.ts']);
    expect(parsePorcelainZ('C  copy.ts\0origin.ts\0')).toEqual(['copy.ts']);
  });

  it('路径字面含 " -> " 不被误当 rename 截断（-z 模式无箭头语义）', () => {
    expect(parsePorcelainZ('?? cost -> benefit.md\0')).toEqual(['cost -> benefit.md']);
  });

  it('空输出 / 末尾空 token → 空数组', () => {
    expect(parsePorcelainZ('')).toEqual([]);
    expect(parsePorcelainZ('\0')).toEqual([]);
  });
});

describe('dedupeReportTasks —— hook 留底 vs watcher 同源去重（只删冗余 hook，绝不删真任务）', () => {
  const TTY = '/dev/ttys014';
  it('同 tty + summary 相等 + 时间相近：丢 hook、留 watcher（更全）', () => {
    const summary = '给 AOM 加容器重启指标采集，打通拓扑图';
    const hook = mem({ id: 'h1', tty: TTY, cwd: '/p/api', summary, prompt: '', source: 'hook', endedAt: 100_000 });
    const watcher = mem({ id: 'w1', tty: TTY, cwd: '/p/api', summary, prompt: '@api 加 AOM 采集', source: 'local', endedAt: 120_000 });
    const out = dedupeReportTasks([hook, watcher]);
    expect(out.map((m) => m.id)).toEqual(['w1']);
  });

  it('只有 hook（窗口关了、watcher 没落）→ 保留（这正是留底要救的）', () => {
    const hook = mem({ id: 'h1', tty: TTY, cwd: '/p/api', summary: '改完 serve.ts，测试通过', source: 'hook', endedAt: 100_000 });
    expect(dedupeReportTasks([hook]).map((m) => m.id)).toEqual(['h1']);
  });

  it('不同 tab 的两条 hook（同 cwd、通用开头）→ 都保留，不误合并', () => {
    const a = mem({ id: 'h1', tty: '/dev/ttys01', cwd: '/p', summary: '已完成，测试通过', source: 'hook', endedAt: 100_000 });
    const b = mem({ id: 'h2', tty: '/dev/ttys02', cwd: '/p', summary: '已完成，测试通过', source: 'hook', endedAt: 200_000 });
    expect(dedupeReportTasks([a, b]).map((m) => m.id).sort()).toEqual(['h1', 'h2']);
  });

  it('summary 相等但时间超窗（>15min）→ hook 不被误删', () => {
    const summary = '同一段文本';
    const hook = mem({ id: 'h1', tty: TTY, cwd: '/p', summary, source: 'hook', endedAt: 100_000 });
    const watcher = mem({ id: 'w1', tty: TTY, cwd: '/p', summary, source: 'local', endedAt: 100_000 + 16 * 60_000 });
    expect(dedupeReportTasks([hook, watcher]).map((m) => m.id).sort()).toEqual(['h1', 'w1']);
  });

  it('feishu 任务 watcher 无 summary → hook 保留（对不上不误删真任务）', () => {
    const feishu = mem({ id: 'f1', tty: TTY, cwd: '/p', prompt: '跑 npm test', summary: undefined, source: 'feishu', endedAt: 100_000 });
    const hook = mem({ id: 'h1', tty: TTY, cwd: '/p', summary: '测试全过', source: 'hook', endedAt: 101_000 });
    expect(dedupeReportTasks([feishu, hook]).map((m) => m.id).sort()).toEqual(['f1', 'h1']);
  });

  it('非 hook 条目彼此从不合并（各是独立真实任务）', () => {
    const a = mem({ id: 'a', tty: TTY, cwd: '/p', summary: '同文本', source: 'local', endedAt: 100_000 });
    const b = mem({ id: 'b', tty: TTY, cwd: '/p', summary: '同文本', source: 'local', endedAt: 101_000 });
    expect(dedupeReportTasks([a, b]).map((m) => m.id).sort()).toEqual(['a', 'b']);
  });
});

describe('hook-summary —— per-tty 缓存防串台（High #1）', () => {
  const TTY = '/dev/ttys777';

  beforeEach(() => {
    // 用一条极早的 record + 立刻 consume 清掉可能的残留
    getHookSummary(TTY, { consume: true, maxAgeMs: 0 });
  });

  it('基本往返：记录后可取回（不带 since）', () => {
    recordHookSummary(TTY, '  这是 assistant 的真实回答  ');
    expect(getHookSummary(TTY)).toBe('这是 assistant 的真实回答');
  });

  it('since 时间窗：早于任务开始的 hook 被拒（防上一个任务残留串台）', () => {
    recordHookSummary(TTY, 'A 任务的回答');
    const future = Date.now() + 60_000; // 模拟「任务 B 在更晚才开始」
    expect(getHookSummary(TTY, { since: future })).toBeUndefined();
  });

  it('since 缓冲：hook 略早于 pending.sentAt（快任务时序竞态）仍被接受', () => {
    // notifier 用 since = pending.sentAt - HOOK_SINCE_SLACK_MS(5s)。模拟：hook 在 now 写入，
    // pending 在 ~4s 后才建（sentAt=now+4000）→ 有效 since=now-1000 ≤ hook.at → 应接受（不误拒）。
    recordHookSummary(TTY, '快任务的合法回答');
    const effectiveSince = Date.now() + 4000 - 5000; // sentAt - slack
    expect(getHookSummary(TTY, { since: effectiveSince })).toBe('快任务的合法回答');
  });

  it('consume：读一次后即删，同 tty 后续任务取不到（防复用）', () => {
    recordHookSummary(TTY, '只该被取一次的回答');
    expect(getHookSummary(TTY, { consume: true })).toBe('只该被取一次的回答');
    expect(getHookSummary(TTY)).toBeUndefined();
  });

  it('TTL：过期即失效', () => {
    recordHookSummary(TTY, '过期内容');
    // maxAgeMs:-1 → 任何非负 elapsed 都判过期，确定性命中过期分支（不依赖真实等待）
    expect(getHookSummary(TTY, { maxAgeMs: -1 })).toBeUndefined();
  });

  it('tty 归一化：带不带 /dev/ 前缀视为同一 tab', () => {
    recordHookSummary('ttys778', '归一化测试');
    expect(getHookSummary('/dev/ttys778', { consume: true })).toBe('归一化测试');
  });
});
