import { describe, it, expect } from 'vitest';
import {
  applyClaudeHooks,
  renderCodexHooksBlock,
  resolveHookSpecs,
  upsertCodexHooksBlock,
  extractHooksState,
  CODEX_HOOKS_BEGIN,
  CODEX_HOOKS_END,
  tomlString,
  type ResolvedHookSpec,
} from '../packages/orchestrator/src/agents/index.js';

const STOP: ResolvedHookSpec = {
  event: 'Stop',
  matcher: '.*',
  command: '/repo/bin/mchat-stop-hook',
  purpose: '回传',
  timeoutSec: 30,
};
const GATE: ResolvedHookSpec = {
  event: 'PreToolUse',
  matcher: '.*',
  command: '/repo/bin/mchat-permission-hook',
  purpose: '审批闸',
  timeoutSec: 360,
};

describe('resolveHookSpecs', () => {
  it('脚本不存在的 spec 被丢掉，其余保序', () => {
    const out = resolveHookSpecs(
      [
        { event: 'Stop', matcher: '*', script: 'a', purpose: 'A' },
        { event: 'PreToolUse', matcher: 'Bash', script: 'missing', purpose: 'B' },
        { event: 'PreToolUse', matcher: 'Task', script: 'c', purpose: 'C', timeoutSec: 9 },
      ],
      (s) => (s === 'missing' ? undefined : `/bin/${s}`),
    );
    expect(out.map((s) => s.command)).toEqual(['/bin/a', '/bin/c']);
    expect(out[0]!.timeoutSec).toBeUndefined();
    expect(out[1]!.timeoutSec).toBe(9);
  });
});

describe('applyClaudeHooks', () => {
  it('空配置 → 按 spec 顺序装上', () => {
    const cfg: Record<string, unknown> = {};
    applyClaudeHooks(cfg, [STOP, GATE]);
    const hooks = (cfg as { hooks: Record<string, unknown[]> }).hooks;
    // spec 带 timeoutSec 就落成 claude 的 `timeout`（秒）
    expect(hooks['Stop']).toEqual([
      { matcher: '.*', hooks: [{ type: 'command', command: '/repo/bin/mchat-stop-hook', timeout: 30 }] },
    ]);
    expect(hooks['PreToolUse']).toHaveLength(1);
  });

  it('spec 没配 timeoutSec → 不落 timeout（既有条目写法不变）', () => {
    const cfg: Record<string, unknown> = {};
    const { timeoutSec: _drop, ...noTimeout } = STOP;
    applyClaudeHooks(cfg, [noTimeout]);
    const hooks = (cfg as { hooks: Record<string, unknown[]> }).hooks;
    expect(hooks['Stop']).toEqual([
      { matcher: '.*', hooks: [{ type: 'command', command: '/repo/bin/mchat-stop-hook' }] },
    ]);
  });

  it('幂等：连跑两次结果一致，不会翻倍', () => {
    const a: Record<string, unknown> = {};
    applyClaudeHooks(a, [STOP, GATE]);
    const once = JSON.stringify(a);
    applyClaudeHooks(a, [STOP, GATE]);
    expect(JSON.stringify(a)).toBe(once);
  });

  it('用户自己的 hook 一条都不能动', () => {
    const cfg = {
      hooks: {
        Stop: [{ matcher: '*', hooks: [{ type: 'command', command: '/me/my-own-hook.sh' }] }],
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/me/audit.sh' }] }],
      },
    };
    const { removed } = applyClaudeHooks(cfg, [STOP]);
    expect(cfg.hooks.Stop[0]).toEqual({
      matcher: '*',
      hooks: [{ type: 'command', command: '/me/my-own-hook.sh' }],
    });
    expect(cfg.hooks.PreToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: '/me/audit.sh' }] },
    ]);
    expect(removed['Stop']).toBe(0);
  });

  it('旧的 mchat-* 条目（哪怕路径变了）被清掉，不留重复', () => {
    const cfg = {
      hooks: {
        Stop: [
          { matcher: '*', hooks: [{ type: 'command', command: '/old/path/bin/mchat-stop-hook' }] },
          { matcher: '*', hooks: [{ type: 'command', command: '/me/keep.sh' }] },
        ],
      },
    };
    const { removed } = applyClaudeHooks(cfg, [STOP]);
    expect(removed['Stop']).toBe(1);
    expect(cfg.hooks.Stop.map((e) => e.hooks[0]!.command)).toEqual([
      '/me/keep.sh',
      '/repo/bin/mchat-stop-hook',
    ]);
  });

  it('本次不装的 slot 里的旧残留也要清（脚本被删/改名的升级路径）', () => {
    const cfg = {
      hooks: {
        PostToolUse: [
          { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: '/x/mchat-posttooluse-hook' }] },
        ],
      },
    };
    applyClaudeHooks(cfg, [STOP]); // specs 里没有 PostToolUse
    expect(cfg.hooks.PostToolUse).toEqual([]);
  });

  it('hooks 字段是坏值（非对象）也不炸', () => {
    const cfg = { hooks: 'oops' } as unknown as Record<string, unknown>;
    expect(() => applyClaudeHooks(cfg, [STOP])).not.toThrow();
  });
});

describe('tomlString', () => {
  it('转义反斜杠与双引号', () => {
    expect(tomlString('a"b')).toBe('"a\\"b"');
    expect(tomlString('C:\\x')).toBe('"C:\\\\x"');
    expect(tomlString('.*')).toBe('".*"');
  });

  // 防回归（security review）：TOML 基本字符串里不允许裸换行 —— 没转义的话这一行会被劈成两行，
  // 后半截当成新的 TOML 语句执行 = 往用户 config.toml 注入任意内容（比如伪造一条 [[hooks.*]]）。
  it('控制字符必须转义，不能让值逃出字符串字面量', () => {
    const out = tomlString('/a/b\ncommand = "/evil"\n#x');
    expect(out).not.toContain('\n');
    expect(out).toContain('\\n');
    expect(tomlString('a\tb')).toBe('"a\\tb"');
    expect(tomlString('a\rb')).toBe('"a\\rb"');
    expect(tomlString('a\u0000b')).toBe('"a\\u0000b"');
  });

  it('渲染出来的整块里不会出现裸控制字符（路径含换行的极端情况）', () => {
    const block = renderCodexHooksBlock([{ ...STOP, command: '/x\ncommand = "/evil"' }]);
    const cmdLines = block.split('\n').filter((l) => l.startsWith('command = '));
    expect(cmdLines).toHaveLength(1); // 注入成功的话会变成两行
  });
});

describe('renderCodexHooksBlock', () => {
  it('渲染成 codex 的 array-of-table，带哨兵', () => {
    const block = renderCodexHooksBlock([STOP, GATE]);
    expect(block.startsWith(CODEX_HOOKS_BEGIN)).toBe(true);
    expect(block.trimEnd().endsWith(CODEX_HOOKS_END)).toBe(true);
    expect(block).toContain('[[hooks.Stop]]');
    expect(block).toContain('[[hooks.Stop.hooks]]');
    expect(block).toContain('matcher = ".*"');
    expect(block).toContain('command = "/repo/bin/mchat-stop-hook"');
    expect(block).toContain('timeout = 360');
  });

  it('没给 timeoutSec 就不落 timeout 行', () => {
    const block = renderCodexHooksBlock([{ ...STOP, timeoutSec: undefined }]);
    expect(block).not.toContain('timeout =');
  });
});

describe('extractHooksState', () => {
  it('没有信任记录 → 空串', () => {
    expect(extractHooksState('[[hooks.Stop]]\nmatcher = ".*"\n')).toBe('');
  });

  it('从第一个 [hooks.state 起一路取到末尾', () => {
    const inner = '[[hooks.Stop]]\nmatcher = ".*"\n\n[hooks.state]\n\n[hooks.state."/c:stop:0:0"]\ntrusted_hash = "sha256:abc"\n';
    expect(extractHooksState(inner)).toBe('[hooks.state]\n\n[hooks.state."/c:stop:0:0"]\ntrusted_hash = "sha256:abc"');
  });

  it('只有带点的子表（没有裸 [hooks.state]）也认', () => {
    expect(extractHooksState('x = 1\n[hooks.state."/c:stop:0:0"]\ntrusted_hash = "h"\n'))
      .toBe('[hooks.state."/c:stop:0:0"]\ntrusted_hash = "h"');
  });

  it('不能被相似前缀误命中（[hooks.stateful] 不是信任记录表）', () => {
    expect(extractHooksState('[[hooks.Stop]]\n[hooks.stateful]\nx = 1\n')).toBe('');
  });

  it('只匹配行首，值里出现 [hooks.state 不算', () => {
    expect(extractHooksState('command = "/x [hooks.state] y"\n')).toBe('');
  });

  // 加固（security review 第四轮）：面向「codex 以后改了插入位置」。若信任记录之后
  // 还混着我们自己的 hook 定义，「一路吃到末尾」就会把它搬到区块外形成永不清理的孤儿
  // （同一个 hook 注册两次 → 一条命令弹两张审批卡）。与其静默搬错，不如 fail loud。
  it('信任记录后面混进非 [hooks.state 的表头 → 抛错，不静默搬走', () => {
    const inner = '[hooks.state."/c:stop:0:0"]\ntrusted_hash = "h"\n\n[[hooks.PreToolUse]]\nmatcher = ".*"\n';
    expect(() => extractHooksState(inner)).toThrow(/非 \[hooks\.state/);
  });

  it('多条 [hooks.state 子表连在一起是正常的，不该误报', () => {
    const inner = '[hooks.state]\n\n[hooks.state."/c:stop:0:0"]\ntrusted_hash = "a"\n\n[hooks.state."/c:pre_tool_use:0:0"]\ntrusted_hash = "b"\n';
    expect(() => extractHooksState(inner)).not.toThrow();
    expect(extractHooksState(inner)).toContain('trusted_hash = "b"');
  });
});

describe('upsertCodexHooksBlock', () => {
  const block = renderCodexHooksBlock([STOP]);

  it('原文件没有区块 → 追加到末尾（TOML 里表之后的裸 key 会被吃掉，只能放最后）', () => {
    const raw = 'notify = ["/repo/bin/mchat-codex-notify"]\n\nmodel = "gpt-5.5"\n\n[tui]\nx = 1\n';
    const next = upsertCodexHooksBlock(raw, block);
    expect(next.startsWith('notify = ')).toBe(true);
    expect(next.indexOf(CODEX_HOOKS_BEGIN)).toBeGreaterThan(next.indexOf('[tui]'));
    expect(next).toContain('model = "gpt-5.5"');
  });

  it('已有区块 → 整块替换，区块外的用户配置逐字不动', () => {
    const raw = 'model = "x"\n\n' + renderCodexHooksBlock([{ ...STOP, command: '/OLD/mchat-stop-hook' }]) + '\n\n[tui]\ny = 2\n';
    const next = upsertCodexHooksBlock(raw, block);
    expect(next).toContain('/repo/bin/mchat-stop-hook');
    expect(next).not.toContain('/OLD/mchat-stop-hook');
    expect(next).toContain('model = "x"');
    expect(next).toContain('[tui]\ny = 2');
    // 替换不能留下第二份区块
    expect(next.split(CODEX_HOOKS_BEGIN)).toHaveLength(2);
  });

  it('幂等：对同一份 spec 连跑两次，第二次输出与第一次逐字相同', () => {
    const raw = 'model = "x"\n';
    const once = upsertCodexHooksBlock(raw, block);
    expect(upsertCodexHooksBlock(once, block)).toBe(once);
  });

  // 防回归（security review）：只 indexOf 第一处哨兵的话，残块会被永久遗留 ——
  // 可能指向已删除的旧脚本路径，或把同一个 hook 挂两遍（同一条命令弹两张审批卡）。
  // 也不能按「第一个 BEGIN 到最后一个 END」整段吃掉：两块之间可能夹着用户自己的配置。
  it('文件里有两份托管区块 → 抛错且不做任何改动，交给人处理', () => {
    const raw = block + '\n\nmodel = "用户自己的配置"\n\n' + block + '\n';
    expect(() => upsertCodexHooksBlock(raw, block)).toThrow(/2 处/);
  });

  // 哨兵残缺时既不能猜边界（按 EOF 截断可能删掉用户配置），也不能当没区块直接追加
  // （那会造出含两个 BEGIN 的文件，等于把问题推到下次重启）→ fail loud。
  it('只有 BEGIN 没有 END（写入被打断）→ 抛错且不改动', () => {
    const raw = 'model = "x"\n\n' + CODEX_HOOKS_BEGIN + '\n[[hooks.Stop]]\n';
    expect(() => upsertCodexHooksBlock(raw, block)).toThrow(/不成对/);
  });

  it('只有 END 没有 BEGIN → 抛错且不改动', () => {
    expect(() => upsertCodexHooksBlock('model = "x"\n' + CODEX_HOOKS_END + '\n', block)).toThrow(/不成对/);
  });

  // 防回归（真机实测 2026-09-14）：用户在 codex TUI 里 /hooks 批准信任后，codex 把
  // [hooks.state] / trusted_hash 写在**END 哨兵之前**（尾部注释被当尾注，新表插它前面），
  // 也就是落在托管区块**内部**。照常整块替换会把信任记录删掉 →
  // hook 变回未信任、**静默不执行**，回传悄悄退化成只剩 notify，用户毫无提示。
  it('codex 写在区块内的信任记录必须被保留，并挪到区块外', () => {
    const raw =
      'model = "x"\n\n' +
      renderCodexHooksBlock([{ ...STOP, command: '/OLD/mchat-stop-hook' }]).replace(
        CODEX_HOOKS_END,
        '[hooks.state]\n\n[hooks.state."/c.toml:stop:0:0"]\ntrusted_hash = "sha256:deadbeef"\n\n' + CODEX_HOOKS_END,
      );
    const next = upsertCodexHooksBlock(raw, block);
    expect(next).toContain('trusted_hash = "sha256:deadbeef"');
    expect(next).toContain('/repo/bin/mchat-stop-hook');
    expect(next).not.toContain('/OLD/mchat-stop-hook');
    // 关键：信任记录现在在 END 哨兵**之后**，下次替换不会再被卷进去
    expect(next.indexOf('trusted_hash')).toBeGreaterThan(next.indexOf(CODEX_HOOKS_END));
  });

  it('保留信任记录后再跑一次仍然幂等', () => {
    const withState =
      'model = "x"\n\n' +
      renderCodexHooksBlock([STOP]).replace(
        CODEX_HOOKS_END,
        '[hooks.state."/c.toml:stop:0:0"]\ntrusted_hash = "sha256:abc"\n\n' + CODEX_HOOKS_END,
      );
    const once = upsertCodexHooksBlock(withState, block);
    expect(upsertCodexHooksBlock(once, block)).toBe(once);
    expect(once).toContain('sha256:abc');
  });

  it('区块里没有信任记录时行为不变（不平白多出空行）', () => {
    const raw = 'model = "x"\n\n' + renderCodexHooksBlock([{ ...STOP, command: '/OLD/x-mchat-stop-hook' }]) + '\n';
    const next = upsertCodexHooksBlock(raw, block);
    expect(next).not.toContain('hooks.state');
    expect(upsertCodexHooksBlock(next, block)).toBe(next);
  });

  it('哨兵顺序颠倒 → 抛错，不按 [begin,end] 乱切', () => {
    const raw = CODEX_HOOKS_END + '\nmodel = "x"\n' + CODEX_HOOKS_BEGIN + '\n';
    expect(() => upsertCodexHooksBlock(raw, block)).toThrow(/不成对/);
  });
});
