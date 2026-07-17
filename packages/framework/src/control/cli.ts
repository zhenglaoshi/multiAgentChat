import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { argv, cwd as procCwd, exit, stderr, stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import type { ApprovalRequest } from 'multiagent-orchestrator';
import type { TaskState, TaskStatus } from 'multiagent-orchestrator';
import type { TerminalTab } from 'multiagent-host-mac';
import { SOCKET_PATH } from './protocol.js';
import type {
  ApprovalListData,
  ApprovalRequestData,
  ApprovalResolveData,
  ChatGetData,
  LarkAskData,
  LarkResolveChatData,
  LarkSendData,
  TabScreenData,
  TabKeysData,
  WeComSendData,
  WeComResolveChatData,
  Request,
  Response,
  StageRecallData,
  TabCloseData,
  TabRestartClaudeData,
  TapdStageData,
  TabGetData,
  TabHistoryData,
  TabListData,
  TabNewData,
  TabRecentCwdsData,
  TabSendData,
  TaskAbortData,
  TaskGetData,
  TaskListData,
  TaskStageData,
  SubagentAddData,
  SubagentDeleteData,
  SubagentListData,
  SubagentShowData,
} from './protocol.js';

const STATE_FILE = join(homedir(), '.multiagent-chat', 'cli-state.json');

interface CliState {
  currentTty?: string;
}

async function loadState(): Promise<CliState> {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8')) as CliState;
  } catch {
    return {};
  }
}

async function saveState(s: CliState): Promise<void> {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

interface Flags {
  tty?: string;
  cwd?: string;
  lines?: number;
  wait: boolean;
  all: boolean;
  newWindow: boolean;
  title?: string;
  body?: string;
  chat?: string;          // --chat <chat_id>
  name?: string;          // --name (上传文件名 / 或 task stage 名)
  taskId?: string;
  claimId?: string;       // agent tapd stage --claim <id>
  summary?: string;
  artifact?: string;
  note?: string;
  reason?: string;
  action?: 'start' | 'end' | 'fail' | 'skip';
  status?: string;
  gateTimeoutMs?: number;
  here: boolean;
  hard: boolean;
  yes: boolean;           // restart-all-claude-tabs --yes：真执行（否则 dry-run）
  dryRun: boolean;        // restart-all-claude-tabs --dry-run：只列目标
  continueSession: boolean; // restart-all-claude-tabs --continue：续上次会话（默认全新 claude，不带历史）
  includeSelf: boolean;   // restart-all-claude-tabs --include-self：连发起命令的 tab 一起重启
  except?: string;        // restart-all-claude-tabs --except tty1,tty2：额外排除的 tty（csv）
  plain: boolean;         // agent lark send-text --plain：强制纯文本
  auto: boolean;          // agent lark send-text --auto：Stop-hook 等自动推送，daemon 会按 chat.watchAllTabs gate
  originPid?: number;     // agent lark send-text --origin-pid <ppid>：hook 传 Claude Code pid，daemon 反查 tab
  originCwd?: string;     // agent lark send-text --origin-cwd <cwd>：hook 传 Claude Code cwd，反查 fallback
  question: boolean;      // agent lark send-text --question：本次推送含待用户回答的问题，daemon 记 pendingAnswerTty
  optionsJson?: string;   // agent lark send-text --options-json '["是","否"]'：AskUserQuestion 选项 label
  options?: string;       // agent lark ask --options "a,b,c" (逗号分隔简写)
  specJson?: string;      // agent lark ask form --spec-json '{"questions":[...]}'（多问题表单）
  timeoutMs?: number;     // agent lark ask --timeout <ms>
  positional: string[];
}

function die(msg: string): never {
  stderr.write(`agent: ${msg}\n`);
  exit(2);
}

function parseArgs(args: string[]): Flags {
  const flags: Flags = {
    wait: false,
    all: false,
    newWindow: false,
    here: false,
    hard: false,
    yes: false,
    dryRun: false,
    continueSession: false,
    includeSelf: false,
    plain: false,
    auto: false,
    question: false,
    positional: [],
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--tty' || a === '-t') {
      flags.tty = args[++i] ?? die('-t 需要 tty');
    } else if (a === '--cwd') {
      flags.cwd = args[++i] ?? die('--cwd 需要路径');
    } else if (a === '-n' || a === '--lines') {
      flags.lines = Number(args[++i] ?? die('--lines 需要数字'));
    } else if (a === '--wait') {
      flags.wait = true;
    } else if (a === '--all' || a === '-a') {
      flags.all = true;
    } else if (a === '--new-window') {
      flags.newWindow = true;
    } else if (a === '--title') {
      flags.title = args[++i] ?? die('--title 需要值');
    } else if (a === '--body') {
      flags.body = args[++i] ?? die('--body 需要值');
    } else if (a === '--chat') {
      flags.chat = args[++i] ?? die('--chat 需要值');
    } else if (a === '--name') {
      flags.name = args[++i] ?? die('--name 需要值');
    } else if (a === '--task-id') {
      flags.taskId = args[++i] ?? die('--task-id 需要值');
    } else if (a === '--claim') {
      flags.claimId = args[++i] ?? die('--claim 需要 claim id');
    } else if (a === '--summary') {
      flags.summary = args[++i] ?? die('--summary 需要值');
    } else if (a === '--artifact') {
      flags.artifact = args[++i] ?? die('--artifact 需要值');
    } else if (a === '--note') {
      flags.note = args[++i] ?? die('--note 需要值');
    } else if (a === '--start') {
      flags.action = 'start';
    } else if (a === '--end') {
      flags.action = 'end';
    } else if (a === '--fail') {
      flags.action = 'fail';
    } else if (a === '--skip') {
      flags.action = 'skip';
    } else if (a === '--here') {
      flags.here = true;
    } else if (a === '--hard') {
      flags.hard = true;
    } else if (a === '--yes' || a === '-y') {
      flags.yes = true;
    } else if (a === '--dry-run') {
      flags.dryRun = true;
    } else if (a === '--continue') {
      flags.continueSession = true;
    } else if (a === '--include-self') {
      flags.includeSelf = true;
    } else if (a === '--except') {
      flags.except = args[++i] ?? die('--except 需要 tty（逗号分隔）');
    } else if (a === '--plain') {
      flags.plain = true;
    } else if (a === '--auto') {
      flags.auto = true;
    } else if (a === '--question') {
      flags.question = true;
    } else if (a === '--origin-pid') {
      const v = args[++i] ?? die('--origin-pid 需要数字');
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) die(`--origin-pid 非法：${v}`);
      flags.originPid = n;
    } else if (a === '--origin-cwd') {
      flags.originCwd = args[++i] ?? die('--origin-cwd 需要路径');
    } else if (a === '--options-json') {
      flags.optionsJson = args[++i] ?? die('--options-json 需要 JSON');
    } else if (a === '--options') {
      flags.options = args[++i] ?? die('--options 需要 csv');
    } else if (a === '--spec-json') {
      flags.specJson = args[++i] ?? die('--spec-json 需要 JSON');
    } else if (a === '--timeout' || a === '--timeout-ms') {
      const v = args[++i] ?? die('--timeout 需要毫秒数');
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) die(`--timeout 非法：${v}`);
      flags.timeoutMs = n;
    } else if (a === '--reason') {
      flags.reason = args[++i] ?? die('--reason 需要值');
    } else if (a === '--status') {
      flags.status = args[++i] ?? die('--status 需要值');
    } else if (a === '--gate-timeout') {
      flags.gateTimeoutMs = Number(args[++i] ?? die('--gate-timeout 需要毫秒数'));
    } else if (a.startsWith('--chat=')) {
      flags.chat = a.slice('--chat='.length);
    } else {
      flags.positional.push(a);
    }
  }
  return flags;
}

async function readStdinIfPiped(): Promise<string | null> {
  if (stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const c of stdin) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString('utf8').trim();
  return s || null;
}

function connectSocket(): Promise<Socket> {
  return new Promise((resolveP, rejectP) => {
    const sock = connect(SOCKET_PATH);
    sock.once('connect', () => resolveP(sock));
    sock.once('error', (e) => {
      rejectP(
        new Error(
          `连接 ${SOCKET_PATH} 失败：${e.message}\n→ 检查 dev 服务是否在跑（npm run dev）`,
        ),
      );
    });
  });
}

function readLines(sock: Socket, onLine: (line: string) => boolean | void): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const stop = onLine(line);
        if (stop === true) {
          sock.end();
          resolveP();
          return;
        }
      }
    });
    sock.once('end', () => resolveP());
    sock.once('close', () => resolveP());
    sock.once('error', rejectP);
  });
}

async function sendOnce<T>(req: Request): Promise<T> {
  const sock = await connectSocket();
  sock.write(`${JSON.stringify(req)}\n`);
  let payload: Response<T> | null = null;
  await readLines(sock, (line) => {
    payload = JSON.parse(line) as Response<T>;
    return true;
  });
  if (!payload) throw new Error('服务端无响应');
  const p = payload as Response<T>;
  if (!p.ok) throw new Error(p.error);
  return p.data;
}

function homeify(p: string | undefined): string {
  if (!p) return '?';
  const home = process.env['HOME'];
  if (home && p.startsWith(home)) return '~' + p.slice(home.length);
  return p;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function approvalIcon(s: ApprovalRequest['status']): string {
  switch (s) {
    case 'pending':
      return '⏳';
    case 'approved':
      return '✅';
    case 'rejected':
      return '❌';
    case 'timeout':
      return '⌛';
  }
}

function fmtAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return `${Math.floor(d / 1000)}s`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
  if (d < 24 * 3_600_000) return `${Math.floor(d / 3_600_000)}h`;
  return `${Math.floor(d / (24 * 3_600_000))}d`;
}

function groupByWindow(tabs: TerminalTab[]): Map<number, TerminalTab[]> {
  const m = new Map<number, TerminalTab[]>();
  for (const t of tabs) {
    const arr = m.get(t.windowId);
    if (arr) arr.push(t);
    else m.set(t.windowId, [t]);
  }
  return m;
}

function printTabs(tabs: TerminalTab[], currentTty?: string) {
  if (tabs.length === 0) {
    stdout.write('(没有 Terminal tab)\n');
    return;
  }
  const groups = groupByWindow(tabs);
  for (const [wid, arr] of groups) {
    const front = arr[0]?.windowFrontmost ? ' (front)' : '';
    stdout.write(`📦 Window ${wid}${front}\n`);
    for (const t of arr) {
      const star = t.tty === currentTty ? '★' : ' ';
      const busy = t.busy ? '● busy' : '○ idle';
      const tui = t.hasTUI ? ' ⚠TUI' : '';
      const procs = t.processes.length ? ` (${t.processes.slice(-2).join('/')})` : '';
      const title = t.title ? ` "${truncate(t.title, 36)}"` : '';
      stdout.write(
        `  ${star} ${t.tty}  ${busy}${tui}${procs}\n    cwd: ${homeify(t.cwd)}${title}\n`,
      );
    }
  }
}

async function resolveTargetTty(flags: Flags): Promise<string> {
  if (flags.tty) {
    const data = await sendOnce<TabGetData>({ op: 'tab.get', tty: flags.tty });
    if (!data.tab) die(`tab 不存在：${flags.tty}`);
    return data.tab.tty;
  }
  const state = await loadState();
  if (state.currentTty) {
    const data = await sendOnce<TabGetData>({ op: 'tab.get', tty: state.currentTty });
    if (data.tab) return data.tab.tty;
  }
  die('没有指定 tab。先 `agent tabs` 看，然后 `agent use <tty>`，或者 `agent send -t <tty>`');
}

// ---- commands ----

async function cmdTabs(): Promise<void> {
  const data = await sendOnce<TabListData>({ op: 'tab.list' });
  const state = await loadState();
  printTabs(data.tabs, state.currentTty);
}

async function cmdUse(flags: Flags): Promise<void> {
  const target = flags.positional[0];
  if (!target) die('agent use <tty>');
  const data = await sendOnce<TabGetData>({ op: 'tab.get', tty: target });
  if (!data.tab) die(`tab 不存在：${target}`);
  await saveState({ currentTty: data.tab.tty });
  stdout.write(`★ 当前 tab: ${data.tab.tty}  cwd: ${homeify(data.tab.cwd)}\n`);
}

async function cmdWhich(): Promise<void> {
  const state = await loadState();
  if (!state.currentTty) {
    stdout.write('（没有 default tab；用 agent use <tty> 设置）\n');
    return;
  }
  const data = await sendOnce<TabGetData>({ op: 'tab.get', tty: state.currentTty });
  if (!data.tab) {
    stdout.write(`（state 里的 ${state.currentTty} 不存在了；用 agent use 重设）\n`);
    return;
  }
  const t = data.tab;
  stdout.write(`★ ${t.tty}\n  cwd: ${homeify(t.cwd)}\n  busy: ${t.busy}${t.hasTUI ? ' ⚠TUI' : ''}\n`);
  if (t.title) stdout.write(`  title: ${t.title}\n`);
  if (t.processes.length) stdout.write(`  procs: ${t.processes.join(', ')}\n`);
}

async function cmdSend(flags: Flags): Promise<void> {
  let text = flags.positional.join(' ').trim();
  if (!text || text === '-') {
    const piped = await readStdinIfPiped();
    if (piped) text = piped;
  }
  if (!text) die('需要发送内容（位置参数或 stdin）');
  const tty = await resolveTargetTty(flags);
  const data = await sendOnce<TabSendData>({
    op: 'tab.send',
    tty,
    text,
    waitForOutput: flags.wait,
  });
  if (!data.result.ok) {
    stderr.write(`❌ ${data.result.reason}\n`);
    exit(1);
  }
  stderr.write(`→ sent to ${tty}\n`);
  if (flags.wait && data.result.diff !== undefined) {
    stdout.write(data.result.diff + '\n');
  }
}

async function cmdOpen(flags: Flags): Promise<void> {
  const cwd = flags.cwd ?? flags.positional[0] ?? procCwd();
  const opts: { cwd?: string; mode?: 'new-tab' | 'new-window' } = {};
  if (cwd) opts.cwd = cwd;
  if (flags.newWindow) opts.mode = 'new-window';
  const data = await sendOnce<TabNewData>({ op: 'tab.new', ...opts });
  await saveState({ currentTty: data.tty });
  stdout.write(
    `🆕 ${data.tty}  cwd=${homeify(cwd)}${flags.newWindow ? ' (new window)' : ''}  ★ 当前\n`,
  );
}

async function cmdShow(flags: Flags): Promise<void> {
  const tty = await resolveTargetTty(flags);
  const lines = flags.lines ?? 60;
  const data = await sendOnce<TabHistoryData>({ op: 'tab.history', tty, lines });
  stdout.write(`# ${tty}  (tail ${lines}/${data.totalLines})\n\n`);
  stdout.write(data.text + '\n');
}

async function cmdClose(flags: Flags): Promise<void> {
  const tty = flags.tty ?? flags.positional[0];
  if (!tty) die('agent close <tty> 或 -t <tty>');
  const data = await sendOnce<TabCloseData>({ op: 'tab.close', tty });
  stdout.write(data.closed ? `⊘ closed ${tty}\n` : `tab not found: ${tty}\n`);
}

/** normalize：'3' / 'ttys003' / '/dev/ttys003' → '/dev/ttys003' */
function normalizeTty(raw: string): string {
  const s = raw.trim();
  if (s.startsWith('/dev/')) return s;
  if (s.startsWith('ttys')) return `/dev/${s}`;
  if (/^\d+$/.test(s)) return `/dev/ttys${s.padStart(3, '0')}`;
  return s;
}

/**
 * 探测本命令跑在哪个 tab（controlling tty）—— 沿 pid → ppid 祖先链上溯，
 * 找到第一个持有真 ctty 的祖先（claude 进程本身持有终端 ctty，bash 工具子进程
 * 可能没有，故要往上走）。用于默认排除"自己"，避免 --yes 误杀发起方 tab。
 * 整条链都无 ctty（如无控制终端的守护/沙箱环境）返回 undefined。
 */
function detectSelfTty(): string | undefined {
  let pid: number | undefined = process.pid;
  for (let i = 0; i < 12 && pid && pid > 1; i++) {
    try {
      const r = spawnSync('ps', ['-o', 'tty=,ppid=', '-p', String(pid)], { encoding: 'utf8' });
      const line = r.stdout.trim();
      const m = /^(\S+)\s+(\d+)$/.exec(line);
      if (!m) break;
      const tty = m[1]!;
      if (tty !== '??' && tty !== '?') return normalizeTty(tty);
      pid = Number(m[2]);
    } catch {
      break;
    }
  }
  return undefined;
}

async function cmdRestartClaudeTabs(flags: Flags): Promise<void> {
  const except = new Set<string>();
  if (flags.except) {
    for (const t of flags.except.split(',')) {
      const s = t.trim();
      if (s) except.add(normalizeTty(s));
    }
  }
  // 默认排除发起命令的 tab（除非 --include-self）
  let selfTty: string | undefined;
  let selfUndetected = false;
  if (!flags.includeSelf) {
    selfTty = detectSelfTty();
    if (selfTty) except.add(selfTty);
    else selfUndetected = true;
  }

  const continueSession = flags.continueSession;
  // 没 --yes 一律 dry-run（安全默认）
  const dryRun = flags.dryRun || !flags.yes;

  const data = await sendOnce<TabRestartClaudeData>({
    op: 'tab.restart-claude',
    except: [...except],
    continueSession,
    dryRun,
  });

  const mode = continueSession ? 'claude --continue（续会话）' : 'claude（全新，不带历史）';
  if (data.excluded.length) {
    stdout.write(`↷ 排除：${data.excluded.join(', ')}${selfTty ? `  [含 self=${selfTty}]` : ''}\n`);
  } else if (selfTty) {
    stdout.write(`↷ self=${selfTty}（未在 claude tab 列表中，无需排除）\n`);
  }
  if (selfUndetected) {
    stdout.write(
      '⚠ 探测不到发起命令的 tab（无 ctty）——无法自动排除"自己"。\n' +
      '  若下方列表含你正在用的 tab，请用 --except <tty> 手动排除，否则 --yes 会重启它。\n',
    );
  }

  if (data.dryRun) {
    if (data.targets.length === 0) {
      stdout.write('（没有可重启的 claude tab）\n');
      return;
    }
    stdout.write(`\n将重启 ${data.targets.length} 个 claude tab（机制：原地 Ctrl-C 退出 → ${mode}）：\n`);
    for (const t of data.targets) {
      stdout.write(`  • ${t.tty}   cwd: ${homeify(t.cwd)}\n`);
    }
    stdout.write(`\n这是 dry-run。确认无误后加 --yes 真执行：\n  agent restart-all-claude-tabs --yes\n`);
    return;
  }

  if (data.targets.length === 0) {
    stdout.write('（没有可重启的 claude tab）\n');
    return;
  }
  stdout.write(`\n重启结果（${mode}）：\n`);
  let okN = 0;
  for (const t of data.targets) {
    if (t.ok) {
      okN++;
      stdout.write(`  ✅ ${t.tty}   cwd: ${homeify(t.cwd)}\n`);
    } else {
      stdout.write(`  ❌ ${t.tty}   ${t.reason ?? '未知失败'}\n`);
    }
  }
  stdout.write(`\n完成：${okN}/${data.targets.length} 成功。\n`);
}

async function cmdTapd(flags: Flags): Promise<void> {
  const sub = flags.positional[0];
  if (sub === 'stage') {
    const stage = flags.positional[1];
    const claimId = flags.claimId;
    if (!stage || !claimId) {
      die('agent tapd stage <fixing|verifying|awaiting-approval|resolved|failed> --claim <id> [--note "..."]');
    }
    const req: Extract<Request, { op: 'tapd.stage' }> = { op: 'tapd.stage', claimId, stage };
    if (flags.note) req.note = flags.note;
    const data = await sendOnce<TapdStageData>(req);
    stdout.write(data.updated ? `✅ TAPD stage → ${data.stage}\n` : '未更新\n');
    return;
  }
  die('用法：agent tapd stage <state> --claim <id> [--note "..."]');
}

async function cmdScreen(flags: Flags): Promise<void> {
  const tty = await resolveTargetTty(flags);
  const push = flags.chat || !flags.plain;
  let pushToChatId: string | undefined;
  if (push) {
    if (flags.chat) pushToChatId = flags.chat;
    else {
      // 自动反查
      const guessed = await sendOnce<LarkResolveChatData>({
        op: 'lark.resolve-chat',
        ...(tty ? { tty } : {}),
      });
      if (guessed.chatId) pushToChatId = guessed.chatId;
    }
  }
  const data = await sendOnce<TabScreenData>({
    op: 'tab.screen',
    tty,
    ...(pushToChatId ? { pushToChatId } : {}),
  });
  stdout.write(`✓ 抓屏：${data.path}\n`);
  if (data.pushed) {
    stdout.write(`  → 已推 chat=${data.pushed.chatId}\n`);
  } else if (pushToChatId) {
    stdout.write(`  ⚠ 推送 chat=${pushToChatId} 失败或未生效\n`);
  }
}

async function cmdKeys(flags: Flags): Promise<void> {
  const tty = await resolveTargetTty(flags);
  const seq = flags.positional.join(' ').trim();
  if (!seq) die("agent keys [-t tty] '<按键序列>' 例：agent keys '2d . ⏎'");
  const data = await sendOnce<TabKeysData>({
    op: 'tab.keys',
    tty,
    sequence: seq,
    ...(flags.timeoutMs ? { intervalMs: flags.timeoutMs } : {}),
  });
  stdout.write(`✓ 已注入按键到 ${data.tty}（约 ${data.steps} 个 token）\n`);
}

async function cmdChat(flags: Flags): Promise<void> {
  const chatId = flags.positional[0];
  if (!chatId) die('agent chat <chatId>');
  const data = await sendOnce<ChatGetData>({ op: 'chat.get', chatId });
  stdout.write(`chat: ${chatId}\n`);
  if (data.activeTab) {
    stdout.write(`active tty: ${data.activeTab.tty}  cwd=${homeify(data.activeTab.cwd)}\n`);
  } else {
    stdout.write('active tty: (none)\n');
  }
}

// ---- Lark outbound subcommands ----

function getCurrentTty(): string | undefined {
  try {
    const r = spawnSync('tty', [], { stdio: ['inherit', 'pipe', 'ignore'] });
    if (r.status !== 0) return undefined;
    const out = r.stdout?.toString('utf8').trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

async function resolveTargetChatId(flags: Flags): Promise<string> {
  if (flags.chat) return flags.chat;
  const tty = getCurrentTty();
  const data = await sendOnce<LarkResolveChatData>({
    op: 'lark.resolve-chat',
    ...(tty ? { tty } : {}),
  });
  if (!data.chatId) {
    die('无法推断目标 chat（没有 pending，也没有 active chat），请用 --chat <id>');
  }
  if (data.source !== 'pending') {
    stderr.write(
      `⚠ 没找到当前 tab 的 pending，回退到 ${data.source} = ${data.chatId}\n`,
    );
  }
  return data.chatId;
}

// ---- skill install / uninstall ----

const SKILL_NAME = 'multiagent-lark';

function projectSkillSrcDir(): string {
  // 本文件位于 packages/framework/src/control/cli.ts；monorepo 根 = ../../../..
  const here = dirname(fileURLToPath(import.meta.url));
  return resolvePath(here, '..', '..', '..', '..', 'skills', SKILL_NAME);
}

function userSkillDir(): string {
  return join(homedir(), '.claude', 'skills', SKILL_NAME);
}

async function cmdInstallSkill(): Promise<void> {
  const src = projectSkillSrcDir();
  const srcSkillMd = join(src, 'SKILL.md');
  if (!existsSync(srcSkillMd)) {
    die(`找不到 skill 源文件：${srcSkillMd}`);
  }
  const dst = userSkillDir();
  await mkdir(dst, { recursive: true });
  const content = await readFile(srcSkillMd, 'utf8');
  await writeFile(join(dst, 'SKILL.md'), content, 'utf8');
  stdout.write(`✓ skill 已安装到 ${dst}\n`);
  stdout.write(`  下次启动的 Claude Code session 会自动加载\n`);
  stdout.write(`  现有 session 在 /skills 重载（或重启 claude code）\n`);
}

async function cmdUninstallSkill(): Promise<void> {
  const dst = userSkillDir();
  if (!existsSync(dst)) {
    stdout.write(`skill 没安装在 ${dst}\n`);
    return;
  }
  const { rm } = await import('node:fs/promises');
  await rm(dst, { recursive: true, force: true });
  stdout.write(`✓ 已卸载 ${dst}\n`);
}

async function cmdLark(flags: Flags): Promise<void> {
  const sub = flags.positional[0];
  if (!sub) die('agent lark <send-text|send-card|send-file|send-image|ask|which-chat>');
  const rest = flags.positional.slice(1);
  if (sub === 'which-chat') {
    const tty = getCurrentTty();
    const data = await sendOnce<LarkResolveChatData>({
      op: 'lark.resolve-chat',
      ...(tty ? { tty } : {}),
    });
    if (tty) stdout.write(`tty: ${tty}\n`);
    stdout.write(`chat: ${data.chatId ?? '(none)'}\n`);
    stdout.write(`source: ${data.source}\n`);
    return;
  }
  if (sub === 'send-text') {
    let text = rest.join(' ');
    if (!text || text === '-') {
      const piped = await readStdinIfPiped();
      if (piped) text = piped;
    }
    if (!text) die('agent lark send-text "..."');
    const chatId = await resolveTargetChatId(flags);
    let quickAnswerOptions: string[] | undefined;
    if (flags.optionsJson) {
      try {
        const parsed = JSON.parse(flags.optionsJson);
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
          quickAnswerOptions = parsed;
        }
      } catch {
        /* 解析失败 → 忽略，走无按钮 body */
      }
    }
    const data = await sendOnce<LarkSendData>({
      op: 'lark.send-text',
      chatId,
      text,
      ...(flags.plain ? { plain: true } : {}),
      ...(flags.auto ? { auto: true } : {}),
      ...(flags.question ? { question: true } : {}),
      ...(flags.originPid !== undefined ? { originPid: flags.originPid } : {}),
      ...(flags.originCwd !== undefined ? { originCwd: flags.originCwd } : {}),
      ...(quickAnswerOptions ? { quickAnswerOptions } : {}),
    });
    // daemon 在 --auto 且 watchAllTabs=false 时会返回 details.gated=true
    if (data.details && (data.details as { gated?: boolean }).gated) {
      stdout.write(`○ auto-push gated（chat ${chatId} 未开启 /watch on）\n`);
    } else {
      stdout.write(
        `✓ 文本已发到 ${chatId}${flags.plain ? ' (plain)' : ''}${flags.auto ? ' (auto)' : ''}\n`,
      );
      // 手动 send-text 时把内容 preview 回显到 stderr —— 让 shell TUI 里的
      // 用户/claude 都能"看见到底推了什么"。Stop hook 的 --auto 跳过（那本就是
      // last_assistant_message，TUI 里已经显示过，再回显只会 noise）。
      if (!flags.auto) {
        const MAX = 800;
        const preview = text.length > MAX ? text.slice(0, MAX) + '\n…(截断，共 ' + text.length + ' 字符)' : text;
        stderr.write('─── 推送内容 ───\n' + preview + '\n────────────────\n');
      }
    }
    return;
  }
  if (sub === 'send-card') {
    let json = rest.join(' ');
    if (!json || json === '-') {
      const piped = await readStdinIfPiped();
      if (piped) json = piped;
    }
    if (!json) die('agent lark send-card \'<json>\' 或从 stdin 输入');
    let card: unknown;
    try {
      card = JSON.parse(json);
    } catch (e) {
      die(`卡片 JSON 解析失败：${(e as Error).message}`);
    }
    const chatId = await resolveTargetChatId(flags);
    await sendOnce<LarkSendData>({ op: 'lark.send-card', chatId, card });
    stdout.write(`✓ 卡片已发到 ${chatId}\n`);
    return;
  }
  if (sub === 'send-file') {
    const path = rest[0];
    if (!path) die('agent lark send-file <path>');
    const abs = resolvePath(path);
    if (!existsSync(abs)) die(`文件不存在: ${abs}`);
    const chatId = await resolveTargetChatId(flags);
    const req: Request = {
      op: 'lark.send-file',
      chatId,
      path: abs,
      ...(flags.name ? { name: flags.name } : {}),
    };
    const data = await sendOnce<LarkSendData>(req);
    stdout.write(
      `✓ 文件已发到 ${chatId}\n  ${JSON.stringify(data.details)}\n`,
    );
    return;
  }
  if (sub === 'send-image') {
    const path = rest[0];
    if (!path) die('agent lark send-image <path>');
    const abs = resolvePath(path);
    if (!existsSync(abs)) die(`文件不存在: ${abs}`);
    const chatId = await resolveTargetChatId(flags);
    const data = await sendOnce<LarkSendData>({
      op: 'lark.send-image',
      chatId,
      path: abs,
    });
    stdout.write(
      `✓ 图片已发到 ${chatId}\n  ${JSON.stringify(data.details)}\n`,
    );
    return;
  }
  if (sub === 'ask') {
    // agent lark ask <single|multi|input> --title '...' [--options 'a,b,c' | --options-json '[]']
    //                                     [--timeout <ms>] [--chat <chatId>]
    // 阻塞式：弹飞书交互卡片，用户点选/回复 → CLI stdout 打印 JSON 答案。
    const type = (rest[0] ?? '').toLowerCase();
    if (type !== 'single' && type !== 'multi' && type !== 'input' && type !== 'form') {
      die("agent lark ask <single|multi|input|form> --title '...' [--options 'a,b,c' | --spec-json '{...}']");
    }
    if (!flags.title) die('agent lark ask 需要 --title');

    // ── form：多问题表单（--spec-json '{"questions":[{title,type,options}]}'）──
    if (type === 'form') {
      if (!flags.specJson) die("form 类型需要 --spec-json '{\"questions\":[{\"title\":\"..\",\"type\":\"single|multi\",\"options\":[\"a\",\"b\"]}]}'");
      let questions: { title: string; type: 'single' | 'multi'; options: string[]; allowText?: boolean }[];
      try {
        const parsed = JSON.parse(flags.specJson) as { questions?: unknown };
        const qs = parsed.questions;
        if (!Array.isArray(qs) || qs.length === 0) die('--spec-json 的 questions 必须是非空数组');
        questions = (qs as unknown[]).map((q, i) => {
          const o = q as { title?: unknown; type?: unknown; options?: unknown; allowText?: unknown };
          const qt = o.type === 'multi' ? 'multi' : 'single';
          if (typeof o.title !== 'string' || !o.title) die(`第 ${i + 1} 题缺 title`);
          if (!Array.isArray(o.options) || o.options.length === 0 || !o.options.every((x) => typeof x === 'string')) die(`第 ${i + 1} 题 options 必须是非空字符串数组`);
          return { title: o.title, type: qt, options: o.options as string[], ...(o.allowText === true ? { allowText: true } : {}) };
        });
      } catch (e) {
        die(`--spec-json 解析失败: ${(e as Error).message}`);
      }
      const chatId = await resolveTargetChatId(flags);
      stderr.write(`⏳ 等待飞书表单答复… (chat=${chatId}, questions=${questions.length})\n`);
      const reqPayload: Request = {
        op: 'lark.ask',
        chatId,
        type: 'form',
        title: flags.title,
        questions,
        ...(flags.timeoutMs ? { timeoutMs: flags.timeoutMs } : {}),
      };
      const data = await sendOnce<LarkAskData>(reqPayload);
      const req = data.request;
      if (req.status === 'answered' && req.answer?.kind === 'form') {
        stdout.write(JSON.stringify({ status: 'answered', type: 'form', answers: req.answer.items }) + '\n');
        exit(0);
      } else if (req.status === 'cancelled') {
        stdout.write(JSON.stringify({ status: 'cancelled' }) + '\n');
        exit(1);
      } else {
        stdout.write(JSON.stringify({ status: 'timeout' }) + '\n');
        exit(2);
      }
    }

    let options: string[] = [];
    if (type !== 'input') {
      if (flags.optionsJson) {
        try {
          const parsed = JSON.parse(flags.optionsJson);
          if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
            options = parsed;
          } else {
            die('--options-json 必须是字符串数组');
          }
        } catch (e) {
          die(`--options-json 解析失败: ${(e as Error).message}`);
        }
      } else if (flags.options) {
        const raw = flags.options.trim();
        if (raw.startsWith('[')) {
          // 逗号安全：--options 也接受 JSON 数组（选项文本含逗号时用它，一个 flag 搞定）
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
              options = parsed.map((s) => s.trim()).filter((s) => s.length > 0);
            } else {
              die('--options 是 JSON 时必须是字符串数组');
            }
          } catch (e) {
            die(`--options JSON 解析失败: ${(e as Error).message}`);
          }
        } else {
          options = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        }
      }
      if (options.length === 0) {
        die(`${type} 类型需要 --options 或 --options-json`);
      }
    }
    const chatId = await resolveTargetChatId(flags);
    stderr.write(`⏳ 等待飞书答复… (chat=${chatId}, type=${type}${options.length ? `, options=${options.length}` : ''})\n`);
    const reqPayload: Request = {
      op: 'lark.ask',
      chatId,
      type: type as 'single' | 'multi' | 'input',
      title: flags.title,
      ...(options.length > 0 ? { options } : {}),
      ...(flags.timeoutMs ? { timeoutMs: flags.timeoutMs } : {}),
    };
    const data = await sendOnce<LarkAskData>(reqPayload);
    const req = data.request;
    if (req.status === 'answered' && req.answer) {
      // stdout 打 JSON，方便脚本 / claude 直接 pipe
      const payload: Record<string, unknown> = { status: 'answered', type };
      if (req.answer.kind === 'single') {
        payload['index'] = req.answer.index;
        payload['value'] = req.answer.value;
      } else if (req.answer.kind === 'multi') {
        payload['indices'] = req.answer.indices;
        payload['values'] = req.answer.values;
      } else if (req.answer.kind === 'input') {
        payload['text'] = req.answer.text;
      }
      stdout.write(JSON.stringify(payload) + '\n');
      exit(0);
    } else if (req.status === 'cancelled') {
      stdout.write(JSON.stringify({ status: 'cancelled' }) + '\n');
      exit(1);
    } else {
      stdout.write(JSON.stringify({ status: 'timeout' }) + '\n');
      exit(2);
    }
  }
  die(`未知 lark 子命令：${sub}`);
}

async function resolveWeComChatId(flags: Flags): Promise<string> {
  if (flags.chat) return flags.chat;
  const data = await sendOnce<WeComResolveChatData>({ op: 'wecom.resolve-chat' });
  if (!data.chatId) {
    die('无法反查企微 chat（缺 WECOM_DEFAULT_TO_USER），请用 --chat wecom:user:<userid>');
  }
  return data.chatId;
}

async function cmdWeCom(flags: Flags): Promise<void> {
  const sub = flags.positional[0];
  if (!sub) die('agent wecom <send-text|send-file|send-image|ask|which-chat>');
  const rest = flags.positional.slice(1);

  if (sub === 'which-chat') {
    const data = await sendOnce<WeComResolveChatData>({ op: 'wecom.resolve-chat' });
    stdout.write(`chat: ${data.chatId ?? '(none)'}\n`);
    stdout.write(`source: ${data.source}\n`);
    return;
  }

  if (sub === 'send-text') {
    let text = rest.join(' ');
    if (!text || text === '-') {
      const piped = await readStdinIfPiped();
      if (piped) text = piped;
    }
    if (!text) die('agent wecom send-text "..."');
    const chatId = await resolveWeComChatId(flags);
    const data = await sendOnce<WeComSendData>({
      op: 'wecom.send-text',
      chatId,
      text,
    });
    stdout.write(`✓ 文本已发到 ${chatId}（msgid=${data.messageId || '-'}）\n`);
    if (!flags.auto) {
      const MAX = 800;
      const preview = text.length > MAX ? text.slice(0, MAX) + '\n…(截断，共 ' + text.length + ' 字符)' : text;
      stderr.write('─── 推送内容 ───\n' + preview + '\n────────────────\n');
    }
    return;
  }

  if (sub === 'send-file') {
    const path = rest[0];
    if (!path) die('agent wecom send-file <path>');
    const abs = resolvePath(path);
    if (!existsSync(abs)) die(`文件不存在: ${abs}`);
    const chatId = await resolveWeComChatId(flags);
    const data = await sendOnce<WeComSendData>({
      op: 'wecom.send-file',
      chatId,
      path: abs,
      ...(flags.name ? { name: flags.name } : {}),
    });
    stdout.write(`✓ 文件已发到 ${chatId}（msgid=${data.messageId || '-'}）\n`);
    return;
  }

  if (sub === 'send-image') {
    const path = rest[0];
    if (!path) die('agent wecom send-image <path>');
    const abs = resolvePath(path);
    if (!existsSync(abs)) die(`文件不存在: ${abs}`);
    const chatId = await resolveWeComChatId(flags);
    const data = await sendOnce<WeComSendData>({
      op: 'wecom.send-image',
      chatId,
      path: abs,
    });
    stdout.write(`✓ 图片已发到 ${chatId}（msgid=${data.messageId || '-'}）\n`);
    return;
  }

  if (sub === 'ask') {
    // agent wecom ask <single|multi|input> --title '...' [--options '...'] [--timeout ms]
    // 语义跟 agent lark ask 一致；企微侧走 button_interaction 卡（multi 目前降级 unsupported）
    const type = (rest[0] ?? '').toLowerCase();
    if (type !== 'single' && type !== 'multi' && type !== 'input') {
      die("agent wecom ask <single|multi|input> --title '...' [--options 'a,b,c']");
    }
    if (!flags.title) die('agent wecom ask 需要 --title');
    let options: string[] = [];
    if (type !== 'input') {
      if (flags.optionsJson) {
        try {
          const parsed = JSON.parse(flags.optionsJson);
          if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
            options = parsed;
          } else {
            die('--options-json 必须是字符串数组');
          }
        } catch (e) {
          die(`--options-json 解析失败: ${(e as Error).message}`);
        }
      } else if (flags.options) {
        options = flags.options.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      }
      if (options.length === 0) die(`${type} 类型需要 --options 或 --options-json`);
    }
    const chatId = await resolveWeComChatId(flags);
    stderr.write(
      `⏳ 等待企微答复… (chat=${chatId}, type=${type}${options.length ? `, options=${options.length}` : ''})\n`,
    );
    const data = await sendOnce<import('./protocol.js').WeComAskData>({
      op: 'wecom.ask',
      chatId,
      type: type as 'single' | 'multi' | 'input',
      title: flags.title,
      ...(options.length > 0 ? { options } : {}),
      ...(flags.timeoutMs ? { timeoutMs: flags.timeoutMs } : {}),
    });
    const req = data.request;
    if (req.status === 'answered' && req.answer) {
      const payload: Record<string, unknown> = { status: 'answered', type };
      if (req.answer.kind === 'single') {
        payload['index'] = req.answer.index;
        payload['value'] = req.answer.value;
      } else if (req.answer.kind === 'multi') {
        payload['indices'] = req.answer.indices;
        payload['values'] = req.answer.values;
      } else if (req.answer.kind === 'input') {
        payload['text'] = req.answer.text;
      }
      stdout.write(JSON.stringify(payload) + '\n');
      exit(0);
    } else if (req.status === 'cancelled') {
      stdout.write(JSON.stringify({ status: 'cancelled' }) + '\n');
      exit(1);
    } else {
      stdout.write(JSON.stringify({ status: 'timeout' }) + '\n');
      exit(2);
    }
  }

  die(`未知 wecom 子命令：${sub}`);
}

async function cmdRecentCwds(): Promise<void> {
  const data = await sendOnce<TabRecentCwdsData>({ op: 'tab.recent-cwds' });
  if (data.cwds.length === 0) {
    stdout.write('(没有 recent cwds)\n');
    return;
  }
  for (const c of data.cwds) stdout.write(`  ${homeify(c)}\n`);
}

// approval（保留）

function printApprovalRows(rows: ApprovalRequest[]) {
  if (rows.length === 0) {
    stdout.write('(空)\n');
    return;
  }
  const lines = ['\tID\tSTATUS\tAGE\tTITLE'];
  for (const r of rows) {
    lines.push(
      [
        approvalIcon(r.status),
        r.id,
        r.status,
        fmtAgo(r.createdAt),
        truncate(r.title, 60),
      ].join('\t'),
    );
  }
  stdout.write(lines.join('\n') + '\n');
}

async function cmdApprovals(): Promise<void> {
  const data = await sendOnce<ApprovalListData>({ op: 'approval.list' });
  if (data.active.length) {
    stdout.write('⏳ 待审批：\n');
    printApprovalRows(data.active);
    stdout.write('\n');
  } else {
    stdout.write('⏳ 待审批：(空)\n\n');
  }
  stdout.write('📜 最近历史：\n');
  printApprovalRows(data.recent);
}

async function cmdApprove(flags: Flags): Promise<void> {
  const id = flags.positional[0];
  if (!id) die('agent approve <approval_id>');
  const data = await sendOnce<ApprovalResolveData>({
    op: 'approval.resolve',
    id,
    decision: 'approved',
    resolvedBy: `cli:${process.env['USER'] ?? 'unknown'}`,
  });
  if (!data.request) die(`审批 ${id} 不存在或已完成`);
  stdout.write(`✅ ${data.request.id} approved\n`);
}

async function cmdReject(flags: Flags): Promise<void> {
  const id = flags.positional[0];
  if (!id) die('agent reject <approval_id>');
  const data = await sendOnce<ApprovalResolveData>({
    op: 'approval.resolve',
    id,
    decision: 'rejected',
    resolvedBy: `cli:${process.env['USER'] ?? 'unknown'}`,
  });
  if (!data.request) die(`审批 ${id} 不存在或已完成`);
  stdout.write(`❌ ${data.request.id} rejected\n`);
}

// ---- task / SOP commands ----

function resolveTaskId(flags: Flags): string {
  const id = flags.taskId ?? process.env['AGENT_TASK_ID'];
  if (!id) die('需要 --task-id <id>（或在环境里 export AGENT_TASK_ID）');
  return id;
}

function statusIcon(s: TaskStatus): string {
  switch (s) {
    case 'running':
      return '🔵';
    case 'awaiting-gate':
      return '⏸';
    case 'done':
      return '✅';
    case 'failed':
      return '❌';
  }
}

function printTaskRow(t: TaskState): void {
  const stageInfo =
    t.currentStageIdx < 0
      ? '(未开始)'
      : t.currentStageIdx >= t.stages.length
        ? '(全部完成)'
        : `[${t.currentStageIdx + 1}/${t.stages.length}] ${t.stages[t.currentStageIdx]}`;
  stdout.write(
    `  ${statusIcon(t.status)} ${t.taskId}  ${stageInfo}\n` +
      `    tty: ${t.tty}  cwd: ${homeify(t.cwd)}  ${fmtAgo(t.startedAt)} ago\n`,
  );
  if (t.awaitingGate) stdout.write(`    ⏸ gate: ${t.awaitingGate}\n`);
  if (t.failReason) stdout.write(`    ❌ ${t.failReason}\n`);
}

async function cmdTask(flags: Flags): Promise<void> {
  const sub = flags.positional[0];
  if (!sub) die('agent task <list|show|stage|here|abort> ...');

  if (sub === 'here') {
    // 列当前 tty 的进行中 task
    const tty = flags.tty ?? getCurrentTty();
    if (!tty) die('无法识别 tty，请显式 --tty');
    const [running, gated] = await Promise.all([
      sendOnce<TaskListData>({ op: 'task.list', tty, status: 'running' }),
      sendOnce<TaskListData>({ op: 'task.list', tty, status: 'awaiting-gate' }),
    ]);
    const all = [...gated.tasks, ...running.tasks];
    if (all.length === 0) {
      stdout.write(`(${tty} 没有进行中的 task)\n`);
      return;
    }
    for (const t of all) printTaskRow(t);
    return;
  }

  if (sub === 'abort') {
    let taskId: string | undefined = flags.positional[1] ?? flags.taskId;
    if (!taskId && flags.here) {
      const tty = flags.tty ?? getCurrentTty();
      if (!tty) die('无法识别 tty，--here 失败；请显式 task-id');
      const [running, gated] = await Promise.all([
        sendOnce<TaskListData>({ op: 'task.list', tty, status: 'running' }),
        sendOnce<TaskListData>({ op: 'task.list', tty, status: 'awaiting-gate' }),
      ]);
      const all = [...gated.tasks, ...running.tasks];
      if (all.length === 0) die(`${tty} 没有进行中的 task`);
      if (all.length > 1) {
        stderr.write(`⚠ ${tty} 有 ${all.length} 个进行中的 task，请显式指定：\n`);
        for (const t of all) stderr.write(`  ${t.taskId} (${t.presetName ?? 'ad-hoc'}, stage ${t.currentStageIdx + 1}/${t.stages.length})\n`);
        exit(1);
      }
      taskId = all[0]!.taskId;
    }
    if (!taskId) die('agent task abort <id> 或 --here');
    const req: Extract<Request, { op: 'task.abort' }> = {
      op: 'task.abort',
      taskId,
      hard: flags.hard,
    };
    if (flags.reason) req.reason = flags.reason;
    const data = await sendOnce<TaskAbortData>(req);
    if (!data.task) die(`task ${taskId} 不存在`);
    stderr.write(`🛑 已${flags.hard ? '硬' : '软'}中止 ${taskId}\n`);
    stderr.write(`   tty: ${data.task.tty}\n`);
    stderr.write(`   reason: ${data.task.failReason}\n`);
    return;
  }

  if (sub === 'list') {
    const req: Request = { op: 'task.list' };
    if (flags.status) {
      const s = flags.status as TaskStatus;
      if (!['running', 'awaiting-gate', 'done', 'failed'].includes(s)) {
        die(`--status 必须是 running / awaiting-gate / done / failed`);
      }
      req.status = s;
    }
    if (flags.tty) req.tty = flags.tty;
    if (typeof flags.lines === 'number') req.limit = flags.lines;
    const data = await sendOnce<TaskListData>(req);
    if (data.tasks.length === 0) {
      stdout.write('(没有 task)\n');
      return;
    }
    for (const t of data.tasks) printTaskRow(t);
    return;
  }

  if (sub === 'show') {
    const taskId = flags.positional[1] ?? resolveTaskId(flags);
    const data = await sendOnce<TaskGetData>({ op: 'task.get', taskId });
    if (!data.task) die(`task 不存在：${taskId}`);
    const t = data.task;
    stdout.write(`${statusIcon(t.status)} ${t.taskId}\n`);
    stdout.write(`  preset: ${t.presetName ?? '(ad-hoc)'}\n`);
    stdout.write(`  tty: ${t.tty}  cwd: ${homeify(t.cwd)}\n`);
    stdout.write(`  artifactDir: ${t.artifactDir}\n`);
    stdout.write(`  startedAt: ${new Date(t.startedAt).toISOString()}\n`);
    if (t.endedAt) stdout.write(`  endedAt:   ${new Date(t.endedAt).toISOString()}\n`);
    if (t.awaitingGate) stdout.write(`  ⏸ awaitingGate: ${t.awaitingGate}\n`);
    if (t.failReason) stdout.write(`  ❌ failReason: ${t.failReason}\n`);
    stdout.write(`  stages:\n`);
    t.stageHistory.forEach((s, i) => {
      const cur = i === t.currentStageIdx ? '►' : ' ';
      const icon =
        s.status === 'done' ? '✓' :
        s.status === 'failed' ? '✗' :
        s.status === 'running' ? '⠂' :
        s.status === 'skipped' ? '⤼' : '·';
      stdout.write(`    ${cur} ${icon} ${s.name}`);
      if (s.summary) stdout.write(`  — ${truncate(s.summary, 80)}`);
      if (s.artifactPath) stdout.write(`  [${s.artifactPath}]`);
      stdout.write('\n');
    });
    return;
  }

  if (sub === 'stage') {
    const taskId = resolveTaskId(flags);
    const stageName = flags.name;
    if (!stageName) die('需要 --name <stage>');
    if (!flags.action) die('需要 --start / --end / --fail / --skip 之一');
    const req: Extract<Request, { op: 'task.stage' }> = {
      op: 'task.stage',
      taskId,
      name: stageName,
      action: flags.action,
    };
    if (flags.summary !== undefined) req.summary = flags.summary;
    if (flags.artifact !== undefined) req.artifactPath = flags.artifact;
    if (flags.note !== undefined) req.note = flags.note;
    if (flags.reason !== undefined) req.reason = flags.reason;
    if (flags.gateTimeoutMs !== undefined) req.gateTimeoutMs = flags.gateTimeoutMs;
    if (flags.action === 'end') {
      stderr.write(`⏳ stage end (若有 gate 会阻塞等审批)...\n`);
    }
    const data = await sendOnce<TaskStageData>(req);
    const t = data.task;
    if (data.gateResolved) {
      const g = data.gateResolved;
      if (g.approved) {
        stderr.write(`✅ gate ${g.gateName} approved\n`);
        stdout.write('approved\n');
      } else {
        stderr.write(`❌ gate ${g.gateName} ${g.reason ?? 'rejected'}\n`);
        stdout.write(`${g.reason ?? 'rejected'}\n`);
        exit(1);
      }
    } else if (data.loopback) {
      const lb = data.loopback;
      stderr.write(
        `🔁 loopback: ${lb.failedStage} fail → 从 ${lb.retryFrom} 重跑（${lb.retryCount}/${lb.maxRetries}）\n`,
      );
      // stdout 输出协议格式给主 claude 解析
      stdout.write(`loopback:${lb.retryFrom}\n`);
      exit(0);
    } else {
      stderr.write(
        `→ ${flags.action} ${stageName}  task=${t.taskId} status=${t.status}\n`,
      );
    }
    return;
  }

  die(`未知 task 子命令：${sub}`);
}

// ---- subagent commands ----

async function cmdSubagent(flags: Flags): Promise<void> {
  const sub = flags.positional[0];
  if (!sub) die('agent subagent <list|show|add|delete> ...');
  const cwd = procCwd();

  if (sub === 'list' || sub === 'ls') {
    const data = await sendOnce<SubagentListData>({ op: 'subagent.list', projectRoot: cwd });
    if (data.subagents.length === 0) {
      stdout.write('(没有 subagent。用 `agent subagent add <name> ...` 创建，或 /subagent gen)\n');
      return;
    }
    stdout.write(`共 ${data.subagents.length} 个 subagent:\n`);
    for (const s of data.subagents) {
      const loc = s.location === 'project' ? '📁' : '🏠';
      stdout.write(`  ${loc} ${s.name}`);
      if (s.description) stdout.write(`  — ${truncate(s.description, 60)}`);
      stdout.write('\n');
      if (s.tools?.length) stdout.write(`      tools: ${s.tools.join(', ')}\n`);
    }
    return;
  }

  if (sub === 'show') {
    const name = flags.positional[1] ?? flags.name;
    if (!name) die('agent subagent show <name>');
    const data = await sendOnce<SubagentShowData>({
      op: 'subagent.show',
      name,
      projectRoot: cwd,
    });
    if (!data.subagent) die(`subagent 不存在：${name}`);
    const s = data.subagent;
    stdout.write(`=== ${s.name} (${s.location}) ===\n`);
    stdout.write(`file: ${s.filePath}\n`);
    if (s.description) stdout.write(`description: ${s.description}\n`);
    if (s.tools?.length) stdout.write(`tools: ${s.tools.join(', ')}\n`);
    if (s.model) stdout.write(`model: ${s.model}\n`);
    if (s.color) stdout.write(`color: ${s.color}\n`);
    stdout.write('\n--- body ---\n');
    stdout.write(s.body + '\n');
    return;
  }

  if (sub === 'add') {
    // agent subagent add <name> --description "..." --tools "A,B,C" --model sonnet --color blue --body "..."
    // body 可以来自 stdin
    const name = flags.positional[1] ?? flags.name;
    if (!name) die('agent subagent add <name> [--description ...] [--tools A,B,C] [--body "..."] 或从 stdin');
    let body = flags.body;
    if (!body) {
      const piped = await readStdinIfPiped();
      if (piped) body = piped;
    }
    if (!body) die('缺 subagent body（--body 或 stdin）');
    const req: Extract<Request, { op: 'subagent.add' }> = {
      op: 'subagent.add',
      name,
      body,
      projectRoot: cwd,
      overwrite: flags.hard,
    };
    if (flags.reason !== undefined) req.description = flags.reason;
    if (flags.title !== undefined && !req.description) req.description = flags.title;
    if (flags.artifact !== undefined) req.tools = flags.artifact.split(',').map((s) => s.trim()).filter(Boolean);
    if (flags.summary !== undefined) req.model = flags.summary;
    // color: 复用 --note flag（reused）
    if (flags.note !== undefined) req.color = flags.note;
    if (flags.action === 'skip') req.location = 'project';
    try {
      const data = await sendOnce<SubagentAddData>(req);
      const s = data.subagent;
      stdout.write(`✅ subagent 已保存：${s.name}\n`);
      stdout.write(`   ${s.filePath}\n`);
    } catch (e) {
      die((e as Error).message);
    }
    return;
  }

  if (sub === 'delete' || sub === 'rm') {
    const name = flags.positional[1] ?? flags.name;
    if (!name) die('agent subagent delete <name>');
    const data = await sendOnce<SubagentDeleteData>({
      op: 'subagent.delete',
      name,
      projectRoot: cwd,
    });
    if (!data.deleted) die(`subagent 不存在：${name}`);
    stdout.write(`✗ 已删除 ${name}\n`);
    return;
  }


  if (sub === 'gen-submit') {
    // agent subagent gen-submit --task-id <session> --chat X --body '<json>'
    // 或 body 从 stdin
    const sessionId = flags.taskId;
    const chatId = flags.chat;
    if (!sessionId) die('agent subagent gen-submit --task-id <session-id> --chat <chatId> --body <json>');
    if (!chatId) die('缺 --chat <chatId>');
    let body = flags.body;
    if (!body) {
      const piped = await readStdinIfPiped();
      if (piped) body = piped;
    }
    if (!body) die('缺 JSON（--body 或 stdin）');
    const req: Extract<Request, { op: 'subagent.gen-submit' }> = {
      op: 'subagent.gen-submit',
      sessionId,
      chatId,
      json: body,
      projectRoot: cwd,
    };
    if (flags.action === 'skip') req.location = 'project';
    if (flags.hard) req.overwrite = true;  // 复用 --hard flag 作 overwrite
    const data = await sendOnce<import('./protocol.js').SubagentGenSubmitData>(req);
    stdout.write(`session=${data.sessionId}\n`);
    stdout.write(`added=${data.added.length}: ${data.added.map((s) => s.name).join(', ')}\n`);
    if (data.skipped.length) {
      stdout.write(`skipped=${data.skipped.length}: ${data.skipped.map((s) => s.name + '(' + s.reason.slice(0, 40) + ')').join(', ')}\n`);
    }
    if (data.templateSaved) stdout.write(`template=${data.templateSaved.name}\n`);
    return;
  }

  die(`未知 subagent 子命令：${sub}`);
}

async function cmdStageRecall(flags: Flags): Promise<void> {
  // --name 是 stage 名（复用现有 flag）
  const req: Extract<Request, { op: 'stage.recall' }> = { op: 'stage.recall' };
  if (flags.name) req.stage = flags.name;
  if (flags.cwd) req.cwd = flags.cwd;
  if (flags.positional.length > 0) req.keywords = flags.positional;
  if (typeof flags.lines === 'number') req.limit = flags.lines;
  const data = await sendOnce<StageRecallData>(req);
  if (data.results.length === 0) {
    stdout.write('(没有匹配的 stage 记忆)\n');
    return;
  }
  for (const r of data.results) {
    const ago = fmtAgo(r.endedAt);
    const preset = r.presetName ? `\`${r.presetName}\` · ` : '';
    stdout.write(
      `🧠 ${preset}**${r.stageName}**  score=${r.score}  ${ago} ago\n` +
        `   ${truncate(r.userPrompt, 80)}\n` +
        `   → ${truncate(r.summary || '(无摘要)', 100)}\n`,
    );
    if (r.artifactPath) stdout.write(`   📄 ${r.artifactPath}\n`);
    stdout.write(`   cwd: ${homeify(r.cwd)}  ·  task: ${r.taskId}\n\n`);
  }
}

/**
 * `agent connect [key]` —— 本地对接引导（socket-free，不依赖 daemon）。
 * 首次启动飞书未配时的快速对接入口：直接读写 .env，无需飞书通道。
 */
async function cmdConnect(flags: Flags): Promise<void> {
  const { integrationStatuses, INTEGRATIONS, getIntegration, upsertEnvKeys } = await import('multiagent-orchestrator');
  const key = flags.positional[0];
  const statuses = await integrationStatuses();

  if (!key) {
    stdout.write('本项目对接列表（配置某项：agent connect <key>）：\n\n');
    for (const s of statuses) {
      const badge = !s.connected ? '⬜ 未对接' : s.disabled ? '⏸ 已停用' : '✅ 已启用';
      stdout.write(`  ${badge}  ${s.key.padEnd(10)} ${s.name}\n`);
    }
    const lark = statuses.find((s) => s.key === 'lark');
    if (lark && !lark.connected) {
      stdout.write('\n⚡ 飞书(核心)未配置 —— 运行 `agent connect lark` 立即快速对接。\n');
      stdout.write('   飞书 App ID/Secret 在：飞书开发者后台 → 你的应用 → 凭证与基础信息。\n');
    }
    return;
  }

  const it = getIntegration(key);
  if (!it) die(`未知对接：${key}（可选：${INTEGRATIONS.map((i) => i.key).join(' / ')}）`);
  const kv: Record<string, string> = {};
  for (const f of it.fields) if (f.fixedValue) kv[f.env] = f.fixedValue;
  const inputs = it.fields.filter((f) => !f.fixedValue);
  if (inputs.length > 0) {
    const readline = await import('node:readline/promises');
    const rl = readline.createInterface({ input: stdin, output: stderr });
    stderr.write(`\n配置「${it.name}」—— ${it.desc}\n（逐项输入，直接回车跳过某项）\n`);
    for (const f of inputs) {
      const ans = (await rl.question(`  ${f.label}${f.secret ? ' 🔒密钥' : ''} [${f.env}]: `)).trim();
      if (ans) kv[f.env] = ans;
    }
    rl.close();
  }
  if (Object.keys(kv).length === 0) {
    stderr.write('未输入任何值，已取消。\n');
    return;
  }
  await upsertEnvKeys(kv);
  stdout.write(`\n✓ 已写入 .env：${Object.keys(kv).join(', ')}\n`);
  stdout.write(`  运行（或重启）\`npm run dev\` 生效。\n`);
}

async function cmdDoctor(): Promise<void> {
  const { runDoctor } = await import('./doctor.js');
  stderr.write('🩺 诊断中...\n\n');
  const report = await runDoctor({ repoRoot: procCwd() });
  const iconMap: Record<string, string> = {
    pass: '✅',
    warn: '⚠️ ',
    fail: '❌',
    skip: '⏭ ',
  };
  const severityWidth = 12;
  for (const r of report.results) {
    const icon = iconMap[r.status] ?? '?';
    const sev = `[${r.severity}]`.padEnd(severityWidth);
    stdout.write(`${icon} ${sev} ${r.name}: ${r.message}\n`);
    if (r.detail) stdout.write(`     ${r.detail}\n`);
    if (r.hint && (r.status === 'fail' || r.status === 'warn')) {
      stdout.write(`     💡 ${r.hint}\n`);
    }
  }
  stdout.write('\n');
  stdout.write(
    `汇总：✅ ${report.summary.pass}  ⚠️  ${report.summary.warn}  ❌ ${report.summary.fail}  ⏭ ${report.summary.skip}\n`,
  );
  const overallIcon =
    report.overall === 'healthy' ? '🟢' : report.overall === 'degraded' ? '🟡' : '🔴';
  const overallText =
    report.overall === 'healthy'
      ? '健康'
      : report.overall === 'degraded'
        ? '亚健康（能用但有 warn/fail）'
        : '不可用（有 critical fail）';
  stdout.write(`${overallIcon} 整体：${overallText}\n`);
  if (report.overall === 'broken') exit(1);
}

async function cmdRequestApproval(flags: Flags): Promise<void> {
  let title = flags.title;
  let body = flags.body;
  if (!title && flags.positional[0]) title = flags.positional[0];
  if (!body && flags.positional[1]) body = flags.positional[1];
  if (!body) {
    const piped = await readStdinIfPiped();
    if (piped) body = piped;
  }
  if (!title) die('需要 --title');
  if (!body) die('需要 --body 或 stdin');

  // 自动反查目标 chat（同 lark CLI 机制：tty → pending → chatId / fallback active chat）
  let chatId = flags.chat;
  if (!chatId) {
    const tty = getCurrentTty();
    const resolved = await sendOnce<LarkResolveChatData>({
      op: 'lark.resolve-chat',
      ...(tty ? { tty } : {}),
    });
    if (!resolved.chatId) {
      die('无法推断目标 chat 来发审批卡片，请用 --chat 或先在飞书 chat 里发个命令');
    }
    chatId = resolved.chatId;
    if (resolved.source !== 'pending') {
      stderr.write(
        `⚠ 没找到当前 tab 的 pending，回退到 ${resolved.source}=${chatId}\n`,
      );
    }
  }

  stderr.write(`⏳ 审批请求中…\n`);
  const taskId = process.env['AGENT_TASK_ID'];
  const reqPayload: Request = {
    op: 'approval.request',
    title,
    body,
    chatId,
    ...(taskId ? { taskId } : {}),
  };
  const data = await sendOnce<ApprovalRequestData>(reqPayload);

  const result = data.request;
  const resolvedBy = result.resolvedBy ?? 'unknown';
  if (result.status === 'approved') {
    stderr.write(`✅ approved by ${resolvedBy}\n`);
    stdout.write('approved\n');
    exit(0);
  } else if (result.status === 'rejected') {
    stderr.write(`❌ rejected by ${resolvedBy}\n`);
    stdout.write('rejected\n');
    exit(1);
  } else {
    stderr.write(`⌛ ${result.status}\n`);
    stdout.write(`${result.status}\n`);
    exit(2);
  }
}

async function cmdKnowledge(flags: Flags): Promise<void> {
  const sub = flags.positional[0] ?? 'stats';

  if (sub === 'stats') {
    const data = await sendOnce<import('./protocol.js').KnowledgeStatsData>({ op: 'knowledge.stats' });
    stdout.write(`Knowledge extraction · ${data.enabled ? '✅ ENABLED' : '⊘ 未启用（设 KNOWLEDGE_EXTRACT_ENABLED=1）'}\n`);
    stdout.write(`总条目：${data.total}\n`);
    if (data.total > 0 && data.latestAt) {
      stdout.write(`最新：${new Date(data.latestAt).toISOString()}\n`);
      stdout.write(`按 kind:\n`);
      for (const [k, v] of Object.entries(data.byKind)) stdout.write(`  ${k}: ${v}\n`);
    }
    stdout.write(`队列：${data.queueSize} 个待提取\n`);
    return;
  }

  if (sub === 'list') {
    const opts: Parameters<typeof sendOnce>[0] = {
      op: 'knowledge.list',
      limit: flags.lines ?? 20,
    };
    if (flags.cwd) (opts as unknown as Record<string, unknown>)['cwd'] = flags.cwd;
    const data = await sendOnce<import('./protocol.js').KnowledgeListData>(opts as unknown as Request);
    if (data.entries.length === 0) { stdout.write('(空)\n'); return; }
    for (const e of data.entries) {
      const ts = new Date(e.createdAt).toISOString().replace('T', ' ').slice(0, 16);
      const cwd = e.source.cwd ? ` · ${e.source.cwd.replace(/^.+\//, '')}` : '';
      stdout.write(`[${ts}] ${e.kind}${cwd}  ·  ${e.title}\n`);
      stdout.write(`  tags: ${e.tags.join(', ')}\n`);
      stdout.write(`  id: ${e.id}\n\n`);
    }
    return;
  }

  if (sub === 'show') {
    const id = flags.positional[1];
    if (!id) die('agent knowledge show <id>');
    const data = await sendOnce<import('./protocol.js').KnowledgeListData>({ op: 'knowledge.list', limit: 1000 } as never);
    const e = data.entries.find((x) => x.id === id || x.id.startsWith(id));
    if (!e) die(`no entry: ${id}`);
    stdout.write(`# ${e.title}\n\n`);
    stdout.write(`Kind: ${e.kind}\n`);
    stdout.write(`Created: ${new Date(e.createdAt).toISOString()}\n`);
    stdout.write(`Tags: ${e.tags.join(', ')}\n`);
    stdout.write(`Origin: ${e.source.origin}${e.source.cwd ? ' · ' + e.source.cwd : ''}\n`);
    if (e.source.commandsRun?.length) {
      stdout.write(`Commands: ${e.source.commandsRun.slice(0, 5).join(' | ')}\n`);
    }
    stdout.write(`\n---\n\n${e.body}\n`);
    return;
  }

  if (sub === 'extract-last' || sub === 'el') {
    const tty = await resolveTargetTty(flags);
    const lines = flags.lines ?? 200;
    const data = await sendOnce<import('./protocol.js').KnowledgeExtractLastData>({
      op: 'knowledge.extract-last',
      tty,
      lines,
    });
    if (data.queued) {
      stdout.write(`✓ 已入队（${data.chunkLen} 字符）· 后台跑 claude -p，几秒后 agent knowledge list 看结果\n`);
    } else {
      stdout.write(`⊘ 未入队：${data.reason ?? '(未知原因)'}\n`);
      exit(1);
    }
    return;
  }

  die(`agent knowledge <stats|list [-n N] [--cwd X]|show <id>|extract-last [-t tty] [-n lines]>`);
}

function printHelp() {
  stdout.write(
    [
      'agent — multiAgentChat CLI（控制 Mac 上 Terminal.app 的 tab）',
      '',
      '查看：',
      '  agent tabs                          列所有 Terminal tab，按 window 分组（★ = CLI 默认）',
      '  agent show [-t tty] [-n 60]         看 tab 屏幕历史 tail',
      '  agent which                         CLI 当前默认 tab',
      '  agent chat <chatId>                 看飞书 chat 状态',
      '',
      '操作：',
      '  agent use <tty>                     设 CLI 默认 tab',
      '  agent send [-t tty] [--wait] "cmd"  发命令到 tab（A 模式自然 do script）',
      '  agent open [path] [--new-window]    开新 tab，默认 front window，可选新 window',
      '  agent close <tty>                   关 tab（关整 window；自动过 Terminal 关闭确认框）',
      '  agent restart-all-claude-tabs       原地重启所有 claude tab（Ctrl-C 退出 → 纯 claude 重跑）',
      '     默认排除发起命令的 tab；默认全新 claude（不带历史）；默认 dry-run，加 --yes 才执行',
      '     选项：--yes 真执行  --dry-run 只列  --continue 续上次会话  --except t1,t2 额外排除  --include-self 连自己',
      '  agent recent-cwds                   最近用过的 cwd',
      '  agent screen [-t tty] [--chat X]    抓 tab 所在窗口截图（含 alt-screen TUI）+ 自动推图到飞书',
      '  agent keys [-t tty] \'<seq>\'         往 tab 发按键序列（osascript System Events）',
      '     语法：d=↓ u=↑ l=← r=→ .=空格 ⏎=回车 t=tab x=esc',
      '           修饰：ctrl+c cmd+k alt+f  连发：3d 或 d*3  打字：\'hello world\'',
      '           例：agent keys \'2d . ⏎\'      # ↓↓ 空 回',
      '',
      '飞书外发（供 shell 里 agent 调用）：',
      '  agent lark send-text [--chat X] "..."    发文本（自动反查当前 tab 对应 chat）',
      '  agent lark send-card [--chat X] \'<json>\'   发卡片',
      '  agent lark send-file [--chat X] <path>   发文件（xlsx/pdf/zip/任意）',
      '  agent lark send-image [--chat X] <path>  发图片',
      '  agent lark which-chat                    看当前 tab 默认发哪个 chat',
      '  agent lark ask <single|multi|input> --title "..." [--options "a,b,c"] [--timeout ms]',
      '       弹飞书交互卡片，阻塞式拿答案（stdout JSON）；退出码 0/1/2 = 答完/取消/超时',
      '       例：agent lark ask single --title "选一个" --options "A,B,C"',
      '            agent lark ask multi  --title "勾几个" --options "1,2,3"',
      '            agent lark ask input  --title "输入什么"   # 用户在 chat 回文本',
      '',
      '企业微信外发（企微 transport，需 .env 里 WECOM_* 5 项）：',
      '  agent wecom send-text [--chat wecom:user:X] "..."',
      '  agent wecom send-file [--chat X] <path>',
      '  agent wecom send-image [--chat X] <path>',
      '  agent wecom which-chat                   看当前默认企微 chat',
      '       --chat 不给时走 WECOM_DEFAULT_TO_USER；@target 派发到 tab 目前只支持',
      '       企微收消息端（企微 chat → @ttys003 命令），CLI 侧发消息不涉及 tab',
      '',
      '安装 Claude Code 全局 skill：',
      '  agent install-skill                      把 multiagent-lark 装到 ~/.claude/skills/',
      '                                            装完所有 Mac 上的 claude 都自动知道用 agent lark',
      '  agent uninstall-skill',
      '',
      '审批：',
      '  agent approvals                     列待审批和最近',
      '  agent approve <id>',
      '  agent reject <id>',
      '  agent request-approval --title T --body B    供 agent 调用',
      '',
      'SOP 任务（多 stage 编排，主 claude 在 tab 内调用）：',
      '  agent task list [--status running|awaiting-gate|done|failed] [-n N]',
      '  agent task here                       当前 tty 上进行中的 task',
      '  agent task show <task-id>            或 --task-id（也可读 AGENT_TASK_ID env）',
      '  agent task stage --task-id X --name <stage> --start',
      '  agent task stage --task-id X --name <stage> --end [--summary "..."] [--artifact path]',
      '       ↑ 若该 stage 命中 gate（如 after-architect），命令会阻塞等审批',
      '  agent task stage --task-id X --name <stage> --fail [--note "..."]',
      '       ↑ stdout 若输出 `loopback:<stage>` = 已 reset 那段 stages，主 claude 应从该 stage 重跑',
      '  agent task stage --task-id X --name <stage> --skip --reason "..."',
      '       主 agent 判定该 stage 没必要时跳过（状态变 skipped，不触发 loops）',
      '  agent task abort <task-id> [--hard] [--reason "..."]',
      '  agent task abort --here [--hard]      自动找当前 tty 的 task 中止',
      '       ↑ soft（默认）：保留已完成 stage artifact；hard：claude 立刻停手不写收尾',
      '  agent stage-recall [--name <stage>] [--cwd <dir>] [-n N] [kw1 kw2 ...]',
      '       查跨任务的 stage memory（"上次 architect 在这个 cwd 做了啥"）',
      '',
      '诊断：',
      '  agent doctor                 全项目健康检查（Node/env/socket/AppleScript/skill/subagent...）',
      '',
      'Subagent 管理（Claude Code 自定义 subagent）：',
      '  agent subagent list                    列所有可用 subagent（用户全局 + 项目本地）',
      '  agent subagent show <name>             看某个 subagent 详情 + system prompt',
      '  agent subagent add <name> --body "..." 手工加（body 从 stdin 也行）',
      '       可选：--title/--reason=description  --artifact "A,B,C"=tools',
      '             --summary=model  --note=color  --skip=写到项目本地',
      '  agent subagent delete <name>',
      '  agent subagent gen-submit --task-id X --chat Y --body <json>',
      '       主 claude 生成 subagent JSON 后走这条落盘（一般不用手调）',
      '       飞书里发 `/subagent gen <desc>` 主 claude 会自动调',
      '',
      '  agent help',
    ].join('\n') + '\n',
  );
}

// EPIPE 处理：被 head/less 之类的 pipe 提前关闭时不要 crash
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') exit(0);
});

async function main(): Promise<void> {
  const [, , cmd = 'help', ...rest] = argv;
  const flags = parseArgs(rest);
  try {
    switch (cmd) {
      case 'tabs':
      case 'ls':
      case 'shells':
        return await cmdTabs();
      case 'use':
        return await cmdUse(flags);
      case 'which':
        return await cmdWhich();
      case 'send':
        return await cmdSend(flags);
      case 'open':
      case 'new':
        return await cmdOpen(flags);
      case 'show':
      case 'history':
        return await cmdShow(flags);
      case 'close':
        return await cmdClose(flags);
      case 'restart-all-claude-tabs':
      case 'restart-claude':
        return await cmdRestartClaudeTabs(flags);
      case 'tapd':
        return await cmdTapd(flags);
      case 'screen':
        return await cmdScreen(flags);
      case 'keys':
        return await cmdKeys(flags);
      case 'chat':
        return await cmdChat(flags);
      case 'recent-cwds':
        return await cmdRecentCwds();
      case 'lark':
        return await cmdLark(flags);
      case 'wecom':
        return await cmdWeCom(flags);
      case 'install-skill':
        return await cmdInstallSkill();
      case 'uninstall-skill':
        return await cmdUninstallSkill();
      case 'approvals':
        return await cmdApprovals();
      case 'approve':
        return await cmdApprove(flags);
      case 'reject':
        return await cmdReject(flags);
      case 'request-approval':
        return await cmdRequestApproval(flags);
      case 'task':
        return await cmdTask(flags);
      case 'stage-recall':
        return await cmdStageRecall(flags);
      case 'doctor':
        return await cmdDoctor();
      case 'connect':
      case 'onboard':
        return await cmdConnect(flags);
      case 'subagent':
        return await cmdSubagent(flags);
      case 'knowledge':
      case 'kb':
        return await cmdKnowledge(flags);
      case 'help':
      case '--help':
      case '-h':
        printHelp();
        return;
      default:
        stderr.write(`未知命令：${cmd}\n\n`);
        printHelp();
        exit(2);
    }
  } catch (e) {
    stderr.write(`agent: ${(e as Error).message}\n`);
    exit(1);
  }
}

main();
