import type { ApprovalRequest, AskRequest, PerfItem, Plan, TapdItem, IntegrationStatus, Integration, WorkTask, HandoffTask, HandoffStatus, LetterNotification } from 'multiagent-orchestrator';
import { tapdSummary, TAPD_KIND_LABEL, HANDOFF_STATUS_LABEL, allowedNextForRole } from 'multiagent-orchestrator';
import { inferTabStatus, getHostPermissionSpec, type TabStatusInfo, type HostPermissionStatus } from 'multiagent-host-mac';
import type { TerminalTab } from 'multiagent-host-mac';
import { homedir } from 'node:os';

function homeify(p: string, home: string): string {
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/**
 * 用户可控字符串拼进 `lark_md` 前的转义：反引号（提前闭合 inline code）、`[`/`]`（组装
 * `[text](url)` / `![](url)` 钓鱼链接/图片）、反斜杠、`<`（lark_md 白名单 HTML-like 标签）。
 * plain_text 元素不解析 markdown，无需转义——只用于 lark_md/div content。
 */
export function escapeLarkMd(s: string): string {
  return s.replace(/[`\\[\]]/g, '\\$&').replace(/</g, '&lt;');
}

/**
 * 中间省略、保头保尾 —— 用于**区分性信息常在尾部**的场景（路径的 basename、
 * 选项的结尾差异）。tail-cut 的 `truncate` 会把 basename/结尾差异截掉导致两项看着一样；
 * 这个保留头+尾，如 `/Users/zheng/ihealth-project/…/rooster2`。
 */
function smartTrim(s: string, n: number): string {
  if (s.length <= n) return s;
  if (n <= 3) return s.slice(0, n);
  const keep = n - 1; // 给 '…' 留 1
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return s.slice(0, head) + '…' + (tail > 0 ? s.slice(s.length - tail) : '');
}

/**
 * 选项**完整**正文块：编号列出每个选项的全文（lark_md 自动换行、绝不截断），
 * 让用户在正文里看清每项到底在选啥；交互控件（按钮/下拉）只作"按编号选"。
 * markFor 可选（多选打勾 ☑/☐）。搭配 `optionsNeedFullList` 决定要不要插这块。
 */
function choiceBody(options: string[], markFor?: (i: number) => string): string {
  return options
    .map((o, i) => `${markFor ? markFor(i) + ' ' : ''}**${i + 1}.** ${o}`)
    .join('\n');
}

/** 任一选项长到会被按钮/下拉截断 → 需在正文补完整编号列表（默认按按钮宽度 18 判） */
function optionsNeedFullList(options: string[], limit = 18): boolean {
  return options.some((o) => o.length > limit);
}

// ---- Approval card (保留) ----

/**
 * 审批卡片，根据 ApprovalRequest.status 渲染四态。
 *  pending  : 蓝色 + 「✅ 批准」「❌ 拒绝」按钮
 *  approved : 绿色 + "已批准 by ..."
 *  rejected : 红色 + "已拒绝 by ..."
 *  timeout  : 灰色 + "已超时（自动拒绝）"
 */
/**
 * 同事任务甩单卡（P2）。requester（发单方）/ assignee（收单方）各看一张，状态双向同步。
 * ⚠ 对端可控字段（title/summaryMd/peer/note）一律用 `plain_text` 元素渲染——不解析 lark_md，
 *    从根上杜绝 `[text](url)` 钓鱼链接注入（含下游 redactMaybe 二次插入 `[REDACTED-*]`）。
 * 交互多次 patch → 必须 update_multi:true。
 */
export function handoffTaskCard(t: HandoffTask) {
  // 防御性兜底：字段本应经 validateIncoming 保证类型，这里再兜一层防脏数据 render 崩
  const S = (v: unknown, n: number): string => truncate(typeof v === 'string' ? v : String(v ?? ''), n);
  const label = HANDOFF_STATUS_LABEL[t.status] ?? String(t.status);
  const template =
    t.status === 'done' ? 'green' :
    t.status === 'declined' || t.status === 'canceled' ? 'grey' :
    t.role === 'assignee' && t.status === 'sent' ? 'yellow' :  // 待我处理
    'blue';
  const dir = t.role === 'assignee' ? `来自 ${S(t.peer, 80)}` : `发给 ${S(t.peer, 80)}`;

  const elements: unknown[] = [];
  elements.push({ tag: 'div', text: { tag: 'plain_text', content: `${dir}　·　${label}` } });
  if (t.summaryMd) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'plain_text', content: S(t.summaryMd, 2000) } });
  }
  if (Array.isArray(t.attachments) && t.attachments.length) {
    elements.push({
      tag: 'div',
      text: { tag: 'plain_text', content: `📎 附件：${t.attachments.map((a) => S(a?.name, 60)).join('、')}` },
    });
  }
  // 状态历史尾巴（最近 3 条带备注的）——也用 plain_text
  const notes = (Array.isArray(t.statusHistory) ? t.statusHistory : []).filter((h) => h.note).slice(-3);
  for (const h of notes) {
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: `📝 ${S(h.by, 80)}（${HANDOFF_STATUS_LABEL[h.status] ?? h.status}）：${S(h.note, 200)}` }],
    });
  }

  const buttons = handoffButtons(t);
  if (buttons.length > 0) {
    elements.push({ tag: 'action', actions: buttons });
  } else {
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `任务 ${t.id.slice(0, 8)}` }] });
  }

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template, title: { tag: 'plain_text', content: `👥 ${S(t.title, 40)}` } },
    elements,
  };
}

/** 目标状态 → 按钮文案/样式。 */
const HANDOFF_BTN: Record<HandoffStatus, { label: string; type: 'primary' | 'danger' | 'default' }> = {
  accepted: { label: '🤝 接收', type: 'primary' },
  in_progress: { label: '🚧 开始', type: 'primary' },
  done: { label: '✅ 完成', type: 'primary' },
  declined: { label: '🙅 拒绝', type: 'danger' },
  canceled: { label: '↩️ 撤回', type: 'danger' },
  sent: { label: '', type: 'default' }, // 不会作为按钮目标
};

/**
 * 依角色+当前状态给出可点的下一步按钮。规则来自 orchestrator/handoff/state.ts 的
 * allowedNextForRole（单一事实源，CLI/sendHandoffStatus 走同一份），避免按钮与状态机漂移。
 */
function handoffButtons(t: HandoffTask): unknown[] {
  return allowedNextForRole(t.role, t.status).map((status) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: HANDOFF_BTN[status].label },
    type: HANDOFF_BTN[status].type,
    value: { action: 'handoff-status', taskId: t.id, status },
  }));
}

export function approvalCard(req: ApprovalRequest) {
  const template =
    req.status === 'pending' ? 'yellow' :        // pending 强调"需操作"用 yellow
    req.status === 'approved' ? 'green' :
    req.status === 'rejected' ? 'red' :
    'grey';
  const icon =
    req.status === 'pending' ? '🚨' :
    req.status === 'approved' ? '✅' :
    req.status === 'rejected' ? '❌' :
    '⌛';
  const stateLabel =
    req.status === 'pending' ? '需要你审批' :
    req.status === 'approved' ? '已批准' :
    req.status === 'rejected' ? '已拒绝' :
    '已超时（自动拒绝）';

  const elements: unknown[] = [];

  // pending 状态：顶部加强提示 banner
  if (req.status === 'pending') {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `<font color='red'>**⏱ 等你响应中 · 5 分钟超时**</font>`,
      },
    });
    elements.push({ tag: 'hr' });
  }

  elements.push({ tag: 'div', text: { tag: 'lark_md', content: req.body } });
  elements.push({ tag: 'hr' });

  if (req.status === 'pending') {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '✅ 批准' },
          type: 'primary',
          value: { action: 'approve', approvalId: req.id },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '❌ 拒绝' },
          type: 'danger',
          value: { action: 'reject', approvalId: req.id },
        },
      ],
    });
  } else {
    const byPart = req.resolvedBy ? ` by ${req.resolvedBy}` : '';
    const elapsedMs =
      (req.resolvedAt ?? Date.now()) - req.createdAt;
    const elapsed =
      elapsedMs < 1000
        ? `${elapsedMs}ms`
        : elapsedMs < 60_000
          ? `${(elapsedMs / 1000).toFixed(1)}s`
          : `${Math.floor(elapsedMs / 60_000)}m${Math.floor((elapsedMs % 60_000) / 1000)}s`;
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${stateLabel}**${byPart}\n<font color='grey'>耗时 ${elapsed} · ${req.id}</font>`,
      },
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      template,
      title: {
        tag: 'plain_text',
        content: `${icon} ${req.title}`,
      },
    },
    elements,
  };
}

/** 关单个 tab 的确认卡（破坏性 → 先确认）。确认=close-tab-do，取消=close-cancel。 */
export function closeTabConfirmCard(tty: string, opts?: { cwd?: string; hasAgent?: boolean; agentLabel?: string }) {
  const agentNote = opts?.hasAgent
    ? `\n<font color='grey'>该 tab 在跑 ${opts.agentLabel ?? 'claude/codex'} —— 会**先 Ctrl-C 退出**再关，避免残留占 CPU/内存。</font>`
    : '';
  const cwd = opts?.cwd ? `\n📁 \`${opts.cwd}\`` : '';
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'yellow', title: { tag: 'plain_text', content: '⚠️ 确认关闭 tab' } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `确认关闭 \`${tty}\`？该会话将丢失。${cwd}${agentNote}` } },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '✅ 确认关闭' }, type: 'danger', value: { action: 'close-tab-do', tty } },
        { tag: 'button', text: { tag: 'plain_text', content: '⊘ 取消' }, type: 'default', value: { action: 'close-cancel' } },
      ] },
    ],
  };
}

/**
 * 裸 shell（没跑 claude/codex）收到「任务型」内容时的拦截卡。
 * 直接把任务当 shell 命令灌进去会报错、引号不配对还会把 shell 卡进 `dquote>` 续行卡死，
 * 所以先拦下来问：起 agent 执行 / 还是坚持按命令发。
 * 每个可用 agent 一个「起并执行」按钮 + 一个「仍按命令发送」逃生按钮。token 关联暂存的原始 prompt。
 */
export function bareShellNoAgentCard(opts: {
  tty: string;
  promptPreview: string;
  token: string;
  agents: { kind: string; displayName: string }[];
}) {
  const emojiFor = (kind: string) => (kind === 'codex' ? '🐿' : '🤖');
  const launchButtons = opts.agents.map((a) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: `${emojiFor(a.kind)} 起 ${a.displayName} 并执行` },
    type: 'primary',
    value: { action: 'bare-shell-launch', token: opts.token, agent: a.kind },
  }));
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'yellow', title: { tag: 'plain_text', content: `⚠️ ${opts.tty} 还没启动 claude/codex` } },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content:
            `这条更像是给 agent 的**任务**，但 \`${opts.tty}\` 是个裸 shell。直接当命令发会报错，` +
            `引号不配对还会把这个 shell 卡进 \`dquote>\` 续行**卡死**，所以先拦下来：\n\n` +
            `> ${opts.promptPreview}`,
        },
      },
      {
        tag: 'action',
        actions: [
          ...launchButtons,
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '⌨️ 仍按 shell 命令发送' },
            type: 'default',
            value: { action: 'bare-shell-raw', token: opts.token },
          },
        ],
      },
    ],
  };
}

/** 批量关空闲 tab 的确认卡（列出清单 + 数量）。确认=close-idle-do。 */
export function closeIdleConfirmCard(ttys: { tty: string; cwd?: string; agentLabel?: string }[]) {
  const lines = ttys.map((t) => `· \`${t.tty}\`${t.agentLabel ? ` (${t.agentLabel})` : ''}${t.cwd ? ` — ${t.cwd}` : ''}`);
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'yellow', title: { tag: 'plain_text', content: `⚠️ 确认关闭 ${ttys.length} 个空闲 tab` } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `将关闭以下空闲 tab（不含 daemon 自己 / 忙碌中的）；**在跑 claude/codex 的会先 Ctrl-C 退出再关**：\n${lines.join('\n')}` } },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: `✅ 全部关闭 (${ttys.length})` }, type: 'danger', value: { action: 'close-idle-do' } },
        { tag: 'button', text: { tag: 'plain_text', content: '⊘ 取消' }, type: 'default', value: { action: 'close-cancel' } },
      ] },
    ],
  };
}

// ---- Tabs card (按 window 分组) ----

export interface TabsCardData {
  tabs: TerminalTab[];
  activeTty?: string;
  home: string;
  /** 可选 status overrides：watcher / dashboard 可以传更精确的 status（含 history detect） */
  statusByTty?: Map<string, TabStatusInfo>;
  /** daemon 自己所在 tab：不给「关闭」按钮（关了整套服务就没了）。 */
  selfTty?: string;
}

export function tabsCard(data: TabsCardData) {
  const elements: unknown[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `PC 上共 **${data.tabs.length}** 个 Terminal tab${data.activeTty ? `，本会话当前 = \`${data.activeTty}\`` : ''}`,
      },
    },
    { tag: 'hr' },
  ];

  if (data.tabs.length === 0) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: 'Terminal.app 里没有 tab。发送 `/new` 开一个。' },
    });
  } else {
    // group by windowId, preserve order
    const groups = new Map<number, TerminalTab[]>();
    for (const t of data.tabs) {
      const arr = groups.get(t.windowId);
      if (arr) arr.push(t);
      else groups.set(t.windowId, [t]);
    }
    for (const [wid, arr] of groups) {
      const front = arr[0]?.windowFrontmost ? ' (front)' : '';
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `📦 **Window ${wid}**${front}`,
        },
      });
      for (const t of arr) {
        const star = t.tty === data.activeTty ? '★ ' : '';
        const statusInfo = data.statusByTty?.get(t.tty) ?? inferTabStatus(t);
        const cwdShown = homeify(t.cwd ?? '?', data.home);
        const detailLine = statusInfo.detail
          ? `\n<font color='grey'>${statusInfo.detail}</font>`
          : '';
        const procs = t.processes.length
          ? `\n<font color='grey'>${t.processes.slice(-3).join(' / ')}</font>`
          : '';
        const title = t.title
          ? `\n<font color='grey'>"${truncate(t.title, 50)}"</font>`
          : '';
        elements.push({
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `${star}${statusInfo.icon} \`${t.tty}\` · **${statusInfo.label.replace(/^[^\w一-龥]+\s*/, '')}**\n📁 \`${cwdShown}\`${detailLine}${title}${procs}`,
          },
        });
        // 按钮行：非当前 tab → [★ 用它] [→ 发一条]；当前 tab → 只 [→ 发一条]（切没意义）
        const perTabActions: unknown[] = [];
        if (t.tty !== data.activeTty) {
          perTabActions.push({
            tag: 'button',
            text: { tag: 'plain_text', content: '★ 切到这个' },
            type: 'primary',
            value: { action: 'use-tab', tty: t.tty },
          });
        }
        perTabActions.push({
          tag: 'button',
          text: { tag: 'plain_text', content: '→ 发一条' },
          type: t.tty === data.activeTty ? 'primary' : 'default',
          value: { action: 'send-to-tab-arm', tty: t.tty },
        });
        // daemon 自己的 tab 不给关闭按钮（关了整套没了）
        if (t.tty !== data.selfTty) {
          perTabActions.push({
            tag: 'button',
            text: { tag: 'plain_text', content: '🗑 关闭' },
            type: 'danger',
            value: { action: 'close-tab-confirm', tty: t.tty },
          });
        }
        elements.push({ tag: 'action', actions: perTabActions });
      }
      elements.push({ tag: 'hr' });
    }
  }

  // 底部：开新 tab + 一键关闭空闲的 claude/codex tab（省 CPU/内存；排除自己/忙的，确认时列清单）
  const bottomActions: unknown[] = [
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '🆕 开新 tab' },
      type: 'primary',
      value: { action: 'choose-dir' },
    },
  ];
  // 空闲 = 非忙碌 + 非 daemon 自己（含普通 shell 和 idle 的 claude/codex）。有 agent 的关前会先退。
  const idleCount = data.tabs.filter((t) => t.tty !== data.selfTty && !t.busy).length;
  if (idleCount > 0) {
    bottomActions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: `🧹 关闭空闲 tab (${idleCount})` },
      type: 'danger',
      value: { action: 'close-idle-confirm' },
    });
  }
  elements.push({ tag: 'action', actions: bottomActions });

  return {
    // update_multi:true —— 多按钮交互卡，点 use-tab 后 patchCard 才能视觉生效（否则 API code 0 卡不变、"点了没反应"）
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'turquoise',
      title: { tag: 'plain_text', content: '🐚 Terminal Tabs' },
    },
    elements,
  };
}

// ---- Choose dir card (三段式) ----

export interface ChooseDirEntry {
  cwd: string;
  label: string;
  hint?: string;
}

export interface ChooseDirCardData {
  quickEntries: ChooseDirEntry[];      // 快速按钮
  dropdownEntries: ChooseDirEntry[];   // 下拉框选项
  home: string;
  defaultCwd: string;                  // ~
  title?: string;                      // 覆盖 header 标题（fuzzy 匹配卡片用）
  browseStart?: string;                // 「浏览」按钮的起点，通常 = home
}

export function chooseDirCard(data: ChooseDirCardData) {
  const elements: unknown[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: '**在哪个目录开新 tab？**\n手机端选目录：先看下面按钮；找不到就点最下方「🗂 浏览」层层进；或发 `/new pigeon` 关键词模糊匹配、`/new @<alias>` 用收藏。',
      },
    },
    { tag: 'hr' },
    { tag: 'div', text: { tag: 'lark_md', content: '🚀 **快速选**' } },
  ];

  for (const e of data.quickEntries) {
    const shown = homeify(e.cwd, data.home);
    elements.push({
      tag: 'div',
      fields: [
        {
          is_short: false,
          text: {
            tag: 'lark_md',
            content: `**${e.label}**\n\`${shown}\`${e.hint ? `\n<font color='grey'>${e.hint}</font>` : ''}`,
          },
        },
      ],
      extra: {
        tag: 'button',
        text: { tag: 'plain_text', content: '在这开' },
        type: 'primary',
        value: { action: 'create-tab', cwd: e.cwd },
      },
    });
  }

  if (data.dropdownEntries.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '📂 **或从全部目录里选**' },
    });
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'select_static',
          placeholder: {
            tag: 'plain_text',
            content: `选目录…（默认 ${homeify(data.defaultCwd, data.home)}）`,
          },
          options: data.dropdownEntries.map((e) => ({
            text: {
              tag: 'plain_text',
              content: smartTrim(homeify(e.cwd, data.home), 60),
            },
            value: `create-tab|${e.cwd}`,
          })),
          value: { action: 'create-tab-via-select' },
        },
      ],
    });
  }

  elements.push({ tag: 'hr' });
  // 🗂 浏览按钮 —— 从 browseStart 开始级联点击
  if (data.browseStart) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '🗂 浏览文件夹（层层点）' },
          type: 'default',
          value: { action: 'browse-dir', cwd: data.browseStart },
        },
      ],
    });
  }
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content:
        '**其它快捷用法**\n' +
        '• `/new ~/code/foo`  精确路径\n' +
        '• `/new pigeon`      关键词模糊匹配\n' +
        '• `/new @mac`        用收藏\n' +
        '• `/pin mac`         把当前 tab 的 cwd 存为 @mac',
    },
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'green',
      title: {
        tag: 'plain_text',
        content: data.title ?? '🗂 选择目录开新 Tab',
      },
    },
    elements,
  };
}

// ---- Browse card (级联浏览文件系统) ----

export interface BrowseCardEntry {
  path: string;      // 绝对路径
  name: string;      // basename 展示
  isGitRepo?: boolean;
}

export interface BrowseCardData {
  currentCwd: string;              // 当前浏览到哪
  parentCwd?: string;              // 上一层（用于「返回上级」）
  subdirs: BrowseCardEntry[];      // 当前目录下的**全部**子文件夹（卡片内部分页展示）
  home: string;
  page?: number;                   // 当前页（0-based）；超过总页数会被夹到合法范围
  truncated?: boolean;             // 已废弃：分页后不再截断，保留字段仅为兼容
}

/** 单页最多列多少子文件夹（feishu select_static 选项有上限，且太长下拉难滚 → 分页）。 */
const BROWSE_PAGE_SIZE = 25;

export function browseCard(data: BrowseCardData) {
  const cwdShown = homeify(data.currentCwd, data.home);
  const total = data.subdirs.length;
  const pageCount = Math.max(1, Math.ceil(total / BROWSE_PAGE_SIZE));
  // 夹到合法范围（防越界 page）
  const page = Math.min(Math.max(0, data.page ?? 0), pageCount - 1);
  const start = page * BROWSE_PAGE_SIZE;
  const end = Math.min(start + BROWSE_PAGE_SIZE, total);
  const pageSlice = data.subdirs.slice(start, end);

  const countLine =
    total === 0
      ? '（这里没有子文件夹）'
      : pageCount > 1
        ? `子文件夹 ${total} 个 · 第 ${page + 1}/${pageCount} 页（本页 ${start + 1}–${end}）`
        : `子文件夹 ${total} 个`;

  const elements: unknown[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `📍 **当前**：\`${cwdShown}\`\n${countLine}`,
      },
    },
    { tag: 'hr' },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '✅ 就在这开 tab' },
          type: 'primary',
          value: { action: 'create-tab', cwd: data.currentCwd },
        },
        ...(data.parentCwd
          ? [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '⬆ 上一层' },
                type: 'default',
                value: { action: 'browse-dir', cwd: data.parentCwd },
              },
            ]
          : []),
      ],
    },
  ];

  if (total > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '📂 **进入子文件夹**' },
    });
    // 用 select_static 列出本页（避免几十个按钮把卡片撑爆 + 绕开 select 选项上限）
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'select_static',
          placeholder: {
            tag: 'plain_text',
            content: '选一个子文件夹进入…',
          },
          options: pageSlice.map((e) => ({
            text: {
              tag: 'plain_text',
              content: truncate(
                (e.isGitRepo ? '📦 ' : '📁 ') + e.name,
                60,
              ),
            },
            value: `browse-dir|${e.path}`,
          })),
          value: { action: 'browse-dir-select' },
        },
      ],
    });
    // 分页导航（仅多页时出现）：上一页 / 下一页，停在同目录、翻页
    if (pageCount > 1) {
      const navButtons: unknown[] = [];
      if (page > 0) {
        navButtons.push({
          tag: 'button',
          text: { tag: 'plain_text', content: '◀ 上一页' },
          type: 'default',
          value: { action: 'browse-dir', cwd: data.currentCwd, page: page - 1 },
        });
      }
      if (page < pageCount - 1) {
        navButtons.push({
          tag: 'button',
          text: { tag: 'plain_text', content: '下一页 ▶' },
          type: 'default',
          value: { action: 'browse-dir', cwd: data.currentCwd, page: page + 1 },
        });
      }
      elements.push({ tag: 'action', actions: navButtons });
    }
  }

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `<font color='grey'>Tip：也可以直接发 \`/new ${cwdShown}/子目录名\`</font>`,
    },
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: `🗂 浏览目录` },
    },
    elements,
  };
}

// ---- Waiting input card (tab 卡在等输入时通知) ----

export interface WaitingInputCardData {
  tty: string;
  title: string;         // tab.title
  cwd: string;
  promptSnippet: string; // 末尾 12 行
  home: string;
}

export function waitingInputCard(data: WaitingInputCardData) {
  const cwdShown = homeify(data.cwd, data.home);
  return {
    // update_multi：卡上有 use-tab/回复按钮，点击后 patch 才视觉生效
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'yellow',
      title: {
        tag: 'plain_text',
        content: `🚨 需要你输入 · ${data.tty}`,
      },
    },
    elements: [
      // 顶部强提示 banner
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `<font color='red'>**⏱ Terminal 正在等你响应**</font>`,
        },
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `🏷 \`${data.tty}\` · 📁 \`${cwdShown}\`${data.title ? `\n<font color='grey'>"${truncate(data.title, 60)}"</font>` : ''}`,
        },
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `\`\`\`\n${data.promptSnippet}\n\`\`\``,
        },
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: { tag: 'lark_md', content: '**快捷响应**' },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'y' },
            type: 'primary',
            value: { action: 'send-to-tab', tty: data.tty, text: 'y' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'n' },
            type: 'danger',
            value: { action: 'send-to-tab', tty: data.tty, text: 'n' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '⏎ Enter' },
            type: 'default',
            value: { action: 'send-to-tab', tty: data.tty, text: '' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '📜 看完整 history' },
            type: 'default',
            value: { action: 'show-history', tty: data.tty },
          },
        ],
      },
      { tag: 'hr' },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: '**自由文字回复**\n直接发消息（任意文本）会进入这个 tab。先 /use 切到它：',
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '★ 设为当前 tab（之后消息直发它）' },
            type: 'primary',
            value: { action: 'use-tab', tty: data.tty },
          },
        ],
      },
    ],
  };
}

// ---- Progress card（实时跟踪 tab 输出，patch 而非新发） ----

export interface ProgressCardData {
  state: 'running' | 'done' | 'failed';
  tty: string;
  taskDescription: string;
  cwd?: string;
  outputTail: string;
  startedAt: number;
  updatedAt: number;
  isActiveForChat?: boolean;
  /** 完整 prompt（用于「↻ 重发」按钮，只有 feishu 来源任务才有） */
  rerunPrompt?: string;
  rerunTargetLabel?: string;
  /** 任务来源 —— 'local' 时卡片标题加 🏠 标识；wecom 在此侧不渲染，daemon 另派 */
  source?: 'feishu' | 'local' | 'wecom';
  /** pending.sentAt，作为按钮 value 里的唯一 key 找回 pending */
  sentAt?: number;
  /** 单卡静默模式：显示"已静默"提示 + 按钮变成"🔊 恢复实时" */
  quietUntilDone?: boolean;
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m${s}s`;
  }
  return `${Math.floor(ms / 3_600_000)}h${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

export function progressCard(data: ProgressCardData) {
  const template =
    data.state === 'running' ? 'blue' :
    data.state === 'done' ? 'green' :
    'red';
  const icon =
    data.state === 'running' ? '⏳' :
    data.state === 'done' ? '✓' :
    '✗';
  const stateLabel =
    data.state === 'running' ? '执行中' :
    data.state === 'done' ? '完成' :
    '失败';

  const elapsed = fmtElapsed(data.updatedAt - data.startedAt);
  const updatedSec = Math.floor((Date.now() - data.updatedAt) / 1000);
  const body = (data.outputTail || '(暂无输出)').slice(-2500);

  // 布局：一个 div 装完（正文代码块 + 元数据灰字），一行 action 按钮
  //   header — [icon][state] · [tty] · [taskDescription 前 40 字]
  //   div    — 正文代码块 + `<font color='grey'>` 元数据行
  //   action — 按钮组
  // Feishu 会在 header/div/action 之间画很淡的隐式分隔；只保留 div↔action 之间那 1 条
  // （不再单独用 note 元素，避免多一条 div↔note 分隔）
  const shortDesc = data.taskDescription.length > 40
    ? data.taskDescription.slice(0, 40) + '…'
    : data.taskDescription;

  // 具体路径塞进标题（homeified 完整路径，过长中间省略保头尾），让"在哪执行"一眼可见。
  const cwdShown = data.cwd ? homeify(data.cwd.replace(/\/+$/, ''), homedir()) : '';
  const folderTag = cwdShown ? `📁${smartTrim(cwdShown, 42)} · ` : '';

  const metaParts: string[] = [];
  if (cwdShown) metaParts.push(`📁 ${cwdShown}`);
  metaParts.push(`⏱ ${elapsed}`);
  metaParts.push(`${updatedSec}s 前更新`);
  if (data.quietUntilDone && data.state === 'running') {
    metaParts.push(`🔇 已静默 · 完成时才更新`);
  }

  const bodyBlock = '```\n' + body + '\n```';
  const metaLine = `<font color='grey'>${metaParts.join(' · ')}</font>`;

  const elements: unknown[] = [
    {
      tag: 'div',
      text: { tag: 'lark_md', content: `${bodyBlock}\n${metaLine}` },
    },
  ];

  // running 状态下加操作按钮
  if (data.state === 'running') {
    const activeBtn = data.isActiveForChat
      ? {
          tag: 'button',
          text: { tag: 'plain_text', content: '✓ 当前 active' },
          type: 'default',
          value: { action: 'noop' },
        }
      : {
          tag: 'button',
          text: { tag: 'plain_text', content: '★ 设为 active' },
          type: 'default',
          value: { action: 'use-tab', tty: data.tty },
        };
    const runningActions: unknown[] = [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '📜 完整 history' },
        type: 'default',
        value: { action: 'show-history', tty: data.tty },
      },
      activeBtn,
    ];
    if (data.sentAt !== undefined) {
      runningActions.push(
        data.quietUntilDone
          ? {
              tag: 'button',
              text: { tag: 'plain_text', content: '🔊 恢复实时' },
              type: 'default',
              value: { action: 'pending-unquiet', tty: data.tty, sentAt: data.sentAt },
            }
          : {
              tag: 'button',
              text: { tag: 'plain_text', content: '🔇 静默此任务' },
              type: 'default',
              value: { action: 'pending-quiet', tty: data.tty, sentAt: data.sentAt },
            },
      );
    }
    runningActions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '⊘ Ctrl-C' },
      type: 'danger',
      value: { action: 'cancel-task', tty: data.tty },
    });
    elements.push({ tag: 'action', actions: runningActions });
  } else {
    const doneActions: unknown[] = [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '📜 完整 history' },
        type: 'default',
        value: { action: 'show-history', tty: data.tty },
      },
    ];
    if (data.rerunPrompt) {
      doneActions.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '↻ 重发' },
        type: 'primary',
        value: {
          action: 'rerun-task',
          tty: data.tty,
          prompt: data.rerunPrompt,
          ...(data.rerunTargetLabel ? { targetLabel: data.rerunTargetLabel } : {}),
        },
      });
    }
    elements.push({ tag: 'action', actions: doneActions });
  }

  const sourceTag = data.source === 'local' ? '🏠 ' : '';
  return {
    // update_multi：卡上有 use-tab / quiet toggle / rerun 等点击按钮，点击后 patch 才视觉生效
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template,
      title: {
        tag: 'plain_text',
        content: `${sourceTag}${icon} ${stateLabel} · ${data.tty} · ${folderTag}${shortDesc}`,
      },
    },
    elements,
  };
}

// ---- Dashboard card（手机一屏概览） ----

export interface DashboardPendingItem {
  tty: string;
  taskDescription: string;
  startedAt: number;
  progressMessageId?: string;
}

export interface DashboardSopTaskRow {
  taskId: string;
  tty: string;
  presetName?: string;
  status: 'running' | 'awaiting-gate' | 'done' | 'failed';
  /** 当前 stage 索引（0-based）；-1 = 未开始；length = 全部完成 */
  currentStageIdx: number;
  stages: string[];
  awaitingGate?: string;
  startedAt: number;
}

export interface DashboardCardData {
  activeTty?: string;
  activeCwd?: string;
  totalTabs: number;
  shellIdleTabs: number;
  shellBusyTabs: number;
  claudeActiveTabs: number;
  claudeWaitingTabs: number;
  claudeLoginTabs: number;
  tuiTabs: number;
  pendingItems: DashboardPendingItem[];
  recentDone: Array<{ tty: string; taskDescription: string; doneAt: number }>;
  /** 需要关注的 tab（login / waiting），dashboard 顶部高亮显示 */
  attentionTabs: Array<{ tty: string; statusLabel: string; cwd: string }>;
  /** 活跃的 SOP 任务（running + awaiting-gate） */
  sopTasks?: DashboardSopTaskRow[];
  home: string;
}

function relativeTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return `${Math.floor(d / 1000)}s 前`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m 前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h 前`;
  return `${Math.floor(d / 86_400_000)}d 前`;
}

export function dashboardCard(data: DashboardCardData) {
  const elements: unknown[] = [];

  // 头部：active tab
  const activeLine = data.activeTty
    ? `★ \`${data.activeTty}\`\n📁 \`${homeify(data.activeCwd ?? '?', data.home)}\``
    : '*本会话还没设 active tab — 发 /s 看列表选一个*';
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: activeLine },
  });

  elements.push({ tag: 'hr' });

  // 需要关注的 tab（login / waiting）顶部高亮
  if (data.attentionTabs.length > 0) {
    let attentionText = '🚨 **需要你看一眼**\n';
    for (const a of data.attentionTabs) {
      attentionText += `  • ${a.statusLabel} · \`${a.tty}\` · ${homeify(a.cwd, data.home)}\n`;
    }
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: attentionText.trimEnd() },
    });
    elements.push({ tag: 'hr' });
  }

  // 统计
  const statParts: string[] = [`📊 **${data.totalTabs}** tab`];
  if (data.claudeActiveTabs) statParts.push(`🤖 ${data.claudeActiveTabs} claude 跑`);
  if (data.claudeWaitingTabs) statParts.push(`⏳ ${data.claudeWaitingTabs} claude 等输入`);
  if (data.claudeLoginTabs) statParts.push(`🔐 ${data.claudeLoginTabs} 待登录`);
  if (data.shellBusyTabs) statParts.push(`⚙️ ${data.shellBusyTabs} shell 跑命令`);
  if (data.shellIdleTabs) statParts.push(`💤 ${data.shellIdleTabs} idle`);
  if (data.tuiTabs) statParts.push(`⚠️ ${data.tuiTabs} TUI`);
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: statParts.join(' · ') },
  });

  // pending 任务
  elements.push({ tag: 'hr' });
  if (data.pendingItems.length === 0) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '⏳ **当前没有 pending 任务**' },
    });
  } else {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `⏳ **${data.pendingItems.length} 个 pending 任务**`,
      },
    });
    for (const p of data.pendingItems) {
      elements.push({
        tag: 'div',
        fields: [
          {
            is_short: false,
            text: {
              tag: 'lark_md',
              content: `\`${p.tty}\`  跑了 ${relativeTime(p.startedAt)}\n${truncate(p.taskDescription, 80)}`,
            },
          },
        ],
        extra: {
          tag: 'button',
          text: { tag: 'plain_text', content: '看进度' },
          type: 'primary',
          value: { action: 'show-history', tty: p.tty },
        },
      });
    }
  }

  // SOP 任务（running + awaiting-gate）
  const sopRows = data.sopTasks ?? [];
  if (sopRows.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `🎯 **${sopRows.length} 个 SOP 任务进行中**`,
      },
    });
    for (const t of sopRows) {
      const stageInfo =
        t.currentStageIdx < 0
          ? '_未开始_'
          : t.currentStageIdx >= t.stages.length
            ? '_全部完成_'
            : `[${t.currentStageIdx + 1}/${t.stages.length}] **${t.stages[t.currentStageIdx]}**`;
      const statusBadge =
        t.status === 'awaiting-gate'
          ? `  <font color='red'>⏸ ${t.awaitingGate ?? 'gate'}</font>`
          : '';
      const presetLabel = t.presetName ? `\`${t.presetName}\` · ` : '';
      elements.push({
        tag: 'div',
        fields: [
          {
            is_short: false,
            text: {
              tag: 'lark_md',
              content:
                `${presetLabel}\`${t.tty}\` · ${stageInfo}${statusBadge}\n` +
                `<font color='grey'>${relativeTime(t.startedAt)} · ${t.taskId}</font>`,
            },
          },
        ],
        extra: {
          tag: 'button',
          text: { tag: 'plain_text', content: '看 stage' },
          type: 'primary',
          value: { action: 'show-task', taskId: t.taskId },
        },
      });
    }
  }

  // 最近完成
  if (data.recentDone.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '✓ **最近完成**' },
    });
    for (const r of data.recentDone.slice(0, 5)) {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `<font color='grey'>${relativeTime(r.doneAt)} · \`${r.tty}\`</font>\n${truncate(r.taskDescription, 80)}`,
        },
      });
    }
  }

  // 操作行
  elements.push({ tag: 'hr' });
  const actions: unknown[] = [
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '🐚 看 tab 列表' },
      type: 'default',
      value: { action: 'show-shells' },
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '🆕 新 tab' },
      type: 'primary',
      value: { action: 'choose-dir' },
    },
  ];
  if (data.pendingItems.length > 0) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '⊘ 全部 Ctrl-C' },
      type: 'danger',
      value: { action: 'cancel-all-pending' },
    });
  }
  elements.push({ tag: 'action', actions });

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'turquoise',
      title: { tag: 'plain_text', content: '🎛 Dashboard' },
    },
    elements,
  };
}

// ---- Stage Gate Card（SOP gate 专属审批卡，含上一 stage artifact 预览） ----

export interface StageGateCardData {
  approvalId: string;
  taskId: string;
  stageName: string;
  gateName: string;
  presetName?: string;
  stageSummary?: string;
  artifactPath?: string;
  artifactPreview?: string;     // 已截过的预览
  allStages?: string[];
  currentStageIdx?: number;
  status: 'pending' | 'approved' | 'rejected' | 'timeout';
  resolvedBy?: string;
  resolvedAt?: number;
  createdAt: number;
}

export function stageGateCard(d: StageGateCardData) {
  const elements: unknown[] = [];

  // 顶部：stage 序进度（"✓ explore → ✓ architect ⏸ → · coder"）
  if (d.allStages && typeof d.currentStageIdx === 'number') {
    const parts = d.allStages.map((s, i) => {
      if (i < d.currentStageIdx!) return `✓ ${s}`;
      if (i === d.currentStageIdx) return `⏸ **${s}**`;
      return `· ${s}`;
    });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: parts.join('  →  ') },
    });
    elements.push({ tag: 'hr' });
  }

  // pending 状态强调
  if (d.status === 'pending') {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `<font color='red'>**⏱ Stage gate · 等你批准下一 stage 启动 · 30 分钟超时**</font>`,
      },
    });
    elements.push({ tag: 'hr' });
  }

  // stage 完成摘要
  const sumLines: string[] = [];
  sumLines.push(`**刚完成的 stage**：\`${d.stageName}\``);
  if (d.stageSummary) sumLines.push(`**摘要**：${d.stageSummary}`);
  if (d.artifactPath) sumLines.push(`**产出文件**：\`${d.artifactPath}\``);
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: sumLines.join('\n') },
  });

  // artifact 预览
  if (d.artifactPreview && d.artifactPreview.trim()) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '**产出预览**：' },
    });
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: '```\n' + d.artifactPreview + '\n```',
      },
    });
  }

  elements.push({ tag: 'hr' });

  // 按钮
  if (d.status === 'pending') {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '✅ 批准·下一 stage' },
          type: 'primary',
          value: { action: 'approve', approvalId: d.approvalId },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '❌ 拒绝·终止任务' },
          type: 'danger',
          value: { action: 'reject', approvalId: d.approvalId },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '看完整 stage 卡' },
          type: 'default',
          value: { action: 'show-task', taskId: d.taskId },
        },
      ],
    });
  } else {
    const stateLabel =
      d.status === 'approved'
        ? '✅ 已批准'
        : d.status === 'rejected'
          ? '❌ 已拒绝'
          : '⌛ 已超时（按拒绝处理）';
    const by = d.resolvedBy ? ` by ${d.resolvedBy}` : '';
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**${stateLabel}**${by}\n<font color='grey'>task: ${d.taskId}</font>` },
    });
  }

  const template =
    d.status === 'pending'
      ? 'orange'
      : d.status === 'approved'
        ? 'green'
        : d.status === 'rejected'
          ? 'red'
          : 'grey';

  const titleParts = [`🚧 Gate · ${d.stageName}`];
  if (d.presetName) titleParts.push(`(${d.presetName})`);

  return {
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: titleParts.join(' ') },
    },
    elements,
  };
}

/** 按审批请求选卡：有 gateContext → 专属 stageGateCard（带 stage/artifact 预览），否则通用 approvalCard。 */
export function buildApprovalCard(req: ApprovalRequest): unknown {
  if (req.gateContext) {
    const data: StageGateCardData = {
      approvalId: req.id,
      taskId: req.gateContext.taskId,
      stageName: req.gateContext.stageName,
      gateName: req.gateContext.gateName,
      status: req.status,
      createdAt: req.createdAt,
    };
    if (req.gateContext.presetName) data.presetName = req.gateContext.presetName;
    if (req.gateContext.stageSummary) data.stageSummary = req.gateContext.stageSummary;
    if (req.gateContext.artifactPath) data.artifactPath = req.gateContext.artifactPath;
    if (req.gateContext.artifactPreview) data.artifactPreview = req.gateContext.artifactPreview;
    if (req.gateContext.allStages) data.allStages = req.gateContext.allStages;
    if (typeof req.gateContext.currentStageIdx === 'number') data.currentStageIdx = req.gateContext.currentStageIdx;
    if (req.resolvedBy) data.resolvedBy = req.resolvedBy;
    if (req.resolvedAt) data.resolvedAt = req.resolvedAt;
    return stageGateCard(data);
  }
  return approvalCard(req);
}

// ---- Stage progress card（单个 SOP 任务的 stage 时间线） ----

export interface StageProgressRow {
  name: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  startedAt?: number;
  endedAt?: number;
  summary?: string;
  artifactPath?: string;
  note?: string;
}

export interface StageProgressCardData {
  taskId: string;
  presetName?: string;
  tty: string;
  cwd: string;
  artifactDir: string;
  status: 'running' | 'awaiting-gate' | 'done' | 'failed';
  awaitingGate?: string;
  failReason?: string;
  currentStageIdx: number;
  stages: StageProgressRow[];
  startedAt: number;
  endedAt?: number;
  home: string;
}

function stageIcon(status: StageProgressRow['status']): string {
  switch (status) {
    case 'done': return '✅';
    case 'running': return '⠂';
    case 'failed': return '❌';
    case 'skipped': return '⤼';
    case 'pending': return '·';
  }
}

export function stageProgressCard(data: StageProgressCardData) {
  const elements: unknown[] = [];

  // 头部信息
  const presetLine = data.presetName ? `\`${data.presetName}\`  ·  ` : '';
  const header = `${presetLine}\`${data.tty}\`\n📁 \`${homeify(data.cwd, data.home)}\``;
  elements.push({ tag: 'div', text: { tag: 'lark_md', content: header } });

  // 状态徽章
  const statusLine: string[] = [];
  if (data.status === 'awaiting-gate' && data.awaitingGate) {
    statusLine.push(`<font color='red'>⏸ 等审批：${data.awaitingGate}</font>`);
  } else if (data.status === 'done') {
    statusLine.push(`<font color='green'>✅ 已完成</font>`);
  } else if (data.status === 'failed') {
    statusLine.push(`<font color='red'>❌ 失败${data.failReason ? `：${data.failReason}` : ''}</font>`);
  } else {
    statusLine.push('🔵 进行中');
  }
  statusLine.push(`📂 ${data.artifactDir}`);
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: statusLine.join('  ·  ') },
  });

  elements.push({ tag: 'hr' });

  // stage 时间线
  for (let i = 0; i < data.stages.length; i++) {
    const s = data.stages[i]!;
    const cursor = i === data.currentStageIdx && data.status !== 'done' ? '►' : ' ';
    const icon = stageIcon(s.status);
    let line = `${cursor} ${icon} **${s.name}**`;
    if (s.status === 'running' && s.startedAt) {
      line += `  <font color='grey'>(跑了 ${relativeTime(s.startedAt)})</font>`;
    } else if (s.endedAt && s.startedAt) {
      const ms = s.endedAt - s.startedAt;
      const dur = ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
      line += `  <font color='grey'>(${dur})</font>`;
    }
    if (s.artifactPath) line += `\n   📄 \`${s.artifactPath}\``;
    if (s.summary) line += `\n   ${truncate(s.summary, 200)}`;
    if (s.note) line += `\n   <font color='red'>${truncate(s.note, 160)}</font>`;
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: line } });
  }

  // 时间脚注
  elements.push({ tag: 'hr' });
  const timeFoot: string[] = [`开始 ${relativeTime(data.startedAt)}`];
  if (data.endedAt) timeFoot.push(`收尾 ${relativeTime(data.endedAt)}`);
  timeFoot.push(`task: \`${data.taskId}\``);
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `<font color='grey'>${timeFoot.join('  ·  ')}</font>`,
    },
  });

  // 操作按钮
  if (data.status === 'running' || data.status === 'awaiting-gate') {
    const actions: unknown[] = [];
    if (data.status === 'awaiting-gate') {
      actions.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '看审批列表' },
        type: 'default',
        value: { action: 'show-approvals' },
      });
    }
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '🛑 中止' },
      type: 'danger',
      value: { action: 'abort-task', taskId: data.taskId },
    });
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '🛑 硬中止' },
      type: 'danger',
      value: { action: 'abort-task', taskId: data.taskId, hard: true },
    });
    elements.push({ tag: 'action', actions });
  }

  const template =
    data.status === 'done'
      ? 'green'
      : data.status === 'failed'
        ? 'red'
        : data.status === 'awaiting-gate'
          ? 'orange'
          : 'blue';

  return {
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: `🎯 SOP · ${data.taskId}` },
    },
    elements,
  };
}

// ---- Batch progress card（多 @target 任务聚合，避免飞书会话刷屏） ----

export interface BatchTaskItem {
  target: string;             // @target 字符串
  tty?: string;               // 解析后的 tty（若已解析）
  taskDescription: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  outputTailShort?: string;   // 任务输出 tail，3-5 行截断
  startedAt?: number;
  endedAt?: number;
}

export interface BatchProgressCardData {
  batchId: string;
  items: BatchTaskItem[];
  startedAt: number;
  updatedAt: number;
  home: string;
}

function statusIconForBatch(s: BatchTaskItem['status']): string {
  switch (s) {
    case 'pending': return '⏳';
    case 'running': return '🟢';
    case 'done': return '✓';
    case 'failed': return '✗';
    case 'cancelled': return '⊘';
  }
}

export function batchProgressCard(data: BatchProgressCardData) {
  const doneCount = data.items.filter(
    (i) => i.status === 'done' || i.status === 'failed' || i.status === 'cancelled',
  ).length;
  const total = data.items.length;
  const allDone = doneCount === total;
  const elapsed = data.updatedAt - data.startedAt;
  const elapsedLabel =
    elapsed < 60_000
      ? `${(elapsed / 1000).toFixed(1)}s`
      : `${Math.floor(elapsed / 60_000)}m${Math.floor((elapsed % 60_000) / 1000)}s`;

  const elements: unknown[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**批量任务**：${doneCount}/${total} ${allDone ? '✓ 全部完成' : '执行中'} · 已运行 ${elapsedLabel}`,
      },
    },
    { tag: 'hr' },
  ];

  for (const item of data.items) {
    const icon = statusIconForBatch(item.status);
    const ttyLabel = item.tty ? `\`${item.tty}\`` : `@${item.target}`;
    const tail = (item.outputTailShort ?? '').trim();
    const tailBlock = tail
      ? `\n\`\`\`\n${tail.length > 400 ? tail.slice(-400) : tail}\n\`\`\``
      : '';
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `${icon} **@${item.target}** → ${ttyLabel}\n<font color='grey'>${truncate(item.taskDescription, 80)}</font>${tailBlock}`,
      },
    });
    elements.push({ tag: 'hr' });
  }

  // 底部操作（只在还有 running 时显示「全部取消」）
  if (!allDone) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '⊘ 全部 Ctrl-C' },
          type: 'danger',
          value: { action: 'cancel-batch', batchId: data.batchId },
        },
      ],
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      template: allDone ? 'green' : 'blue',
      title: {
        tag: 'plain_text',
        content: allDone
          ? `✓ 批量任务完成 (${total})`
          : `🚀 批量任务 (${doneCount}/${total})`,
      },
    },
    elements,
  };
}

// ---- Chain progress card（任务链：A 完成 → 自动触发 B） ----

export interface ChainStepItem {
  target: string;
  tty?: string;
  prompt: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped';
  startedAt?: number;
  endedAt?: number;
  outputTailShort?: string;
  failureReason?: string;
}

export interface ChainProgressCardData {
  chainId: string;
  steps: ChainStepItem[];
  status: 'running' | 'done' | 'failed' | 'cancelled';
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
}

function statusIconForChain(s: ChainStepItem['status']): string {
  switch (s) {
    case 'pending': return '⏳';
    case 'running': return '🟢';
    case 'done': return '✓';
    case 'failed': return '💀';
    case 'cancelled': return '⊘';
    case 'skipped': return '—';
  }
}

function elapsedLabel(start: number | undefined, end: number | undefined): string {
  if (!start) return '';
  const e = (end ?? Date.now()) - start;
  return e < 60_000
    ? `${(e / 1000).toFixed(1)}s`
    : `${Math.floor(e / 60_000)}m${Math.floor((e % 60_000) / 1000)}s`;
}

export function chainProgressCard(data: ChainProgressCardData) {
  const total = data.steps.length;
  const doneCount = data.steps.filter(
    (s) => s.status === 'done' || s.status === 'failed' || s.status === 'cancelled' || s.status === 'skipped',
  ).length;
  const totalElapsed = elapsedLabel(data.createdAt, data.endedAt ?? data.updatedAt);

  const elements: unknown[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content:
          data.status === 'done'
            ? `**任务链完成** · ${total} 步 · 总耗时 ${totalElapsed}`
            : data.status === 'failed'
              ? `**任务链失败** · 已执行 ${doneCount}/${total} · 总耗时 ${totalElapsed}`
              : data.status === 'cancelled'
                ? `**任务链已终止** · ${doneCount}/${total} · 总耗时 ${totalElapsed}`
                : `**任务链运行中** · ${doneCount}/${total} · 已运行 ${totalElapsed}`,
      },
    },
    { tag: 'hr' },
  ];

  data.steps.forEach((step, i) => {
    const icon = statusIconForChain(step.status);
    const ttyLabel = step.tty ? ` → \`${step.tty}\`` : '';
    const dur = step.startedAt
      ? `  <font color='grey'>${elapsedLabel(step.startedAt, step.endedAt)}</font>`
      : '';
    const lines: string[] = [
      `${icon} **Step ${i + 1}** · @${step.target}${ttyLabel}${dur}`,
      `<font color='grey'>${truncate(step.prompt, 100)}</font>`,
    ];
    if (step.outputTailShort && (step.status === 'done' || step.status === 'failed')) {
      const tail = step.outputTailShort.length > 300
        ? step.outputTailShort.slice(-300)
        : step.outputTailShort;
      lines.push('```\n' + tail + '\n```');
    }
    if (step.failureReason && step.status === 'failed') {
      lines.push(`<font color='red'>${step.failureReason}</font>`);
    }
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: lines.join('\n') },
    });
  });

  if (data.status === 'running') {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '⊘ 终止链' },
          type: 'danger',
          value: { action: 'cancel-chain', chainId: data.chainId },
        },
      ],
    });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      template:
        data.status === 'done' ? 'green' :
        data.status === 'failed' ? 'red' :
        data.status === 'cancelled' ? 'grey' :
        'blue',
      title: {
        tag: 'plain_text',
        content:
          data.status === 'done' ? `⛓ 任务链完成 (${total})` :
          data.status === 'failed' ? `⛓ 任务链失败 (${doneCount}/${total})` :
          data.status === 'cancelled' ? `⛓ 任务链已终止` :
          `⛓ 任务链 (${doneCount}/${total})`,
      },
    },
    elements,
  };
}

// ---- Ack card ----

export interface AckCardData {
  title: string;
  body: string;
  template?: 'green' | 'red' | 'orange' | 'blue';
}

// ---- Template (preset) 列表 / 详情 ----

export interface TemplateListItem {
  name: string;
  description?: string;
  target?: string;
  promptPreview: string;       // 截断的 prompt 预览
  placeholders: string[];      // 占位符 key 列表
  stages?: string[];           // SOP stage 序，存在即为 SOP 模板
  gates?: string[];
  updatedAt?: number;
}

export function templateListCard(items: TemplateListItem[]) {
  const elements: unknown[] = [];

  if (items.length === 0) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content:
          '还没有模板。用：\n`/template save <name> [@target] <prompt with {key}>`\n创建。',
      },
    });
  } else {
    for (const it of items) {
      const lines: string[] = [];
      const isSop = (it.stages?.length ?? 0) > 0;
      const sopBadge = isSop ? '  🎯' : '';
      const head =
        `**${it.name}**${sopBadge}` +
        (it.target ? ` → @${it.target}` : '') +
        (it.placeholders.length
          ? `  <font color='grey'>{${it.placeholders.join('}, {')}}</font>`
          : '');
      lines.push(head);
      if (it.description) lines.push(`<font color='grey'>${it.description}</font>`);
      if (isSop) {
        const gateBadge = (it.gates?.length ?? 0) > 0 ? `  ⏸${it.gates!.length}` : '';
        lines.push(`<font color='blue'>SOP: ${it.stages!.join(' → ')}${gateBadge}</font>`);
      }
      lines.push(`\`${truncate(it.promptPreview, 80)}\``);
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: lines.join('\n') },
      });
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '▶ 运行' },
            type: 'primary',
            value: { action: 'run-template', name: it.name },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '📄 详情' },
            type: 'default',
            value: { action: 'show-template', name: it.name },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✗ 删除' },
            type: 'danger',
            value: { action: 'delete-template', name: it.name },
          },
        ],
      });
      elements.push({ tag: 'hr' });
    }
  }

  elements.push({
    tag: 'note',
    elements: [
      {
        tag: 'plain_text',
        content:
          '新建：/template save <name> [@target] <prompt with {key}>\n触发：/run <name> [k=v ...]',
      },
    ],
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'turquoise',
      title: { tag: 'plain_text', content: '📋 任务模板' },
    },
    elements,
  };
}

export interface TemplateDetailData {
  name: string;
  description?: string;
  target?: string;
  prompt: string;
  placeholders: string[];
  stages?: string[];
  gates?: string[];
  artifactDir?: string;
  createdAt?: number;
  updatedAt?: number;
}

export function templateDetailCard(d: TemplateDetailData) {
  const elements: unknown[] = [];

  const headerLines: string[] = [];
  if (d.target) headerLines.push(`**目标**：@${d.target}`);
  if (d.description) headerLines.push(`**描述**：${d.description}`);
  if (d.placeholders.length)
    headerLines.push(`**占位符**：${d.placeholders.map((p) => `\`{${p}}\``).join(' ')}`);
  if (d.stages && d.stages.length > 0) {
    headerLines.push(`**🎯 SOP stages**：${d.stages.join(' → ')}`);
    if (d.gates && d.gates.length > 0) {
      headerLines.push(`**⏸ gates**：${d.gates.join(', ')}`);
    }
    if (d.artifactDir) {
      headerLines.push(`**📂 artifactDir**：\`${d.artifactDir}\``);
    }
  }
  if (headerLines.length) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: headerLines.join('\n') },
    });
  }

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: '**prompt**：' },
  });
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: '```\n' + d.prompt + '\n```' },
  });

  if (d.updatedAt) {
    elements.push({
      tag: 'note',
      elements: [
        {
          tag: 'plain_text',
          content: `更新于 ${new Date(d.updatedAt).toLocaleString('zh-CN', { hour12: false })}`,
        },
      ],
    });
  }

  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '▶ 运行' },
        type: 'primary',
        value: { action: 'run-template', name: d.name },
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '✗ 删除' },
        type: 'danger',
        value: { action: 'delete-template', name: d.name },
      },
    ],
  });

  return {
    // update_multi：卡上有 use-tab / 回复当前 按钮，点击后 patch 才视觉生效
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: `📋 ${d.name}` },
    },
    elements,
  };
}

// ---- Origin-shell push card（hook 从非 activeTty 的 shell 推消息用） ----

export interface OriginShellPushCardData {
  /** 触发本次推送的 shell tty，e.g. "/dev/ttys004" */
  tty: string;
  /** 触发本次推送时 Claude Code 的 cwd（可为空） */
  cwd?: string;
  home: string;
  /** 消息正文，支持 lark_md */
  body: string;
  /** true → PreToolUse AskUserQuestion；false → Stop hook 等一般消息 */
  question: boolean;
  /**
   * AskUserQuestion 的选项 label 列表。只在单问题（questions.length===1）且
   * options 数 ≤ 4 时给。有值 → 每个 option 变成一个按钮，点击直接 send-to-tab 到源 shell，
   * 不改 activeTty（保留用户在别的 shell 长期会话的意图）。
   */
  quickAnswerOptions?: string[];
}

/** answer-select 组件 value 编码：`answer|<tty>|<label>`。tty 无 `|`，label 允许含（split 时 splice 剩下）。 */
function encodeAnswerOption(tty: string, label: string): string {
  return `answer|${tty}|${label}`;
}

/**
 * AskUserQuestion 箭头菜单下拉 value 编码：`askans|<tty>|<index>`（0-based）。
 * 与 `answer|` 区分：answer-select 回调命中 `askans|` → driveAskSelect（默认 pty 写数字）驱动本地
 * 原生选择菜单（打文本选不中，见 handlers driveAskSelectFromCard）；`answer|` 是老的打文本路径。
 */
function encodeAskSelect(tty: string, index: number): string {
  return `askans|${tty}|${index}`;
}

/**
 * 非 activeTty 的 shell 通过 hook 推消息到飞书时用的卡片。
 * header 显示 `❓/💬 ttys004`。
 * 快答组件（根据 options 数）：
 *  - 1-4 options → 每 option 一个按钮（一 tap 直答）
 *  - 5+ options → select_static 下拉（避免按钮撑爆卡片）
 * 附加按钮：[⭐ 切到此 shell]（use-tab）+ [📜 shell history]（show-history）。
 *
 * activeTty 自己的推送不走本卡片，走纯文本 + `🖥 ...` 前缀，避免每条 Stop hook 都变卡片。
 */
export function originShellPushCard(d: OriginShellPushCardData) {
  const shortTty = d.tty.startsWith('/dev/') ? d.tty.slice(5) : d.tty;
  const cwdShown = d.cwd ? homeify(d.cwd, d.home) : '?';
  const icon = d.question ? '❓' : '💬';
  const template: 'yellow' | 'blue' = d.question ? 'yellow' : 'blue';

  const opts = d.quickAnswerOptions ?? [];
  // ≤ 4：按钮组；≥ 5：下拉框。都通过 send-to-tab 或 answer-select 走同源 shell。
  const useButtons = opts.length > 0 && opts.length <= 4;
  const useDropdown = opts.length >= 5;

  // 选项偏长 → 控件只显示编号（按钮 `1`/下拉 `1. 摘要`），完整选项在正文编号列出（见下）。
  const longOpts = optionsNeedFullList(opts);

  const buttonActions = useButtons
    ? opts.map((label, i) => ({
        tag: 'button' as const,
        text: {
          tag: 'plain_text' as const,
          content: longOpts ? `${i + 1}. ${smartTrim(label, 14)}` : truncate(label, 18),
        },
        type: i === 0 ? ('primary' as const) : ('default' as const),
        // question（AskUserQuestion）→ ask-select：点了经 pty 写数字 (index+1) 直选本地箭头菜单（锁屏可用）；
        // 非 question（罕见的一般快答）→ 老的 send-to-tab 打文本。
        value: d.question
          ? { action: 'ask-select', tty: d.tty, index: i, label }
          : { action: 'send-to-tab', tty: d.tty, text: label },
      }))
    : null;

  const dropdownAction = useDropdown
    ? {
        tag: 'select_static' as const,
        placeholder: {
          tag: 'plain_text' as const,
          content: `选择答案… (${opts.length} 项)`,
        },
        options: opts.map((label, i) => ({
          text: {
            tag: 'plain_text' as const,
            content: longOpts ? `${i + 1}. ${smartTrim(label, 56)}` : truncate(label, 60),
          },
          // question → askans|<tty>|<index>（pty 数字驱动）；否则老的 answer|<tty>|<label>（打文本）
          value: d.question ? encodeAskSelect(d.tty, i) : encodeAnswerOption(d.tty, label),
        })),
        value: { action: 'answer-select' },
      }
    : null;

  const hasQuickWidget = buttonActions !== null || dropdownAction !== null;
  const hintLine = d.question
    ? hasQuickWidget
      ? '<font color=\'grey\'>点选项直发到此 shell；也可直接回复文本，会 one-shot 路由到这里（不必 @）</font>'
      : '<font color=\'grey\'>直接回复即可，会 one-shot 路由到此 shell（不必 @）</font>'
    : '<font color=\'grey\'>此 shell 非当前 tab；点⭐切到它，后续回复会持续发到这里</font>';

  const elements: unknown[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `🏷 \`${shortTty}\` · 📁 \`${cwdShown}\``,
      },
    },
    { tag: 'hr' },
    { tag: 'div', text: { tag: 'lark_md', content: d.body } },
  ];
  // 选项偏长：正文完整编号列出，控件按编号选（避免按钮/下拉截断看不清选啥）
  if (hasQuickWidget && longOpts) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: choiceBody(opts) } });
  }
  elements.push(
    { tag: 'hr' },
    { tag: 'div', text: { tag: 'lark_md', content: hintLine } },
  );

  if (buttonActions) {
    elements.push({ tag: 'action', actions: buttonActions });
  } else if (dropdownAction) {
    elements.push({ tag: 'action', actions: [dropdownAction] });
  }
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '⭐ 切到此 shell' },
        type: 'primary',
        value: { action: 'use-tab', tty: d.tty },
      },
      // 逃生口：这张卡片来自非 active 的源 shell，pendingAnswerTty 已经被
      // arm 到源 shell 了。用户想给 chat.activeTty 说话时，一 tap 把 pending
      // 重定向到 activeTty（daemon 侧读实时 chat 拿 tty，不 embed 在按钮里）。
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '→ 回复当前' },
        type: 'default',
        value: { action: 'arm-active-reply' },
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '📜 shell history' },
        type: 'default',
        value: { action: 'show-history', tty: d.tty },
      },
    ],
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: `${icon} ${shortTty}` },
    },
    elements,
  };
}

// ---- Receipt card（按钮点后 patch 原卡的"已完成"回执） ----

export interface ReceiptCardData {
  /** 标题，e.g. "✓ 已回答『是』 → ttys004" */
  title: string;
  /** 可选详情行，e.g. "cwd: ~/proj" */
  detail?: string;
  /** 模板色，默认 green（完成态） */
  template?: 'green' | 'blue' | 'grey';
  /** 时间戳 ms，默认 now；渲染成"HH:MM:SS" */
  at?: number;
}

/**
 * 按钮点击后的回执卡（patch 原卡用）。刻意做得比 ackCard 更瘦：
 *  - 无 body 大段文字
 *  - 无残留按钮（原卡的 action 被整个覆盖掉）
 *  - 只留 header + 一行详情 + 灰色时间戳
 * 目的：让用户在飞书 timeline 上一眼看清"这一步做完了"，且不留误点空间。
 */
export function receiptCard(d: ReceiptCardData) {
  const template = d.template ?? 'green';
  const at = new Date(d.at ?? Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
  const detailLine = d.detail
    ? `${d.detail}\n<font color='grey'>${at}</font>`
    : `<font color='grey'>${at}</font>`;
  return {
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: d.title },
    },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: detailLine } }],
  };
}

export function ackCard(data: AckCardData) {
  const template = data.template ?? 'green';
  // 标题没含 emoji 时自动加 emoji 前缀，让卡片类型一眼可辨
  const hasLeadingEmoji =
    /^[\p{Extended_Pictographic}✅❌⚠️⊘★⏳🚨ℹ️📜🆕↻🐚🎛📋🏠🔐⚙️💤🤖🚀✓⏵]/u.test(
      data.title.trimStart(),
    );
  let title = data.title;
  if (!hasLeadingEmoji) {
    const prefix =
      template === 'green' ? '✅ ' :
      template === 'red' ? '❌ ' :
      template === 'orange' ? '⚠️ ' :
      'ℹ️ ';
    title = prefix + title;
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: title },
    },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: data.body } }],
  };
}

// ---- Ask cards (single / multi / input，供 `agent lark ask` 用) ----

/**
 * 渲染 ask 卡片，四态复用同一函数：
 *   pending  → 按 type 出交互控件
 *   answered → 绿卡 + 答案预览
 *   cancelled/timeout → 灰卡
 * multi 状态下 selection 决定每个按钮前面是 ☑ 还是 ☐。
 */
/** 任一题允许自由输入(allowText) → 走向导式(B)，否则一张卡铺完(A)。 */
function formNeedsWizard(req: AskRequest): boolean {
  return (req.questions ?? []).some((q) => q.allowText);
}

/** 某题当前答案的可读描述（供汇总/提交页）。 */
function formAnswerLabel(req: AskRequest, qi: number): string {
  const q = req.questions?.[qi];
  if (!q) return '';
  const txt = req.formText?.[qi];
  if (txt) return `💬 ${truncate(txt, 60)}`;
  const chosen = (req.formSelection?.[qi] ?? []).map((i) => q.options[i] ?? '');
  return chosen.length ? chosen.join('、') : '（未选）';
}

/** resolved 状态的表单摘要卡（A/B 共用）。 */
function askFormResolvedCard(req: AskRequest) {
  const questions = req.questions ?? [];
  const template = req.status === 'answered' ? 'green' : 'grey';
  const stateLabel = req.status === 'answered' ? '已提交' : req.status === 'cancelled' ? '已取消' : '已超时';
  const lines: string[] = [];
  if (req.answer?.kind === 'form') {
    req.answer.items.forEach((it) => {
      const qTitle = questions[it.q]?.title ?? `问题${it.q + 1}`;
      let ans = '';
      if (it.kind === 'single') ans = it.value ?? '';
      else if (it.kind === 'multi') ans = (it.values ?? []).join('、') || '（空）';
      else ans = `💬 ${it.text ?? ''}`;
      lines.push(`**${it.q + 1}. ${qTitle}** → ${ans}`);
    });
  }
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template, title: { tag: 'plain_text', content: `📋 ${req.title} · ${stateLabel}` } },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') || `_${stateLabel}_` } }],
  };
}

/** 方案 A：一张卡铺完所有（固定选项）问题 + 一个提交。 */
function askFormAllInOneCard(req: AskRequest) {
  const questions = req.questions ?? [];
  const sels = req.formSelection ?? [];
  const elements: unknown[] = [];
  questions.forEach((q, qi) => {
    const sel = new Set(sels[qi] ?? []);
    const isSingle = q.type === 'single';
    const longQ = optionsNeedFullList(q.options);
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**${qi + 1}. ${q.title}**　<font color='grey'>${isSingle ? '单选' : '多选'}</font>` } });
    // 选项偏长：正文完整编号列出（带选中标记），按钮缩成「标记+编号」
    if (longQ) {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: choiceBody(q.options, (i) => { const on = sel.has(i); return isSingle ? (on ? '🔘' : '⚪') : (on ? '☑' : '☐'); }) } });
    }
    for (let i = 0; i < q.options.length; i += 2) {
      const row: unknown[] = [];
      for (let j = i; j < Math.min(i + 2, q.options.length); j++) {
        const on = sel.has(j);
        const mark = isSingle ? (on ? '🔘' : '⚪') : (on ? '☑' : '☐');
        row.push({
          tag: 'button',
          text: { tag: 'plain_text', content: longQ ? `${mark} ${j + 1}` : `${mark} ${truncate(q.options[j] ?? '', 36)}` },
          type: on ? 'primary' : 'default',
          value: { action: 'ask.form-toggle', askId: req.id, q: qi, i: j },
        });
      }
      elements.push({ tag: 'action', actions: row });
    }
  });
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'action',
    actions: [
      { tag: 'button', text: { tag: 'plain_text', content: '✅ 提交' }, type: 'primary', value: { action: 'ask.form-submit', askId: req.id } },
      { tag: 'button', text: { tag: 'plain_text', content: '⊘ 取消' }, type: 'default', value: { action: 'ask.form-cancel', askId: req.id } },
    ],
  });
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'yellow', title: { tag: 'plain_text', content: `📋 ${req.title} · ${questions.length} 题` } },
    elements,
  };
}

/** 方案 B：向导式，一次一题；allowText 题带「💬 打字回答」→ 武装后回复文字。 */
function askFormWizardCard(req: AskRequest) {
  const questions = req.questions ?? [];
  const sels = req.formSelection ?? [];
  const n = questions.length;
  const cursor = Math.max(0, Math.min(req.formCursor ?? 0, n));
  const elements: unknown[] = [];

  if (cursor >= n) {
    const summary = questions.map((q, qi) => `**${qi + 1}. ${q.title}**：${formAnswerLabel(req, qi)}`);
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**确认提交**（共 ${n} 题）\n${summary.join('\n')}` } });
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'action',
      actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '✅ 提交' }, type: 'primary', value: { action: 'ask.form-submit', askId: req.id } },
        { tag: 'button', text: { tag: 'plain_text', content: '⬅ 上一题' }, type: 'default', value: { action: 'ask.form-nav', askId: req.id, to: n - 1 } },
        { tag: 'button', text: { tag: 'plain_text', content: '⊘ 取消' }, type: 'default', value: { action: 'ask.form-cancel', askId: req.id } },
      ],
    });
    return {
      config: { wide_screen_mode: true, update_multi: true },
      header: { template: 'yellow', title: { tag: 'plain_text', content: `📋 ${req.title} · 确认提交` } },
      elements,
    };
  }

  const q = questions[cursor]!;
  const sel = new Set(sels[cursor] ?? []);
  const isSingle = q.type === 'single';
  const armed = req.formTextArmed === cursor;
  const curText = req.formText?.[cursor];
  const hint = armed
    ? `<font color='blue'>**请直接在对话里回复文字**作为本题答案（回复后自动进入下一题）</font>`
    : `<font color='grey'>${isSingle ? '单选 · 点一下即选并前进' : '多选 · 点着勾选'}${q.allowText ? ' · 或「💬 打字回答」' : ''}</font>`;
  elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**${cursor + 1}. ${q.title}**\n${hint}${curText ? `\n已填：💬 ${truncate(curText, 50)}` : ''}` } });

  const longQ = optionsNeedFullList(q.options);
  // 选项偏长：正文完整编号列出（带选中标记），按钮缩成「标记+编号」
  if (longQ) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: choiceBody(q.options, (i) => { const on = sel.has(i); return isSingle ? (on ? '🔘' : '⚪') : (on ? '☑' : '☐'); }) } });
  }
  for (let i = 0; i < q.options.length; i += 2) {
    const row: unknown[] = [];
    for (let j = i; j < Math.min(i + 2, q.options.length); j++) {
      const on = sel.has(j);
      const mark = isSingle ? (on ? '🔘' : '⚪') : (on ? '☑' : '☐');
      row.push({
        tag: 'button',
        text: { tag: 'plain_text', content: longQ ? `${mark} ${j + 1}` : `${mark} ${j + 1}. ${truncate(q.options[j] ?? '', 36)}` },
        type: on ? 'primary' : 'default',
        value: { action: 'ask.form-toggle', askId: req.id, q: cursor, i: j },
      });
    }
    elements.push({ tag: 'action', actions: row });
  }
  if (q.allowText) {
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: armed ? '⌨️ 等你回复文字…' : '💬 打字回答（Other）' },
        type: armed ? 'primary' : 'default',
        value: { action: 'ask.form-text', askId: req.id, q: cursor },
      }],
    });
  }
  elements.push({ tag: 'hr' });
  // 导航行：上一题 / 下一题（末题不显示）
  const nav: unknown[] = [];
  if (cursor > 0) nav.push({ tag: 'button', text: { tag: 'plain_text', content: '⬅ 上一题' }, type: 'default', value: { action: 'ask.form-nav', askId: req.id, to: cursor - 1 } });
  if (cursor < n - 1) nav.push({ tag: 'button', text: { tag: 'plain_text', content: '下一题 ➡' }, type: 'default', value: { action: 'ask.form-nav', askId: req.id, to: cursor + 1 } });
  if (nav.length > 0) elements.push({ tag: 'action', actions: nav });
  // 提交 / 取消：每一页都在，随时可交
  elements.push({
    tag: 'action',
    actions: [
      { tag: 'button', text: { tag: 'plain_text', content: '✅ 提交' }, type: 'primary', value: { action: 'ask.form-submit', askId: req.id } },
      { tag: 'button', text: { tag: 'plain_text', content: '⊘ 取消' }, type: 'default', value: { action: 'ask.form-cancel', askId: req.id } },
    ],
  });

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'yellow', title: { tag: 'plain_text', content: `📋 ${req.title} · 第 ${cursor + 1}/${n} 题` } },
    elements,
  };
}

/**
 * 多问题表单卡。全固定选项 → 一张卡铺完(A)；任一题允许自由输入 → 向导式(B)。
 */
export function askFormCard(req: AskRequest) {
  if (req.status !== 'pending') return askFormResolvedCard(req);
  return formNeedsWizard(req) ? askFormWizardCard(req) : askFormAllInOneCard(req);
}

export function askCard(req: AskRequest) {
  if (req.type === 'form') return askFormCard(req);
  const isPending = req.status === 'pending';
  const template =
    req.status === 'pending' ? (req.type === 'input' ? 'blue' : 'yellow') :
    req.status === 'answered' ? 'green' :
    req.status === 'cancelled' ? 'grey' :
    'grey';
  const stateIcon =
    req.status === 'pending' ? (req.type === 'input' ? '⌨️' : (req.type === 'multi' ? '☑' : '⭕')) :
    req.status === 'answered' ? '✅' :
    req.status === 'cancelled' ? '⊘' :
    '⌛';
  const typeLabel =
    req.type === 'single' ? '单选' :
    req.type === 'multi'  ? '多选' :
    '输入';
  const stateLabel =
    req.status === 'pending' ? `需你${typeLabel} · 5 分钟超时` :
    req.status === 'answered' ? '已回答' :
    req.status === 'cancelled' ? '已取消' :
    '已超时';
  const headerTitle = `${stateIcon} ${req.title} · ${stateLabel}`;

  const elements: unknown[] = [];

  if (isPending) {
    if (req.type === 'input') {
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `<font color='blue'>**在这个 chat 里直接回复文本消息即可**</font>\n（5 分钟没回复会自动超时）`,
        },
      });
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '⊘ 取消' },
            type: 'default',
            value: { action: 'ask.cancel', askId: req.id },
          },
        ],
      });
    } else if (req.type === 'single') {
      const longOpts = optionsNeedFullList(req.options);
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: longOpts ? `**点编号选项即可提交**（完整内容见下）` : `**点一个选项即可提交**` },
      });
      // 选项偏长：正文完整编号列出，按钮按编号选
      if (longOpts) {
        elements.push({ tag: 'div', text: { tag: 'lark_md', content: choiceBody(req.options) } });
      }
      elements.push({ tag: 'hr' });
      // 每 2 个按钮一行，避免手机上排版乱
      const pairs: unknown[][] = [];
      for (let i = 0; i < req.options.length; i += 2) {
        const row: unknown[] = [];
        for (let j = i; j < Math.min(i + 2, req.options.length); j++) {
          row.push({
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: longOpts ? `${j + 1}` : `${j + 1}. ${truncate(req.options[j] ?? '', 40)}`,
            },
            type: 'primary',
            value: { action: 'ask.pick', askId: req.id, index: j },
          });
        }
        pairs.push(row);
      }
      for (const row of pairs) {
        elements.push({ tag: 'action', actions: row });
      }
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '⊘ 取消' },
            type: 'default',
            value: { action: 'ask.cancel', askId: req.id },
          },
        ],
      });
    } else {
      // multi
      const selectedSet = new Set(req.selection);
      const longOpts = optionsNeedFullList(req.options);
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**点选项切换勾选，最后点 [✅ 提交]**（已选 ${req.selection.length} 项）`,
        },
      });
      // 选项偏长：正文完整编号列出（带勾选态），按钮按编号切换
      if (longOpts) {
        elements.push({ tag: 'div', text: { tag: 'lark_md', content: choiceBody(req.options, (i) => (selectedSet.has(i) ? '☑' : '☐')) } });
      }
      elements.push({ tag: 'hr' });
      for (let i = 0; i < req.options.length; i += 2) {
        const row: unknown[] = [];
        for (let j = i; j < Math.min(i + 2, req.options.length); j++) {
          const on = selectedSet.has(j);
          row.push({
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: longOpts ? `${on ? '☑' : '☐'} ${j + 1}` : `${on ? '☑' : '☐'} ${j + 1}. ${truncate(req.options[j] ?? '', 40)}`,
            },
            type: on ? 'primary' : 'default',
            value: { action: 'ask.toggle', askId: req.id, index: j },
          });
        }
        elements.push({ tag: 'action', actions: row });
      }
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '✅ 提交' },
            type: 'primary',
            value: { action: 'ask.submit', askId: req.id },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '⊘ 取消' },
            type: 'default',
            value: { action: 'ask.cancel', askId: req.id },
          },
        ],
      });
    }
  } else {
    // 已 resolve 状态：展示答案摘要
    const byPart = req.resolvedBy ? ` by ${req.resolvedBy}` : '';
    const elapsedMs = (req.resolvedAt ?? Date.now()) - req.createdAt;
    const elapsed =
      elapsedMs < 1000 ? `${elapsedMs}ms` :
      elapsedMs < 60_000 ? `${(elapsedMs / 1000).toFixed(1)}s` :
      `${Math.floor(elapsedMs / 60_000)}m${Math.floor((elapsedMs % 60_000) / 1000)}s`;

    let ansLine = '';
    if (req.answer?.kind === 'single') {
      ansLine = `**选中**：${req.answer.index + 1}. ${req.answer.value}`;
    } else if (req.answer?.kind === 'multi') {
      if (req.answer.indices.length === 0) {
        ansLine = `**选中**：（空）`;
      } else {
        const parts = req.answer.indices.map((i, k) => `${i + 1}. ${req.answer!.kind === 'multi' ? (req.answer as { values: string[] }).values[k] ?? '' : ''}`);
        ansLine = `**选中**（${req.answer.indices.length}项）：\n- ${parts.join('\n- ')}`;
      }
    } else if (req.answer?.kind === 'input') {
      ansLine = `**输入**：${truncate(req.answer.text, 200)}`;
    } else if (req.status === 'cancelled') {
      ansLine = `_已取消_`;
    } else if (req.status === 'timeout') {
      ansLine = `_已超时_`;
    }
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: ansLine } });
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: `${stateLabel}${byPart} · 用时 ${elapsed}` }],
    });
  }

  return {
    // update_multi:true 让这张卡可被 card.action.trigger 回调响应直接替换刷新
    // （即时反馈：点击瞬间 toast + 卡片同帧变化，不再依赖异步 patchCard）
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template,
      title: { tag: 'plain_text', content: headerTitle },
    },
    elements,
  };
}

// ---- TAPD bug/需求 通知卡 ----

const TAPD_SEVERITY_LABEL: Record<string, string> = {
  fatal: '致命', serious: '严重', normal: '一般', prompt: '提示', advice: '建议',
};

/**
 * 指派给我的当天 TAPD 缺陷/需求通知卡（黄 = 需我操作）。
 * [认领并建分支] → 走 tapd-claim 流程（选 repo/基准分支 → git checkout -b → 开 tab）。
 */
export function tapdItemCard(item: TapdItem) {
  const isBug = item.system === 'bug';
  const icon = isBug ? '🐞' : '📌';
  const kindLabel = isBug ? '缺陷' : '需求';
  const sev = item.severity ? (TAPD_SEVERITY_LABEL[item.severity] ?? item.severity) : '';
  // 差异化：缺陷=橙（致命/严重升红），需求=蓝
  const template = isBug
    ? (item.severity === 'fatal' || item.severity === 'serious' ? 'red' : 'orange')
    : 'blue';

  // TAPD 来的自由文本（标题/状态名/提出人/项目名/描述摘要）都可能含 `[ ] < ` 反引号 →
  // 拼进 lark_md 前统一 escapeLarkMd，防有 TAPD 写权限者在标题塞 [钓鱼](url) 渲染成可点链接。
  const lines: string[] = [];
  lines.push(`**${escapeLarkMd(truncate(item.title, 80))}**`);
  const meta: string[] = [`#${item.id}`, kindLabel];
  if (sev) meta.push(`严重级:${escapeLarkMd(sev)}`);
  if (item.statusLabel || item.status) meta.push(`状态:${escapeLarkMd(item.statusLabel ?? item.status)}`);
  if (item.reporter) meta.push(`提出:${escapeLarkMd(item.reporter)}`);
  lines.push(`<font color='grey'>${meta.join(' · ')}</font>`);
  if (item.workspaceName) lines.push(`<font color='grey'>项目:${escapeLarkMd(item.workspaceName)}</font>`);
  if (item.modified) lines.push(`<font color='grey'>更新:${escapeLarkMd(item.modified)}</font>`);
  // 摘要：一眼看清这条是干啥的（光 id+链接看不出）
  const summary = tapdSummary(item.description, 160);
  if (summary) lines.push(`\n${escapeLarkMd(summary)}`);

  const elements: unknown[] = [
    { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
    { tag: 'hr' },
    {
      tag: 'div',
      text: { tag: 'lark_md', content: `建议分支名：\`${item.branch}\`` },
    },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '🌿 认领并建分支' },
          type: 'primary',
          value: {
            action: 'tapd-claim',
            id: item.id,
            system: item.system,
            workspaceId: item.workspaceId,
            branch: item.branch,
            title: item.title,
          },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '🔗 打开 TAPD' },
          type: 'default',
          multi_url: { url: item.url, pc_url: item.url, ios_url: item.url, android_url: item.url },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '🕐 稍后' },
          type: 'default',
          value: { action: 'tapd-snooze', id: item.id },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '🙈 不是我的' },
          type: 'default',
          value: { action: 'tapd-not-mine', id: item.id },
        },
      ],
    },
  ];

  return {
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: `${icon} 指派给你的${kindLabel}` },
    },
    elements,
  };
}

/**
 * 轻量提示卡：已是我的条目发生「状态变化 / 内容改动」时推，只提示、不塞认领流。
 * 蓝色信息态；按钮只有「🔗 打开 TAPD」（认领仍走首次指派时的 tapdItemCard）。
 *  - kind==='status' → 「状态：旧 → 新」（状态名尽量中文，回退英文 key）
 *  - kind==='update' → 「📝 内容有改动」+ 当前状态
 */
export function tapdInfoCard(data: {
  item: TapdItem;
  kind: 'status' | 'update';
  prevStatus?: string;
  prevStatusLabel?: string;
}) {
  const { item, kind } = data;
  const isBug = item.system === 'bug';
  const icon = isBug ? '🐞' : '📌';
  const kindLabel = isBug ? '缺陷' : '需求';
  // TAPD 自由文本一律 escapeLarkMd 再拼进 lark_md（防标题/状态名注入 [钓鱼](url) 等）。
  const newStatus = escapeLarkMd(item.statusLabel || item.status || '');

  const lines: string[] = [];
  lines.push(`**${escapeLarkMd(truncate(item.title, 80))}**`);
  const meta: string[] = [`#${item.id}`, kindLabel];
  if (item.workspaceName) meta.push(escapeLarkMd(item.workspaceName));
  lines.push(`<font color='grey'>${meta.join(' · ')}</font>`);
  if (kind === 'status') {
    const prev = escapeLarkMd(data.prevStatusLabel || data.prevStatus || '?');
    lines.push(`状态：${prev} → **${newStatus || '?'}**`);
  } else {
    lines.push(`📝 内容有改动`);
    if (newStatus) lines.push(`<font color='grey'>当前状态：${newStatus}</font>`);
  }
  if (item.modified) lines.push(`<font color='grey'>更新时间：${escapeLarkMd(item.modified)}</font>`);

  const title = kind === 'status' ? `${icon} ${kindLabel}状态更新` : `${icon} ${kindLabel}有更新`;
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: title } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔗 打开 TAPD' },
            type: 'default',
            multi_url: { url: item.url, pc_url: item.url, ios_url: item.url, android_url: item.url },
          },
        ],
      },
    ],
  };
}

/**
 * 认领后的 repo 多选卡：勾这个 bug/需求涉及的 repo（可多选），再「建分支并开工」。
 * 每个 repo 按钮 toggle（点一下 ✅/⬜ 切换，卡片原地 patch）。
 */
const TAPD_BASE_LABEL: Record<string, string> = {
  current: '当前分支直接改(不建分支)',
  head: `从当前 HEAD 切`,
  master: '从 master 切',
  develop: '从 develop 切',
};

/** repo 多选卡每页显示多少个 repo 按钮（3 行 × 3）。超过就分页，任意多 repo 都能翻到。 */
const TAPD_REPO_PAGE_SIZE = 9;

export function tapdRepoPickerCard(
  claim: { id: string; branch: string; title: string; system: string; selectedRepos: string[]; sop?: boolean; base?: string; kind?: 'fix' | 'feature' | 'indev'; pickPage?: number },
  candidates: { path: string; label: string }[],
  home: string,
) {
  const selected = new Set(claim.selectedRepos);
  const kindLabel = claim.system === 'bug' ? '缺陷' : '需求';
  const modeLabel = claim.sop ? 'SOP 编排（多 stage）' : '直接修（普通任务）';
  const baseLabel = TAPD_BASE_LABEL[claim.base ?? 'head'] ?? '从当前 HEAD 切';
  // 任务类型（决定目录策略）：显式 kind 优先，否则由 base/sop 派生
  const taskKind = claim.kind ?? (claim.base === 'current' ? 'indev' : (claim.sop ? 'feature' : 'fix'));
  const taskKindLabel = TAPD_KIND_LABEL[taskKind];

  // 分页：不再截断前 10 个，任意多 repo 都能翻到（对齐 browseCard 分页）
  const total = candidates.length;
  const pageCount = Math.max(1, Math.ceil(total / TAPD_REPO_PAGE_SIZE));
  const page = Math.min(Math.max(0, claim.pickPage ?? 0), pageCount - 1); // 夹到合法范围，防越界
  const start = page * TAPD_REPO_PAGE_SIZE;
  const end = Math.min(start + TAPD_REPO_PAGE_SIZE, total);
  const pageSlice = candidates.slice(start, end);

  const repoButtons = pageSlice.map((c) => ({
    tag: 'button',
    text: {
      tag: 'plain_text',
      content: `${selected.has(c.path) ? '✅' : '⬜'} ${truncate(c.label, 28)}`,
    },
    type: selected.has(c.path) ? 'primary' : 'default',
    value: { action: 'tapd-pick-repo', id: claim.id, cwd: c.path },
  }));

  // 每行最多 3 个按钮，分组
  const rows: unknown[] = [];
  for (let i = 0; i < repoButtons.length; i += 3) {
    rows.push({ tag: 'action', actions: repoButtons.slice(i, i + 3) });
  }

  const countLine =
    total === 0
      ? "<font color='grey'>（没扫到 repo，用下面「➕ 手输路径」加，或先 /pin 收藏目录）</font>"
      : pageCount > 1
        ? `<font color='grey'>repo ${total} 个 · 第 ${page + 1}/${pageCount} 页（本页 ${start + 1}–${end}）</font>`
        : `<font color='grey'>repo ${total} 个</font>`;

  const selList = claim.selectedRepos.length
    ? claim.selectedRepos.map((p) => `\`${escapeLarkMd(homeify(p, home))}\``).join(' ')
    : '<font color=\'grey\'>（还没选，点下面的 repo 勾选，可多选）</font>';

  const elements: unknown[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${truncate(claim.title, 70)}**\n<font color='grey'>${kindLabel} #${claim.id} · 分支 \`${claim.branch}\`</font>`,
      },
    },
    { tag: 'hr' },
    { tag: 'div', text: { tag: 'lark_md', content: `已选 repo：${selList}\n${countLine}` } },
    ...rows,
  ];

  // 分页导航（仅多页时出现）：上一页 / 下一页，停在同 claim 换页
  if (pageCount > 1) {
    const nav: unknown[] = [];
    if (page > 0) nav.push({ tag: 'button', text: { tag: 'plain_text', content: '◀ 上一页' }, type: 'default', value: { action: 'tapd-repo-page', id: claim.id, page: page - 1 } });
    if (page < pageCount - 1) nav.push({ tag: 'button', text: { tag: 'plain_text', content: '下一页 ▶' }, type: 'default', value: { action: 'tapd-repo-page', id: claim.id, page: page + 1 } });
    elements.push({ tag: 'action', actions: nav });
  }

  // 🔍 搜索添加：下拉可打字过滤（覆盖前 50 个候选），选中即勾选/取消——找 repo 比翻页快
  if (total > 0) {
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'select_static',
          placeholder: { tag: 'plain_text', content: '🔍 搜索 repo 名快速添加…' },
          options: candidates.slice(0, 50).map((c) => ({
            text: { tag: 'plain_text', content: truncate((selected.has(c.path) ? '✅ ' : '') + c.label, 60) },
            value: `pick|${c.path}`,
          })),
          value: { action: 'tapd-repo-select', id: claim.id },
        },
      ],
    });
  }
  // ➕ 手输路径：扫描没覆盖到的 repo（新 clone / 不在扫描根下）现场补
  elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '➕ 手输路径' }, type: 'default', value: { action: 'tapd-repo-addpath', id: claim.id } }] });

  elements.push({ tag: 'hr' });
  // 三组开关的中文说明（消除「看不懂」）
  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content:
        "<font color='grey'>🏷 **类型**：线上bug/新需求 → 建 `~/ihealth-work/…_<id6>/` 独立目录(worktree)，不碰你当前代码；开发中(原地改) → 各 repo 当前分支直接改。\n"
        + '🔁 **基准**：新分支从哪切 —— HEAD=从当前提交，master/develop=先 fetch 再从主干切；「当前分支直接改」=不建新分支。\n'
        + '🧩 **模式**：SOP=多步编排(需求→架构→编码→测试，含审批 gate)；直接修=一把梭。</font>',
    },
  });
  elements.push({ tag: 'div', text: { tag: 'lark_md', content: `类型：**${taskKindLabel}**　·　模式：**${modeLabel}**　·　基准：**${baseLabel}**${taskKind === 'indev' ? '' : `\n<font color='grey'>→ 建 \`~/ihealth-work/${taskKind === 'feature' ? 'feature' : 'fix'}_${claim.branch.split('_')[1] ?? ''}/\` 隔离目录（worktree）</font>`}` } });
  elements.push({
    tag: 'action',
    actions: [
      { tag: 'button', text: { tag: 'plain_text', content: `🏷 类型：${taskKindLabel}` }, type: 'default', value: { action: 'tapd-cycle-kind', id: claim.id } },
      { tag: 'button', text: { tag: 'plain_text', content: `🔁 基准：${baseLabel}` }, type: 'default', value: { action: 'tapd-cycle-base', id: claim.id } },
      { tag: 'button', text: { tag: 'plain_text', content: claim.sop ? '切成：直接修' : '切成：SOP 编排' }, type: 'default', value: { action: 'tapd-toggle-sop', id: claim.id } },
    ],
  });
  elements.push({
    tag: 'action',
    actions: [
      { tag: 'button', text: { tag: 'plain_text', content: '🚀 建分支并开工' }, type: 'primary', value: { action: 'tapd-claim-go', id: claim.id } },
      { tag: 'button', text: { tag: 'plain_text', content: '取消' }, type: 'default', value: { action: 'tapd-ignore', id: claim.id } },
    ],
  });

  return {
    // update_multi：多选 toggle / 翻页多次 patch 的交互卡必须带，否则第二次起飞书端视觉不刷新
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: 'turquoise',
      title: { tag: 'plain_text', content: `🌿 认领 · 选涉及的 repo（可多选）` },
    },
    elements,
  };
}

/**
 * 手输 repo 路径的表单卡（飞书 schema 2.0 form + input）：扫描没覆盖到的 repo 现场补。
 * 提交 → tapd-repo-addpath-submit：校验是存在的目录后，加入该 claim 的候选并默认勾选。
 */
export function tapdAddPathCard(claimId: string) {
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: '➕ 手输 repo 路径' }, template: 'turquoise' },
    body: {
      elements: [
        { tag: 'markdown', content: '扫描没找到的 repo，在这里填**绝对路径**（支持 `~`），提交后自动勾上。' },
        {
          tag: 'form',
          name: 'addpathform',
          elements: [
            { tag: 'input', name: 'path', label: { tag: 'plain_text', content: 'repo 目录路径' }, placeholder: { tag: 'plain_text', content: '/Users/you/code/xxx 或 ~/code/xxx' } },
            { tag: 'button', text: { tag: 'plain_text', content: '✅ 添加' }, type: 'primary', name: 'submit', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { action: 'tapd-repo-addpath-submit', id: claimId } }] },
          ],
        },
      ],
    },
  };
}

/**
 * TAPD claim 生命周期卡（飞书，随 `agent tapd stage` 上报 patch）：
 * 认领 → 修复中 → 验证中 → 待审批回写 → 已解决，当前阶段高亮。
 */
export function tapdClaimCard(claim: {
  id: string; system: string; title: string; branch: string; url: string; tty?: string;
  stage?: string; stageNote?: string;
}) {
  const ORDER = ['claimed', 'fixing', 'verifying', 'awaiting-approval', 'resolved'];
  const LABEL: Record<string, string> = {
    claimed: '已认领', fixing: '修复中', verifying: '验证中', 'awaiting-approval': '待审批回写', resolved: '已解决',
  };
  const cur = claim.stage ?? 'claimed';
  const failed = cur === 'failed';
  const curIdx = ORDER.indexOf(cur);
  const steps = ORDER.map((s, i) => {
    const mark = failed ? (i === 0 ? '✅' : '⚪')
      : i < curIdx ? '✅' : i === curIdx ? '🔵' : '⚪';
    return `${mark} ${LABEL[s]}`;
  }).join('　→　');
  const kindLabel = claim.system === 'bug' ? '缺陷' : '需求';
  const lines = [
    `**${truncate(claim.title, 70)}**`,
    `<font color='grey'>${kindLabel} #${claim.id} · 分支 \`${claim.branch}\`${claim.tty ? ` · ${claim.tty}` : ''}</font>`,
    '',
    failed ? `❌ **卡住/失败**${claim.stageNote ? `：${claim.stageNote}` : ''}` : steps,
  ];
  if (!failed && claim.stageNote) lines.push(`<font color='grey'>${claim.stageNote}</font>`);
  return {
    config: { wide_screen_mode: true },
    header: {
      template: cur === 'resolved' ? 'green' : failed ? 'red' : 'blue',
      title: { tag: 'plain_text', content: `🌿 ${kindLabel}修复进度 #${claim.id}` },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
      { tag: 'action', actions: [{
        tag: 'button', text: { tag: 'plain_text', content: '🔗 打开 TAPD' }, type: 'default',
        multi_url: { url: claim.url, pc_url: claim.url, ios_url: claim.url, android_url: claim.url },
      }] },
    ],
  };
}

/**
 * A3 Planner 计划卡（方案丙）：列出 claude -p 分解的步骤，每步一个「▶ 派发」按钮，
 * 用户点哪步就把该步 prompt 发给当前 active tab（不自动串）。蓝 = 待你操作。
 */
export function planCard(plan: Plan) {
  const elements: unknown[] = [];
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: `🎯 **目标**：${truncate(plan.goal, 80)}\n📋 ${plan.summary}` },
  });
  elements.push({ tag: 'hr' });

  plan.steps.forEach((s, i) => {
    const tgt = s.target ? `　<font color='grey'>→ ${s.target}</font>` : '';
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**${i + 1}. ${s.title}**${tgt}\n${truncate(s.prompt, 120)}` },
    });
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: `▶ 派发步骤 ${i + 1}` },
        type: 'primary',
        value: { action: 'plan-dispatch', planId: plan.id, step: i },
      }],
    });
  });

  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: '点「派发」把该步发给当前 active tab（先 /use @xxx 选目标）。逐步执行，不自动串。' }],
  });

  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: `🧩 执行计划 · ${plan.steps.length} 步` } },
    elements,
  };
}

/**
 * performance-platform 慢查询/性能建议通知卡（P0=红 / P1=橙 / P2=蓝）。
 * [🔧 认领修复] → perf-claim（开 tab 注入根因+索引命令+改动文件让 claude 修）。
 */
/** 任务工作目录列表卡：每条带「📂 打开」按钮，点击在该任务的 worktree 目录开新 tab。 */
export function worktasksCard(tasks: WorkTask[], home: string, query?: string) {
  const kindIcon = (k: string) => (k === 'fix' ? '🐞' : k === 'feature' ? '✨' : '🔧');
  const elements: unknown[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: query ? `🔍 匹配 **"${query}"**（${tasks.length}）` : `📁 **任务工作目录**（最近 ${tasks.length}）`,
      },
    },
  ];
  for (const t of tasks.slice(0, 10)) {
    const dir = t.taskDir ? homeify(t.taskDir, home) : (t.repos[0] ? homeify(t.repos[0], home) : '(原地改)');
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        // title/branch 都要转义：公函开工落的 WorkTask，title 是**外部 agent 写的议题**，
        // 不转义的话对方能在议题里塞 [钓鱼](url)，等你哪天 /worktasks 就渲染成可点链接。
        content: `${kindIcon(t.kind)} **${escapeLarkMd(truncate(t.title, 60))}**\n<font color='grey'>\`${escapeLarkMd(t.branch)}\` · ${escapeLarkMd(dir)}${t.source ? ` · ${escapeLarkMd(t.source)}` : ''}</font>`,
      },
    });
    const actions: unknown[] = [];
    if (t.repos.length > 0) {
      actions.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '📂 打开' },
        type: 'primary',
        value: { action: 'worktask-open', id: t.id },
      });
    }
    if (t.tapdUrl) {
      actions.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '🔗 TAPD' },
        type: 'default',
        multi_url: { url: t.tapdUrl, pc_url: t.tapdUrl, ios_url: t.tapdUrl, android_url: t.tapdUrl },
      });
    }
    if (actions.length > 0) elements.push({ tag: 'action', actions });
  }
  if (tasks.length > 10) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `<font color='grey'>… 还有 ${tasks.length - 10} 条，用 \`/worktasks <关键词>\` 收窄</font>` } });
  }
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: '📁 任务工作目录' } },
    elements,
  };
}

export function perfItemCard(item: PerfItem) {
  const template = item.priority === 'P0' ? 'red' : item.priority === 'P1' ? 'orange' : 'blue';

  const lines: string[] = [`**${truncate(item.title, 80)}**`];
  const meta: string[] = [item.priority];
  if (item.target) meta.push(`目标:${item.target}`);
  if (item.repo) meta.push(`仓库:${item.repo}`);
  const ns = [item.database, item.collection].filter(Boolean).join('.');
  if (ns) meta.push(ns);
  lines.push(`<font color='grey'>${meta.join(' · ')}</font>`);
  if (item.rootCause) lines.push(`\n**根因**：${truncate(item.rootCause, 160)}`);
  else if (item.rationale) lines.push(`\n${truncate(item.rationale, 160)}`);
  if (item.indexCommand) lines.push(`\n**索引建议**：\n\`${truncate(item.indexCommand, 200)}\``);
  if (item.codeFile) lines.push(`\n**改动文件**：\`${item.codeFile}\``);

  const actions: unknown[] = [
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '🔧 认领修复' },
      type: 'primary',
      value: { action: 'perf-claim', id: item.id },
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '📋 认领并建需求' },
      type: 'default',
      value: { action: 'perf-claim-story', id: item.id },
    },
  ];
  if (item.codePermalink) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '🔗 源码' },
      type: 'default',
      multi_url: { url: item.codePermalink, pc_url: item.codePermalink, ios_url: item.codePermalink, android_url: item.codePermalink },
    });
  }
  actions.push(
    { tag: 'button', text: { tag: 'plain_text', content: '🕐 稍后' }, type: 'default', value: { action: 'perf-snooze', id: item.id } },
    { tag: 'button', text: { tag: 'plain_text', content: '🙈 不是我的' }, type: 'default', value: { action: 'perf-not-mine', id: item.id } },
  );

  return {
    config: { wide_screen_mode: true },
    header: { template, title: { tag: 'plain_text', content: `⚡ 性能建议 · ${item.priority}` } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
      { tag: 'hr' },
      { tag: 'action', actions },
    ],
  };
}

// ==== 对接管理面板（/connect）====

/** 对接总览状态卡：按分组列出，未对接的跟 [对接] 按钮。 */
export function connectStatusCard(statuses: IntegrationStatus[]) {
  const groups = ['核心', '开发', '传输', '其他'] as const;
  const elements: unknown[] = [
    { tag: 'div', text: { tag: 'lark_md', content: '**本项目对接列表**（业务人员按需开启，开发类默认不启）' } },
  ];
  for (const g of groups) {
    const items = statuses.filter((s) => s.group === g);
    if (items.length === 0) continue;
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `**${g}**` } });
    for (const s of items) {
      const badge = !s.connected
        ? (s.skill ? "<font color='grey'>⬜ 未安装</font>" : s.agent ? "<font color='grey'>⬜ 未就绪</font>" : "<font color='grey'>⬜ 未对接</font>")
        : s.disabled
          ? "<font color='orange'>⏸ 已停用（配置保留）</font>"
          : (s.skill ? "<font color='green'>✅ 已安装</font>" : s.agent ? "<font color='green'>✅ 就绪</font>" : s.claudeMd ? "<font color='green'>✅ 已写入全局</font>" : "<font color='green'>✅ 已启用</font>");
      const todo = s.agent && s.missing.length ? ` · <font color='orange'>待办：${s.missing.join('、')}</font>` : '';
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: `${badge}　**${s.name}**\n<font color='grey'>${s.desc}</font>${todo}` } });
      if (s.core) continue; // 核心(飞书)不可停用
      let btn: unknown | null = null;
      if (!s.connected) {
        btn = { tag: 'button', text: { tag: 'plain_text', content: s.skill ? `📥 安装` : s.agent ? `📋 查看引导` : s.claudeMd ? `📥 写入规则` : `🔌 对接` }, type: 'primary', value: { action: 'connect-config', key: s.key } };
      } else if (s.claudeMd) {
        btn = { tag: 'button', text: { tag: 'plain_text', content: `🗑 移除规则` }, type: 'default', value: { action: 'connect-remove', key: s.key } }; // 断开=真删全局块
      } else if (s.skill || s.agent) {
        continue; // skill 型已装 / agent 型已就绪：无需停用
      } else if (s.disabled) {
        btn = { tag: 'button', text: { tag: 'plain_text', content: `▶ 启用` }, type: 'primary', value: { action: 'connect-enable', key: s.key } };
      } else {
        btn = { tag: 'button', text: { tag: 'plain_text', content: `⏸ 停用` }, type: 'default', value: { action: 'connect-disable', key: s.key } };
      }
      elements.push({ tag: 'action', actions: [btn] });
    }
  }
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: '🔌 对接管理' } },
    elements,
  };
}

/**
 * 某对接的配置输入表单卡（飞书 schema 2.0 form + input）。填完提交 → connect-submit。
 * 纯开关型（只有 fixedValue 字段）→ 返回 null，由调用方直接走确认。
 */
export function connectFormCard(it: Integration): unknown | null {
  const inputs = it.fields.filter((f) => !f.fixedValue);
  if (inputs.length === 0) return null;
  const formEls: unknown[] = inputs.map((f) => ({
    tag: 'input',
    name: f.env,
    label: { tag: 'plain_text', content: `${f.label}${f.secret ? ' 🔒' : ''}` },
    placeholder: { tag: 'plain_text', content: f.placeholder ?? (f.secret ? '粘贴密钥/令牌' : `填 ${f.env}`) },
  }));
  formEls.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '✅ 提交配置' },
    type: 'primary',
    name: 'submit',
    form_action_type: 'submit',
    behaviors: [{ type: 'callback', value: { action: 'connect-submit', key: it.key } }],
  });
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: `🔌 配置 · ${it.name}` }, template: 'blue' },
    body: { elements: [
      { tag: 'markdown', content: `${it.desc}\n\n填完点提交，确认后写入 .env 并重启生效。密钥仅写入本地 .env（gitignored），不外泄。` },
      { tag: 'form', name: 'connectform', elements: formEls },
    ] },
  };
}

/** 写入前的确认卡（脱敏展示）。[确认写入并重启]/[取消]。 */
export function connectConfirmCard(key: string, name: string, lines: string[]) {
  return {
    config: { wide_screen_mode: true },
    header: { template: 'yellow', title: { tag: 'plain_text', content: `⚠️ 确认对接 · ${name}` } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `将写入 .env（密钥已脱敏）：\n${lines.join('\n')}` } },
      { tag: 'div', text: { tag: 'lark_md', content: "<font color='grey'>确认后写入并**重启 dev** 生效（约数秒）。</font>" } },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '✅ 确认写入并重启' }, type: 'primary', value: { action: 'connect-apply', key } },
        { tag: 'button', text: { tag: 'plain_text', content: '⊘ 取消' }, type: 'default', value: { action: 'connect-cancel', key } },
      ] },
    ],
  };
}

// ==== CareyClaw 调试密钥 到期提醒 / 更新 ====

/** 调试密钥状态卡（到期提醒也复用它）。带 [🔄更新密钥]（弹输入表单）+ [🔗去后台]。 */
export function careyclawKeyCard(status: { hasKey: boolean; keyMasked?: string; expiresAt?: string; daysLeft?: number }, opts?: { remind?: boolean }) {
  const expired = status.hasKey && typeof status.daysLeft === 'number' && status.daysLeft < 0;
  const soon = status.hasKey && typeof status.daysLeft === 'number' && status.daysLeft >= 0 && status.daysLeft <= 2;
  const template = expired ? 'red' : soon ? 'orange' : 'blue';
  const title = opts?.remind
    ? (expired ? '🔑 CareyClaw 调试密钥已过期' : `🔑 CareyClaw 调试密钥 ${status.daysLeft} 天后过期`)
    : '🔑 CareyClaw 调试密钥';

  const lines: string[] = [];
  if (!status.hasKey) {
    lines.push("<font color='grey'>还没设置调试密钥</font>");
  } else {
    lines.push(`当前：\`${status.keyMasked}\``);
    if (status.expiresAt) {
      const label = expired ? "<font color='red'>已过期</font>" : soon ? `<font color='orange'>剩 ${status.daysLeft} 天</font>` : `剩 ${status.daysLeft} 天`;
      lines.push(`访问权限到期：${status.expiresAt}　${label}`);
    }
  }
  lines.push('\n<font color=\'grey\'>更新步骤：平台后台「我的资料 → 开发者」点「刷新」走短信验证 → 复制新密钥 → 点下面「更新密钥」贴回。</font>');

  return {
    config: { wide_screen_mode: true },
    header: { template, title: { tag: 'plain_text', content: title } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '🔄 更新密钥' }, type: 'primary', value: { action: 'careyclaw-key-update' } },
        { tag: 'button', text: { tag: 'plain_text', content: '🔗 去后台' }, type: 'default', multi_url: { url: 'https://bot.ihealthcn.com', pc_url: 'https://bot.ihealthcn.com', ios_url: 'https://bot.ihealthcn.com', android_url: 'https://bot.ihealthcn.com' } },
      ] },
    ],
  };
}

/** 更新调试密钥的输入表单卡（飞书 schema 2.0 form）。提交 → careyclaw-key-submit。 */
export function careyclawKeyFormCard() {
  return {
    schema: '2.0',
    header: { title: { tag: 'plain_text', content: '🔄 更新 CareyClaw 调试密钥' }, template: 'blue' },
    body: { elements: [
      { tag: 'markdown', content: '把后台刷新后拿到的新密钥贴进来（到期日可选，如 2026-08-16，用于到期提醒）。' },
      { tag: 'form', name: 'ckform', elements: [
        { tag: 'input', name: 'dev_key', label: { tag: 'plain_text', content: '调试密钥 (oct_dev_...) 🔒' }, placeholder: { tag: 'plain_text', content: 'oct_dev_...' } },
        { tag: 'input', name: 'expires_at', label: { tag: 'plain_text', content: '访问权限到期日(可选)' }, placeholder: { tag: 'plain_text', content: '2026-08-16' } },
        { tag: 'button', text: { tag: 'plain_text', content: '✅ 保存' }, type: 'primary', name: 'submit', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { action: 'careyclaw-key-submit' } }] },
      ] },
    ] },
  };
}

// ==== TAPD 建任务 / 列表 / 状态变更卡片（/tapd new + /tapd） ====

/** 级联选择步骤卡（选项目 / 选需求类别通用）：一个 select_static 下拉。 */
export interface TapdSelectCardData {
  header: string;                 // 标题栏，如 "📝 新建 TAPD 需求 · 选项目"
  body: string;                   // 正文说明（lark_md），含任务标题
  placeholder: string;            // 下拉占位符
  action: string;                 // 下拉 widget 的 action（tapd-nw-p / tapd-nw-t）
  draftId: string;                // 草稿 id（回调据此找回标题/已选项）
  options: { label: string; value: string }[]; // option.value 为字符串（"id|name"）
}
export function tapdSelectCard(d: TapdSelectCardData) {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: d.header } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: d.body } },
      {
        tag: 'action',
        actions: [
          {
            tag: 'select_static',
            placeholder: { tag: 'plain_text', content: d.placeholder },
            options: d.options.slice(0, 50).map((o) => ({
              text: { tag: 'plain_text', content: smartTrim(o.label, 60) },
              value: o.value,
            })),
            value: { action: d.action, d: d.draftId },
          },
        ],
      },
    ],
  };
}

/** 建成功卡。 */
export interface TapdCreatedCardData {
  title: string;
  projectName: string;
  typeName?: string;
  id?: string;
  url: string;
}
export function tapdCreatedCard(d: TapdCreatedCardData) {
  const lines = [
    `**${truncate(d.title, 80)}**`,
    `📁 ${d.projectName}${d.typeName ? ` · ${d.typeName}` : ''}${d.id ? ` · #${d.id}` : ''}`,
  ];
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'green', title: { tag: 'plain_text', content: '✅ TAPD 需求已创建' } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔗 打开 TAPD' },
            type: 'primary',
            url: d.url,
            value: { action: 'noop' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '📋 我的 TAPD' },
            type: 'default',
            value: { action: 'tapd-list' },
          },
        ],
      },
    ],
  };
}

/**
 * 第二步：填「主题(标题)+内容(描述)」的表单卡（飞书 schema 2.0 form）。
 * 提交 → tapd-nw-submit（form_value: { title, content }）。
 * 创建人/开发负责人自动=当前账号（TAPD_NICK），不在表单里问。
 */
export function tapdCreateFormCard(d: { draftId: string; projectName: string; title?: string }) {
  const titleInput: Record<string, unknown> = {
    tag: 'input',
    name: 'title',
    label: { tag: 'plain_text', content: '主题（需求标题）*' },
    placeholder: { tag: 'plain_text', content: '一句话说清要做什么' },
  };
  if (d.title) titleInput['default_value'] = d.title;
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: '📝 新建 TAPD 需求 · 填内容' }, template: 'blue' },
    body: { elements: [
      { tag: 'markdown', content: `项目：**${truncate(d.projectName, 40)}**\n填「主题(标题)」和「内容(描述)」，创建人/开发负责人自动=当前账号。` },
      { tag: 'form', name: 'tapdnewform', elements: [
        titleInput,
        { tag: 'input', name: 'content', label: { tag: 'plain_text', content: '内容（描述，可选）' }, placeholder: { tag: 'plain_text', content: '详细描述 / 验收点…' } },
        { tag: 'button', text: { tag: 'plain_text', content: '✅ 创建需求' }, type: 'primary', name: 'submit', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { action: 'tapd-nw-submit', d: d.draftId } }] },
      ] },
    ] },
  };
}

/**
 * 建需求结果卡（schema 2.0，供 patch 表单卡；用 markdown 链接而非按钮，避开 2.0 action 按钮）。
 * 成功=绿+打开链接；失败(多为网络/网关连不上)=红+原因，草稿不删可重试。
 */
export function tapdCreateResultCardV2(d: { ok: boolean; title: string; projectName: string; id?: string; url?: string; error?: string }) {
  if (!d.ok) {
    return {
      schema: '2.0',
      config: { update_multi: true },
      header: { title: { tag: 'plain_text', content: '❌ TAPD 需求创建失败' }, template: 'red' },
      body: { elements: [
        { tag: 'markdown', content: `**${truncate(d.title, 80)}**\n项目：${truncate(d.projectName, 40)}\n\n原因：${d.error ?? '未知'}\n\n（草稿保留，网关恢复后可再点「✅ 创建需求」重试）` },
      ] },
    };
  }
  const link = d.url ? `\n\n[🔗 打开 TAPD](${d.url})` : '';
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: '✅ TAPD 需求已创建' }, template: 'green' },
    body: { elements: [
      { tag: 'markdown', content: `**${truncate(d.title, 80)}**\n📁 ${truncate(d.projectName, 40)}${d.id ? ` · #${d.id}` : ''}${link}` },
    ] },
  };
}

/** 我的 TAPD 列表卡：每条一行 + 「🔄 改状态」按钮。 */
export interface TapdListItem {
  id: string;
  system: 'bug' | 'story';
  workspaceId: number;
  workspaceName?: string;
  title: string;
  statusLabel: string;
  workitemTypeId?: string;
  url: string;
}
export function tapdListCard(items: TapdListItem[]) {
  const elements: unknown[] = [];
  if (items.length === 0) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '✅ 没有指派给你的未结束缺陷/需求' } });
  }
  for (const it of items.slice(0, 20)) {
    const icon = it.system === 'bug' ? '🐞' : '📌';
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `${icon} **${truncate(it.title, 50)}**\n<font color='grey'>#${it.id} · ${it.workspaceName ?? it.workspaceId} · 状态：${it.statusLabel || '?'}</font>`,
      },
      extra: {
        tag: 'button',
        text: { tag: 'plain_text', content: '🔄 改状态' },
        type: 'default',
        value: {
          action: 'tapd-st',
          ws: it.workspaceId,
          sys: it.system,
          id: it.id,
          wt: it.workitemTypeId ?? '',
          cur: it.statusLabel || '',
          t: truncate(it.title, 30),
        },
      },
    });
  }
  if (items.length > 20) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: `<font color='grey'>… 还有 ${items.length - 20} 条，收窄 TAPD_WORKSPACE_IDS 或去 TAPD 看</font>` } });
  }
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: `📋 我的 TAPD（${items.length}）` } },
    elements,
  };
}

/** 改状态：选目标状态的下拉卡（点某条「改状态」后单独发一张）。 */
export interface TapdStatusPickCardData {
  title: string;
  workspaceId: number;
  system: 'bug' | 'story';
  id: string;
  currentStatus: string;
  options: { label: string; value: string }[]; // option.value = "st|<中文状态名>"
}
export function tapdStatusPickCard(d: TapdStatusPickCardData) {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'yellow', title: { tag: 'plain_text', content: '🔄 改状态' } },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**${truncate(d.title, 60)}**\n<font color='grey'>#${d.id} · 当前：${d.currentStatus || '?'}</font>`,
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'select_static',
            placeholder: { tag: 'plain_text', content: '选择目标状态…' },
            options: d.options.slice(0, 50).map((o) => ({
              text: { tag: 'plain_text', content: smartTrim(o.label, 40) },
              value: o.value,
            })),
            value: { action: 'tapd-st-set', ws: d.workspaceId, sys: d.system, id: d.id },
          },
        ],
      },
    ],
  };
}

// ---- macOS 授权缺失 · 交互卡（探针 broken 时推送）----
// 完整列出受影响功能（不截断——critical），带「📂 打开面板」（Mac 一键跳授权页，鼠标点勾选）
// 和「🔄 我授好了·重启复检」（kickstart daemon，新进程复检后自动推 ✅/🚨）。
export function hostPermissionCard(denied: HostPermissionStatus[]) {
  const blocks = denied.map((d) => {
    const spec = getHostPermissionSpec(d.id);
    const affects = spec.affects.map((a) => `　· ${a}`).join('\n');
    const errTag = d.errNum !== undefined ? ` <font color='grey'>（错误 ${d.errNum}）</font>` : '';
    return `**❌ ${spec.name}**${errTag}\n<font color='grey'>授权位置：${spec.macLocation}</font>\n受影响功能：\n${affects}`;
  });
  // 去重要开的面板：accessibility → 辅助功能；两个 automation → 自动化
  const panes = [...new Set(denied.map((d) => (d.id === 'accessibility' ? 'accessibility' : 'automation')))];
  const paneButtons = panes.map((p) => ({
    tag: 'button' as const,
    text: { tag: 'plain_text' as const, content: p === 'accessibility' ? '📂 打开「辅助功能」' : '📂 打开「自动化」' },
    type: 'primary' as const,
    value: { action: 'perm-open-pane', pane: p },
  }));
  return {
    config: { wide_screen_mode: true },
    header: { template: 'red', title: { tag: 'plain_text', content: `🚨 macOS 授权缺失 · ${denied.length} 项` } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: blocks.join('\n\n') } },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: '<font color=\'grey\'>**在电脑旁**：点下面「打开面板」→ Mac 跳到授权页 → 勾选 node（launchd）/ Terminal（dev）→ 回来点「🔄 我授好了」。\n**不在电脑旁**：授权只能在 Mac 本地点（TCC 安全限制，没法远程授予），到电脑旁再操作。</font>' } },
      { tag: 'action', actions: [...paneButtons, { tag: 'button', text: { tag: 'plain_text', content: '🔄 我授好了 · 重启复检' }, type: 'default', value: { action: 'perm-recheck' } }] },
    ],
  };
}

// ---- 权限授权等级卡 ----

/** 权限授权等级选择卡：5 档按钮，当前档 primary 标记，点击即切(action perm-level-set)。 */
export function permLevelCard(current: number, labels: Record<number, string>) {
  const rows = [0, 1, 2, 3, 4].map((n) => ({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: `${n === current ? '**▶ ' : ''}L${n} · ${labels[n] ?? ''}${n === current ? '（当前）**' : ''}`,
    },
  }));
  const buttons = [0, 1, 2, 3, 4].map((n) => ({
    tag: 'button' as const,
    text: { tag: 'plain_text' as const, content: n === current ? `✓ L${n}` : `L${n}` },
    type: n === current ? ('primary' as const) : ('default' as const),
    value: { action: 'perm-level-set', level: n },
  }));
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: '🎚 权限审批授权等级' } },
    elements: [
      ...rows,
      { tag: 'hr' },
      { tag: 'action', actions: buttons },
      { tag: 'div', text: { tag: 'lark_md', content: '<font color=\'grey\'>选的档决定"高危拦到哪一层"；越低越自动、越高越谨慎。学习型放行在各档内仍生效。</font>' } },
    ],
  };
}

// ---- Dogfood 自审报告卡 ----

export interface AuditCardFinding {
  severity: 'high' | 'medium' | 'low';
  category: string;
  title: string;
  detail?: string;
}

/** dogfood 自审报告卡：列出发现(按严重度图标)。无发现→绿；出错→红。 */
export function auditReportCard(findings: AuditCardFinding[], opts?: { error?: string }) {
  const sevIcon: Record<string, string> = { high: '🔴', medium: '🟠', low: '⚪' };
  const template = opts?.error ? 'red' : findings.length ? 'orange' : 'green';
  const elements: unknown[] = [];
  if (opts?.error) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `自审跑失败：${opts.error}` },
    });
  } else if (findings.length === 0) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '✓ 没发现明显问题（CHANGELOG↔docs / 报错日志 / TODO）。' } });
  } else {
    const blocks = findings.slice(0, 10).map((f) => {
      const icon = sevIcon[f.severity] ?? '⚪';
      const detail = f.detail ? `\n  <font color='grey'>${f.detail}</font>` : '';
      return `${icon} **[${f.category}]** ${f.title}${detail}`;
    });
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: blocks.join('\n\n') } });
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '<font color=\'grey\'>只报告不改仓库(v1)。要修哪条直接 @tab 派活给 claude。</font>' },
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      template,
      title: { tag: 'plain_text', content: `🔧 自审报告${findings.length ? ` · ${findings.length} 条` : ''}` },
    },
    elements,
  };
}


// ================= CareyClaw Agent 公函 =================

/**
 * 公函任务卡。
 *
 * 卡上所有来自平台的文本（议题、职责域 key）都过 `escapeLarkMd`：公函是**别的 agent 写的
 * 外部输入**，不转义的话对方可以在议题里塞 `[钓鱼](url)` 渲染成可点链接。
 *
 * 「开工」刻意做成按钮而不是自动执行：不是每封公函都值得开一个目录 + 一个 tab
 * （很多只是知会/抄送），自动建会攒下一堆空目录和空 tab。
 */
export function letterTaskCard(n: LetterNotification, bodyShown = true) {
  const t = n.thread;
  const isReply = n.kind === 'reply';
  const lines: string[] = [];
  lines.push(`**${escapeLarkMd(truncate(t.subject, 80))}**`);

  const meta: string[] = [`发起:${escapeLarkMd(t.initiator || '?')}`];
  if (isReply) meta.push(`第 ${t.lastSeq} 封（上次看到 ${n.prevSeq}）`);
  if (t.strict) meta.push('strict');
  lines.push(`<font color='grey'>${meta.join(' · ')}</font>`);

  const others = t.participants.filter((p) => p !== t.nextOwner);
  if (others.length) lines.push(`<font color='grey'>参与:${escapeLarkMd(others.join(', '))}</font>`);
  if (t.pendingMine > 0) lines.push(`<font color='red'>待我答 ${t.pendingMine} 项</font>`);
  if (t.pendingOthers.length) {
    lines.push(`<font color='grey'>还欠答:${escapeLarkMd(t.pendingOthers.join(', '))}</font>`);
  }
  if (t.updatedAt) lines.push(`<font color='grey'>更新:${escapeLarkMd(t.updatedAt)}</font>`);

  const url = `https://bot.ihealthcn.com/app/letters`;
  return {
    // 会被反复点（读全文 / 开工各 patch 一次）→ 必须 update_multi，否则第二次 patch 视觉不生效
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      // 待我答=橙（需要响应）；纯知会=蓝（信息）
      template: t.pendingMine > 0 ? 'orange' : 'blue',
      title: { tag: 'plain_text', content: isReply ? '📮 公函有新回复' : '📮 新公函' },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          // 内容在这张卡**之前**已经推过了，所以正常情况下这里是「确认」而不是「先去读」
          content: bodyShown
            ? "<font color='grey'>↑ 上面几条是这封的完整内容，看过再决定是否开工</font>"
            : "<font color='red'>⚠ 这封的内容没拉下来，你还没看过 —— 先「读全文」，读到了才会给开工按钮</font>",
        },
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          // **内容没成功推给人时，绝不给「确认，开工」**。
          // seq 校验只挡「对方又更新了」，挡不住「这一版压根没给人看过」——
          // 拉全文失败时 seq 没变，校验放行，正文就会进到高权限会话，而人从没见过它。
          // 「人看过全文才执行」这条边界要靠按钮本身不出现来保证，不能只靠一句提示。
          ...(bodyShown
            ? [{
                tag: 'button',
                text: { tag: 'plain_text', content: '✅ 确认，开工' },
                type: 'primary',
                // 带上这张卡展示的是第几封：点击时若线程已经推进（对方又追加了一封），
                // 那份内容用户没看过，不能拿去喂高权限会话 —— 见 openLetterWorkspace 的 seq 校验
                value: { action: 'letter-work', threadId: t.threadId, seq: t.lastSeq },
              }]
            : []),
          {
            tag: 'button',
            text: { tag: 'plain_text', content: bodyShown ? '📖 再读一遍' : '📖 读全文（重试）' },
            type: bodyShown ? 'default' : 'primary',
            value: { action: 'letter-read', threadId: t.threadId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔗 打开公函页' },
            type: 'default',
            multi_url: { url, pc_url: url, ios_url: url, android_url: url },
          },
        ],
      },
    ],
  };
}

/**
 * 公函令牌失效卡。
 * MCP 用的是 `~/.careyclaw/token-prod` 里的 `oct_dev_` 开发者令牌，会过期；
 * 过期后轮询全挂，必须显式告知——否则表现是「公函再也不推了」，很难察觉。
 */
export function letterAuthCard(detail: string) {
  const url = 'https://bot.ihealthcn.com/app/profile';
  return {
    config: { wide_screen_mode: true },
    header: { template: 'red', title: { tag: 'plain_text', content: '🔑 公函令牌失效' } },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: [
            '公函轮询已停 —— CareyClaw 开发者令牌过期或被吊销。',
            `<font color='grey'>${escapeLarkMd(truncate(detail, 160))}</font>`,
            '',
            '去平台「工具中心 → 本地调试密钥」刷新，新令牌写回 `~/.careyclaw/token-prod` 即自动恢复。',
          ].join('\n'),
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔗 去刷新密钥' },
            type: 'primary',
            multi_url: { url, pc_url: url, ios_url: url, android_url: url },
          },
        ],
      },
    ],
  };
}
