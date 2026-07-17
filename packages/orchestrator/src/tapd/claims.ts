import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { TapdSystem } from './types.js';

const DATA_DIR = resolve('./data/tapd/claims');

/** 认领一个 TAPD 缺陷/需求的进行态（多选 repo → 切分支 → 开 tab）。 */
export interface TapdClaim {
  id: string;                // TAPD item id（也是 claim 主键）
  system: TapdSystem;
  workspaceId: number;
  title: string;
  branch: string;            // fix_<后6> / feat_<后6>
  url: string;
  description?: string;      // 认领时拉的详情，注入 claude 用
  selectedRepos: string[];   // 用户勾选的 repo 路径
  /** true → 开工时跑 SOP（多 stage 编排）；false → 普通任务直接修。默认：需求 true / 缺陷 false。 */
  sop: boolean;
  /**
   * 任务类型（决定工作目录策略，与 sop 正交）：
   *  - 'fix'      线上bug → ~/ihealth-work/fix_<id6>/ worktree 隔离目录
   *  - 'feature'  新需求 → feature_<id6>/ worktree 隔离目录
   *  - 'indev'    开发中 → 各 repo 当前分支原地改，不建目录
   * 未设时由 base/sop 派生（兼容旧 claim）：base=current→indev，否则 sop?feature:fix。
   */
  kind?: 'fix' | 'feature' | 'indev';
  /**
   * 分支基准：
   *  - 'current'  在当前分支直接改，不建新分支（测试阶段 bug：基于被测分支）
   *  - 'head'     从当前 HEAD 切 fix_/feat_（默认）
   *  - 'master' / 'develop'  从主干切（线上 bug hotfix）
   */
  base: 'current' | 'head' | 'master' | 'develop';
  status: 'picking' | 'working' | 'ignored';
  tty?: string;              // 开工后的 tab
  createdAt: number;
  // ---- A 生命周期（工作 claude 用 `agent tapd stage` 上报，daemon patch 卡）----
  /** 当前阶段 */
  stage?: TapdStage;
  /** 阶段备注（claude 上报时可带） */
  stageNote?: string;
  /** 发消息/patch 卡用的 chatId（飞书 oc_ / 企微 wecom:）*/
  chatId?: string;
  /** 生命周期卡的 messageId（飞书用来 patch）*/
  cardMessageId?: string;
}

/** claim 生命周期阶段（认领 → 修复 → 验证 → 待审批 → 已解决）。 */
export type TapdStage = 'claimed' | 'fixing' | 'verifying' | 'awaiting-approval' | 'resolved' | 'failed';

export const TAPD_STAGE_ORDER: TapdStage[] = ['claimed', 'fixing', 'verifying', 'awaiting-approval', 'resolved'];
export const TAPD_STAGE_LABEL: Record<TapdStage, string> = {
  claimed: '已认领',
  fixing: '修复中',
  verifying: '验证中',
  'awaiting-approval': '待审批回写',
  resolved: '已解决',
  failed: '卡住/失败',
};

/** 解析 claim 的任务类型：优先显式 kind，否则由 base/sop 派生（兼容旧 claim）。 */
export function resolveClaimKind(claim: Pick<TapdClaim, 'kind' | 'base' | 'sop'>): 'fix' | 'feature' | 'indev' {
  if (claim.kind) return claim.kind;
  if (claim.base === 'current') return 'indev';
  return claim.sop ? 'feature' : 'fix';
}

export const TAPD_KIND_LABEL: Record<'fix' | 'feature' | 'indev', string> = {
  fix: '🐞 线上bug',
  feature: '✨ 新需求',
  indev: '🔧 开发中(原地改)',
};

async function ensureDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

function fileFor(id: string): string {
  // id 全数字，安全
  return join(DATA_DIR, `${id}.json`);
}

export async function loadClaim(id: string): Promise<TapdClaim | null> {
  try {
    return JSON.parse(await readFile(fileFor(id), 'utf8')) as TapdClaim;
  } catch {
    return null;
  }
}

export async function saveClaim(claim: TapdClaim): Promise<void> {
  await ensureDir();
  const f = fileFor(claim.id);
  const tmp = f + '.tmp';
  await writeFile(tmp, JSON.stringify(claim, null, 2), 'utf8');
  await rename(tmp, f);
}

/** 勾选 / 取消勾选一个 repo，返回更新后的 claim。 */
export async function toggleRepo(id: string, cwd: string): Promise<TapdClaim | null> {
  const claim = await loadClaim(id);
  if (!claim) return null;
  const i = claim.selectedRepos.indexOf(cwd);
  if (i >= 0) claim.selectedRepos.splice(i, 1);
  else claim.selectedRepos.push(cwd);
  await saveClaim(claim);
  return claim;
}
