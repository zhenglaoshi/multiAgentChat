/** 一个对接需要的一个环境变量字段。 */
export interface IntegrationField {
  env: string;
  label: string;
  secret?: boolean;       // 密钥：确认卡里脱敏显示、绝不 log
  placeholder?: string;
  fixedValue?: string;    // 开关型（如 KNOWLEDGE_EXTRACT_ENABLED=1）：对接即写死此值，不需输入
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
