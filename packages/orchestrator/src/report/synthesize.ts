import { spawn } from 'node:child_process';
import { logger } from '../logger.js';
import type { CollectedWork, ReportWindow } from './collect.js';

const CLAUDE_TIMEOUT_MS = 180_000; // claude -p 冷启动可能慢

const WINDOW_LABEL: Record<ReportWindow, string> = { day: '日报', week: '周报', month: '月报', year: '年报' };

/** 把采集数据拼成给 claude 的合成 prompt（要求输出 markdown 简报）。 */
export function buildBriefPrompt(data: CollectedWork): string {
  const label = WINDOW_LABEL[data.window];
  // git 提交按 repo 分组
  const byRepo = new Map<string, string[]>();
  for (const c of data.commits) {
    const arr = byRepo.get(c.repo) ?? [];
    arr.push(`${c.date} ${c.subject}`);
    byRepo.set(c.repo, arr);
  }
  const commitBlock = byRepo.size
    ? [...byRepo.entries()].map(([repo, cs]) => `【${repo}】(${cs.length})\n${cs.map((s) => '  - ' + s).join('\n')}`).join('\n')
    : '（无 git 提交）';
  const taskBlock = data.tasks.length
    ? data.tasks.slice(0, 40).map((t) => `  - ${t.prompt.slice(0, 80)}${t.summary ? ` → ${t.summary.slice(0, 80)}` : ''}`).join('\n')
    : '（无）';

  return [
    `你是我的工作总结助手。基于下面「${data.sinceLabel} ~ ${data.untilLabel}」我的真实工作数据，写一份**${label}简报**。`,
    ``,
    `# git 提交（按仓库分组，${data.commits.length} 条）`,
    commitBlock,
    ``,
    `# 通过助手跑过的任务（${data.tasks.length} 条）`,
    taskBlock,
    ``,
    `要求：`,
    `- 输出**中文 markdown**，简洁（${label}是简报，别啰嗦）。`,
    `- 结构：## ${label}（${data.sinceLabel}~${data.untilLabel}）→ **主要工作**（按项目/主题归纳，不要逐条罗列 commit，提炼成几件事）→ **产出/进展**（关键成果、数字）→ **遗留/下一步**（若能看出）。`,
    `- 只根据上面数据，别编造；数据少就如实简短。`,
    `- 直接输出 markdown 正文，不要前言/解释/代码围栏。`,
  ].join('\n');
}

/** spawn claude -p 合成简报，返回 markdown。 */
export function synthesizeBrief(data: CollectedWork): Promise<string> {
  const prompt = buildBriefPrompt(data);
  return new Promise((resolveP, rejectP) => {
    const p = spawn('claude', ['-p', prompt, '--max-turns', '1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // 标记内部会话 → Stop hook 跳过，不把这次合成输出泄漏到飞书
      env: { ...process.env, MCHAT_INTERNAL_SESSION: '1' },
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => { p.kill('SIGTERM'); rejectP(new Error('claude timeout')); }, CLAUDE_TIMEOUT_MS);
    p.on('error', (e) => { clearTimeout(timer); rejectP(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { rejectP(new Error(`claude exit ${code}: ${stderr.slice(0, 200)}`)); return; }
      const md = stdout.trim().replace(/^```(?:markdown|md)?\n?/i, '').replace(/\n?```$/i, '').trim();
      if (!md) { rejectP(new Error('claude 空输出')); return; }
      resolveP(md);
    });
  });
}

/** 采集 + 合成的便捷入口（日/周报）。 */
export async function generateBrief(
  collect: () => Promise<CollectedWork>,
): Promise<{ markdown: string; data: CollectedWork }> {
  const data = await collect();
  const markdown = await synthesizeBrief(data);
  logger.info('report brief generated', { window: data.window, commits: data.commits.length, tasks: data.tasks.length });
  return { markdown, data };
}
