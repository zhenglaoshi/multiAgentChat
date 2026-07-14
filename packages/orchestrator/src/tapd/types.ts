/**
 * TAPD 集成数据模型
 *
 * 通过公司的 TAPD MCP 网关（streamable-http + Bearer token）访问 TAPD。
 * 监听指派给"我"（current_owner）的当天缺陷/需求，推飞书让我认领 → 切分支 → 开 claude tab。
 */

/** 实体类型：缺陷 or 需求。任务(task)暂并入 story 处理。 */
export type TapdSystem = 'bug' | 'story';

export interface TapdConfig {
  /** MCP 网关 endpoint（streamable-http） */
  mcpUrl: string;
  /** Bearer token（放 .env，勿入库） */
  token: string;
  /** 我的 TAPD 昵称（current_owner 过滤 + 身份）——token 的 email 不会自动解析成 nick */
  nick: string;
  /** 只监听这些项目；空 = 用 get-user-participant-projects 发现的全部 */
  workspaceIds: number[];
  /** 监听哪些类型（默认 bug+story）。TAPD_SYSTEMS=bug 则只 bug。 */
  systems: TapdSystem[];
  /** 轮询间隔 ms（默认 5min） */
  pollMs: number;
  /** 是否启用（缺 TAPD_MCP_URL/TOKEN/NICK 任一 → false） */
  enabled: boolean;
}

/** 归一化后的一条待办实体（缺陷或需求）。 */
export interface TapdItem {
  id: string;
  system: TapdSystem;
  workspaceId: number;
  workspaceName?: string;
  title: string;
  status: string;            // 英文状态 key（如 'new' / 'in_progress' / 'closed'）
  statusLabel?: string;      // 中文状态名（若拿得到）
  severity?: string;
  priority?: string;
  reporter?: string;
  current_owner?: string;
  created?: string;
  modified?: string;
  description?: string;
  /** TAPD 网页链接 */
  url: string;
  /** 建分支用：fix_<id>（缺陷）/ feat_<id>（需求） */
  branch: string;
}
