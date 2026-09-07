import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { detectHostPermissions, detectLidAwake, getHostPermissionSpec, LID_AWAKE_INSTALL_CMD } from 'multiagent-host-mac';

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
  if (major >= 22) {
    return { name: 'Node ≥ 22', severity: 'critical', status: 'pass', message: `${process.version}` };
  }
  return {
    name: 'Node ≥ 22',
    severity: 'critical',
    status: 'fail',
    message: `${process.version} 太老`,
    hint: '装 Node 22+：nvm install 22 && nvm use 22',
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

/**
 * macOS 授权自检（三项独立 TCC：Automation→Terminal / Automation→System Events / Accessibility）。
 * 走 host-mac 的 detectHostPermissions（单一事实源，副作用无害）。
 *
 * ⚠ 这修掉了老版本的假绿坑：老的「AppleScript 权限」只读了进程 name（仅需 Automation），
 *   从不碰按键/UI（需 Accessibility），于是 Automation 给了、Accessibility 没给时全绿，
 *   但关 tab / 回车提交其实是坏的。现在 Accessibility 单独一条、被拒即 fail。
 */
async function runHostPermissions(): Promise<DoctorResult[]> {
  if (platform() !== 'darwin') {
    return [{ name: 'macOS 授权', severity: 'critical', status: 'skip', message: '非 macOS' }];
  }
  const statuses = await detectHostPermissions();
  return statuses.map((s) => {
    const spec = getHostPermissionSpec(s.id);
    if (s.granted) {
      return { name: spec.name, severity: spec.severity, status: 'pass' as const, message: '已授权' };
    }
    return {
      name: spec.name,
      severity: spec.severity,
      status: 'fail' as const,
      message: `未授权${s.errNum !== undefined ? `（错误 ${s.errNum}）` : ''}`,
      hint: `${spec.macLocation}；授给谁：dev=Terminal.app / launchd=node，授完重启 daemon`,
      detail: `影响：${spec.affects.join('；')}`,
    };
  });
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
    hint: 'daemon 应该自动 spawn；如没有，先 pkill tsx + 重启 pnpm dev。合盖睡眠见下一项「合盖远程」',
  };
}

/**
 * 「插电合盖也能远程」守护（`sudo scripts/lid-awake.sh install` 装的 root LaunchDaemon）：
 * 插电 → pmset disablesleep 1（合盖只灭屏锁屏、不睡），拔电 → 0（恢复默认）。
 * 只读检查：plist 在不在 + 当前 SleepDisabled（只在 `pmset -g` 里）+ 电源来源。
 *  - 装了 → pass
 *  - 没装但 SleepDisabled=1（手动 `pmset -a disablesleep 1`）→ warn：拔电放包里也不睡
 *  - 没装 → warn 带装法
 */
async function runLidAwake(): Promise<DoctorResult> {
  const name = '合盖远程 (插电不睡)';
  if (platform() !== 'darwin') {
    return { name, severity: 'optional', status: 'skip', message: '非 macOS' };
  }
  const st = await detectLidAwake();
  const sd = st.sleepDisabled === null ? '?' : st.sleepDisabled ? '1' : '0';
  const state = `电源=${st.powerSource} SleepDisabled=${sd}`;
  if (!st.isLaptop) {
    return { name, severity: 'optional', status: 'skip', message: `台式机 / 无内置电池，不存在合盖问题（${state}）` };
  }
  if (st.installed) {
    if (!st.running) {
      return {
        name,
        severity: 'optional',
        status: 'warn',
        message: `守护 plist 在，但 launchd 里没在跑（${state}）—— 合盖照样会睡`,
        hint: `重装一次：${LID_AWAKE_INSTALL_CMD}；或 scripts/lid-awake.sh status 看日志`,
      };
    }
    if (st.powerSource === 'ac' && st.sleepDisabled === false) {
      return {
        name,
        severity: 'optional',
        status: 'warn',
        message: `守护在跑，但插电状态下 SleepDisabled 还是 0（${state}）—— 可能刚插电不到 10s，稍后再查`,
        hint: 'scripts/lid-awake.sh log 看守护是否报 pmset 失败',
      };
    }
    if (st.powerSource === 'battery' && st.sleepDisabled === true) {
      return {
        name,
        severity: 'optional',
        status: 'warn',
        message: `守护在跑，但用电池时 SleepDisabled 还是 1（${state}）—— 该恢复默认睡眠却没恢复，放包里会不睡`,
        hint: 'scripts/lid-awake.sh log 看 pmset -a disablesleep 0 是否反复失败；应急：sudo pmset -a disablesleep 0',
      };
    }
    return {
      name,
      severity: 'optional',
      status: 'pass',
      message: `守护在跑：插电合盖不睡 / 拔电恢复默认（${state}）`,
    };
  }
  if (sd === '1') {
    return {
      name,
      severity: 'optional',
      status: 'warn',
      message: `全局 disablesleep=1，但没装随电源自动切换的守护（${state}）`,
      hint: `拔电放包里也不会睡（发热耗电）→ ${LID_AWAKE_INSTALL_CMD}（插电才禁睡），或 sudo pmset -a disablesleep 0`,
    };
  }
  return {
    name,
    severity: 'optional',
    status: 'warn',
    message: `未装（${state}）—— 合盖即睡、Wi-Fi 断，手机发的命令收不到`,
    hint: `${LID_AWAKE_INSTALL_CMD}（插电合盖不睡；拔电自动恢复默认睡眠）`,
  };
}

/**
 * 企业微信 transport 健康检查。缺 env 不算 fail，只是 skip（因为企微是可选 IM）。
 * 有 env 时试拉一次 access_token 验证凭证。
 */
async function runWeCom(): Promise<DoctorResult[]> {
  const corpId = process.env['WECOM_CORP_ID'];
  const agentId = process.env['WECOM_AGENT_ID'];
  const secret = process.env['WECOM_SECRET'];
  const token = process.env['WECOM_TOKEN'];
  const aesKey = process.env['WECOM_AES_KEY'];
  const port = Number(process.env['WECOM_CALLBACK_HTTP_PORT'] ?? '3939');
  const callbackUrl = process.env['WECOM_CALLBACK_URL'];

  const has = { corpId: !!corpId, agentId: !!agentId, secret: !!secret, token: !!token, aesKey: !!aesKey };
  const allSet = has.corpId && has.agentId && has.secret && has.token && has.aesKey;

  const results: DoctorResult[] = [];

  if (!allSet) {
    const missing = Object.entries(has).filter(([, v]) => !v).map(([k]) => k);
    results.push({
      name: '企业微信 transport',
      severity: 'optional',
      status: 'skip',
      message: `未 attach（缺 ${missing.join('/')} 中的一项或多项）`,
      hint: '若要启用企微，看 docs/wecom-bot-setup.md',
    });
    return results;
  }

  // 尝试拉 token 验证凭证
  try {
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId!)}&corpsecret=${encodeURIComponent(secret!)}`;
    const resp = await fetch(url);
    const data = (await resp.json()) as { errcode?: number; errmsg?: string; access_token?: string };
    if (data.errcode === 0 && data.access_token) {
      results.push({
        name: '企业微信 access_token',
        severity: 'important',
        status: 'pass',
        message: `凭证有效（corpId=${corpId!.slice(0, 6)}…, agentId=${agentId}）`,
      });
    } else {
      results.push({
        name: '企业微信 access_token',
        severity: 'important',
        status: 'fail',
        message: `errcode=${data.errcode} errmsg=${data.errmsg}`,
        hint: '检查 WECOM_CORP_ID / WECOM_SECRET；确认应用「可见范围」包含你自己',
      });
    }
  } catch (e) {
    results.push({
      name: '企业微信 access_token',
      severity: 'important',
      status: 'fail',
      message: `获取失败: ${(e as Error).message}`,
      hint: '检查网络 / 凭证；企微 API 白名单？',
    });
  }

  // callback URL 可达性（optional）
  if (callbackUrl) {
    try {
      const resp = await fetch(callbackUrl, { method: 'GET' });
      // 无 signature 时 daemon 应返回 400/401，这算"能访问到"
      const ok = resp.status === 400 || resp.status === 401 || resp.status === 200;
      results.push({
        name: '企业微信 tunnel URL',
        severity: 'optional',
        status: ok ? 'pass' : 'warn',
        message: `${callbackUrl} → HTTP ${resp.status}`,
      });
    } catch (e) {
      results.push({
        name: '企业微信 tunnel URL',
        severity: 'optional',
        status: 'warn',
        message: `${callbackUrl} 访问失败: ${(e as Error).message}`,
        hint: 'tunnel（cloudflared/ngrok）是否还在跑？',
      });
    }
  }

  results.push({
    name: '企业微信 receiver port',
    severity: 'optional',
    status: 'pass',
    message: `准备监听 ${port}（daemon 起来后 event server 会占用）`,
  });

  return results;
}

/**
 * Web dashboard 健康检查 —— 只看 env 有没有配。不实际 curl（daemon 内嵌 server
 * 本进程内不好检测；用户可自己 `curl http://<mac>:<port>/api/tabs?token=<xxx>` 试）
 */
function runWebDashboard(): DoctorResult {
  const token = process.env['WEB_DASHBOARD_TOKEN'];
  const port = process.env['WEB_DASHBOARD_PORT'] ?? '3940';
  if (!token) {
    return {
      name: 'Web dashboard',
      severity: 'optional',
      status: 'skip',
      message: '未启用（缺 WEB_DASHBOARD_TOKEN）',
      hint: '要启用：`openssl rand -hex 32` 生 token，填 .env 里的 WEB_DASHBOARD_TOKEN；手机浏览器打开 http://<mac-name>:' + port + '/#token=<TOKEN>',
    };
  }
  return {
    name: 'Web dashboard',
    severity: 'optional',
    status: 'pass',
    message: `已配置（port=${port}，token 前 4 位 ${token.slice(0, 4)}…）`,
    hint: '手机浏览器打开 http://<mac-name>:' + port + '/#token=<TOKEN>',
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
  results.push(...(await runHostPermissions()));
  results.push(await runSocketAndLark());
  results.push(await runCaffeinate());
  results.push(await runLidAwake());
  results.push(await runSubagents());
  results.push(await runPresets());
  results.push(await runData(repoRoot));
  results.push(...(await runWeCom()));
  results.push(runWebDashboard());
  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const r of results) summary[r.status]++;
  let overall: DoctorReport['overall'];
  if (results.some((r) => r.severity === 'critical' && r.status === 'fail')) overall = 'broken';
  else if (results.some((r) => r.status === 'fail' || (r.severity === 'important' && r.status === 'warn'))) overall = 'degraded';
  else overall = 'healthy';
  return { results, summary, overall };
}
