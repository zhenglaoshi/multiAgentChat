import type { AgentHookSpec } from './types.js';

/**
 * hook 安装的**纯逻辑**：配置文本进、配置文本出，不碰文件系统。
 * daemon 只负责读盘 / 备份 / 写盘（见 apps/daemon/src/index.ts 的 installClaudeCodeHooks /
 * installCodexHooks）。放这里是为了能单测 —— 这两段逻辑一旦写坏，代价是用户的
 * ~/.claude/settings.json 或 ~/.codex/config.toml 被破坏。
 */

/** 已解析成绝对路径的 hook 规格（daemon 把 spec.script 解析成 command 后传进来）。 */
export interface ResolvedHookSpec {
  event: string;
  matcher: string;
  /** hook 脚本绝对路径 */
  command: string;
  purpose: string;
  timeoutSec?: number;
}

/** 本项目管理的 hook 脚本名 —— 清旧条目时按这个识别「哪些是我们写进去的」。 */
export const MCHAT_HOOK_SCRIPTS = [
  'mchat-stop-hook',
  'mchat-pretooluse-hook',
  'mchat-posttooluse-hook',
  'mchat-permission-hook',
  'mchat-task-hook',
  'mchat-hook-echo',
];

/** 历史上本项目往 claude settings.json 写过的 slot —— 即便本次不装也要清一遍残留。 */
export const MCHAT_CLAUDE_HOOK_SLOTS = ['Stop', 'PreToolUse', 'PostToolUse'];

/** 把 adapter 的 spec 配上脚本绝对路径。`resolveScript` 返回 undefined = 该脚本不存在，跳过。 */
export function resolveHookSpecs(
  specs: readonly AgentHookSpec[],
  resolveScript: (script: string) => string | undefined,
): ResolvedHookSpec[] {
  const out: ResolvedHookSpec[] = [];
  for (const spec of specs) {
    const command = resolveScript(spec.script);
    if (!command) continue;
    out.push({
      event: spec.event,
      matcher: spec.matcher,
      command,
      purpose: spec.purpose,
      ...(spec.timeoutSec !== undefined ? { timeoutSec: spec.timeoutSec } : {}),
    });
  }
  return out;
}

// ───────────────────────────── claude: settings.json ─────────────────────────────

type ClaudeHookEntry = {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string }>;
};
type ClaudeSettings = {
  hooks?: { [slot: string]: ClaudeHookEntry[] | undefined };
  [k: string]: unknown;
};

/**
 * 把 spec 幂等写进 Claude Code 的 settings.json 对象（**原地修改**并返回剔除统计）。
 *
 * 幂等策略：先把所有相关 slot 里指向 mchat-* 的旧条目剔掉，再按 spec 顺序追加。
 * 用户自己的 hook 条目一律保留 —— 判据是 `command` 里是否含本项目的脚本名。
 */
export function applyClaudeHooks(
  cfg: ClaudeSettings,
  specs: readonly ResolvedHookSpec[],
): { removed: Record<string, number> } {
  if (!cfg.hooks || typeof cfg.hooks !== 'object') cfg.hooks = {};
  const hooks = cfg.hooks;

  const stripOld = (slot: string): number => {
    const arr = hooks[slot];
    if (!Array.isArray(arr)) {
      hooks[slot] = [];
      return 0;
    }
    const before = arr.length;
    hooks[slot] = arr.filter((entry) => {
      const hks = entry && Array.isArray(entry.hooks) ? entry.hooks : [];
      return !hks.some(
        (h) => h && typeof h.command === 'string' && MCHAT_HOOK_SCRIPTS.some((s) => h.command!.includes(s)),
      );
    });
    return before - hooks[slot]!.length;
  };

  const removed: Record<string, number> = {};
  for (const slot of new Set([...MCHAT_CLAUDE_HOOK_SLOTS, ...specs.map((s) => s.event)])) {
    removed[slot] = stripOld(slot);
  }
  for (const s of specs) {
    hooks[s.event]!.push({
      matcher: s.matcher,
      hooks: [{ type: 'command', command: s.command }],
    });
  }
  return { removed };
}

// ────────────────────────────── codex: config.toml ──────────────────────────────

/** codex config.toml 里本项目托管区块的哨兵（按它做幂等替换，区块外的用户配置一律不动）。 */
export const CODEX_HOOKS_BEGIN = '# >>> multiagent-chat hooks (managed — 由 daemon 自动维护，勿手改) >>>';
export const CODEX_HOOKS_END = '# <<< multiagent-chat hooks (managed) <<<';

/**
 * TOML 基本字符串字面量。
 *
 * 除了反斜杠与双引号，**控制字符也必须转义** —— 尤其是换行：TOML 的基本字符串里不允许裸换行，
 * 一个没转义的 `\n` 会把这一行劈成两行，后半截被当成新的 TOML 语句 → 等于往用户的
 * config.toml 注入任意内容（例如伪造一条 `[[hooks.*]]`）。这里写进去的值目前只来自
 * 项目自身的 bin/ 绝对路径，正常不含换行；但「路径里不会有换行」是个**隐含假设**，
 * 不该让配置文件的完整性依赖它。
 */
export function tomlString(v: string): string {
  let out = '';
  for (const ch of v) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    // TOML 规定 U+0000–U+0008 / U+000A–U+001F / U+007F 必须用转义序列表示
    else if (code <= 0x1f || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `"${out}"`;
}

/** 渲染 codex 的 `[[hooks.<Event>]]` TOML 区块（含首尾哨兵）。 */
export function renderCodexHooksBlock(specs: readonly ResolvedHookSpec[]): string {
  const lines: string[] = [CODEX_HOOKS_BEGIN];
  for (const s of specs) {
    lines.push(`# ${s.purpose}`);
    lines.push(`[[hooks.${s.event}]]`);
    // matcher 在 codex 是正则且全值匹配（内部包 \A(?:…)\z）；claude 那边是字面量工具名，别混
    lines.push(`matcher = ${tomlString(s.matcher)}`);
    lines.push(`[[hooks.${s.event}.hooks]]`);
    lines.push('type = "command"');
    lines.push(`command = ${tomlString(s.command)}`);
    // 超时来自 adapter 的 spec（阻塞型审批闸要给足，见 orchestrator/agents/codex.ts）
    if (s.timeoutSec !== undefined) lines.push(`timeout = ${s.timeoutSec}`);
    lines.push('');
  }
  lines.push(CODEX_HOOKS_END);
  return lines.join('\n');
}

/**
 * 从旧托管区块的内容里把 codex 自己写的 `[hooks.state...]`（hook 信任记录）切出来。
 *
 * **为什么必须切出来**（真机实测，2026-09-14）：用户在 codex TUI 里 `/hooks` 批准信任后，
 * codex 会把 `[hooks.state]` / `[hooks.state."<path>:stop:0:0"] trusted_hash = ...` 写进
 * config.toml —— 而它插入的位置在我们**END 哨兵之前**（codex 把文件尾部的注释当作尾注，
 * 新表插在它前面）。也就是说信任记录落在了托管区块**内部**。
 * 如果下次 upsert 照常整块替换，就会把信任记录一并删掉 →
 * hook 变回"未信任"、**静默不执行**，回传退化成只剩 notify，而用户不会收到任何提示。
 *
 * 所以替换时把这段原样保留，并挪到**区块之外**（END 哨兵之后）。挪出去之后，
 * 文件尾部不再是我们的注释，codex 后续追加的 state 也会落在区块外，不会再被卷进来。
 *
 * 注：hook 定义本身改了（命令路径 / timeout 变更）时，codex 算出的 trusted_hash 会对不上，
 * 用户仍需重新批准一次 —— 那是 codex 信任模型的固有行为，不是这里能规避的。
 *
 * ⚠ **这里依赖一个观察、不是 codex 的文档承诺**：信任记录总是贴在区块尾部（第一个
 * `[hooks.state` 之后一路到区块末尾都是 state）。若将来 codex 改成把 state 插在托管区块**中间**，
 * 这个「从第一个匹配行吃到末尾」的切法会把夹在中间的 hook 定义一并搬走。
 * 下次走「改 hook 定义 → 重新 /hooks 批准 → 重启 daemon」流程时要专门复核一次这个假设，
 * 结果记进 docs/codex-integration.md §8.4。
 */
export function extractHooksState(blockInner: string): string {
  const m = /^\[hooks\.state(\]|\.)/m.exec(blockInner);
  if (!m || m.index === undefined) return '';
  const state = blockInner.slice(m.index).trim();
  // 校验：搬出去的这一段里**每个**表头都必须是 [hooks.state…。
  // 这是面向「codex 以后改了插入位置」的保险 —— 万一信任记录不再贴在区块尾部，
  // 而是插在两条 hook 定义中间，上面那句「从第一个匹配一路吃到末尾」就会把我们自己的
  // hook 定义当成 state 搬到区块外，形成永不被清理的孤儿（同一个 hook 被注册两次 →
  // 一条命令弹两张审批卡、结果推两遍）。与其静默搬错，不如 fail loud 让人看一眼 ——
  // 和本文件其它分支（多份哨兵 / 哨兵残缺）的处理风格保持一致。
  const stray = state
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('[') && !l.startsWith('[hooks.state'));
  if (stray.length > 0) {
    throw new Error(
      `codex config.toml 的托管区块里，信任记录之后混进了非 [hooks.state 的表头：${stray[0]}。` +
      '未做任何改动 —— 这多半是 codex 改了写入位置，需要人工确认后再调整 extractHooksState。',
    );
  }
  return state;
}

/**
 * 把托管区块幂等并入 codex 的 config.toml 文本。
 *
 * - 已有哨兵区块 → **整块替换**（升级路径：改了 spec 重启 daemon 即生效）
 * - 没有 → 追加到文件末尾
 *
 * 只动哨兵之间的内容。用户自己的 `[hooks]` 条目、`notify`、其余配置一律不碰 ——
 * `[[hooks.X]]` 是 array-of-table，追加不会覆盖已有项，只会往数组里再加一条。
 * 追加到**末尾**也是必须的：TOML 里 `[[...]]` 之后的裸 key 会归属该表，
 * 插到文件中间会把后面用户的顶层 key 吃进我们的表里。
 */
export function upsertCodexHooksBlock(raw: string, block: string): string {
  const begins = countOccurrences(raw, CODEX_HOOKS_BEGIN);
  const ends = countOccurrences(raw, CODEX_HOOKS_END);
  // 文件里出现多份托管区块 = 之前某次写入被打断 / 有人手工编辑留下了残块。
  // 这时**不能**只替换第一份：残块会永久留下（可能指向已删除的旧脚本路径，或把同一个
  // hook 挂两遍 → 同一条命令弹两张审批卡）。也不该自作主张按「第一个 BEGIN 到最后一个 END」
  // 整段吃掉 —— 两块之间可能夹着用户自己的配置。抛出来让 daemon 告警、交给人处理。
  if (begins > 1 || ends > 1) {
    throw new Error(
      `codex config.toml 里有 ${begins} 处 multiagent-chat 托管区块（正常应为 0 或 1）。` +
      '未做任何改动 —— 请手工删掉多余的区块（含首尾哨兵注释）后重启 daemon。',
    );
  }
  const begin = raw.indexOf(CODEX_HOOKS_BEGIN);
  const end = raw.indexOf(CODEX_HOOKS_END);
  if (begins === 0 && ends === 0) {
    return raw.trimEnd() + '\n\n' + block + '\n';
  }
  if (begins === 1 && ends === 1 && end > begin) {
    // 把 codex 写在区块内的信任记录捞出来，放到新区块**之后**（见 extractHooksState）
    const inner = raw.slice(begin + CODEX_HOOKS_BEGIN.length, end);
    const state = extractHooksState(inner);
    const tail = state ? `\n\n${state}\n` : '';
    return raw.slice(0, begin) + block + tail + raw.slice(end + CODEX_HOOKS_END.length);
  }
  // 走到这里 = 哨兵残缺（只有一半，或 END 在 BEGIN 前面）：上次写入被打断，或有人手工删了一行。
  // **不猜区块边界**：孤儿 BEGIN 到哪结束无从判断，按 EOF 截断可能把用户自己的配置一起删掉。
  // 也不退化成「当没有区块直接追加」—— 那会造出一份含两个 BEGIN 的文件，等于把问题推到下次重启。
  // 直接 fail loud，让人看一眼再动。
  throw new Error(
    'codex config.toml 里的 multiagent-chat 托管区块哨兵不成对' +
    `（BEGIN ${begins} 个 / END ${ends} 个${begins === 1 && ends === 1 ? '，且顺序颠倒' : ''}）。` +
    '未做任何改动 —— 多半是上次写入被打断或被手工编辑过，请手工把残块连同哨兵注释删干净后重启 daemon。',
  );
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}
