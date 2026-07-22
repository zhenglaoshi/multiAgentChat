/**
 * 学习型放行 —— 权限审批卡的"自我演进"层。
 *
 * 权限 gate 每次「批准/拒绝」都记下（按**归一化命令**，近似精确、**不泛化**）：同一命令
 * 连续批准 ≥ 阈值(默认 3) 且从未被拒 → 之后自动放行、不再弹卡。安全优先：
 *  - **近似精确匹配**（只折叠空白），不把 `rm -rf /a` 学成放行 `rm -rf /b`；
 *  - **最灾难命令永不学习放行**（`rm -rf /`、`mkfs`、`dd of=/dev`、fork bomb…），每次都问；
 *  - 任何一次**拒绝**即打上 denied、永不再自动放行该命令；
 *  - 可 `clearLearned()` 一键清空；每次自动放行仍记 info 日志。
 *
 * 纯判定（normalizeCmd/isNeverLearn/decideAutoAllow）与存储分离，便于单测。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { logger } from '../logger.js';

const STORE_FILE = resolve('./data/guard/learned-allow.json');

function threshold(): number {
  const v = Number(process.env['PERM_LEARN_THRESHOLD']);
  return Number.isFinite(v) && v >= 1 ? v : 3;
}

/** 归一化命令：折叠空白 + trim。**不做变量泛化**（安全：只学"同一条"命令）。 */
export function normalizeCmd(cmd: string): string {
  return cmd.trim().replace(/\s+/g, ' ');
}

/** 最灾难/不可逆命令：即便批准多次也**永不学习放行**，每次都弹卡。 */
export function isNeverLearn(cmd: string): boolean {
  return (
    /\brm\s+-[a-z]*[rf][a-z]*\s+(?:-\S+\s+)*[~/](?:\s|$)/i.test(cmd) || // rm -rf / 或 ~
    /\bmkfs\b|\bdiskutil\s+(?:erase|reformat)/i.test(cmd) ||
    /\bdd\b[^\n]*\bof=\/dev\//i.test(cmd) ||
    /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(cmd) // fork bomb
  );
}

export interface LearnedEntry {
  approvals: number;
  denied: boolean;
  lastAt: number;
  sample: string;
}

/** 纯判定：该 entry 是否已达到自动放行条件。 */
export function decideAutoAllow(
  entry: LearnedEntry | undefined,
  cmd: string,
  thresholdN: number,
): boolean {
  if (isNeverLearn(cmd)) return false;
  if (!entry || entry.denied) return false;
  return entry.approvals >= thresholdN;
}

type Store = Record<string, LearnedEntry>;
function loadStore(): Store {
  try {
    if (existsSync(STORE_FILE)) return JSON.parse(readFileSync(STORE_FILE, 'utf8')) as Store;
  } catch {
    /* ignore */
  }
  return {};
}
function saveStore(s: Store): void {
  try {
    mkdirSync(dirname(STORE_FILE), { recursive: true });
    writeFileSync(STORE_FILE, JSON.stringify(s, null, 2) + '\n', 'utf8');
  } catch (e) {
    logger.warn('learned-allow 持久化失败', { err: (e as Error).message });
  }
}

/** 该命令是否已学习为"自动放行"。 */
export function isLearnedAllowed(cmd: string): boolean {
  const key = normalizeCmd(cmd);
  return decideAutoAllow(loadStore()[key], cmd, threshold());
}

/** 记一次决定：approved → approvals+1；rejected → denied=true（永不再自动放行该命令）。 */
export function recordDecision(cmd: string, approved: boolean): void {
  if (isNeverLearn(cmd)) return; // 灾难命令不进学习库
  const key = normalizeCmd(cmd);
  const store = loadStore();
  const e = store[key] ?? { approvals: 0, denied: false, lastAt: 0, sample: cmd.slice(0, 200) };
  if (approved) e.approvals += 1;
  else e.denied = true;
  e.lastAt = Date.now();
  store[key] = e;
  saveStore(store);
}

/** 学习进度：给审批卡展示"已批准 N 次，再 M 次将自动放行"。 */
export function learnedProgress(cmd: string): { approvals: number; threshold: number; remaining: number } | null {
  if (isNeverLearn(cmd)) return null;
  const t = threshold();
  const e = loadStore()[normalizeCmd(cmd)];
  const approvals = e && !e.denied ? e.approvals : 0;
  return { approvals, threshold: t, remaining: Math.max(0, t - approvals) };
}

/** 清空所有学习放行（/perm-reset）。返回清掉的条数。 */
export function clearLearned(): number {
  const n = Object.keys(loadStore()).length;
  saveStore({});
  return n;
}
