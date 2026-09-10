/**
 * 纯逻辑：给定 package.json 的 scripts，决定跑什么。无 I/O，可单测。
 */
import type { BootCheckPlan, BootCheckStep, PackageManager } from './types.js';

/**
 * 项目自备的「加载期冒烟」脚本名，按优先级。`check:boot` 是本项目推的统一约定名，
 * 其余是已经存在于各仓库的历史命名（pivotal 用 check:schema）。
 */
export const BOOT_SMOKE_SCRIPTS = [
  'check:boot',
  'check:schema',
  'check:startup',
  'smoke',
] as const;

/** 纯静态检查（能挡语法/类型错，挡不住装配期崩溃）。 */
export const STATIC_SCRIPTS = ['typecheck'] as const;

/** 没有冒烟脚本时的退化选项——build 至少能挡编译错。 */
export const FALLBACK_STATIC_SCRIPTS = ['build'] as const;

/**
 * 所有「可能被自动执行」的 script 名 —— 白名单指纹只对这些取 hash（allowlist.ts 用）。
 * 与真正会执行的集合**同源**：这里少列一个，就会出现「内容变了但指纹没变」的盲区。
 */
export const ALL_KNOWN_SCRIPTS: readonly string[] = [
  ...STATIC_SCRIPTS,
  ...BOOT_SMOKE_SCRIPTS,
  ...FALLBACK_STATIC_SCRIPTS,
];

function runPrefix(pm: PackageManager): string {
  // yarn 1.x 没有 `run --silent` 的等价写法，直接 `yarn run`
  return pm === 'yarn' ? 'yarn run' : `${pm} run --silent`;
}

/** 把 script 名变成可执行命令。 */
export function scriptCommand(pm: PackageManager, script: string): string {
  return `${runPrefix(pm)} ${script}`;
}

/**
 * 发现顺序：静态检查（typecheck）→ 项目自备冒烟脚本 → 都没有则退化到 build。
 *
 * 刻意**不做**「通用地起一次进程」兜底：那在 env 来自 K8s 的服务上会因连不上 DB/MQ
 * 退出而判假 FAIL（见 types.ts 开头）。缺冒烟脚本时如实说「未做加载期冒烟」，
 * 而不是假装验证过——这正是评审门门 1 第 4 条要的行为。
 */
export function planBootCheck(
  scripts: Record<string, string> | undefined,
  pm: PackageManager = 'npm',
): BootCheckPlan {
  const s = scripts ?? {};
  const has = (name: string) => typeof s[name] === 'string' && s[name]!.trim() !== '';
  const steps: BootCheckStep[] = [];

  for (const name of STATIC_SCRIPTS) {
    if (has(name)) steps.push({ script: name, command: scriptCommand(pm, name), kind: 'static' });
  }

  const smoke = BOOT_SMOKE_SCRIPTS.find((name) => has(name));
  if (smoke) {
    steps.push({ script: smoke, command: scriptCommand(pm, smoke), kind: 'boot-smoke' });
  } else {
    const fallback = FALLBACK_STATIC_SCRIPTS.find((name) => has(name));
    if (fallback) {
      steps.push({ script: fallback, command: scriptCommand(pm, fallback), kind: 'static' });
    }
  }

  const hasBootSmoke = steps.some((st) => st.kind === 'boot-smoke');
  return { steps, hasBootSmoke, note: buildNote(steps, hasBootSmoke, smoke) };
}

function buildNote(
  steps: BootCheckStep[],
  hasBootSmoke: boolean,
  smoke: string | undefined,
): string {
  if (hasBootSmoke) {
    const others = steps.filter((s) => s.kind === 'static').map((s) => s.script);
    const extra = others.length ? `（另跑了静态检查：${others.join(' / ')}）` : '';
    return `加载期冒烟：${smoke}${extra}`;
  }
  if (steps.length) {
    const names = steps.map((s) => s.script).join(' / ');
    return (
      `未做加载期冒烟：本仓库没有 ${BOOT_SMOKE_SCRIPTS.join(' / ')} 脚本，只跑了静态检查（${names}）。` +
      `静态检查挡不住「装配期崩溃」（resolver 与 schema 不匹配、注册表校验失败、顶层 throw 这类）。` +
      `建议加一个 check:boot：让改动过的模块真被组装一次，并在里面把 DB/MQ 等外部连接短路。`
    );
  }
  return (
    `未做机器验证：package.json 的 scripts 里没有 ${[...STATIC_SCRIPTS, ...BOOT_SMOKE_SCRIPTS, ...FALLBACK_STATIC_SCRIPTS].join(' / ')} 任何一个可跑。` +
    `交付时要如实写「未做机器验证：原因」，别默默省略。`
  );
}
