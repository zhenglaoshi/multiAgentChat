/*
 * AskUserQuestion 多问题 / 多选 → 飞书表单 的纯逻辑（mchat-pretooluse-hook 用，无副作用，便于单测）。
 *
 * 背景：单问题单选早就有「原生菜单 + 飞书按钮卡、pty 写数字直选」双通道；多问题 / 多选以前
 * 只能往飞书推一段展开文本，手机上没法答。两条出路（均已真机验证，2026-09-24）：
 *  - 人**不在**电脑前（锁屏 / 键鼠闲置）→ hook 阻塞等飞书表单作答，用 PreToolUse 的
 *    `updatedInput.answers` 直接把答案填给 AskUserQuestion —— 原生菜单根本不弹，claude 拿到的就是准确答案。
 *  - 人**在**电脑前 → 原生菜单照弹，同时飞书弹表单卡；飞书答完由 daemon 用真按键把原生菜单一路按完
 *    （do script 每次写入都带 \r、且整块写入按「块开始时的状态」处理，单选题只能选中光标项 → 只能走 System Events）。
 *
 * NOTE: ESM only（见 mchat-stop-hook 的说明）。
 */

/** 多问题或含多选题 —— 单问题单选仍走原来的按钮卡通道，这里不接管。 */
export function isMultiAsk(toolInput) {
  const qs = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
  if (qs.length === 0) return false;
  return qs.length > 1 || qs.some((q) => q?.multiSelect === true);
}

function optionLabels(q) {
  const opts = Array.isArray(q?.options) ? q.options : [];
  return opts
    .map((o) => (typeof o?.label === 'string' ? o.label.trim() : ''))
    .filter((l) => l.length > 0);
}

/**
 * AskUserQuestion 的 tool_input → `agent lark ask form --spec-json` 的规格。
 * 原生菜单每题都自带「Type something」→ 表单每题都允许自由输入（allowText）。
 * 任一题没有可用选项 → 返回 null（不接管，退回原来的文本镜像）。
 */
export function toFormSpec(toolInput) {
  const qs = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
  const questions = [];
  for (const q of qs) {
    const options = optionLabels(q);
    const text = typeof q?.question === 'string' ? q.question.trim() : '';
    if (!text || options.length === 0) return null;
    const header = typeof q?.header === 'string' && q.header.trim() ? `【${q.header.trim()}】` : '';
    questions.push({
      title: `${header}${text}`,
      type: q?.multiSelect === true ? 'multi' : 'single',
      options,
      allowText: true,
    });
  }
  if (questions.length === 0) return null;
  return { questions };
}

/**
 * 飞书表单答案（`agent lark ask form` stdout 的 answers 数组）→ AskUserQuestion 的 `answers`
 * （键是原问题文本，值是答案字符串；多选用 ", " 连接 —— 与原生菜单提交时的格式一致，真机核对过）。
 * 有题没答到 → 返回 null（宁可退回原生菜单，也不能替用户编一个答案）。
 */
export function answersFromForm(toolInput, items) {
  const qs = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
  if (!Array.isArray(items)) return null;
  const answers = {};
  for (let i = 0; i < qs.length; i++) {
    const question = typeof qs[i]?.question === 'string' ? qs[i].question : '';
    const item = items.find((it) => Number(it?.q) === i);
    if (!question || !item) return null;
    let value = '';
    if (item.kind === 'text') value = typeof item.text === 'string' ? item.text.trim() : '';
    else if (item.kind === 'multi') value = Array.isArray(item.values) ? item.values.join(', ') : '';
    else value = typeof item.value === 'string' ? item.value : '';
    if (!value) return null;
    answers[question] = value;
  }
  return answers;
}

/** `ioreg -n Root -d1 -a` 的 plist → 是否锁屏（与 host-mac/screen-lock.ts 同一判据）。 */
export function parseScreenLocked(ioregPlist) {
  return /<key>CGSSessionScreenIsLocked<\/key>\s*<true\s*\/>/.test(String(ioregPlist ?? ''));
}

/** `ioreg -c IOHIDSystem -d 4` 输出 → 键鼠闲置秒数；解析不到返回 null。 */
export function parseHidIdleSec(ioregOut) {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(String(ioregOut ?? ''));
  if (!m) return null;
  return Number(m[1]) / 1e9;
}

/**
 * 人是否**不在**电脑前。locked=true → 不在；闲置 ≥ 阈值 → 不在；
 * 任一信号拿不到（非 macOS / ioreg 失败）→ 按「在」处理（退回原生菜单 + 飞书卡驱动，不阻塞会话）。
 */
export function isAway({ locked, idleSec }, awayIdleSec) {
  if (locked === true) return true;
  if (typeof idleSec === 'number' && idleSec >= awayIdleSec) return true;
  return false;
}
