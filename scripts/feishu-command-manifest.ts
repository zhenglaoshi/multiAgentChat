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
  usage?: string[];          // 详细子命令语法（多行；不进飞书后台，只在 md 里）
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
    usage: [
      '/dashboard                            # 显示全局概览卡',
    ],
  },
  {
    name: 'shells',
    aliases: ['s', 'tabs', 'ls'],
    description: '列所有 Terminal tab（可点切换）',
    example: 'shells',
    group: 'nav',
    usage: [
      '/shells                               # 列所有 Terminal tab',
      '/s                                    # 短别名',
    ],
  },
  {
    name: 'where',
    aliases: ['w', 'pwd'],
    description: '当前 active tab 的详情',
    example: 'where',
    group: 'nav',
    usage: [
      '/where                                # 看本会话当前 active tab 的 cwd/tty/title',
    ],
  },
  {
    name: 'history',
    aliases: ['h'],
    description: '当前 tab 屏幕历史 tail',
    example: 'history -n 100',
    group: 'nav',
    usage: [
      '/history                              # 默认 tail 50 行',
      '/history -n 100                       # 指定行数',
    ],
  },

  // ── 任务派发 ────────────────────────────────────
  {
    name: 'use',
    aliases: ['u'],
    description: '切换本会话的 active tab',
    example: 'use ttys001',
    group: 'dispatch',
    usage: [
      '/use ttys001                          # 按 tty 精确切',
      '/use myproject                        # 按 cwd 末尾目录名切',
      '/use                                  # 无参数 → 列 tab 让选',
    ],
  },
  {
    name: 'new',
    aliases: ['n'],
    description: '开新 Terminal tab（无参数弹选目录卡）',
    example: 'new ~/code/foo',
    group: 'dispatch',
    usage: [
      '/new                                  # 弹目录选择卡（含 recent-cwds 建议）',
      '/new ~/code/multiAgentChat            # 直接指定 cwd 开',
      '/new /tmp                             # 绝对路径',
    ],
  },
  {
    name: 'watch',
    description: '开关本地任务监听（Mac 直发的命令也推）',
    example: 'watch on',
    group: 'dispatch',
    usage: [
      '/watch on                             # 打开：非飞书发起的 shell 活动也推到飞书',
      '/watch off                            # 关闭',
      '/watch                                # 不带参数 = 查询当前状态',
    ],
  },

  // ── SOP 编排 ────────────────────────────────────
  {
    name: 'run',
    aliases: ['preset'],
    description: '跑模板 or --sop 临时 SOP',
    example: 'run --sop 实现 X',
    group: 'sop',
    usage: [
      '/run <name>                           # 跑已存的模板（无参数）',
      '/run <name> pos1 pos2                 # 位置参数填 {{1}} {{2}}',
      '/run <name> key=value key2=value2     # 命名参数填 {{key}}',
      '/run --sop <prompt>                   # 临时 SOP，不需预存模板',
      '/run --sop --stages a,b,c <prompt>    # 自定义 stage 序列',
      '/run --sop @<tab> <prompt>            # 绑定特定 tab',
    ],
  },
  {
    name: 'template',
    aliases: ['t', 'templates', 'tpl'],
    description: '管理任务模板（save/show/delete/list）',
    example: 'template',
    group: 'sop',
    usage: [
      '/template                             # 列所有已保存模板（卡片）',
      '/template save <name> <prompt>        # 存模板；prompt 里可用 {{key}} 占位',
      '/template save <name> --stages a,b,c --gates after-b --loops b→c*2 <prompt>',
      '                                      #   --stages: SDLC stage 序列',
      '                                      #   --gates: 在某 stage 后加人工审批点',
      '                                      #   --loops: 循环失败重试规则',
      '/template show <name>                 # 看模板详情（含 stages/gates/loops）',
      '/template delete <name>               # 删',
    ],
  },
  {
    name: 'task',
    aliases: ['tk'],
    description: 'SOP 任务列表 / 详情 / 中止',
    example: 'task',
    group: 'sop',
    usage: [
      '/task                                 # 列所有进行中 + 最近完成的 SOP 任务',
      '/task <task-id>                       # 看单个任务详情卡（stage 时间线）',
      '/task here                            # 只看本会话的进行中 SOP',
      '/task abort                           # 中止本会话进行中的 task（无 id 自动找）',
      '/task abort <task-id>                 # 中止指定 task（soft）',
      '/task abort <task-id> hard            # 硬中止（不等 subagent 收尾）',
    ],
  },

  // ── Subagent ────────────────────────────────────
  {
    name: 'subagent',
    aliases: ['sa', 'subagents'],
    description: '管理 subagent（list/gen/tweak/delete）',
    example: 'subagent gen 视频剪辑',
    group: 'subagent',
    usage: [
      '/subagent                             # 等价 /subagent list',
      '/subagent list                        # 列所有可用 subagent（user+project）',
      '/subagent <name>                      # 看单个详情（含 system prompt 前 800 字）',
      '/subagent gen <域描述>                # LLM 自动为该域生成 3-5 个 subagent + template',
      '/subagent tweak <name> <feedback>     # 对现有 subagent 迭代（会 --hard 覆写）',
      '/subagent delete <name>               # 删',
    ],
  },

  // ── 查询 & 交互 ─────────────────────────────────
  {
    name: 'approvals',
    aliases: ['a'],
    description: '待审批列表 + 最近历史',
    example: 'approvals',
    group: 'query',
    usage: [
      '/approvals                            # 看当前 pending 的审批 + 最近 5 条历史',
      '                                      # 点卡片按钮 "批准" / "拒绝" 直接响应',
    ],
  },
  {
    name: 'recall',
    aliases: ['r'],
    description: '搜任务历史；不带关键词 = 最近 10 条',
    example: 'recall 三梯队',
    group: 'query',
    usage: [
      '/recall                               # 最近 10 条任务 memory',
      '/recall <关键词>                      # 按 cwd + keyword 打分搜',
      '/recall 三梯队 subagent               # 多关键词（AND 语义）',
    ],
  },

  // ── 其它 ────────────────────────────────────────
  {
    name: 'help',
    aliases: ['?'],
    description: '完整命令帮助',
    example: 'help',
    group: 'other',
    usage: [
      '/help                                 # 完整命令列表（含所有短 alias）',
      '/?                                    # 等价短形',
    ],
  },
  {
    name: 'chain',
    aliases: ['c', 'chains'],
    description: '查看运行中的任务链路',
    example: 'chain',
    group: 'other',
    hidden: true,
    note: '语法 @a X >> @b Y 直接用即可，不常用命令',
    usage: [
      '/chain                                # 列运行中链路 + 最近完成',
      '/chain cancel <id>                    # 终止指定链路',
      '',
      '# 链路创建（非命令）—— 一行消息里串联多个 @target：',
      '@myapp 跑测试 >> @docs 生成报告 >> @lark 推送',
    ],
  },
  {
    name: 'audit',
    description: '审批历史',
    example: 'audit 20',
    group: 'other',
    hidden: true,
    note: '/approvals 已含最近历史',
    usage: [
      '/audit                                # 最近 10 条审批历史',
      '/audit 50                             # 指定条数',
    ],
  },
  {
    name: 'presets',
    aliases: ['p'],
    description: '旧名：列任务模板（文本版）',
    example: 'presets',
    group: 'other',
    hidden: true,
    note: '被 /template 取代，为兼容保留',
    usage: [
      '/presets                              # 等价 /template 但只输出文本（无卡片）',
      '/p                                    # 短别名',
    ],
  },
];
