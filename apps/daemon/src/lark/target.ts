import { basename } from 'node:path';
import type { TerminalTab } from '../terminal/types.js';

export interface ResolvedTarget {
  tab: TerminalTab;
  matchType: 'tty' | 'short-tty' | 'title-exact' | 'title-fuzzy' | 'cwd-basename-exact' | 'cwd-fuzzy';
  query: string;
}

/**
 * 按多种规则解析 @target 字符串到具体 tab。
 *
 * 解析优先级：
 *   1. /dev/ttysXXX 完整路径
 *   2. ttysXXX 简写
 *   3. tab.title 精确匹配
 *   4. cwd 的 basename 精确匹配
 *   5. tab.title 子串
 *   6. cwd 子串
 */
export function resolveTarget(
  tabs: TerminalTab[],
  query: string,
): ResolvedTarget | undefined {
  const q = query.trim();
  if (!q) return undefined;

  // /dev/ttysXXX
  if (q.startsWith('/dev/')) {
    const hit = tabs.find((t) => t.tty === q);
    if (hit) return { tab: hit, matchType: 'tty', query };
    return undefined;
  }

  // ttysXXX 短路径
  if (/^ttys\d+$/.test(q)) {
    const full = `/dev/${q}`;
    const hit = tabs.find((t) => t.tty === full);
    if (hit) return { tab: hit, matchType: 'short-tty', query };
    return undefined;
  }

  const qLower = q.toLowerCase();

  // title 精确（不分大小写）
  let hit = tabs.find((t) => (t.title ?? '').toLowerCase() === qLower);
  if (hit) return { tab: hit, matchType: 'title-exact', query };

  // cwd basename 精确
  hit = tabs.find((t) => {
    if (!t.cwd) return false;
    return basename(t.cwd).toLowerCase() === qLower;
  });
  if (hit) return { tab: hit, matchType: 'cwd-basename-exact', query };

  // title 子串
  hit = tabs.find((t) => (t.title ?? '').toLowerCase().includes(qLower));
  if (hit) return { tab: hit, matchType: 'title-fuzzy', query };

  // cwd 子串
  hit = tabs.find((t) => (t.cwd ?? '').toLowerCase().includes(qLower));
  if (hit) return { tab: hit, matchType: 'cwd-fuzzy', query };

  return undefined;
}

export interface TargetedLine {
  target: string;
  text: string;
}

export interface ChainStepDescriptor {
  target: string;
  prompt: string;
}

export interface ParsedMessage {
  /** 如果有 @target 指令，列出每个目标 + 对应命令；多行同 target 会合并 */
  targeted: TargetedLine[];
  /** 没有任何 @target 时，把整段当做发到 active tab 的文本 */
  fallback?: string;
  /**
   * 链式语法：单行内 `@a X >> @b Y >> @c Z` 串行执行。
   * 仅当消息为单行 + 含 `>>` 时填充；否则 undefined。
   */
  chain?: ChainStepDescriptor[];
  /**
   * 解析告警（v1 不支持的混用场景，例如多行 + chain）。供 handlers 给用户友好提示。
   */
  warning?: string;
}

/**
 * 解析飞书消息文本。
 * 规则：
 *  - 单行 + 含 `>>` → chain（每段必须形如 `@target text`）
 *  - 行首 @<target> <text> → 该行属于 target（batch / single）
 *  - 非 @ 行：若之前已有 @ 行，归入最近的 target（多行命令）；否则进 fallback
 */
export function parseMessage(text: string): ParsedMessage {
  const lines = text.split('\n');

  // 优先尝试 chain（仅当消息只有一行且含 `>>`）
  const nonBlankLines = lines.filter((l) => l.trim() !== '');
  if (nonBlankLines.length === 1 && /(^|[^>])>>(?!>)/.test(nonBlankLines[0]!)) {
    const chain = parseChain(nonBlankLines[0]!);
    if (chain && chain.steps.length >= 2) {
      return { targeted: [], chain: chain.steps };
    }
    if (chain && chain.warning) {
      return { targeted: [], warning: chain.warning };
    }
  } else if (nonBlankLines.length > 1 && nonBlankLines.some((l) => /(^|[^>])>>(?!>)/.test(l))) {
    return {
      targeted: [],
      warning:
        'chain 语法 `>>` 必须单行使用；多行视为并发 batch。请把链路写成一行。',
    };
  }

  const targeted: TargetedLine[] = [];
  const fallbackLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (!trimmed) {
      if (targeted.length > 0) {
        targeted[targeted.length - 1]!.text += '\n';
      } else {
        fallbackLines.push('');
      }
      continue;
    }
    const m = trimmed.match(/^@(\S+)\s+(.+)$/);
    if (m) {
      targeted.push({ target: m[1]!, text: m[2]!.trim() });
    } else if (targeted.length > 0) {
      targeted[targeted.length - 1]!.text += '\n' + trimmed;
    } else {
      fallbackLines.push(line);
    }
  }

  // 清理每个 targeted text 的 trailing 空行
  for (const t of targeted) t.text = t.text.trim();

  if (targeted.length === 0) {
    return { targeted: [], fallback: fallbackLines.join('\n') };
  }
  return { targeted };
}

/**
 * 拆解形如 `@a X >> @b Y >> @c Z` 的单行 chain。
 * 每段必须以 `@<target>` 开头；至少 2 段才视为合法 chain。
 */
function parseChain(line: string): { steps: ChainStepDescriptor[]; warning?: string } | undefined {
  const segments = line.split(/\s*>>\s*/).map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) return undefined;
  const steps: ChainStepDescriptor[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const m = seg.match(/^@(\S+)\s+(.+)$/);
    if (!m) {
      return {
        steps: [],
        warning: `chain 第 ${i + 1} 段缺少 \`@target\` 前缀："${seg.slice(0, 40)}"`,
      };
    }
    steps.push({ target: m[1]!, prompt: m[2]!.trim() });
  }
  return { steps };
}
