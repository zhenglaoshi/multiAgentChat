/**
 * SOP stage artifact 骨架 schema —— 让"文件 handoff"可验证。
 *
 * 每个 SDLC stage 的 artifact 应含若干必填 section；`--end --artifact` 时 server 灵活校验
 *（含任一 alias 即算命中，大小写不敏感、中英通吃），缺 section 会 surface 给主 agent + 卡，
 * 但**不硬 block**（避免 heading 措辞差异导致死锁）。自定义 stage 无 schema → 不校验直接放行。
 */
export interface ArtifactSection {
  key: string;        // 显示名
  aliases: string[];  // 匹配关键词（中英）
}

export interface StageArtifactSchema {
  label: string;
  requiredSections: ArtifactSection[];
}

export const STAGE_ARTIFACT_SCHEMA: Record<string, StageArtifactSchema> = {
  'requirement-analyzer': {
    label: '需求分析',
    requiredSections: [
      { key: '目标', aliases: ['目标', 'goals', 'objective'] },
      { key: '非目标', aliases: ['非目标', 'non-goals', 'nongoals', 'out of scope'] },
      { key: '验收标准', aliases: ['验收标准', 'acceptance criteria', 'acceptance', '验收'] },
      { key: '开放问题', aliases: ['开放问题', 'open questions', '待确认', 'assumptions', '假设'] },
    ],
  },
  architect: {
    label: '架构设计',
    requiredSections: [
      { key: '受影响文件', aliases: ['受影响文件', 'affected files', '影响文件', '改动文件'] },
      { key: '接口/数据流', aliases: ['接口', 'interface', '数据流', 'data flow'] },
      { key: '风险', aliases: ['风险', 'risk', 'risks', '隐患'] },
    ],
  },
  coder: {
    label: '编码',
    requiredSections: [
      { key: '改动摘要', aliases: ['改动', 'changes', '实现', '摘要', 'summary'] },
    ],
  },
  tester: {
    label: '测试',
    requiredSections: [
      { key: '覆盖行为', aliases: ['覆盖', 'coverage', '测试点', 'test case', '用例'] },
      { key: '结果', aliases: ['结果', 'result', 'pass', 'fail', '通过'] },
    ],
  },
  'regression-checker': {
    label: '回归验证',
    requiredSections: [
      { key: '验收核对', aliases: ['验收', 'acceptance', '核对', 'criteria'] },
      { key: '结论', aliases: ['结论', 'verdict', 'pass', 'fail', '通过', '判定'] },
    ],
  },
};

export interface ArtifactCheckResult {
  ok: boolean;
  missing: string[];    // 缺失 section 的显示名
  schemaKnown: boolean; // 该 stage 有没有 schema（无则不校验）
}

/** 按 stage 名取 schema（大小写不敏感，LLM 上报的 name 常大小写不一致）。 */
function schemaFor(stageName: string): StageArtifactSchema | undefined {
  const key = Object.keys(STAGE_ARTIFACT_SCHEMA).find((k) => k.toLowerCase() === stageName.toLowerCase());
  return key ? STAGE_ARTIFACT_SCHEMA[key] : undefined;
}

/** 灵活校验：content 是否含每个必填 section 的任一 alias。无 schema 的 stage 直接 ok。 */
export function checkArtifact(stageName: string, content: string): ArtifactCheckResult {
  const schema = schemaFor(stageName);
  if (!schema) return { ok: true, missing: [], schemaKnown: false };
  const lc = content.toLowerCase();
  const missing = schema.requiredSections
    .filter((sec) => !sec.aliases.some((a) => lc.includes(a.toLowerCase())))
    .map((sec) => sec.key);
  return { ok: missing.length === 0, missing, schemaKnown: true };
}

/** 给 wrapper prompt / subagent 的骨架提示（一行列出必填 section）；无 schema 返回 null。 */
export function artifactSkeletonHint(stageName: string): string | null {
  const schema = schemaFor(stageName);
  if (!schema) return null;
  return schema.requiredSections.map((s) => s.key).join(' / ');
}
