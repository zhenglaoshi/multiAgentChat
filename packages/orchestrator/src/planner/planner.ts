import { spawn } from 'node:child_process';
import { logger } from '../logger.js';
import type { Plan, PlanContext, PlanStep } from './types.js';

// claude -p 冷启动实测 30-90s，给到 180s（与知识提炼器一致）
const CLAUDE_TIMEOUT_MS = 180_000;

// 内存态计划库（ephemeral：dev 重启清空，可接受——计划确认后即派发）
const plans = new Map<string, Plan>();

export function getPlan(id: string): Plan | undefined {
  return plans.get(id);
}
export function savePlan(plan: Plan): void {
  plans.set(plan.id, plan);
  // 简单容量控制：只留最近 50 个
  if (plans.size > 50) {
    const oldest = [...plans.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) plans.delete(oldest.id);
  }
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function ttyShort(tty: string): string {
  return tty.replace(/^\/dev\//, '');
}

function buildPrompt(goal: string, ctx: PlanContext): string {
  const tabLines = ctx.tabs.length
    ? ctx.tabs.map((t) => `- ${ttyShort(t.tty)}  cwd=${t.cwd ?? '?'}  ${t.title ?? ''}`).join('\n')
    : '（无）';
  const repoLines = ctx.repos.length ? ctx.repos.map((r) => `- ${r}`).join('\n') : '（无）';
  return [
    '你是一个任务规划器，把用户的目标分解成可直接执行的步骤。',
    '',
    `用户目标：${goal}`,
    '',
    '当前可用的终端 tab（每步可建议其一作为执行目标，用 tty 短名如 ttys003）：',
    tabLines,
    '',
    '可用 git 仓库路径：',
    repoLines,
    '',
    '要求：',
    '- 分解成 2-6 个步骤，按执行顺序排列（可有先后依赖）。',
    '- 每个 prompt 是一条可直接发给某个 claude 终端执行的完整中文指令，具体、含足够上下文。',
    "- target 填建议的 tab 短名或仓库名，不确定就留空字符串 ''。",
    '',
    '只输出一个 JSON 对象，不要任何解释 / markdown / 代码围栏：',
    '{"summary":"一句话概述整个计划","steps":[{"title":"步骤简述(≤20字)","target":"ttys003 或 仓库名 或 空","prompt":"完整指令"}]}',
  ].join('\n');
}

/** 从文本里抓第一个平衡的 JSON 对象（简单栈，够用）。 */
function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

function coerceSteps(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanStep[] = [];
  for (const s of raw) {
    const o = s as Record<string, unknown>;
    if (typeof o?.['prompt'] !== 'string' || !o['prompt']) continue;
    out.push({
      title: typeof o['title'] === 'string' && o['title'] ? o['title'] : (o['prompt'] as string).slice(0, 20),
      ...(typeof o['target'] === 'string' && o['target'] ? { target: o['target'] } : {}),
      prompt: o['prompt'] as string,
    });
  }
  return out;
}

/** spawn `claude -p` 把目标分解成计划；解析 JSON，存入内存库，返回 Plan。 */
export function generatePlan(goal: string, ctx: PlanContext): Promise<Plan> {
  const prompt = buildPrompt(goal, ctx);
  return new Promise((resolveP, rejectP) => {
    const p = spawn('claude', ['-p', prompt, '--max-turns', '1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MCHAT_INTERNAL_SESSION: '1' },
    });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => { p.kill('SIGTERM'); rejectP(new Error('claude 规划超时(180s)')); }, CLAUDE_TIMEOUT_MS);
    p.on('error', (e) => { clearTimeout(timer); rejectP(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { rejectP(new Error(`claude exit ${code}: ${stderr.slice(0, 200)}`)); return; }
      const obj = extractJsonObject(stdout) as { summary?: unknown; steps?: unknown } | null;
      if (!obj) { rejectP(new Error('claude 输出里没解析到 JSON：' + stdout.slice(0, 150))); return; }
      const steps = coerceSteps(obj.steps);
      if (steps.length === 0) { rejectP(new Error('计划没有有效步骤')); return; }
      const plan: Plan = {
        id: `plan-${Date.now().toString(36)}-${shortId()}`,
        goal,
        summary: typeof obj.summary === 'string' ? obj.summary : goal,
        steps,
        createdAt: Date.now(),
      };
      savePlan(plan);
      logger.info('plan generated', { id: plan.id, steps: steps.length });
      resolveP(plan);
    });
  });
}
