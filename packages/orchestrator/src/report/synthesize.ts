import { spawn } from 'node:child_process';
import { logger } from '../logger.js';
import type { CollectedWork, ReportWindow } from './collect.js';
import { renderReportPptx, type ReportDoc } from './render-pptx.js';

const CLAUDE_TIMEOUT_MS = 180_000; // claude -p 冷启动可能慢

const WINDOW_LABEL: Record<ReportWindow, string> = { day: '日报', week: '周报', month: '月报', year: '年报' };

/** 把未提交改动拼成给 claude 的文本块。 */
function uncommittedBlockOf(data: CollectedWork): string {
  if (!data.uncommitted.length) return '（无未提交改动）';
  return data.uncommitted
    .map((u) => {
      const sample = u.files.slice(0, 8).join(', ');
      return `【${u.repo}@${u.branch || '?'}】未提交 ${u.count} 处：${sample}${u.count > 8 ? ' …' : ''}`;
    })
    .join('\n');
}

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
    ? data.tasks.slice(0, 40).map((t) => `  - ${t.prompt.slice(0, 80)}${t.summary ? ` → ${t.summary.slice(0, 200)}` : ''}`).join('\n')
    : '（无）';
  const uncommittedBlock = uncommittedBlockOf(data);

  return [
    `你是我的工作总结助手。基于下面「${data.sinceLabel} ~ ${data.untilLabel}」我的真实工作数据，写一份**${label}简报**。`,
    ``,
    `# git 提交（按仓库分组，${data.commits.length} 条）`,
    commitBlock,
    ``,
    `# 未提交改动（进行中、尚未 commit，${data.uncommitted.length} 个仓库）`,
    uncommittedBlock,
    ``,
    `# 通过助手跑过的任务（${data.tasks.length} 条）`,
    taskBlock,
    ``,
    `要求（这份发到手机飞书看，务必**手机端易读**）：`,
    `- **主要工作用阿拉伯数字编号**「1. 2. 3.」，**每条独立一行**，以加粗的项目/主题开头，后跟一句话说清做了啥，别写成大段落。`,
    `- 每行尽量短（手机一屏看得全）；**不要用表格、不要多级缩进/嵌套列表**。`,
    `- 结构固定三段、段名加粗：**主要工作**（1. 2. 3. 逐条，按项目/主题归纳，不要逐条罗列 commit）→ **产出/进展**（关键成果/数字，短横线即可）→ **遗留/下一步**（若能看出）。`,
    `- 「未提交改动」是还没 commit 的活，算**进行中**：在对应条目标注「进行中/未提交」，别当已完成产出。`,
    `- 只根据上面数据，别编造；数据少就如实简短。`,
    `- 顶部标题保留 \`## ${label}（${data.sinceLabel}~${data.untilLabel}）\`。直接输出中文 markdown 正文，不要前言/解释/代码围栏。`,
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

// ================= P2 · 月报/年报 PPT =================

interface ReportSections { sections: { heading: string; bullets: string[] }[] }

/** 结构化合成 prompt：要求 claude 输出 JSON（分节 + bullets），供 PPT 分页渲染。 */
function buildStructuredPrompt(data: CollectedWork): string {
  const label = WINDOW_LABEL[data.window];
  const byRepo = new Map<string, string[]>();
  for (const c of data.commits) {
    const arr = byRepo.get(c.repo) ?? []; arr.push(`${c.date} ${c.subject}`); byRepo.set(c.repo, arr);
  }
  const commitBlock = byRepo.size
    ? [...byRepo.entries()].map(([r, cs]) => `【${r}】(${cs.length})\n${cs.slice(0, 60).map((s) => '  - ' + s).join('\n')}`).join('\n')
    : '（无 git 提交）';
  const taskBlock = data.tasks.length
    ? data.tasks.slice(0, 60).map((t) => `  - ${t.prompt.slice(0, 80)}${t.summary ? ` → ${t.summary.slice(0, 160)}` : ''}`).join('\n')
    : '（无）';
  const uncommittedBlock = uncommittedBlockOf(data);
  return [
    `你是我的工作总结助手。基于「${data.sinceLabel} ~ ${data.untilLabel}」我的真实工作数据，生成一份 **${label}** 的分节内容，用于做 PPT。`,
    ``,
    `# git 提交（按仓库，${data.commits.length} 条）`, commitBlock,
    ``, `# 未提交改动（进行中，${data.uncommitted.length} 个仓库）`, uncommittedBlock,
    ``, `# 助手任务（${data.tasks.length} 条）`, taskBlock,
    ``,
    `输出**严格 JSON**（不要任何解释/markdown 围栏），schema：`,
    `{"sections":[{"heading":"章节名","bullets":["要点1","要点2"]}]}`,
    `建议章节：主要工作（按项目/主题归纳成几件事，不要逐条 commit）、关键成果（含数字）、亮点/难点、遗留与下一步（未提交改动算进行中，放这里）。`,
    `每章节 3-8 个 bullet，中文，简练。只根据上面数据，别编造。`,
  ].join('\n');
}

function synthesizeStructured(data: CollectedWork): Promise<ReportSections> {
  const prompt = buildStructuredPrompt(data);
  return new Promise((resolveP, rejectP) => {
    const p = spawn('claude', ['-p', prompt, '--max-turns', '1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MCHAT_INTERNAL_SESSION: '1' },
    });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => { p.kill('SIGTERM'); rejectP(new Error('claude timeout')); }, CLAUDE_TIMEOUT_MS);
    p.on('error', (e) => { clearTimeout(timer); rejectP(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) { rejectP(new Error(`claude exit ${code}: ${stderr.slice(0, 200)}`)); return; }
      const a = stdout.indexOf('{'); const b = stdout.lastIndexOf('}');
      if (a < 0 || b <= a) { rejectP(new Error('claude 无 JSON 输出: ' + stdout.slice(0, 150))); return; }
      try {
        const j = JSON.parse(stdout.slice(a, b + 1)) as ReportSections;
        if (!Array.isArray(j.sections)) throw new Error('缺 sections');
        resolveP(j);
      } catch (e) { rejectP(new Error('JSON 解析失败: ' + (e as Error).message)); }
    });
  });
}

/** 采集 + 结构化合成 + pptxgenjs 渲染 → .pptx 路径（月/年报）。 */
export async function generatePptxReport(
  collect: () => Promise<CollectedWork>,
  outPath: string,
  author?: string,
): Promise<{ path: string; data: CollectedWork }> {
  const data = await collect();
  const struct = await synthesizeStructured(data);
  const repos = new Set(data.commits.map((c) => c.repo));
  const doc: ReportDoc = {
    title: `${data.sinceLabel.slice(0, data.window === 'year' ? 4 : 7)} ${WINDOW_LABEL[data.window]}`,
    period: `${data.sinceLabel} ~ ${data.untilLabel}`,
    stats: [
      { label: 'git 提交', value: String(data.commits.length) },
      { label: '涉及仓库', value: String(repos.size) },
      { label: '助手任务', value: String(data.tasks.length) },
    ],
    sections: struct.sections,
  };
  if (author) doc.author = author;
  await renderReportPptx(doc, outPath);
  logger.info('report pptx generated', { window: data.window, path: outPath, sections: struct.sections.length });
  return { path: outPath, data };
}
