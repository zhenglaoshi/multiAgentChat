import { describe, it, expect } from 'vitest';
import {
  parseProcName,
  parsePsLine,
  groupProcsByTty,
  inferBusy,
  parsePaneRow,
  toTmuxKey,
  parseAcStandbyTimeout,
  parsePowerSourceFromSysfs,
  TMUX_HOST_CAPABILITIES,
  tmuxHost,
  buildNewTabArgs,
  newSessionName,
  sendLiteral,
  buildTmuxErrorMessage,
} from '../packages/host-tmux/src/index.js';
import { macHost } from '../packages/host-mac/src/host.js';
import { parseKeySteps } from '../packages/orchestrator/src/keys/tokens.js';
import { inferTabStatusFrom, findTuiProc, hasTuiProc } from '../packages/orchestrator/src/agents/tab-status.js';
import { resolveHostOverride } from '../packages/framework/src/host-bootstrap.js';

const FS = String.fromCharCode(31);

describe('parseProcName', () => {
  it('普通命令取 argv[0]（保留路径，AgentAdapter 的 endsWith(/claude) 判据要用）', () => {
    expect(parseProcName('/usr/local/bin/claude')).toBe('/usr/local/bin/claude');
    expect(parseProcName('claude')).toBe('claude');
  });

  it('node 包装形式取脚本路径 —— 否则 agent 永远认不出来', () => {
    // 真机形态：codex/claude 常以 `node /path/bin/xxx` 出现（见 bin/lib/headless.mjs 的同类教训）
    expect(parseProcName('node /Users/z/.nvm/versions/node/v22/bin/claude')).toBe(
      '/Users/z/.nvm/versions/node/v22/bin/claude',
    );
    expect(parseProcName('node --enable-source-maps /opt/bin/codex exec')).toBe('/opt/bin/codex');
  });

  it('login shell 的前导 - 不影响判定', () => {
    expect(parseProcName('-zsh')).toBe('-zsh');
  });

  it('空行 → 空串', () => {
    expect(parseProcName('   ')).toBe('');
  });
});

describe('parsePsLine / groupProcsByTty', () => {
  it('无控制终端的行被丢掉', () => {
    expect(parsePsLine('?        /usr/lib/systemd/systemd')).toBeNull();
    expect(parsePsLine('-        kworker')).toBeNull();
  });

  it('tty 补 /dev/ 前缀', () => {
    expect(parsePsLine('pts/3    /usr/local/bin/claude')).toEqual(['/dev/pts/3', '/usr/local/bin/claude']);
  });

  it('按 tty 分组', () => {
    const out = ['pts/1    -bash', 'pts/1    /usr/local/bin/claude', 'pts/2    -zsh', '?        init'].join('\n');
    const m = groupProcsByTty(out);
    expect(m.get('/dev/pts/1')).toEqual(['-bash', '/usr/local/bin/claude']);
    expect(m.get('/dev/pts/2')).toEqual(['-zsh']);
    expect(m.has('?')).toBe(false);
  });
});

describe('inferBusy', () => {
  it('只有壳 → 闲', () => {
    expect(inferBusy(['-bash'])).toBe(false);
    expect(inferBusy(['/bin/zsh'])).toBe(false);
  });
  it('有别的进程 → 忙', () => {
    expect(inferBusy(['-bash', '/usr/local/bin/claude'])).toBe(true);
    expect(inferBusy(['-zsh', 'npm'])).toBe(true);
  });
  it('空列表 → 闲（pane 刚建、ps 还没抓到）', () => {
    expect(inferBusy([])).toBe(false);
  });
});

describe('parsePaneRow', () => {
  const row = (fields: string[]): string => fields.join(FS);

  it('解析出 tty 主键 + cwd（tmux 白送，不用 lsof）', () => {
    const procs = new Map([['/dev/pts/3', ['-bash', '/usr/local/bin/claude']]]);
    const t = parsePaneRow(row(['/dev/pts/3', '%5', '@2', '1', '0', 'my-title', '/home/z/proj']), procs);
    expect(t).not.toBeNull();
    expect(t!.tty).toBe('/dev/pts/3');
    expect(t!.paneId).toBe('%5');
    expect(t!.windowId).toBe(2);
    expect(t!.windowFrontmost).toBe(true);
    expect(t!.title).toBe('my-title');
    expect(t!.cwd).toBe('/home/z/proj');
    expect(t!.busy).toBe(true);
    expect(t!.processes).toEqual(['-bash', '/usr/local/bin/claude']);
  });

  it('字段不足 / 无 tty → null（不造半个 tab 出来）', () => {
    expect(parsePaneRow('', new Map())).toBeNull();
    expect(parsePaneRow(row(['/dev/pts/3', '%5']), new Map())).toBeNull();
  });

  it('跑着 vim 的 pane 标 hasTUI（带路径也要认出来）', () => {
    const procs = new Map([['/dev/pts/9', ['-zsh', '/usr/bin/vim']]]);
    const t = parsePaneRow(row(['/dev/pts/9', '%1', '@0', '0', '0', '', '/tmp']), procs);
    expect(t!.hasTUI).toBe(true);
  });
});

describe('TUI 判定（两个宿主共用）', () => {
  it('带路径的进程名也能认出 TUI —— 统一用 basename 归一', () => {
    expect(findTuiProc(['/usr/bin/vim'])).toBe('/usr/bin/vim');
    expect(hasTuiProc(['-zsh', '/opt/homebrew/bin/htop'])).toBe(true);
    expect(hasTuiProc(['-zsh', '/usr/local/bin/claude'])).toBe(false);
  });
});

describe('toTmuxKey', () => {
  it('具名键 → tmux 按键名', () => {
    expect(toTmuxKey({ kind: 'named', key: 'enter', mods: [] })).toBe('Enter');
    expect(toTmuxKey({ kind: 'named', key: 'escape', mods: [] })).toBe('Escape');
    expect(toTmuxKey({ kind: 'named', key: 'down', mods: [] })).toBe('Down');
    expect(toTmuxKey({ kind: 'named', key: 'pagedown', mods: [] })).toBe('NPage');
  });

  it('ctrl+c → C-c', () => {
    expect(toTmuxKey({ kind: 'text', text: 'c', mods: ['ctrl'] })).toBe('C-c');
  });

  it('无修饰键的文本 → null（走字面通道，可能是一整句话）', () => {
    expect(toTmuxKey({ kind: 'text', text: 'hello world', mods: [] })).toBeNull();
  });

  it('Command 修饰键明确抛错，不静默降级成裸键', () => {
    expect(() => toTmuxKey({ kind: 'named', key: 'enter', mods: ['cmd'] })).toThrow(/Command/);
  });

  it('修饰键配多字符 → 抛错', () => {
    expect(() => toTmuxKey({ kind: 'text', text: 'abc', mods: ['ctrl'] })).toThrow();
  });
});

describe('按键语法在两个宿主间一致（共享解析）', () => {
  it('单字母别名仍是方向键，不是打字', () => {
    expect(parseKeySteps('d')).toEqual([{ kind: 'named', key: 'down', mods: [] }]);
    expect(parseKeySteps('u')).toEqual([{ kind: 'named', key: 'up', mods: [] }]);
    // 连体展开
    expect(parseKeySteps('ddd')).toHaveLength(3);
  });

  it('ctrl+c ctrl+c → 两步', () => {
    expect(parseKeySteps('ctrl+c ctrl+c')).toEqual([
      { kind: 'text', text: 'c', mods: ['ctrl'] },
      { kind: 'text', text: 'c', mods: ['ctrl'] },
    ]);
  });

  it('引号内按原样打字', () => {
    expect(parseKeySteps("'hello world'")).toEqual([{ kind: 'text', text: 'hello world', mods: [] }]);
  });
});

describe('tab 状态推断（两个宿主共用同一份）', () => {
  it('跑着 claude → active', () => {
    expect(inferTabStatusFrom({ processes: ['-bash', 'claude'], busy: true }).kind).toBe('claude-active');
  });
  it('屏幕有选项菜单 → waiting', () => {
    expect(inferTabStatusFrom({ processes: ['claude'], busy: true }, '❯ 1. 是').kind).toBe('claude-waiting');
  });
  it('没 agent 且不忙 → shell-idle', () => {
    expect(inferTabStatusFrom({ processes: ['-zsh'], busy: false }).kind).toBe('shell-idle');
  });
});

describe('powercfg 解析（WSL 防睡眠漂移检测）', () => {
  it('0x00000000 = 从不睡', () => {
    expect(parseAcStandbyTimeout('Current AC Power Setting Index: 0x00000000')).toBe(0);
  });
  it('非 0 = 会睡', () => {
    expect(parseAcStandbyTimeout('Current AC Power Setting Index: 0x0000001e')).toBe(30);
  });
  it('读不到 → null（按未知处理，不能当成已设好）', () => {
    expect(parseAcStandbyTimeout('something else')).toBeNull();
  });
  it('电源来源', () => {
    expect(parsePowerSourceFromSysfs('1\n')).toBe('ac');
    expect(parsePowerSourceFromSysfs('0\n')).toBe('battery');
    expect(parsePowerSourceFromSysfs('')).toBe('unknown');
  });
});

describe('tmux 宿主能力声明', () => {
  it('按键注入不受锁屏影响 —— 这是选 tmux 的核心收益', () => {
    expect(TMUX_HOST_CAPABILITIES.keyInjection).toBe(true);
    expect(TMUX_HOST_CAPABILITIES.keyInjectionBlockedWhenLocked).toBe(false);
  });

  it('没有的能力如实标 false，探针据此跳过', () => {
    expect(TMUX_HOST_CAPABILITIES.screenCapture).toBe(false);
    expect(TMUX_HOST_CAPABILITIES.screenLockDetection).toBe(false);
    expect(TMUX_HOST_CAPABILITIES.permissionModel).toBe(false);
  });

  it('isScreenLocked 返回 null（不知道就说不知道，别撒谎说 false）', async () => {
    await expect(tmuxHost.isScreenLocked()).resolves.toBeNull();
  });

  it('不支持的能力调用时抛错而不是静默返回假数据', async () => {
    await expect(tmuxHost.captureScreen('/dev/pts/1')).rejects.toThrow(/不支持截图/);
  });

  it('没有授权模型 → 空规格', async () => {
    expect(tmuxHost.listPermissionSpecs()).toEqual([]);
    await expect(tmuxHost.detectHostPermissions()).resolves.toEqual([]);
    await expect(tmuxHost.probeKeyInjection()).resolves.toEqual({ ok: true });
  });
});

describe('两个宿主的方法集合必须一致', () => {
  it('tmuxHost 与 macHost 暴露同一组 key —— 漏装配一个方法上层就会在运行时炸', () => {
    expect(Object.keys(tmuxHost).sort()).toEqual(Object.keys(macHost).sort());
  });
});

describe('resolveHostOverride', () => {
  it('认 mac / tmux，其余按未设处理', () => {
    expect(resolveHostOverride({ MCHAT_HOST: 'tmux' })).toBe('tmux');
    expect(resolveHostOverride({ MCHAT_HOST: ' MAC ' })).toBe('mac');
    expect(resolveHostOverride({ MCHAT_HOST: 'windows' })).toBeNull();
    expect(resolveHostOverride({})).toBeNull();
  });
});


describe('newTab 的三种 mode（曾经被整个忽略）', () => {
  it('new-tab：在现有 session 里开 window，并切过去', () => {
    expect(buildNewTabArgs({}, 'mchat', 'mchat-x')).toEqual([
      'new-window', '-t', 'mchat', '-P', '-F', '#{pane_tty}',
    ]);
    expect(buildNewTabArgs({ mode: 'new-tab' }, 'mchat', 'mchat-x')).toEqual([
      'new-window', '-t', 'mchat', '-P', '-F', '#{pane_tty}',
    ]);
  });

  it('new-tab-background：加 -d，不抢当前视图', () => {
    expect(buildNewTabArgs({ mode: 'new-tab-background' }, 'mchat', 'mchat-x')).toEqual([
      'new-window', '-d', '-t', 'mchat', '-P', '-F', '#{pane_tty}',
    ]);
  });

  it('new-window：另建独立 session（对应 Mac 的另开一个窗口）', () => {
    expect(buildNewTabArgs({ mode: 'new-window' }, '', 'mchat-abc')).toEqual([
      'new-session', '-d', '-s', 'mchat-abc', '-P', '-F', '#{pane_tty}',
    ]);
  });

  it('cwd 作为独立 argv 追加，不拼进字符串', () => {
    const args = buildNewTabArgs({ cwd: "/home/z/my proj;rm -rf x" }, 'mchat', 'mchat-x');
    expect(args[args.length - 2]).toBe('-c');
    expect(args[args.length - 1]).toBe('/home/z/my proj;rm -rf x');
  });

  it('新 session 名带时间戳后缀，避免撞名', () => {
    expect(newSessionName(0)).toBe('mchat-0');
    expect(newSessionName(1)).not.toBe(newSessionName(2));
  });
});


describe('sendLiteral 的 argv 形状（全包最脆弱的一段，用注入钉住）', () => {
  const capture = () => {
    const calls: string[][] = [];
    return { calls, run: async (args: string[]) => { calls.push(args); } };
  };

  it('普通文本走 -l --（-- 保证以 - 开头的文本不被当 flag）', async () => {
    const c = capture();
    await sendLiteral('%3', '-rf /tmp', c.run);
    expect(c.calls).toEqual([['send-keys', '-t', '%3', '-l', '--', '-rf /tmp']]);
  });

  // 以下几条对应 2026-09-14 真实 tmux 3.7c 的逐例实测结果（见 sendLiteral 注释）
  it('裸分号走 -H 十六进制通道 —— 否则被 tmux 当命令分隔符吃掉', async () => {
    const c = capture();
    await sendLiteral('%3', ';', c.run);
    expect(c.calls).toEqual([['send-keys', '-t', '%3', '-H', '3b']]);
  });

  it('结尾带分号的正常文本：正文走 -l，结尾分号单独用 -H 补发', async () => {
    const c = capture();
    await sendLiteral('%3', 'echo hi;', c.run);
    expect(c.calls).toEqual([
      ['send-keys', '-t', '%3', '-l', '--', 'echo hi'],
      ['send-keys', '-t', '%3', '-H', '3b'],
    ]);
  });

  it('连续多个结尾分号全部补发（实测 `;;` 只落地一个）', async () => {
    const c = capture();
    await sendLiteral('%3', 'x;;;', c.run);
    expect(c.calls).toEqual([
      ['send-keys', '-t', '%3', '-l', '--', 'x'],
      ['send-keys', '-t', '%3', '-H', '3b', '3b', '3b'],
    ]);
  });

  it('分号在中间不受影响（实测完整无损）', async () => {
    const c = capture();
    await sendLiteral('%3', 'a;b', c.run);
    expect(c.calls).toEqual([['send-keys', '-t', '%3', '-l', '--', 'a;b']]);
  });

  it('带 \r 后缀的主路径天然免疫（不以分号结尾）', async () => {
    const c = capture();
    await sendLiteral('%3', ';\r', c.run);
    expect(c.calls[0]).toEqual(['send-keys', '-t', '%3', '-l', '--', ';\r']);
  });

  it('空文本不发命令', async () => {
    const c = capture();
    await sendLiteral('%3', '', c.run);
    expect(c.calls).toEqual([]);
  });

  it('文本作为独立 argv 元素传递，不拼进命令字符串', async () => {
    const c = capture();
    const evil = '$(rm -rf ~) `whoami` ; tmux kill-server';
    await sendLiteral('%3', evil, c.run);
    expect(c.calls[0]![5]).toBe(evil);
  });
});

describe('TmuxError 消息不得带 argv 原文（送进终端的可能是口令）', () => {
  it('只保留命令名 + 退出码 + 截断 stderr', () => {
    const err = Object.assign(new Error('Command failed: tmux send-keys -l -- hunter2-my-password'), { code: 1 });
    const msg = buildTmuxErrorMessage('send-keys', err, "can't find pane");
    expect(msg).not.toContain('hunter2-my-password');
    expect(msg).toContain('send-keys');
    expect(msg).toContain("can't find pane");
  });

  it('stderr 截断到 300 字，别把整屏内容带进错误消息', () => {
    const err = Object.assign(new Error('x'), { code: 1 });
    expect(buildTmuxErrorMessage('capture-pane', err, 'A'.repeat(1000)).length).toBeLessThan(400);
  });
});

describe('parsePaneRow 对不可信 title/cwd 的防护', () => {
  const FS2 = String.fromCharCode(31);
  const row = (f: string[]): string => f.join(FS2);

  it('字段数必须严格等于 7 —— 多出来说明 title 里混了 0x1F，整行不可信', () => {
    expect(parsePaneRow(row(['/dev/pts/1', '%1', '@0', '1', '0', 'a', 'b', 'extra']), new Map())).toBeNull();
  });

  it('title / cwd 里的控制字符被洗掉', () => {
    const t = parsePaneRow(row(['/dev/pts/1', '%1', '@0', '1', '0', 'evil\u0007title', '/tmp\u0001x']), new Map());
    expect(t!.title).toBe('eviltitle');
    expect(t!.cwd).toBe('/tmpx');
  });
});

describe('TUI 名单的已知误判（显式钉住这个取舍）', () => {
  it('MinIO 客户端 mc 会被误判成 Midnight Commander —— 已知、fail-safe（只是拒发不会弄坏终端）', () => {
    expect(hasTuiProc(['/usr/local/bin/mc'])).toBe(true);
  });
});
