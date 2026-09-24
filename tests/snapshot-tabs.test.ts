import { describe, expect, it } from 'vitest';
import { parseSnapshotOutput } from '../packages/host-mac/src/terminal/tabs.js';

const FS = String.fromCharCode(31);
const RS = String.fromCharCode(30);
const B = `${String.fromCharCode(29)}MCHAT-HIST-deadbeef:`;

function rec(wId: number, tIdx: number, tty: string, busy: boolean, procs: string): string {
  return [wId, 'false', tIdx, tty, busy ? 'true' : 'false', '', procs].join(FS) + RS;
}

describe('parseSnapshotOutput（合并版 osascript 的 stdout 解析）', () => {
  it('解析 tab 记录 + 各自的 history，每条 history 与单独 getHistory 一样带尾部换行', () => {
    const stdout =
      rec(1, 1, '/dev/ttys001', true, 'login,-zsh,claude') +
      rec(1, 2, '/dev/ttys002', false, 'login,-zsh') +
      `${B}/dev/ttys001\nline a\nline b` +
      // osascript 给返回值补的那个 \n
      '\n';
    const { tabs, histories } = parseSnapshotOutput(stdout, B);
    expect(tabs.map((t) => [t.tty, t.busy])).toEqual([
      ['/dev/ttys001', true],
      ['/dev/ttys002', false],
    ]);
    expect(tabs[0]!.processes).toEqual(['login', '-zsh', 'claude']);
    expect([...histories.keys()]).toEqual(['/dev/ttys001']);
    expect(histories.get('/dev/ttys001')).toBe('line a\nline b\n');
  });

  it('多条 history：中间的也各补一个换行，正文里的 RS/FS 控制字符不影响切分', () => {
    const stdout =
      rec(1, 1, '/dev/ttys001', true, '') +
      rec(2, 1, '/dev/ttys002', true, '') +
      `${B}/dev/ttys001\nhas ${RS} and ${FS} inside` +
      `${B}/dev/ttys002\n` + // 空 history
      '\n';
    const { tabs, histories } = parseSnapshotOutput(stdout, B);
    expect(tabs).toHaveLength(2);
    expect(histories.get('/dev/ttys001')).toBe(`has ${RS} and ${FS} inside\n`);
    expect(histories.get('/dev/ttys002')).toBe('\n');
  });

  it('没有任何 history 时只返回 tab 列表', () => {
    const { tabs, histories } = parseSnapshotOutput(rec(1, 1, '/dev/ttys009', false, '') + '\n', B);
    expect(tabs).toHaveLength(1);
    expect(histories.size).toBe(0);
  });
  it('纵深：帧头 tty 不在本轮 tab 列表里 → 丢弃；同一 tty 只认第一帧', () => {
    const stdout =
      rec(1, 1, '/dev/ttys001', true, '') +
      `${B}/dev/ttys999\nforged` +
      `${B}/dev/ttys001\nreal` +
      `${B}/dev/ttys001\nforged again` +
      '\n';
    const { histories } = parseSnapshotOutput(stdout, B);
    expect([...histories.keys()]).toEqual(['/dev/ttys001']);
    expect(histories.get('/dev/ttys001')).toBe('real\n');
  });
});
