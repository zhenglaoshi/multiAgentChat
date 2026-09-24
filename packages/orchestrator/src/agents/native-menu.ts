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
  /**
   * 扫描范围（下界 `scanFloor` 到选项之间）内命中 `questionAnchor` 的行数（无锚点恒 0）。
   * ≥2 说明 excerpt 里带上了更早一次（已处理的）审批 —— 因为提问行取的是**最上面**那个命中
   * （任何"切掉上一段"的文本规则都可在模型可控的命令体里伪造，见 parseNativeMenu 内注释）。
   * 调用方据此在卡片上标注"以最下面一段为准"。
   */
  anchorHits: number;
}

/** 往回找选项行的窗口。菜单总在最后；放太大会把历史里的编号列表也捞进来。 */
const TAIL_LINES = 40;
/**
 * **无锚点**的问号规则往上找提问行的最大行数。有锚点的路径不用它（见 `ParseNativeMenuOptions.scanFloor`）。
 */
const QUESTION_LOOKBACK = 200;
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

export interface ParseNativeMenuOptions {
  /** 往回找选项行的窗口（默认 40 行） */
  tailLines?: number;
  /**
   * 提问行的**agent 专属锚点**（如 codex 的 `Would you like to run the following command`）。
   *
   * 不给的话提问行 = 选项上方最近的一句以问号结尾的话。这在 codex 上会踩坑（2026-09-15 真机报障）：
   *     Would you like to run the following command?
   *     Reason: 是否允许读取 TAPD 子需求正文用于后端复审？   ← 模型自己写的 Reason，中文常以问号收尾
   *     $ python3 ...
   *     › 1. Yes, proceed (y)
   * 「最近的问号行」抓到的是 Reason 行 → excerpt 从 Reason 起 → 真正的头行不在 excerpt 里 →
   * `isNativeMenuScreen()` 的成对措辞闸门（要求头行在 excerpt 内）判 false → **不镜像，手机端卡死**。
   *
   * 语义（security 评审 2026-09-15 后收紧）：
   *  - 必须是**整行严格**匹配（`^…$`，对 trim 后的行），不能是子串 —— 子串会被模型写在 Reason/命令里的诱饵命中；
   *  - 取扫描范围内**最上面**一个命中的行，不是最近的，且**没有任何文本边界哨兵**（哨兵可在命令体里伪造）；下界见 `scanFloor`；
   *  - 给了锚点却找不到 → `questionFound=false`（**不退回**问号规则）→ 调用方不镜像。
   */
  questionAnchor?: RegExp;
  /**
   * 锚点扫描的**下界行号**（含）—— 只在有 `questionAnchor` 时生效；不给 = 扫到屏幕顶部（第 0 行）。
   *
   * 这是唯一**不可被文本伪造**的边界：调用方用「菜单出现之前那个 tick 的屏幕内容」在当前屏幕里定位得到
   * （见 im-lark `native-menu-watcher.ts` 的 snapshot/floor）。攻击者能写的文本都是在那之后打印的，
   * 全在下界之下，只能让 excerpt 变大；下界之上的旧审批则被自然排除。
   * 早先这里是固定 200 行回看窗口：security 评审 2026-09-15 第三轮 PoC 证明，把真头行与诱饵之间塞 ≥200 行
   * 就能让真头行掉出窗口、excerpt 只剩诱饵+选项，而窗口外内容不进 excerpt、预算兜底也管不到。
   * 硬窗口对严格锚点路径已无存在意义（只要能扫到真头行就一定选中它），所以改成扫到下界为止。
   * 可传函数：只有屏幕尾部真的有选项块时才会被调用（省掉无菜单 tick 的全屏定位开销）。
   *
   * ⚠ 没有下界（调用方还没建立快照，典型是 daemon 刚重启时菜单已挂在屏上）时**故意不退回有界窗口**：
   * 有界窗口 = security 第三轮 PoC（塞 ≥N 行把真头行顶出窗口）原样复活。宁可扫全屏 → 超集 → 撞展示预算 →
   * 调用方发"缺少基线、请到电脑前"的提示卡；下一次审批起快照就绪、恢复正常。
   */
  scanFloor?: number | (() => number);
}

/**
 * 解析屏幕尾部的原生菜单。认不出返回 null。
 *
 * ⚠ 本函数只做**结构**解析，不判断"这是不是真菜单"——那是 `isNativeMenuScreen()` 的事。
 *
 * @param screen 终端屏幕内容（capture-pane / history 的原样文本）
 */
export function parseNativeMenu(screen: string, opts: ParseNativeMenuOptions = {}): NativeMenu | null {
  if (!screen) return null;
  const tailLines = opts.tailLines ?? TAIL_LINES;
  const anchor = opts.questionAnchor;
  const scanFloorOf = () => {
    const v = typeof opts.scanFloor === 'function' ? opts.scanFloor() : (opts.scanFloor ?? 0);
    return Math.max(0, Math.floor(v));
  };
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
    // 选项文案**不设长度上限**（曾有 200 字上限、超长整个菜单判 null）。codex 0.154 的审批菜单第 2 项是
    //   `Yes, and don't ask again for commands that start with \`<整条命令>\` (p)`
    // 命令本身就能轻松过 200 字（真机样本 237 字）→ 整个菜单被丢弃 → 手机端收不到选择框（2026-09-15 报障）。
    // "超长多半是正文不是选项"这条启发式挡不住什么真问题（真正的闸门是 `isNativeMenuScreen` 的成对措辞），
    // 却会把最需要镜像的那种真菜单挡掉。行长本身已被 MAX_LINE_LEN 截断，不会无界。
    collected.unshift({ index: Number(m[1]), label: m[2]! });
    start = i;
  }

  // 编号必须是严格的 1..N（乱序 / 跳号 / 不从 1 开始 → 多半是普通列表，不认）
  if (collected.length < 2) return null;
  for (let i = 0; i < collected.length; i++) {
    if (collected[i]!.index !== i + 1) return null;
  }

  // 提问行：从第一个选项往上找（要能跨过命令块）。
  //  - 有锚点（agent 声明了整行严格的头行）→ 从选项往上扫到 `scanFloor`，取**最上面**一个命中的行；找不到 → questionFound=false，
  //    **不退回问号规则**。
  //  - 无锚点 → 「离选项最近的问号行」（通用兜底，只有结构判据、无 agent 措辞的场景）。
  //
  // ⚠ 这里**故意没有任何"菜单边界哨兵"**，也不取"最近的"。security 评审 2026-09-15 用真代码连打两轮：
  //  1. 取"最近的"：头行与选项之间的 Reason / 命令是**模型写的**（可被注入的外部内容左右），攻击者在命令
  //     后面放一行诱饵头行（或以问号收尾的句子），excerpt 就从诱饵起、真正危险的命令被挤出去，闸门因
  //     诱饵含那句措辞照样放行 → 手机上只看到一句无害的话 + 选项 = 盲批。
  //  2. 取"最上面"但加「撞到编号选项行就停」的哨兵：命令体里一行形似 `1. xxx` 的普通文本（写清单 / 配置 /
  //     heredoc 都常见）就能让哨兵在真头行之前熄火，"最上面"退化成"诱饵头行"，效果同 1。
  // 任何基于**文本结构**的边界都能在模型可控的命令体里伪造。唯一结构上不可伪造的事实是：攻击者能写的
  // 文本全在真头行**之下**。所以取窗口内最上面的严格头行 —— 伪造只可能让 excerpt 变大（多给人看），
  // 不可能变小。代价：上一次（已答掉的）审批若落在下界之下，excerpt 会把它也带上；
  // 用 `anchorHits` 报给调用方，卡片上显式标注"以最下面一段为准"，而不是靠可伪造的规则把它切掉。
  // 锚点路径**没有固定行数窗口**：塞 ≥N 行就能把真头行顶出任何固定窗口（security 第三轮 PoC）。
  // 扫描下界只认 `scanFloor`（调用方用"菜单出现之前的屏幕"定位的时间下界，文本伪造不了）；
  // 不给下界就扫到屏幕顶部 —— 会把缓冲区里所有旧审批都带上、excerpt 变大 → 撞展示预算 → fail-closed，
  // 是安全的失败方向。无锚点的问号规则仍用 QUESTION_LOOKBACK 限窗（它只是通用兜底）。
  let question = '';
  let questionIdx = -1;
  let anchorHits = 0;
  const lowest = anchor ? Math.min(scanFloorOf(), start) : Math.max(0, start - QUESTION_LOOKBACK);
  for (let i = start - 1; i >= lowest; i--) {
    const line = lines[i]!.trim();
    if (!line) continue;
    if (anchor) {
      // ⚠ 锚点须是无 g/y 标志的正则（有状态的 lastIndex 会让逐行 test 漏判）
      if (anchor.test(line)) { questionIdx = i; anchorHits++; }   // 不 break：继续往上，取最上面的
      continue;
    }
    if (/[?？]\s*$/.test(line)) { questionIdx = i; break; }
  }
  if (questionIdx >= 0) question = lines[questionIdx]!.trim();

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
    anchorHits,
  };
}
