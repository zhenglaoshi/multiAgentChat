import { createHash } from 'node:crypto';

/**
 * 从终端屏幕里认出「agent 的原生选择菜单」并解析出选项 —— **纯函数，宿主与传输无关**。
 *
 * 为什么需要它：claude 的 `AskUserQuestion` 能经 PreToolUse hook 镜像成飞书卡，但 agent 的
 * **原生**菜单不走 hook —— 典型如 codex 的命令审批（由它自己的 `approval_policy` 触发）：
 *   Would you like to run the following command?
 *   > 1. Yes, proceed (y)
 *     2. No, and tell Codex what to do differently (esc)
 *   Press enter to confirm or esc to cancel
 * 它没有任何 hook 事件，daemon 只能从屏幕上看见它。手机端因此收不到选择框、会话就卡在那儿
 * （2026-09-14 用户实测报障）。
 *
 * 设计取舍：**宁可漏认，不可错认**。错认的代价是往正在干活的 tab 里注入一个数字（可能被当成
 * 下一轮真实指令执行），漏认只是退回现状。
 *
 * ⚠ **结构判据（本文件）远远不够，必须配合 agent 专属措辞**（`AgentAdapter.nativeMenuPatterns`）。
 * 2026-09-15 评审用真代码跑出的反例：
 *     Do you want me to proceed with the fix?
 *     1. Yes, proceed and apply the patch now.
 *     2. No, show me the diff first and let me review manually.
 *     Press enter to see more of the changed files...
 * 这是 assistant 提是非问题时**很常见**的写法，结构上与真菜单完全同构 —— 只靠「编号 1..N + 问句 +
 * press enter」一定会误判。调用方务必先过 `isNativeMenuScreen()`。
 */

/** 菜单里的一项。`index` 是 **1-based**，与终端里显示的数字一致（也就是要写进 pty 的那个数字）。 */
export interface NativeMenuOption {
  index: number;
  label: string;
}

export interface NativeMenu {
  /** 提问行（选项上方最近的一句以问号结尾的话）；找不到为空串 */
  question: string;
  options: NativeMenuOption[];
  /** 选项文案数组（喂给现有 askArm / quickAnswerOptions 的形状） */
  labels: string[];
  /** 有没有找到提问行。false → excerpt 退化成"只有选项"，调用方**不应**镜像（内容不全 = 盲批） */
  questionFound: boolean;
  /**
   * 推给人看的原文片段：**从提问行（没有则从第一个选项）一直到屏幕末尾**。
   *
   * 为什么不是「屏幕尾部固定 N 行」：codex 把**要执行的命令**打印在问句和选项之间，
   * 固定窗口一旦比命令块短，用户在手机上看到的就只剩选项 —— 那是**盲批**。
   * 与公函那条边界同一个道理：内容必须先于确认按钮到人眼前，且推给人的与终端上的同源。
   */
  excerpt: string;
  /**
   * excerpt 有没有漏掉**与本次审批相关**的内容 —— 等价于「没找到提问行」。
   * 找到提问行时 excerpt 就是从这次审批的开头起的完整区段，上方只是更早的无关历史，不算省略。
   * （早先把它定义成 `excerptFrom > 0` → 现实中几乎恒为 true，把"可能被截断"这个警示稀释成了噪音。）
   */
  truncatedAbove: boolean;
  /**
   * 同一个菜单的稳定标识 —— 用于「同一菜单只推一次」的去重。
   *
   * ⚠ **必须覆盖整个 excerpt（含中间那段待执行命令），不能只用 question + labels**。
   * codex 审批菜单的问句与选项是**固定文案**（"Would you like to run the following command?" +
   * "Yes, proceed (y)" / "No, and tell Codex..."），只用它们做指纹的话，**该 tab 每一次审批的指纹都相同** ——
   * 于是：上一个审批刚被答掉、下一个审批在同一个轮询间隔（3s）内弹出、watcher 没观察到"菜单消失"时，
   * 指纹相同 → 不重推、不 disarm → **飞书上还显示着上一条命令，用户点"1"批准的却是新的那条**。
   * 这是"展示内容 ≠ 实际执行内容"，正是这个功能最不能出的错（评审 2026-09-15 指出）。
   */
  fingerprint: string;
}

/** 往回找选项行的窗口。菜单总在最后；放太大会把历史里的编号列表也捞进来。 */
const TAIL_LINES = 40;
/**
 * 从第一个选项往上找提问行的最大行数 —— 要能跨过 codex 那段可能很长的命令块。
 * 放得比较宽（200）是有意的：找不到提问行时 `excerpt` 会退化成"只有选项"，
 * 而闸门现在要求措辞出现在 excerpt 里 → 直接**不镜像**。窗口太窄会把正常的长命令审批也挡掉。
 */
const QUESTION_LOOKBACK = 200;
/** 单个选项文案长度上限 —— 超长多半是把正文当成了选项 */
const MAX_LABEL_LEN = 200;
/** 单行长度上限：超长行先截断再喂正则（防御性，屏幕上可能有未换行的超长输出） */
const MAX_LINE_LEN = 1000;

/**
 * 一行是不是「编号选项」。允许行首的当前项指针（U+203A / U+276F / `>` / U+25B6 / `*`）与缩进。
 * 编号后允许 `.` 或 `)`。
 */
const OPTION_RE = /^\s*[›❯>▶*]?\s*(\d{1,2})[.)]\s+(\S.*?)\s*$/;

/**
 * ANSI CSI 转义序列 —— capture-pane / AppleScript history 都可能带。
 * 用 `new RegExp` 而不是正则字面量：ESC(0x1b) 写成字面量会在源码里留一个不可见控制字符。
 */
const ANSI_RE = new RegExp('\\u001b\\[[0-9;?]*[A-Za-z]', 'g');

function cleanLine(line: string): string {
  return line.slice(0, MAX_LINE_LEN).replace(ANSI_RE, '').replace(/\r/g, '').trimEnd();
}

/**
 * 菜单指纹 = **excerpt 的 SHA-256**。
 *
 * ⚠ 这里**不能**用自研的弱哈希（原先是个 32bit×2 的 FNV 变体）。它看着只是"去重"，
 * 实际参与的是一个**安全相关**的判定：指纹相同 → 既不重推卡、也不 disarm →
 * 飞书上停留的仍是上一次那张卡。security 评审 2026-09-15 指出的利用链：
 * 若能让两段不同的 excerpt 碰撞（弱哈希输出空间小、实现公开、可离线暴搜），
 * 就能让「无害命令 A 的卡片」配上「危险命令 B 的现场」—— 用户点"1"批准的是从未展示过的 B。
 * 这恰恰是本轮修复要堵的「展示 ≠ 执行」，绝不能在防线自身留这个口子。
 * excerpt 本身有界（≤40 行、每行 ≤1000 字），直接 sha256 成本可以忽略。
 */
function fingerprintOf(parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

/**
 * 这段文本是不是该 agent 的原生菜单 —— **镜像/注入前的必过闸门**。
 *
 * 语义是 **全部命中（AND）**，空数组一律 false（该 agent 不启用镜像）。
 * 之所以要 AND：单条措辞（如 `1. Yes, proceed`）模型自己在正常回答里也会写，
 * 成对的固定措辞才足以把「真菜单」和「模型自己写的编号问句」分开。
 *
 * ⚠ **必须传 `menu.excerpt`（有界的候选菜单区段），绝不能传整屏 scrollback**。
 * 2026-09-15 security 复审的 PoC：`getCachedHistory` 给的是**全量 scrollback**，只要这个 tty 里
 * **曾经**真的弹过一次审批（正常使用几乎必然发生），那两句话就永久留在历史里 →
 * 对整屏做 `.test()` 会让闸门**对该 tty 永久为真**，退化成只剩结构判据把关，
 * 而结构判据正是上一轮被证明「挡不住模型自己写的编号问句」的那个 —— 刚修的 critical 原样复活。
 * 门槛还比想象的低：这两句魔法短语**逐字出现在本仓库的源码注释里**，codex 自审时 `cat` 一下就会点燃。
 * 所以闸门的取景框必须和 `parseNativeMenu` 一致。
 */
export function isNativeMenuScreen(text: string, patterns: readonly RegExp[]): boolean {
  if (!text || patterns.length === 0) return false;
  return patterns.every((re) => re.test(text));
}

/**
 * 解析屏幕尾部的原生菜单。认不出返回 null。
 *
 * ⚠ 本函数只做**结构**解析，不判断"这是不是真菜单"——那是 `isNativeMenuScreen()` 的事。
 *
 * @param screen 终端屏幕内容（capture-pane / history 的原样文本）
 */
export function parseNativeMenu(screen: string, tailLines = TAIL_LINES): NativeMenu | null {
  if (!screen) return null;
  const lines = screen.split('\n').map(cleanLine);
  const scanFrom = Math.max(0, lines.length - tailLines);

  // 在尾部窗口里从下往上找最后一个编号行
  let end = -1;
  for (let i = lines.length - 1; i >= scanFrom; i--) {
    if (OPTION_RE.test(lines[i]!)) { end = i; break; }
  }
  if (end < 0) return null;

  const collected: NativeMenuOption[] = [];
  let start = end;
  for (let i = end; i >= 0; i--) {
    const m = OPTION_RE.exec(lines[i]!);
    if (!m) break;                       // 必须连续相邻，中间断开就停
    const label = m[2]!;
    if (label.length > MAX_LABEL_LEN) return null;
    collected.unshift({ index: Number(m[1]), label });
    start = i;
  }

  // 编号必须是严格的 1..N（乱序 / 跳号 / 不从 1 开始 → 多半是普通列表，不认）
  if (collected.length < 2) return null;
  for (let i = 0; i < collected.length; i++) {
    if (collected[i]!.index !== i + 1) return null;
  }

  // 提问行：从第一个选项往上找最近的一句以问号结尾的话（要能跨过命令块）
  let question = '';
  let questionIdx = -1;
  for (let i = start - 1, seen = 0; i >= 0 && seen < QUESTION_LOOKBACK; i--, seen++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    if (/[?？]\s*$/.test(line)) { question = line; questionIdx = i; break; }
  }

  // 原文片段：从提问行（含）到屏幕末尾 —— 中间那段「要批准的命令」必须在内
  const excerptFrom = questionIdx >= 0 ? questionIdx : start;
  const labels = collected.map((o) => o.label);
  const excerpt = lines.slice(excerptFrom).join('\n').trim();
  return {
    questionFound: questionIdx >= 0,
    question,
    options: collected,
    labels,
    excerpt,
    truncatedAbove: questionIdx < 0,
    // 指纹覆盖**整段 excerpt** = 我们推给用户看的那段原文本身。
    // 这样"指纹没变"与"用户看到的内容没变"是同一件事，不可能再出现展示与执行不一致。
    // 副作用是 excerpt 里若有每 tick 都在变的元素（计时器/spinner），指纹会一直变 →
    // 永远达不到 STABLE_TICKS → **不推送**。那是安全的失败方向（宁可漏推，不可错推）。
    fingerprint: fingerprintOf([excerpt]),
  };
}
