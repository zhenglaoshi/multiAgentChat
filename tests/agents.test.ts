import { describe, it, expect } from 'vitest';
import {
  detectAgentFromProcs,
  getAgentAdapter,
  claudeAdapter,
  codexAdapter,
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
