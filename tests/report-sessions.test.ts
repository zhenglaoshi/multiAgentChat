import { describe, it, expect } from 'vitest';
import { isHumanPrompt, isTrivialPrompt, type RawUserEntry } from '../packages/orchestrator/src/report/sessions.js';
import { dedupeContainedRoots } from '../packages/host-mac/src/dir-index.js';

/** 真人在终端里打进去的一条（字段照实测的 jsonl 取样）。 */
function human(partial: Partial<RawUserEntry> = {}): RawUserEntry {
  return {
    type: 'user',
    cwd: '/Users/me/work',
    timestamp: '2026-09-08T02:00:33.576Z',
    promptSource: 'typed',
    origin: { kind: 'human' },
    message: { role: 'user', content: '帮我新建一个项目，对接 apimonitor 的 mq 数据' },
    ...partial,
  };
}

describe('isHumanPrompt —— 只认真人输入（防内部会话混进日报）', () => {
  it('真人 typed 输入 → 收', () => {
    expect(isHumanPrompt(human())).toBe(true);
  });

  it('本项目自己 spawn 的 claude -p（promptSource=sdk、无 origin）→ 拒', () => {
    // 报告合成 / 自审 / 知识提炼都会落进同一批 jsonl，不拒的话日报里会出现「你是我的工作总结助手…」
    const sdk = human({
      promptSource: 'sdk',
      message: { role: 'user', content: '你是我的工作总结助手。基于下面的真实工作数据…' },
    });
    delete sdk.origin;
    expect(isHumanPrompt(sdk)).toBe(false);
  });

  it('工具结果回灌的 user 记录（content 是数组）→ 拒', () => {
    expect(isHumanPrompt(human({ message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }))).toBe(false);
  });

  it('非 user 类型（assistant / system / mode 行）→ 拒', () => {
    expect(isHumanPrompt(human({ type: 'assistant' }))).toBe(false);
    expect(isHumanPrompt({ type: 'mode' })).toBe(false);
  });

  it('缺 message / content 非字符串 → 拒（不抛）', () => {
    expect(isHumanPrompt({ type: 'user', origin: { kind: 'human' } })).toBe(false);
    expect(isHumanPrompt(human({ message: { role: 'user', content: undefined } }))).toBe(false);
  });

  it('origin.kind=human 或 promptSource=typed 任一成立即可（字段随版本演进，留双通道）', () => {
    const onlyOrigin = human({ promptSource: 'other' });
    expect(isHumanPrompt(onlyOrigin)).toBe(true);
    const onlyTyped = human();
    delete onlyTyped.origin;
    expect(isHumanPrompt(onlyTyped)).toBe(true);
  });
});

describe('isTrivialPrompt —— 剔无实质内容的输入', () => {
  it('裸斜杠命令是操作本工具、不是当天的活 → 剔', () => {
    expect(isTrivialPrompt('/report')).toBe(true);
    expect(isTrivialPrompt('/clear')).toBe(true);
    expect(isTrivialPrompt('  /reload  ')).toBe(true);
  });

  it('带参数的斜杠命令是真在干活 → 留', () => {
    expect(isTrivialPrompt('/tapd 建个需求 语音外呼开通')).toBe(false);
    expect(isTrivialPrompt('/report day 昨天')).toBe(false);
  });

  it('单字确认 / 语气词 → 剔', () => {
    expect(isTrivialPrompt('继续')).toBe(true);
    expect(isTrivialPrompt('好的')).toBe(true);
    expect(isTrivialPrompt('ok')).toBe(true);
    expect(isTrivialPrompt('嗯嗯')).toBe(true);
    expect(isTrivialPrompt('可以。')).toBe(true);
  });

  it('短但真实的指令不被误杀', () => {
    expect(isTrivialPrompt('重启一下 daemon')).toBe(false);
    expect(isTrivialPrompt('跑一下测试')).toBe(false);
  });

  it('空 / 纯空白 → 剔（不抛）', () => {
    expect(isTrivialPrompt('')).toBe(true);
    expect(isTrivialPrompt('   \n ')).toBe(true);
  });
});

describe('dedupeContainedRoots —— 扫描根去重（同一批目录别遍历好几遍）', () => {
  it('~ 覆盖了它的子根 → 只留 ~', () => {
    expect(dedupeContainedRoots(['/Users/me', '/Users/me/ihealth-project', '/Users/me/ihealth-work']))
      .toEqual(['/Users/me']);
  });

  it('同级根互不吞并', () => {
    expect(dedupeContainedRoots(['/a/one', '/b/two']).sort()).toEqual(['/a/one', '/b/two']);
  });

  it('按路径分段判断：/a/bc 不该被 /a/b 吃掉', () => {
    expect(dedupeContainedRoots(['/a/b', '/a/bc']).sort()).toEqual(['/a/b', '/a/bc']);
  });

  it('重复路径去重，且不会因为「自己包含自己」被全删光', () => {
    expect(dedupeContainedRoots(['/a', '/a'])).toEqual(['/a']);
  });

  it('带尾斜杠的根也能正确吞并子路径', () => {
    expect(dedupeContainedRoots(['/a/', '/a/b'])).toEqual(['/a/']);
  });

  it('空输入 → 空数组', () => {
    expect(dedupeContainedRoots([])).toEqual([]);
  });
});
