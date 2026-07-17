import { mkdir, writeFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../logger.js';
import type { Integration } from './registry.js';

/** 技能安装目录：Claude Code = ~/.claude/skills，Codex = ~/.agents/skills（两处都装，跨工具通用）。 */
function skillDirs(name: string): string[] {
  return [
    join(homedir(), '.claude', 'skills', name),
    join(homedir(), '.agents', 'skills', name),
  ];
}

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/** skill 型对接是否已安装：每个技能至少在一处（.claude 或 .agents）有 SKILL.md。 */
export async function skillsInstalled(it: Integration): Promise<boolean> {
  if (!it.skills?.length) return false;
  for (const s of it.skills) {
    const any = (await Promise.all(skillDirs(s.name).map((d) => exists(join(d, 'SKILL.md'))))).some(Boolean);
    if (!any) return false;
  }
  return true;
}

/** 下载安装某 skill 型对接的全部技能（写到 .claude 和 .agents 两处）。 */
export async function installIntegrationSkills(it: Integration): Promise<{ ok: boolean; installed: string[]; failed: string[] }> {
  const installed: string[] = [];
  const failed: string[] = [];
  for (const s of it.skills ?? []) {
    try {
      const res = await fetch(s.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const md = await res.text();
      if (!md.includes('name:')) throw new Error('下载内容异常（无 frontmatter）');
      for (const dir of skillDirs(s.name)) {
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, 'SKILL.md'), md, 'utf8');
      }
      installed.push(s.name);
    } catch (e) {
      logger.warn('install skill failed', { skill: s.name, err: (e as Error).message });
      failed.push(s.name);
    }
  }
  return { ok: failed.length === 0 && installed.length > 0, installed, failed };
}

/** 幂等：缺失才装（daemon 启动用，失败静默，不阻塞）。技能自身带自更新，故只需保证存在。 */
export async function ensureIntegrationSkills(it: Integration): Promise<void> {
  if (!it.skills?.length) return;
  if (await skillsInstalled(it)) return;
  await installIntegrationSkills(it).catch(() => { /* 静默 */ });
}
