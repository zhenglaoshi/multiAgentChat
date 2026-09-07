import { spawn } from 'node:child_process';
import { runScript } from './applescript.js';

/**
 * 宿主(macOS)授权自检 —— **单一事实源**。
 *
 * 本项目控 Terminal.app + 注入按键，依赖三个**相互独立**的 macOS TCC 授权：
 *   1. Automation → Terminal.app     （发 Apple Events 控 Terminal）
 *   2. Automation → System Events     （发 Apple Events 给 System Events，按键注入的前置）
 *   3. Accessibility(辅助功能)         （System Events 真发按键 / 读 UI 元素）
 *
 * ⚠ 授权**授给谁**取决于运行模式：`npm run dev`(tsx watch in Terminal) 授给 **Terminal.app**；
 *   launchd 托管 授给 **node**(process.execPath)。两套身份不互通 —— 这是"Automation 给了但
 *   Accessibility 没给 → doctor 假绿、关 tab/回车静默失败"这类坑的根因。
 *
 * doctor / 启动探针 / 文档都从这里取，别再各写一份 osascript。
 */

export type HostPermissionId = 'automation-terminal' | 'automation-system-events' | 'accessibility';

export interface HostPermissionSpec {
  id: HostPermissionId;
  /** 简短名（告警/doctor 标题用） */
  name: string;
  /** 在 macOS 哪里授 */
  macLocation: string;
  /** critical = 缺了核心功能全废 */
  severity: 'critical' | 'important';
  /** 缺了会废哪些功能（人话，逐条，直接进告警/文档） */
  affects: string[];
  /** 授权步骤（dev / launchd 两种模式通用） */
  grantSteps: string[];
}

/** launchd 模式下要授权的 node 真实路径（dev 模式则是 Terminal.app）。 */
const NODE_PATH = process.execPath;

export const HOST_PERMISSION_SPECS: HostPermissionSpec[] = [
  {
    id: 'automation-terminal',
    name: 'Automation → Terminal.app',
    macLocation: '系统设置 → 隐私与安全性 → 自动化',
    severity: 'critical',
    affects: [
      '列出 / 查看所有 Terminal tab',
      '给 tab 发命令（do script）—— 飞书发的任务根本进不去',
      '开新 tab / 按目录打开',
      '读取 tab 输出（任务进度回传全废）',
    ],
    grantSteps: [
      '打开「系统设置 → 隐私与安全性 → 自动化」',
      `找到运行 daemon 的进程条目（dev 模式=Terminal.app；launchd 模式=node）`,
      '展开它，勾选下面的「Terminal」',
      '重启 daemon：launchctl kickstart -k gui/$(id -u)/com.multiagent-chat.daemon（dev 模式则重跑 npm run dev）',
    ],
  },
  {
    id: 'automation-system-events',
    name: 'Automation → System Events',
    macLocation: '系统设置 → 隐私与安全性 → 自动化',
    severity: 'critical',
    affects: [
      '与 System Events 通信 —— 所有按键注入的前置',
      '缺了 Ctrl-C 解卡 / 关 tab / Esc 关菜单全部报 -1743 失败（回车提交与选项作答默认走 pty 直写，不受影响）',
    ],
    grantSteps: [
      '打开「系统设置 → 隐私与安全性 → 自动化」',
      '找到运行 daemon 的进程条目（dev=Terminal.app / launchd=node），展开',
      '勾选下面的「System Events」',
      '重启 daemon：launchctl kickstart -k gui/$(id -u)/com.multiagent-chat.daemon',
    ],
  },
  {
    id: 'accessibility',
    name: 'Accessibility（辅助功能）',
    macLocation: '系统设置 → 隐私与安全性 → 辅助功能',
    severity: 'critical',
    affects: [
      '飞书发给 claude 的命令能**自动回车提交**（否则停在命令行不执行）',
      'Ctrl-C 取消任务 / 优雅退出 agent',
      '关闭 tab（Cmd-W）',
      '重启所有 claude tab',
    ],
    grantSteps: [
      '打开「系统设置 → 隐私与安全性 → 辅助功能」',
      `点左下「+」添加运行 daemon 的进程：dev 模式=Terminal.app；launchd 模式=node（${NODE_PATH}）`,
      '确保它的开关是**打开**的',
      '重启 daemon：launchctl kickstart -k gui/$(id -u)/com.multiagent-chat.daemon',
    ],
  },
];

export function getHostPermissionSpec(id: HostPermissionId): HostPermissionSpec {
  return HOST_PERMISSION_SPECS.find((s) => s.id === id)!;
}

export interface HostPermissionStatus {
  id: HostPermissionId;
  granted: boolean;
  /** AppleScript error number（诊断用；-1743=Automation 被拒，-25211/1002=Accessibility 被拒） */
  errNum?: number;
  /** 原始 stderr / 返回片段（诊断用，截断 200） */
  raw?: string;
}

/** 从 osascript stderr / 返回串里抠 AppleScript error number，形如 "...(-1743)"。 */
function parseErrNum(s: string): number | undefined {
  const m = /\((-?\d+)\)/.exec(s);
  return m ? Number(m[1]) : undefined;
}

/**
 * 探测 Automation → Terminal.app。
 * `count of windows` 是只读、副作用无害。被拒 → osascript 非零退出，stderr 带 -1743 / "not authorized"。
 */
async function probeAutomationTerminal(): Promise<HostPermissionStatus> {
  const r = await runScript('tell application "Terminal" to return (count of windows) as string');
  if (r.code === 0) return { id: 'automation-terminal', granted: true };
  const raw = (r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 200);
  return { id: 'automation-terminal', granted: false, ...(parseErrNum(raw) !== undefined ? { errNum: parseErrNum(raw) } : {}), raw };
}

/**
 * 探测 Automation → System Events。
 * 读 frontmost 进程 `name`（只需 Automation，不需 Accessibility）—— 专门隔离出 SE 通信这一层。
 */
async function probeAutomationSystemEvents(): Promise<HostPermissionStatus> {
  const r = await runScript(
    'tell application "System Events" to return (name of first application process whose frontmost is true)',
  );
  if (r.code === 0 && r.stdout.trim().length > 0) return { id: 'automation-system-events', granted: true };
  const raw = (r.stderr || r.stdout || `exit ${r.code}`).trim().slice(0, 200);
  return { id: 'automation-system-events', granted: false, ...(parseErrNum(raw) !== undefined ? { errNum: parseErrNum(raw) } : {}), raw };
}

/**
 * 探测 Accessibility(辅助功能)。**副作用无害** —— 绝不发按键。
 * 读 frontmost 进程的 `windows`(UI 元素)**需要 AX 授权**，而读 `name` 不需要；这正是
 * doctor 原来漏检的关键差异。被拒 → AppleScript error -25211 / 1002（"not allowed assistive access"
 * / "not allowed to send keystrokes"）。若 SE 的 Automation 也没授，这里会拿到 -1743（级联症状）。
 */
const ACCESSIBILITY_PROBE = `
tell application "System Events"
  try
    set p to first application process whose frontmost is true
    set _cnt to count of windows of p
    return "ok"
  on error e number n
    return "err:" & n
  end try
end tell
`;

async function probeAccessibility(): Promise<HostPermissionStatus> {
  const r = await runScript(ACCESSIBILITY_PROBE);
  const out = r.stdout.trim();
  if (r.code === 0 && out === 'ok') return { id: 'accessibility', granted: true };
  const raw = (out || r.stderr || `exit ${r.code}`).trim().slice(0, 200);
  return { id: 'accessibility', granted: false, ...(parseErrNum(raw) !== undefined ? { errNum: parseErrNum(raw) } : {}), raw };
}

/**
 * 跑全部三个探针（串行 —— osascript 并行在 tsx 下偶发 ETIMEDOUT）。绝不产生副作用。
 * 返回顺序与 HOST_PERMISSION_SPECS 一致。
 */
export async function detectHostPermissions(): Promise<HostPermissionStatus[]> {
  return [
    await probeAutomationTerminal(),
    await probeAutomationSystemEvents(),
    await probeAccessibility(),
  ];
}

/**
 * 在 Mac 上一键跳到对应授权面板（用户到电脑旁鼠标点勾选即可）。
 * TCC 授权无法用命令直接授予（系统安全设计），能做的极限就是把面板打开到位。
 * fire-and-forget，不等结果。
 */
export function openPermissionPane(pane: 'accessibility' | 'automation'): void {
  const url =
    pane === 'accessibility'
      ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
      : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation';
  try {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* ignore —— 打不开面板不致命 */
  }
}
