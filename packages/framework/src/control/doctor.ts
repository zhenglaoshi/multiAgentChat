import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/** 用 spawn（非 execSync）跑外部命令，避免 tsx 里 execSync spawnSync ETIMEDOUT 坑 */
function runCommand(
  cmd: string,
  args: string[],
  timeoutMs = 5000,
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, error: `timeout ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, stdout: stdout.trim() });
      else resolve({ ok: false, error: stderr.trim() || `exit code ${code}` });
    });
  });
}

export type Severity = 'critical' | 'important' | 'optional';
export type Status = 'pass' | 'warn' | 'fail' | 'skip';

export interface DoctorResult {
  name: string;
  severity: Severity;
  status: Status;
  message: string;
  hint?: string;
  detail?: string;
}

const SOCKET_PATH = process.env['AGENT_SOCKET'] ?? join(homedir(), '.multiagent-chat', 'agent.sock');

function runNode(): DoctorResult {
  const v = process.version.replace(/^v/, '');
  const major = parseInt(v.split('.')[0]!, 10);
  if (major >= 20) {
    return { name: 'Node ≥ 20', severity: 'critical', status: 'pass', message: `${process.version}` };
  }
  return {
    name: 'Node ≥ 20',
    severity: 'critical',
    status: 'fail',
    message: `${process.version} 太老`,
    hint: '装 Node 20+：nvm install 20 && nvm use 20',
  };
}

function runPlatform(): DoctorResult {
  const p = platform();
  if (p === 'darwin') {
    return { name: 'macOS', severity: 'critical', status: 'pass', message: 'darwin' };
  }
  return {
    name: 'macOS',
    severity: 'critical',
    status: 'fail',
    message: `${p} — 目前仅支持 macOS`,
    hint: 'AppleScript / Terminal.app 是 macOS 独占',
  };
}

function runEnvFile(repoRoot: string): DoctorResult {
  const envPath = join(repoRoot, '.env');
  if (!existsSync(envPath)) {
    return {
      name: '.env 文件',
      severity: 'critical',
      status: 'fail',
      message: `不存在：${envPath}`,
      hint: 'cp .env.example .env 然后填 LARK_APP_ID / LARK_APP_SECRET',
    };
  }
  const content = readFileSync(envPath, 'utf8');
  const hasAppId = /^\s*LARK_APP_ID\s*=\s*\S+/m.test(content);
  const hasSecret = /^\s*LARK_APP_SECRET\s*=\s*\S+/m.test(content);
  if (!hasAppId || !hasSecret) {
    return {
      name: '.env 变量',
      severity: 'critical',
      status: 'fail',
      message: `缺 ${!hasAppId ? 'LARK_APP_ID ' : ''}${!hasSecret ? 'LARK_APP_SECRET' : ''}`,
      hint: '飞书开放平台申请自建应用拿到，填 .env',
    };
  }
  return { name: '.env 完整', severity: 'critical', status: 'pass', message: 'LARK_APP_ID + LARK_APP_SECRET 都有' };
}

async function runSocketAndLark(): Promise<DoctorResult> {
  if (!existsSync(SOCKET_PATH)) {
    return {
      name: 'Daemon socket',
      severity: 'important',
      status: 'fail',
      message: `socket 不存在：${SOCKET_PATH}`,
      hint: 'pnpm dev 启动 daemon',
    };
  }
  // try connect + resolve-chat（顺手验 lark client 是否初始化）
  return await new Promise<DoctorResult>((res) => {
    const sock = connect(SOCKET_PATH);
    let buf = '';
    const timeout = setTimeout(() => {
      sock.destroy();
      res({
        name: 'Daemon socket',
        severity: 'important',
        status: 'fail',
        message: 'socket 存在但连接超时',
        hint: 'kill dev + 重启 pnpm dev',
      });
    }, 3000);
    sock.on('connect', () => {
      sock.write(JSON.stringify({ op: 'lark.resolve-chat' }) + '\n');
    });
    sock.on('data', (c) => {
      buf += c.toString();
    });
    sock.on('end', () => {
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(buf.trim()) as { ok: boolean; error?: string; data?: unknown };
        if (parsed.ok) {
          res({
            name: 'Daemon socket + lark client',
            severity: 'important',
            status: 'pass',
            message: 'socket 可通 + lark client 已初始化',
          });
        } else if (parsed.error?.includes('lark client 未初始化')) {
          res({
            name: 'Daemon socket',
            severity: 'important',
            status: 'warn',
            message: 'socket 通但 lark client 未初始化',
            hint: '.env 里 LARK_APP_ID / LARK_APP_SECRET 是否正确？',
          });
        } else {
          res({
            name: 'Daemon socket',
            severity: 'important',
            status: 'warn',
            message: `socket 通但响应异常：${parsed.error ?? 'unknown'}`,
          });
        }
      } catch (e) {
        res({
          name: 'Daemon socket',
          severity: 'important',
          status: 'warn',
          message: `parse 失败：${(e as Error).message}`,
        });
      }
    });
    sock.on('error', (e) => {
      clearTimeout(timeout);
      res({
        name: 'Daemon socket',
        severity: 'important',
        status: 'fail',
        message: `连接失败：${e.message}`,
        hint: 'daemon 可能挂了，pnpm dev 重启',
      });
    });
  });
}

async function runAppleScript(): Promise<DoctorResult> {
  if (platform() !== 'darwin') {
    return { name: 'AppleScript 权限', severity: 'critical', status: 'skip', message: '非 macOS' };
  }
  const r = await runCommand(
    'osascript',
    ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'],
    5000,
  );
  if (r.ok) {
    return {
      name: 'AppleScript 权限',
      severity: 'critical',
      status: 'pass',
      message: `frontmost app: ${r.stdout}`,
    };
  }
  if (r.error.includes('1743') || r.error.includes('not allowed')) {
    return {
      name: 'AppleScript 权限',
      severity: 'critical',
      status: 'fail',
      message: 'osascript 被拒绝',
      hint: 'System Settings → Privacy & Security → Accessibility → 加 Terminal.app / iTerm.app / 跑 dev 的进程 / osascript',
    };
  }
  return {
    name: 'AppleScript 权限',
    severity: 'critical',
    status: 'fail',
    message: `osascript 异常：${r.error.slice(0, 100)}`,
  };
}

async function runTerminalTabs(): Promise<DoctorResult> {
  if (platform() !== 'darwin') {
    return { name: 'Terminal tabs', severity: 'important', status: 'skip', message: '非 macOS' };
  }
  const r = await runCommand(
    'osascript',
    ['-e', 'tell application "Terminal" to return (count of windows) as string'],
    8000,
  );
  if (r.ok) {
    return {
      name: 'Terminal.app 可访问',
      severity: 'important',
      status: 'pass',
      message: 'listTabs OK',
    };
  }
  return {
    name: 'Terminal.app 可访问',
    severity: 'important',
    status: 'warn',
    message: `AppleScript 失败：${r.error.slice(0, 80)}`,
    hint: 'Terminal.app 没开或响应慢；如果 AppleScript 权限那条 pass，一般不影响使用',
  };
}

function runSkill(): DoctorResult {
  const p = join(homedir(), '.claude', 'skills', 'multiagent-lark', 'SKILL.md');
  if (existsSync(p)) {
    return {
      name: 'Skill 已装',
      severity: 'important',
      status: 'pass',
      message: `~/.claude/skills/multiagent-lark/SKILL.md`,
    };
  }
  return {
    name: 'Skill 已装',
    severity: 'important',
    status: 'warn',
    message: '未装',
    hint: 'agent install-skill',
  };
}

async function runSubagents(): Promise<DoctorResult> {
  const dir = join(homedir(), '.claude', 'agents');
  if (!existsSync(dir)) {
    return {
      name: 'Subagent 目录',
      severity: 'optional',
      status: 'warn',
      message: `${dir} 不存在`,
      hint: 'agent subagent add <name> ... 或飞书 /subagent gen <desc>',
    };
  }
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
  return {
    name: 'Subagent 目录',
    severity: 'optional',
    status: files.length > 0 ? 'pass' : 'warn',
    message: `${files.length} 个 subagent`,
    detail: files.length > 0 ? files.slice(0, 6).join(', ') + (files.length > 6 ? '…' : '') : undefined,
  };
}

async function runPresets(): Promise<DoctorResult> {
  const dir = join(homedir(), '.multiagent-chat', 'presets');
  if (!existsSync(dir)) {
    return {
      name: 'Presets 目录',
      severity: 'optional',
      status: 'warn',
      message: `${dir} 不存在（尚未存过任务模板）`,
    };
  }
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  return {
    name: 'Presets 目录',
    severity: 'optional',
    status: 'pass',
    message: `${files.length} 个模板`,
    detail: files.length > 0 ? files.map((f) => f.replace(/\.json$/, '')).slice(0, 6).join(', ') : undefined,
  };
}

async function runData(repoRoot: string): Promise<DoctorResult> {
  const dataDir = join(repoRoot, 'data');
  if (!existsSync(dataDir)) {
    return {
      name: 'Data 目录',
      severity: 'optional',
      status: 'skip',
      message: `${dataDir} 不存在（daemon 还没运行过）`,
    };
  }
  const parts: string[] = [];
  for (const sub of ['tasks', 'memories', 'stage-memories', 'approvals', 'chats']) {
    const p = join(dataDir, sub);
    if (existsSync(p)) {
      try {
        const files = (await readdir(p)).filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'));
        parts.push(`${sub}=${files.length}`);
      } catch {
        parts.push(`${sub}=?`);
      }
    } else {
      parts.push(`${sub}=0`);
    }
  }
  return {
    name: 'Data 持久化',
    severity: 'optional',
    status: 'pass',
    message: parts.join(' / '),
  };
}

async function runPnpm(): Promise<DoctorResult> {
  const r = await runCommand('pnpm', ['--version'], 3000);
  if (r.ok) {
    return { name: 'pnpm', severity: 'important', status: 'pass', message: `v${r.stdout}` };
  }
  return {
    name: 'pnpm',
    severity: 'important',
    status: 'warn',
    message: `没找到：${r.error.slice(0, 80)}`,
    hint: 'npm install -g pnpm（若走 corepack 遇 sig 错，先删 /usr/local/bin/pnpm 再装）',
  };
}

async function runClaudeBin(): Promise<DoctorResult> {
  const r = await runCommand('which', ['claude'], 2000);
  if (r.ok) {
    return { name: 'claude CLI', severity: 'important', status: 'pass', message: r.stdout };
  }
  return {
    name: 'claude CLI',
    severity: 'important',
    status: 'warn',
    message: '没找到 claude 命令',
    hint: '安装 Claude Code（用来在 tab 里跑 subagent）',
  };
}

async function runCaffeinate(): Promise<DoctorResult> {
  if (platform() !== 'darwin') {
    return { name: 'caffeinate (防休眠)', severity: 'optional', status: 'skip', message: '非 macOS' };
  }
  if (process.env['AGENT_NO_CAFFEINATE']) {
    return {
      name: 'caffeinate (防休眠)',
      severity: 'optional',
      status: 'skip',
      message: 'AGENT_NO_CAFFEINATE=1 已关闭',
    };
  }
  // 检查 daemon 是否 spawn 了跟随自己 pid 的 caffeinate
  const r = await runCommand('pgrep', ['-fa', 'caffeinate.*-w'], 2000);
  if (r.ok && r.stdout) {
    return {
      name: 'caffeinate (防休眠)',
      severity: 'optional',
      status: 'pass',
      message: '在跑（daemon 期间 Mac 不 idle sleep）',
      detail: r.stdout.split('\n')[0],
    };
  }
  return {
    name: 'caffeinate (防休眠)',
    severity: 'optional',
    status: 'warn',
    message: '未找到跟随 daemon 的 caffeinate 进程',
    hint: 'daemon 应该自动 spawn；如没有，先 pkill tsx + 重启 pnpm dev。合盖睡眠 macOS 强制，任何软件方案无解',
  };
}

export interface DoctorReport {
  results: DoctorResult[];
  summary: { pass: number; warn: number; fail: number; skip: number };
  overall: 'healthy' | 'degraded' | 'broken';
}

export async function runDoctor(opts: { repoRoot?: string } = {}): Promise<DoctorReport> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  // 串行跑外部命令类（execSync 在 tsx 并行时 ETIMEDOUT 有坑），非命令类可以并行
  const syncChecks = [
    runNode(),
    runPlatform(),
    runEnvFile(repoRoot),
    runSkill(),
  ];
  const results: DoctorResult[] = [...syncChecks];
  results.push(await runPnpm());
  results.push(await runClaudeBin());
  results.push(await runAppleScript());
  results.push(await runTerminalTabs());
  results.push(await runSocketAndLark());
  results.push(await runCaffeinate());
  results.push(await runSubagents());
  results.push(await runPresets());
  results.push(await runData(repoRoot));
  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const r of results) summary[r.status]++;
  let overall: DoctorReport['overall'];
  if (results.some((r) => r.severity === 'critical' && r.status === 'fail')) overall = 'broken';
  else if (results.some((r) => r.status === 'fail' || (r.severity === 'important' && r.status === 'warn'))) overall = 'degraded';
  else overall = 'healthy';
  return { results, summary, overall };
}
