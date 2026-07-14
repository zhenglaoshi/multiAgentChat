import type { ApprovalRequest, AskRequest, TapdItem } from 'multiagent-orchestrator';
import { inferTabStatus, type TabStatusInfo } from 'multiagent-host-mac';
import type { TerminalTab } from 'multiagent-host-mac';

function homeify(p: string, home: string): string {
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

// ---- Approval card (保留) ----

/**
 * 审批卡片，根据 ApprovalRequest.status 渲染四态。
 *  pending  : 蓝色 + 「✅ 批准」「❌ 拒绝」按钮
 *  approved : 绿色 + "已批准 by ..."
 *  rejected : 红色 + "已拒绝 by ..."
 *  timeout  : 灰色 + "已超时（自动拒绝）"
 */
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

// ---- Tabs card (按 window 分组) ----

export interface TabsCardData {
  tabs: TerminalTab[];
  activeTty?: string;
  home: string;
  /** 可选 status overrides：watcher / dashboard 可以传更精确的 status（含 history detect） */
  statusByTty?: Map<string, TabStatusInfo>;
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
        elements.push({ tag: 'action', actions: perTabActions });
      }
      elements.push({ tag: 'hr' });
    }
  }

  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '🆕 开新 tab' },
        type: 'primary',
        value: { action: 'choose-dir' },
      },
    ],
  });

  return {
    config: { wide_screen_mode: true },
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
              content: truncate(homeify(e.cwd, data.home), 60),
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
  subdirs: BrowseCardEntry[];      // 当前目录下的子文件夹
  home: string;
  truncated?: boolean;             // 是否列表被截断（超过展示上限）
}

export function browseCard(data: BrowseCardData) {
  const cwdShown = homeify(data.currentCwd, data.home);
  const elements: unknown[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `📍 **当前**：\`${cwdShown}\`\n${data.subdirs.length === 0 ? '（这里没有子文件夹）' : `子文件夹 ${data.subdirs.length} 个${data.truncated ? '（已截断，显示前 30）' : ''}`}`,
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

  if (data.subdirs.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: '📂 **进入子文件夹**' },
    });
    // 用 select_static 一次性列出（避免几十个按钮把卡片撑爆）
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'select_static',
          placeholder: {
            tag: 'plain_text',
            content: '选一个子文件夹进入…',
          },
          options: data.subdirs.slice(0, 30).map((e) => ({
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
    config: { wide_screen_mode: true },
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

  const metaParts: string[] = [];
  if (data.cwd) metaParts.push(`📁 ${data.cwd}`);
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
    config: { wide_screen_mode: true },
    header: {
      template,
      title: {
        tag: 'plain_text',
        content: `${sourceTag}${icon} ${stateLabel} · ${data.tty} · ${shortDesc}`,
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
    config: { wide_screen_mode: true },
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

  const buttonActions = useButtons
    ? opts.map((label, i) => ({
        tag: 'button' as const,
        text: { tag: 'plain_text' as const, content: truncate(label, 18) },
        type: i === 0 ? ('primary' as const) : ('default' as const),
        value: { action: 'send-to-tab', tty: d.tty, text: label },
      }))
    : null;

  const dropdownAction = useDropdown
    ? {
        tag: 'select_static' as const,
        placeholder: {
          tag: 'plain_text' as const,
          content: `选择答案… (${opts.length} 项)`,
        },
        options: opts.map((label) => ({
          text: { tag: 'plain_text' as const, content: truncate(label, 60) },
          value: encodeAnswerOption(d.tty, label),
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
    { tag: 'hr' },
    { tag: 'div', text: { tag: 'lark_md', content: hintLine } },
  ];

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
export function askCard(req: AskRequest) {
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
      elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `**点一个选项即可提交**` },
      });
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
              content: `${j + 1}. ${truncate(req.options[j] ?? '', 40)}`,
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
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**点选项切换勾选，最后点 [✅ 提交]**（已选 ${req.selection.length} 项）`,
        },
      });
      elements.push({ tag: 'hr' });
      for (let i = 0; i < req.options.length; i += 2) {
        const row: unknown[] = [];
        for (let j = i; j < Math.min(i + 2, req.options.length); j++) {
          const on = selectedSet.has(j);
          row.push({
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: `${on ? '☑' : '☐'} ${j + 1}. ${truncate(req.options[j] ?? '', 40)}`,
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
    config: { wide_screen_mode: true },
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

  const lines: string[] = [];
  lines.push(`**${truncate(item.title, 80)}**`);
  const meta: string[] = [`#${item.id}`, kindLabel];
  if (sev) meta.push(`严重级:${sev}`);
  if (item.statusLabel || item.status) meta.push(`状态:${item.statusLabel ?? item.status}`);
  if (item.reporter) meta.push(`提出:${item.reporter}`);
  lines.push(`<font color='grey'>${meta.join(' · ')}</font>`);
  if (item.workspaceName) lines.push(`<font color='grey'>项目:${item.workspaceName}</font>`);
  if (item.modified) lines.push(`<font color='grey'>更新:${item.modified}</font>`);

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
          text: { tag: 'plain_text', content: '🙈 忽略' },
          type: 'default',
          value: { action: 'tapd-ignore', id: item.id },
        },
      ],
    },
  ];

  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'yellow',
      title: { tag: 'plain_text', content: `${icon} 指派给你的${kindLabel}` },
    },
    elements,
  };
}
