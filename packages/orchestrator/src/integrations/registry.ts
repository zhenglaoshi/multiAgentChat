/** 一个对接需要的一个环境变量字段。 */
export interface IntegrationField {
  env: string;
  label: string;
  secret?: boolean;       // 密钥：确认卡里脱敏显示、绝不 log
  placeholder?: string;
  fixedValue?: string;    // 开关型（如 KNOWLEDGE_EXTRACT_ENABLED=1）：对接即写死此值，不需输入
}

/** skill 型对接需要安装的一个 Claude Code 技能。 */
export interface IntegrationSkill {
  name: string;   // 技能目录名（~/.claude/skills/<name>/SKILL.md）
  url: string;    // 下载源
}

export interface Integration {
  key: string;
  name: string;
  group: '核心' | '开发' | '传输' | '其他';
  desc: string;
  fields: IntegrationField[];
  /** true = 任一 field 有值即算已对接（如报告的多个 *_AT）；默认全部有值才算。 */
  anyOf?: boolean;
  /** 核心对接（飞书）不可"取消"，仅展示。 */
  core?: boolean;
  /** skill 型对接：对接=装 Claude Code 技能（无 env / 无密钥；技能自带浏览器授权）。 */
  skillType?: boolean;
  skills?: IntegrationSkill[];
  /** agent 型对接：不填 env 不装技能，"对接"=检测 CLI 装没装/登录没/notify 钩子装没装 + 给引导（如 codex）。 */
  agentType?: 'codex';
  /** claudeMd 型对接：对接=往全局 ~/.claude/CLAUDE.md 写规则块，断开=删掉。规则内容见 claudeMdRule。 */
  claudeMdType?: boolean;
  /** claudeMd 型的规则正文（写入全局 CLAUDE.md，外面自动包 sentinel 标记）。 */
  claudeMdRule?: string;
}

/** 本项目所有可选对接。状态由 .env 里对应 env 是否有值判定。 */
export const INTEGRATIONS: Integration[] = [
  {
    key: 'lark', name: '飞书 (核心)', group: '核心', core: true,
    desc: '手机 IM ⇄ Mac 的主通道，必须配',
    fields: [
      { env: 'LARK_APP_ID', label: '飞书 App ID', placeholder: 'cli_xxx' },
      { env: 'LARK_APP_SECRET', label: '飞书 App Secret', secret: true },
    ],
  },
  {
    key: 'tapd', name: 'TAPD 需求/缺陷监听', group: '开发',
    desc: '自动监听指派/开发给我的 TAPD 需求缺陷，推卡认领',
    fields: [
      { env: 'TAPD_MCP_URL', label: 'TAPD MCP 网关 URL', placeholder: 'https://.../mcp' },
      { env: 'TAPD_MCP_TOKEN', label: 'Bearer Token', secret: true },
      { env: 'TAPD_NICK', label: 'TAPD 昵称', placeholder: '你的名字' },
    ],
  },
  {
    key: 'letters', name: 'CareyClaw 公函监听', group: '开发',
    desc: '每 2 分钟拉 Agent 公函收件箱，新公函/对方回函推任务卡（用 ~/.careyclaw 里的开发者令牌，无需额外配密钥）',
    // 令牌读 ~/.careyclaw/token-prod（careyclaw skill 装过就有），所以默认可用、不需要填 env。
    // 这里只登记一个开关型 field，让 /connect 卡片能列出「公函」并给出停用/启用按钮。
    fields: [{ env: 'LETTERS_ENABLED', label: '启用公函监听', fixedValue: '1' }],
    anyOf: true,
  },
  {
    key: 'perf', name: '性能平台监听', group: '开发',
    desc: '监听 performance-platform 的慢查询/性能建议，推卡认领修复',
    fields: [
      { env: 'PERF_API_URL', label: 'perf-api URL', placeholder: 'http://host:port' },
      { env: 'PERF_API_USER', label: 'Basic Auth 用户名' },
      { env: 'PERF_API_PASS', label: 'Basic Auth 密码', secret: true },
    ],
  },
  {
    key: 'knowledge', name: '知识提炼', group: '开发',
    desc: 'shell 交互流自动提炼知识条目',
    fields: [{ env: 'KNOWLEDGE_EXTRACT_ENABLED', label: '开启', fixedValue: '1' }],
  },
  {
    key: 'codex', name: 'Codex CLI (多 agent)', group: '开发',
    desc: '让 codex tab 也能远程调度 + 响应回传飞书（对标 claude）。检测 CLI/登录/notify 钩子',
    fields: [], agentType: 'codex',
  },
  {
    key: 'review-gate', name: '代码评审门', group: '开发', claudeMdType: true,
    desc: '对接=往全局 ~/.claude/CLAUDE.md 写一条规则：任意项目改代码、交付/提交前，必须并行派 code-reviewer + security-reviewer 审 git diff，有 high/critical 就改到过为止（纯文档/配置豁免）。断开即从全局删除。无需重启，即刻对所有项目的 claude session 生效',
    fields: [],
    claudeMdRule: [
      '## 代码改动必过评审门（强制）',
      '',
      '在**任意项目**里改动 / 新增代码后，把结果交付（宣布完成 / 提交 / 结束回合）**之前**，',
      '**必须**用 Task 工具**并行**派两个 subagent 审本次改动：',
      '',
      '- **`code-reviewer`** —— 质量：正确性隐患(空值/错误处理/资源泄露/竞态)、可读可维护、',
      '  一致性、可测试性、架构耦合(循环依赖/分层)、健壮性、性能、依赖、可观测性、文档。',
      '- **`security-reviewer`** —— 安全：注入、越权、密钥硬编码、危险命令/代码执行、',
      '  SSRF/XXE、不安全反序列化、依赖漏洞、敏感数据泄露、加密误用。',
      '',
      '审的对象是 `git diff`（或本次改动的文件）。拿到结果后：',
      '',
      '1. 有 **high / critical** 问题 → **按建议改**，改完**再派这俩复审**，如此循环，直到两者都无 high+ 问题。',
      '2. 只剩 low/medium 或无问题 → 可以交付；把审查结论简述给用户。',
      '',
      '**豁免**：纯文档 / 注释 / 配置 / 依赖锁文件的改动、或"本身就是在跑评审 / 只读分析"的会话，可跳过。',
      '别把评审跳过当默认——**只要动了产品代码，就走这道门**。',
    ].join('\n'),
  },
  {
    key: 'wecom', name: '企业微信', group: '传输',
    desc: '企微作为额外的 IM 通道（可选）',
    fields: [
      { env: 'WECOM_CORP_ID', label: '企业 ID' },
      { env: 'WECOM_AGENT_ID', label: '应用 AgentId' },
      { env: 'WECOM_SECRET', label: '应用 Secret', secret: true },
      { env: 'WECOM_TOKEN', label: '回调 Token', secret: true },
      { env: 'WECOM_AES_KEY', label: '回调 EncodingAESKey', secret: true },
    ],
  },
  {
    key: 'web', name: 'Web 面板', group: '其他',
    desc: '内置 Web Dashboard',
    fields: [{ env: 'WEB_DASHBOARD_TOKEN', label: '访问 Token', secret: true }],
  },
  {
    key: 'careyclaw', name: 'CareyClaw 平台(龙虾)', group: '其他',
    desc: '检索/试调平台业务 API + 打包发布应用（装官方 Claude Code 技能，浏览器授权，无需密钥）',
    fields: [], skillType: true,
    skills: [
      { name: 'careyclaw-apis', url: 'https://bot.ihealthcn.com/api/skills/cli/careyclaw-apis.md' },
      { name: 'careyclaw-deploy', url: 'https://bot.ihealthcn.com/api/skills/cli/careyclaw-deploy.md' },
    ],
  },
  {
    key: 'perm-gate', name: '高危命令审批', group: '其他', anyOf: true,
    desc: 'claude 跑高危 shell 命令前推飞书审批卡(默认全程开)。此处设【授权等级】默认档:0全自动/1仅致命(默认)/2标准/3严格/4偏执。随时改用飞书 /perm-level(弹卡即切,无需重启)',
    fields: [
      { env: 'PERM_LEVEL', label: '授权等级 0-4(默认1仅致命)', placeholder: '1' },
      { env: 'PERM_LEARN_THRESHOLD', label: '学习放行阈值(同命令批准N次自动放行,默认3)', placeholder: '3' },
    ],
  },
  {
    key: 'secret-guard', name: '明文凭证脱敏', group: '其他', anyOf: true,
    desc: '回显脱敏(推飞书/落盘前脱 AK/SK/密码/token)默认全程开启 + 已内置 skill；此处配【定期扫历史会话】。手动:agent secrets scan|scrub；飞书 /raw 临时看明文',
    fields: [
      { env: 'SECRET_SCRUB_ENABLED', label: '启用定期扫描', fixedValue: '1' },
      { env: 'SECRET_SCRUB_APPLY', label: '定期自动就地脱敏(否则只报告)', fixedValue: '1' },
      { env: 'SECRET_SCRUB_INTERVAL_HOURS', label: '周期(小时)', placeholder: '24' },
    ],
  },
  {
    key: 'report', name: '定时工作报告', group: '其他', anyOf: true,
    desc: '日/周/月报定时自动生成推送（配任一即启）',
    fields: [
      { env: 'REPORT_DAILY_AT', label: '日报时间', placeholder: '18:00' },
      { env: 'REPORT_WEEKLY_AT', label: '周报时间', placeholder: 'Mon 18:00' },
      { env: 'REPORT_MONTHLY_AT', label: '月报时间', placeholder: '1 18:00' },
    ],
  },
];

export function getIntegration(key: string): Integration | undefined {
  return INTEGRATIONS.find((i) => i.key === key);
}
