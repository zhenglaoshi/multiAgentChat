import type { AgentKind } from './types.js';

/**
 * 注入给 tab 里 agent 的引导文案 —— 按 agent 种类分流。
 *
 * 为什么要分流：文案里有一整段在教 agent「单选优先用原生 `AskUserQuestion`」。
 * 那是 **Claude Code 专属工具**，本项目给它配了 PreToolUse/PostToolUse 钩子做飞书镜像
 * （见 bin/mchat-pretooluse-hook）。Codex 没有这个工具、也没有对应的镜像通道 ——
 * 原样灌给 codex 等于教它调一个不存在的东西，用户在手机端就收不到选项。
 * 所以 codex 的版本把整段改成「一律走 `agent lark ask`」（纯 CLI，两个 agent 都能跑）。
 *
 * ⚠ claude 分支的文案与历史逐字一致（tests/agents.test.ts 有快照断言钉住）：
 *   这段 prompt 已被真实使用验证过，任何改动都会改变线上 agent 行为，别顺手"优化"措辞。
 */

/** 两个 agent 共用的开头：并行输出原则 + 推送三件套。 */
const GUIDANCE_HEAD = [
  '[系统提示 - 自动注入]',
  '本对话来自飞书机器人 multiAgentChat。飞书侧通过 AppleScript 观测此 tab 的输出，但 **alt-screen TUI 模式下飞书看不见你的实时屏幕**。',
  '',
  '🔴 首要原则：**两个渠道并行输出，两边都能看到**',
  '- 用户可能同时在飞书 & pc shell 面前 → 响应必须在 shell TUI 里**先完整回答一遍**（自然对话），**然后**用 `agent lark send-text` 推**同样一份**摘要给飞书',
  '- 不要**只**推飞书不在 TUI 里说；也不要**只**在 TUI 里说不推飞书',
  '- 长内容（>2000 字）：TUI 里完整、飞书推浓缩摘要；绝不能相反',
  '',
  '所以：',
  '- 任务完成时先在 TUI 完整回答，然后**必须**调用 `agent lark send-text "结果摘要..."` 主动推送到飞书',
  '- 长任务请每完成一步用 `agent lark send-text` 推送进度',
  '- 文件产出用 `agent lark send-file <path>` 推送文件本体',
];

/** 两个 agent 共用的结尾：审批 / webhook 禁令 / 龙虾技能。 */
const GUIDANCE_TAIL = [
  '- 高风险操作（写数据库 / git push --force / rm -rf / 改 .env）先 `agent request-approval --title --body` 等批准',
  '- 不要直接调任何 webhook（功能弱、不支持文件）',
  '- **「龙虾」= CareyClaw 平台**（bot.ihealthcn.com）。用户说「龙虾/careyclaw 有没有XX接口 / 这个接口怎么调 / 帮我拿XX数据」→ 触发已装的 **careyclaw-apis** 技能（检索/试调平台业务 API）；说「龙虾/careyclaw 部署/发布应用」→ 触发 **careyclaw-deploy** 技能。首次会给浏览器授权链接（用 `agent lark send-text` 把链接推给用户去点）。',
  '',
];

/** claude 的问答段：原生 AskUserQuestion 优先（有飞书镜像），多选/表单走 `agent lark ask`。 */
const ASK_SECTION_CLAUDE = [
  '- **要用户选一个（单选）→ 优先用原生 `AskUserQuestion`**：它在 shell 里弹上下键选择菜单（你人在电脑前可直接选），项目会自动把问题+选项**镜像成飞书按钮卡**（手机端点按钮 / 回裸数字即可，会经 pty 写数字直选那个原生菜单，锁屏也能答）。**电脑原生菜单 + 手机飞书卡，两边都能答，谁先答谁生效** —— 这正是"有时候用电脑、有时候用手机"两不误。',
  '- 多选 / 多问题表单 / 自由长文本 → 用 `agent lark ask`（飞书交互更完整，弹卡手指点选；但**只走飞书、电脑端没有原生菜单**）。确定人在电脑前时也可继续用 AskUserQuestion（原生多选菜单，飞书端仅显示、不便点选）。用户不必手打命令。',
  '    单选：`agent lark ask single --title "选哪个？" --options "选项A,选项B,选项C"`',
  '    多选：`agent lark ask multi  --title "勾选多个" --options "1,2,3"`',
  '    ⚠ 选项文本里**含逗号**时 `--options` 会被拆乱 → 改用 JSON 数组：`--options \'["含,逗号的选项","选项2"]\'`（或 `--options-json`），一个 flag 安全搞定',
  '    输入：`agent lark ask input  --title "输入什么"`  （用户在飞书 chat 里直接回复文本即可）',
  '    多问题表单：`agent lark ask form --title "标题" --spec-json \'{"questions":[{"title":"Q1","type":"single","options":["A","B"],"allowText":true},{"title":"Q2","type":"multi","options":["X","Y"]}]}\'` —— 一次问多个、每题单/多选、allowText 题可自由输入；stdout 返回 `{"status":"answered","type":"form","answers":[{"q":0,"kind":"single","index":0,"value":"A"},...]}`。**多问题表单场景用它**（AskUserQuestion 也能多问题，但飞书镜像对多选/多问题作答不便，表单走这个更顺）。',
  '    stdout 示例：`{"status":"answered","type":"single","index":1,"value":"选项B"}`；status 也可能是 cancelled / timeout',
  '    退出码：0=answered，1=cancelled，2=timeout',
  '- 单选问题**优先原生 `AskUserQuestion`**（原生菜单自动镜像飞书、两边可答）；多选/表单/自由文本用 `agent lark ask`。别在裸 TUI 里 `read` 等键盘而不给任何飞书通道 —— 人在手机时会收不到。',
];

/**
 * codex 的问答段：一律走 `agent lark ask`。
 * codex 有自己的 request_user_input 原生问答，但它**没有对外的 hook 事件**
 * （codex 的 lifecycle hooks 只有 PreToolUse/PostToolUse/Stop/... 那一组，见 docs/codex-integration.md），
 * 本项目钩不到，也就镜像不到飞书 —— 用户在手机端会看到一个卡住的 tab 而没有选项。
 */
const ASK_SECTION_CODEX = [
  '- **任何需要用户回答的场景（单选 / 多选 / 填文本 / 一次问多个）→ 一律用 `agent lark ask`**：弹飞书卡，手机端点按钮即可；用户也能直接打字回答（裸数字 / 逗号分隔 / 选项原文）。用户不必手打命令。',
  '    单选：`agent lark ask single --title "选哪个？" --options "选项A,选项B,选项C"`',
  '    多选：`agent lark ask multi  --title "勾选多个" --options "1,2,3"`',
  '    ⚠ 选项文本里**含逗号**时 `--options` 会被拆乱 → 改用 JSON 数组：`--options \'["含,逗号的选项","选项2"]\'`（或 `--options-json`），一个 flag 安全搞定',
  '    输入：`agent lark ask input  --title "输入什么"`  （用户在飞书 chat 里直接回复文本即可）',
  '    多问题表单：`agent lark ask form --title "标题" --spec-json \'{"questions":[{"title":"Q1","type":"single","options":["A","B"],"allowText":true},{"title":"Q2","type":"multi","options":["X","Y"]}]}\'` —— 一次问多个、每题单/多选、allowText 题可自由输入；stdout 返回 `{"status":"answered","type":"form","answers":[{"q":0,"kind":"single","index":0,"value":"A"},...]}`。',
  '    stdout 示例：`{"status":"answered","type":"single","index":1,"value":"选项B"}`；status 也可能是 cancelled / timeout',
  '    退出码：0=answered，1=cancelled，2=timeout',
  '- **别用 codex 自带的原生提问菜单**：它不经本项目的钩子，问题和选项**到不了飞书**，人在手机时只会看到这个 tab 卡着不动。同理别在裸 TUI 里 `read` 等键盘。',
];

/** 完整 SYSTEM_GUIDANCE（首次 / 每 6h 注入一次）。 */
export function buildSystemGuidance(kind: AgentKind): string {
  const ask = kind === 'codex' ? ASK_SECTION_CODEX : ASK_SECTION_CLAUDE;
  return [...GUIDANCE_HEAD, ...ask, ...GUIDANCE_TAIL].join('\n');
}

/** 短提醒：每条消息末尾追加，防止 6h 间隔的 SYSTEM_GUIDANCE 过期被遗忘。 */
export function buildTuiReminder(kind: AgentKind): string {
  const askLine =
    kind === 'codex'
      ? '要用户**回答任何问题**（单选/多选/填文本/多问题表单）→ `agent lark ask single|multi|input|form`（stdout 拿答案 JSON）。别用 codex 原生提问菜单——它到不了飞书。'
      : '要用户**单选** → 优先原生 `AskUserQuestion`（shell 原生菜单 + 自动镜像飞书按钮卡，电脑/手机两边都能答）；**多选/表单/填文本** → `agent lark ask multi|form|input`（stdout 拿答案 JSON）。';
  return [
    '',
    '---',
    '⚠ 回到飞书 — 飞书看不见你的 TUI 屏幕。**先在 TUI 完整回答用户，然后再** `agent lark send-text "<同样一份摘要>"` 推到飞书（两个渠道并行，不能只推不答）。' + askLine,
  ].join('\n');
}
