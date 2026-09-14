import { describe, it, expect } from 'vitest';
// 静态 import：`commands.ts` 会连带拉起飞书 SDK 等重依赖，放在 `it()` 里动态 import
// 会把这段加载时间算进 5s 的单条用例超时（全量并行跑时实测会超），放模块顶层则算在 import 阶段。
import { isAgentNativeSlash } from '../packages/im-lark/src/lark/commands.js';
import { claudeAdapter, codexAdapter } from '../packages/orchestrator/src/agents/index.js';

describe('slash 转发白名单（跨 agent）', () => {
  it('codex 独有的内建命令必须也在白名单里，否则 codex 用户用不了', () => {
    // /diff 与 /mention 只在 codex 的 builtinSlashCommands 里
    expect(codexAdapter.builtinSlashCommands).toContain('diff');
    expect(claudeAdapter.builtinSlashCommands).not.toContain('diff');
    expect(isAgentNativeSlash('diff')).toBe(true);
    expect(isAgentNativeSlash('mention')).toBe(true);
  });

  it('claude 独有的仍然在（不能为了 codex 把 claude 挤掉）', () => {
    expect(isAgentNativeSlash('agents')).toBe(true);
    expect(isAgentNativeSlash('skills')).toBe(true);
    expect(isAgentNativeSlash('CONFIG')).toBe(true); // 大小写不敏感
  });

  it('/help 刻意不在白名单（mchat 自己的 /help 优先，想要 agent 的用 //help）', () => {
    expect(isAgentNativeSlash('help')).toBe(false);
  });
});
