/*
 * multiAgentChat — 「这次 agent 会话是不是 headless（非交互自动化）」判定
 *
 * 为什么要判：回传 hook 是**全局**装在 ~/.claude/settings.json / ~/.codex/config.toml 的，
 * 本机任何 agent 会话都会触发它，包括知识提炼 / 报告生成这类后台跑的
 * `claude -p` / `codex exec`。那些会话没有对应的 tab，它们的 meta 输出推到飞书纯属噪音。
 *
 * ⚠ 真机实测踩到的坑（2026-09-14）：判定要匹配的是**父进程命令行**，而它长这样 ——
 *     node /Users/x/.nvm/versions/node/v22.12.0/bin/codex exec --sandbox read-only …
 *     /Users/x/.../vendor/x86_64-apple-darwin/bin/codex exec --sandbox read-only …
 *   两层（JS wrapper + 原生二进制）都带 `exec`，但 `codex` 前面是 `/` 而不是空格。
 *   原先写成 `/(^|\s)codex\s+(exec|e)(\s|$)/` → **永远匹配不上**，headless 判定形同虚设，
 *   后台 `codex exec` 的输出会被推去飞书。所以必须允许路径前缀。
 *   （claude 侧不受影响：它匹配的是 `-p` / `--print` 这个**参数**，不是二进制名。）
 */

/** `claude -p` / `claude --print`：headless 标志是参数，与二进制路径无关。 */
const CLAUDE_PRINT = /(^|\s)(-p|--print)(\s|$)/;

/**
 * `codex exec` / `codex e`：二进制可能带任意路径前缀，也可能是 `.js` 包装脚本。
 * `(?:\S*\/)?` 允许路径；要求 `codex` 紧跟在行首/空白/斜杠之后，
 * 这样 `.../bin/mchat-codex-notify` 这种名字里含 codex 的不会误命中（它前面是 `-`）。
 */
const CODEX_EXEC = /(^|\s)(?:\S*\/)?codex(?:\.js)?\s+(exec|e)(\s|$)/;

/**
 * 纯判定：给定父进程命令行，判断是不是 headless 会话。
 * @param {string} parentCmd `ps -o command= -p <ppid>` 的输出
 * @returns {boolean}
 */
export function looksHeadlessCommand(parentCmd) {
  if (typeof parentCmd !== 'string' || !parentCmd) return false;
  return CLAUDE_PRINT.test(parentCmd) || CODEX_EXEC.test(parentCmd);
}
