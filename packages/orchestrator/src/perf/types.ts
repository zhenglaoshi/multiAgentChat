/** performance-platform 的 recommendation 状态（与 -api RecommendationStatus 对齐）。 */
export type PerfStatus = 'pending' | 'in_progress' | 'implemented' | 'verified' | 'dismissed';

/**
 * 归一化后的 perf 待办项（从 -api RecommendationRecord 抽取本项目需要的字段，防御式读取）。
 */
export interface PerfItem {
  id: string;                 // RecommendationRecord._id
  status: string;
  title: string;
  priority: string;           // P0 | P1 | P2
  target?: string;            // backend | frontend | sre | product
  rationale?: string;
  rootCause?: string;
  database?: string;
  collection?: string;
  indexCommand?: string;      // indexRecommendation.command
  codeFile?: string;          // codeChange.file
  codePermalink?: string;     // codeChange.permalink / codeMatches[0].permalink
  codeChange?: string;        // codeChange.change（建议的具体改动）
  repo?: string;              // 解析出的 repo 名（github org/name 的 name 段）
  localPath?: string;         // reposBaseDir/<repo>
  gitCommitUrl?: string;
  createdAt?: number;
  windowDay?: string;
  updatedKey?: string;        // 变更检测用（status + windowDay），变了会再通知一次
  tapdStoryId?: string;       // 「认领并建需求」建成后回填的 TAPD 需求 id（幂等，防重建）
  tapdStoryUrl?: string;      // 对应 TAPD 需求详情链接
}

export interface PerfConfig {
  apiUrl: string;             // perf-api base，如 http://host:port（不含 /api）
  user: string;
  pass: string;
  nick: string;               // 我的身份（回写 implementedBy / 未来 owners 匹配）
  targets: string[];          // 只看这些 target；空 = 全部
  priorities: string[];       // 只看这些优先级；默认 P0,P1
  myRepos: string[];          // 本地归属过滤（repo 名）；空 = 全部（等 perf repos.json 有 owners 后可弃用）
  reposBaseDir: string;       // 本地仓库根，做 repo→localPath 映射
  pollMs: number;
  enabled: boolean;
}
