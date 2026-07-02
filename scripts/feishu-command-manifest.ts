export type CommandGroup =
  | 'nav'       // 概览 / 导航
  | 'dispatch'  // 任务派发
  | 'sop'       // SOP 编排
  | 'subagent'  // Subagent 管理
  | 'query'     // 查询 / 交互
  | 'other';    // 其它

export interface CommandMeta {
  name: string;
  aliases?: string[];
  description: string;       // ≤ 50 字符（飞书限制）
  example: string;           // placeholder / 示例
  group: CommandGroup;
  hidden?: boolean;          // 建议菜单里隐藏
  note?: string;             // 备注（不进飞书后台，只在 md 里）
}

export const GROUP_LABELS: Record<CommandGroup, string> = {
  nav:      '概览 & 导航',
  dispatch: '任务派发',
  sop:      'SOP 编排',
  subagent: 'Subagent',
  query:    '查询 & 交互',
  other:    '其它',
};

export const COMMAND_MANIFEST: CommandMeta[] = [
  // ── 概览 & 导航 ─────────────────────────────────
  {
    name: 'dashboard',
    aliases: ['d'],
    description: '概览：tab + 进行中的任务 + 最近完成',
    example: 'dashboard',
    group: 'nav',
  },
  {
    name: 'shells',
    aliases: ['s', 'tabs', 'ls'],
    description: '列所有 Terminal tab（可点切换）',
    example: 'shells',
    group: 'nav',
  },
  {
    name: 'where',
    aliases: ['w', 'pwd'],
    description: '当前 active tab 的详情',
    example: 'where',
    group: 'nav',
  },
  {
    name: 'history',
    aliases: ['h'],
    description: '当前 tab 屏幕历史 tail',
    example: 'history -n 100',
    group: 'nav',
  },

  // ── 任务派发 ────────────────────────────────────
  {
    name: 'use',
    aliases: ['u'],
    description: '切换本会话的 active tab',
    example: 'use ttys001',
    group: 'dispatch',
  },
  {
    name: 'new',
    aliases: ['n'],
    description: '开新 Terminal tab（无参数弹选目录卡）',
    example: 'new ~/code/foo',
    group: 'dispatch',
  },
  {
    name: 'watch',
    description: '开关本地任务监听（Mac 直发的命令也推）',
    example: 'watch on',
    group: 'dispatch',
  },

  // ── SOP 编排 ────────────────────────────────────
  {
    name: 'run',
    aliases: ['preset'],
    description: '跑模板 or --sop 临时 SOP',
    example: 'run --sop 实现 X',
    group: 'sop',
  },
  {
    name: 'template',
    aliases: ['t', 'templates', 'tpl'],
    description: '管理任务模板（save/show/delete/list）',
    example: 'template',
    group: 'sop',
  },
  {
    name: 'task',
    aliases: ['tk'],
    description: 'SOP 任务列表 / 详情 / 中止',
    example: 'task',
    group: 'sop',
  },

  // ── Subagent ────────────────────────────────────
  {
    name: 'subagent',
    aliases: ['sa', 'subagents'],
    description: '管理 subagent（list/gen/tweak/delete）',
    example: 'subagent gen 视频剪辑',
    group: 'subagent',
  },

  // ── 查询 & 交互 ─────────────────────────────────
  {
    name: 'approvals',
    aliases: ['a'],
    description: '待审批列表 + 最近历史',
    example: 'approvals',
    group: 'query',
  },
  {
    name: 'recall',
    aliases: ['r'],
    description: '搜任务历史；不带关键词 = 最近 10 条',
    example: 'recall 三梯队',
    group: 'query',
  },

  // ── 其它 ────────────────────────────────────────
  {
    name: 'help',
    aliases: ['?'],
    description: '完整命令帮助',
    example: 'help',
    group: 'other',
  },
  {
    name: 'chain',
    aliases: ['c', 'chains'],
    description: '查看运行中的任务链路',
    example: 'chain',
    group: 'other',
    hidden: true,
    note: '语法 @a X >> @b Y 直接用即可，不常用命令',
  },
  {
    name: 'audit',
    description: '审批历史',
    example: 'audit 20',
    group: 'other',
    hidden: true,
    note: '/approvals 已含最近历史',
  },
  {
    name: 'presets',
    aliases: ['p'],
    description: '旧名：列任务模板（文本版）',
    example: 'presets',
    group: 'other',
    hidden: true,
    note: '被 /template 取代，为兼容保留',
  },
];
