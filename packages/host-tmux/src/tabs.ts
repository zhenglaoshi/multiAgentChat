/**
 * tmux pane ⇄ `TerminalTab` 的适配层。
 *
 * 主键仍是 **tty**（`#{pane_tty}` 就是 `/dev/pts/N`），所以上层 46 处调用点的写法零改动；
 * 内部再把 tty 翻成 tmux 的 pane id（`%N`）去下命令 —— pane id 才是 tmux 的稳定标识。
 */

import type { SendResult, TerminalTab, UserFocus, ForceEnterOptions, ForceEnterResult, NewTabOptions, WaitForOutputOptions } from 'multiagent-host-api';
import { findTuiProc, hasTuiProc, logger } from 'multiagent-orchestrator';
import { ensureSession, MCHAT_SESSION, runTmux, runTmuxSoft, sendLiteral } from './tmux.js';
import { inferBusy, snapshotProcsByTty } from './procs.js';
import { resolvePane } from './pane.js';

const FS = String.fromCharCode(31); // field separator

/** `capture-pane` 往回取多少行 scrollback。 */
const HISTORY_LINES = Number(process.env['MCHAT_TMUX_HISTORY_LINES'] ?? 3000);

const LIST_FORMAT = [
  '#{pane_tty}',
  '#{pane_id}',
  '#{window_id}',
  '#{window_active}',
  '#{pane_index}',
  '#{pane_title}',
  '#{pane_current_path}',
].join(FS);

interface PaneRow extends TerminalTab {
  /** tmux 的 pane id（`%3`）—— 下命令用它，不用 tty */
  paneId: string;
}

/**
 * 去掉控制字符（含 0x1F 分隔符自身与换行）。
 * `pane_title` 是 **pane 里跑的任意程序**都能用 OSC 转义序列设置的（`ESC ] 2 ; TITLE BEL`），
 * 也就是说它是本项目威胁模型里的不可信输入；`pane_current_path` 同理可含异常字节。
 * 放进 `TerminalTab` 前先洗一遍，避免脏数据流进 worktask 记录 / 报告 cwd 归因等下游。
 */
function stripControlChars(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/[\u0000-\u001F\u007F]/g, '');
}

/**
 * 解析 `list-panes -F` 的一行。纯函数，便于单测。
 *
 * ⚠ 字段数要求**严格等于 7**：title/cwd 里若混进字面的 0x1F，`>= 7` 会让解构错位
 * （cwd 拿到 title 的尾巴、真 cwd 被吞），而字段数异常本身就是"这行不可信"的信号 —— 宁可丢掉。
 * 换行注入（标题里塞 0x0A 把一行劈成两行、伪造一条 PaneRow）同样被这条挡掉大半：
 * 伪造行凑不齐 7 个 0x1F 字段。
 *
 * 另：**写操作的目标 pane 一律走 `pane.ts` 的 `resolvePane`**（格式串只有 `#{pane_tty} #{pane_id}`，
 * 两个字段都由 tmux/内核分配、不可被 pane 内程序污染）。**别为了省一次 tmux 调用，
 * 把这里解析出来的 paneId 拿去做写操作** —— 那会把一条可污染的数据路径接到"往哪个终端写"上。
 */
export function parsePaneRow(line: string, procsByTty: Map<string, string[]>): PaneRow | null {
  const f = line.split(FS);
  if (f.length !== 7) return null;
  const [tty, paneId, windowId, windowActive, paneIndex, rawTitle, rawCwd] = f;
  if (!tty || !paneId) return null;
  const title = stripControlChars(rawTitle ?? '');
  const cwd = stripControlChars(rawCwd ?? '');
  const processes = procsByTty.get(tty) ?? [];
  return {
    tty,
    paneId,
    // tmux 的 window_id 形如 "@3"；TerminalTab.windowId 是 number，取数字部分（仅用于分组/展示）
    windowId: Number((windowId ?? '').replace(/^@/, '')) || 0,
    windowFrontmost: windowActive === '1',
    tabIndex: Number(paneIndex) || 0,
    title,
    busy: inferBusy(processes),
    processes,
    cwd: cwd || undefined,
    hasTUI: hasTuiProc(processes),
  };
}

async function listPaneRows(): Promise<PaneRow[]> {
  const [out, procs] = await Promise.all([
    runTmuxSoft(['list-panes', '-a', '-F', LIST_FORMAT]),
    snapshotProcsByTty(),
  ]);
  if (out === null) return [];   // tmux server 没起 = 一个 pane 都没有，不是错误
  const rows: PaneRow[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const row = parsePaneRow(line, procs);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * 列 pane。
 * ⚠ 与 macOS 宿主的一处差异：cwd **顺带就填了**（`#{pane_current_path}` 是 tmux 白送的字段，
 * 不像 Mac 要为每个 tab 跑一次 lsof）。所以这里 raw 版也带 cwd，`enrichTabsWithCwd` 退化成恒等。
 */
export async function listTabsRaw(): Promise<TerminalTab[]> {
  return (await listPaneRows()).map(({ paneId: _paneId, ...tab }) => tab);
}

export async function listTabs(): Promise<TerminalTab[]> {
  return listTabsRaw();
}

/** cwd 在 listTabsRaw 就填好了 → 这里是恒等（保留方法是为了满足契约、调用点零改动）。 */
export async function enrichTabsWithCwd(tabs: TerminalTab[]): Promise<TerminalTab[]> {
  return tabs;
}

export async function getCwd(tty: string): Promise<string | undefined> {
  const rows = await listPaneRows();
  return rows.find((r) => r.tty === tty)?.cwd;
}

/**
 * 取 pane 的屏幕内容 + scrollback。
 *
 * ⚠ **与 macOS 的语义差异**（会影响 watcher）：`capture-pane` 拿的是**当前屏幕**（alt-screen 下就是
 * claude/codex 正在显示的那屏）加上普通缓冲区的 scrollback，**不是单调增长的流水**。
 * 好处：Mac 上 `contents of tab` 在 alt-screen 返回 missing value 的老大难在这里不存在，TUI 内容读得到；
 * 代价：`taskOnlyTail = fullHist.slice(beforeCharLen)` 这种「按偏移切尾巴」的算法在长度回缩时会取到空串。
 * watcher 的变化检测（比字符总数）不受影响。详见 docs/windows-port.md §6.4。
 */
export async function getHistory(tty: string): Promise<string> {
  const pane = await resolvePane(tty);
  if (!pane) return '';
  return captureByPane(pane);
}

/**
 * 抓屏的底层调用。
 *
 * ⚠ **调用方只能传从 `pane.ts` 的 `resolvePane()` 拿到的 paneId**，不能传 `listPaneRows()` 里的。
 * 曾经为省一次 `list-panes` 在 `waitForOutput` 里直接用了后者，被安全复审指出可被绕过：
 * `#{pane_title}` 是 pane 内程序能用 OSC 序列自行设置的，塞一个换行 + 6 个 0x1F 分隔的伪造字段，
 * 就能在 `-F` 输出里**拼出一条字段数恰好为 7、能通过全部校验的假行**；假行里的 paneId 若是别的真实
 * pane，这次 capture 就会读到**另一个 pane 的屏幕**并当作本任务输出回传飞书 —— 跨 pane 信息泄露。
 * `resolvePane` 的格式串只有 `#{pane_tty} #{pane_id}`（无自由文本字段，天然不可伪造），所以纪律很简单：
 * **paneId 只信 pane.ts**。省下的那一次进程 spawn 不值得开这个口子。
 */
async function captureByPane(pane: string): Promise<string> {
  // `-J`：把被终端宽度软换行的长行**拼回一行**，与 macOS `history of tab` 的语义对齐（实测 Terminal.app
  // 返回的行可长于列数，即不软换行）。不加的话，一条超过 pane 宽度的菜单选项（codex 的
  // "don't ask again for commands that start with `<整条命令>`"）会被切成多行 → 选项行不相邻 →
  // `parseNativeMenu` 认不出 → 手机端收不到选择框。
  return (await runTmuxSoft(['capture-pane', '-p', '-J', '-t', pane, '-S', `-${HISTORY_LINES}`])) ?? '';
}

/**
 * 往 pane 写「文本 + 回车」**一整块** —— 对应 host-mac 的 `sendKeysRaw`（`do script`）。
 *
 * ⚠ 这里必须原样复刻 macOS 的字节语义，否则两个宿主行为分叉：
 * Terminal 的 `do script X` 往 pty 写的是 `X + "\r"` 一整块，于是
 *  - 裸 shell 里 → shell 读到整行 + 换行 → **命令直接执行**；
 *  - agent TUI 里 → 多字符块被当「粘贴」，块内 `\r` 只算换行 → **不提交**（要靠 forceEnter 单独补一个 \r）。
 * 如果这里只写文本不带 `\r`，裸 shell 里发的命令就永远停在提示符上不执行，
 * 而调用方并不会补回车（`shouldSubmitPromptAfterSend` 只在跑着 agent TUI 时才补）——
 * 表现就是「发了命令没反应」。
 *
 * 用单次 `send-keys -l` 写完整块（含末尾 `\r`），保证 TUI 侧不会把回车读成独立的一次提交。
 */
export async function sendKeysRaw(tty: string, text: string): Promise<boolean> {
  const pane = await resolvePane(tty);
  if (!pane) return false;
  try {
    await sendLiteral(pane, `${text}\r`);
    return true;
  } catch (e) {
    logger.warn('tmux send-keys 失败', { tty, err: (e as Error).message });
    return false;
  }
}

/**
 * 高级 send：先挡独占式 TUI（vim/htop 等，送字符会破坏），再写文本。
 * 判据与 macOS 宿主逐字一致（同一份 TUI 名单，见 orchestrator/agents/tab-status.ts）。
 */
export async function send(tty: string, text: string): Promise<SendResult> {
  const rows = await listPaneRows();
  const tab = rows.find((t) => t.tty === tty);
  if (!tab) return { ok: false, reason: `tab 不存在：${tty}` };
  if (tab.hasTUI) {
    const tuiProc = findTuiProc(tab.processes);
    return {
      ok: false,
      reason: `tab ${tty} 当前在跑 ${tuiProc}（TUI），发字符会破坏，已拒绝。可在终端里退出后重试。`,
    };
  }
  const before = (await getHistory(tty)).split('\n').length;
  const sent = await sendKeysRaw(tty, text);
  if (!sent) return { ok: false, reason: 'send-keys 没找到 pane' };
  return { ok: true, before };
}

/**
 * 提交一次回车。
 *
 * **这是 tmux 宿主相对 macOS 最大的收益**：`send-keys Enter` 就是往 pane 的 pty 写回车字节，
 * 由后台 tmux server 完成 —— 不需要键盘焦点、不经窗口系统，所以
 * **锁屏、别的窗口在前台、系统弹框压着，全都照常提交**（Mac 的 keystroke 兜底在这些情况下会 blocked，
 * 历史上"发了指令没反应"就是它）。因此 `blocked` 恒为 false，也没有 keystroke 退路可言。
 *
 * ⚠ 调用方仍要在「送文本」和本次回车之间留 ≥400ms：两次写入若被 TUI 一次 read 合并，
 * 会整块当粘贴处理而不提交 —— 这条与平台无关（见 host-mac/terminal/tabs.ts 的字节级实测记录）。
 */
export async function forceEnter(tty: string, _opts?: ForceEnterOptions): Promise<ForceEnterResult> {
  // 与 macOS 的 pty 直写同构：空文本 + `\r` = 单独一个回车字节，TUI 视为真回车。
  // 不用 `send-keys Enter`（按键名）是为了与 sendKeysRaw 走同一条字面通道，字节完全一致。
  const sent = await sendKeysRaw(tty, '');
  return { ok: sent, blocked: false, via: 'pty' };
}

/** 发完等输出稳定，返回新增内容。逻辑与 host-mac 同构（轮询 + 稳定计数）。 */
export async function waitForOutput(
  tty: string,
  beforeLineCount: number,
  opts: WaitForOutputOptions = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const pollMs = opts.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let lastLen = -1;
  let stableTicks = 0;
  const tail = (arr: string[]): string => {
    const diff = arr.slice(beforeLineCount).join('\n').trim();
    return diff.split('\n').length < 3 ? arr.slice(-30).join('\n').trim() : diff;
  };
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const rows = await listPaneRows();
    const tab = rows.find((t) => t.tty === tty);
    // 走 getHistory（内部经 resolvePane 解析）而不是复用 rows 里的 paneId —— 见 captureByPane 的说明
    const arr = (await getHistory(tty)).split('\n');
    if (arr.length === lastLen) stableTicks++;
    else { stableTicks = 0; lastLen = arr.length; }
    if (tab && !tab.busy && stableTicks >= 2) return tail(arr);
  }
  return tail((await getHistory(tty)).split('\n'));
}

/**
 * 把 `NewTabOptions` 翻成 tmux argv。**纯函数**，便于单测（真建 pane 没法在 CI 里跑）。
 *
 * 层级对应：Terminal.app 的「窗口 ⊃ 标签页」≈ tmux 的「session ⊃ window」，pane 是 window 里的分屏。
 * 我们一个 window 只放一个 pane，所以：
 *  - `new-tab`            → 在现有 session 里 `new-window`，并**切过去**（对应 Mac 新建标签页会被选中）
 *  - `new-tab-background` → 同上但加 `-d`，不抢当前视图（Mac 那边是"不把新 tab 选为当前"）
 *  - `new-window`         → 新建一个**独立 session**（对应 Mac 的另开一个窗口：可单独 attach、单独关掉）
 *
 * ⚠ 之前这里把 mode 整个忽略了 —— `agent open --new-window` 会静默退化成开标签页。
 * 参数被无声吞掉是最难排查的一类偏差，所以三种 mode 现在各走各的。
 */
export function buildNewTabArgs(opts: NewTabOptions, session: string | null, sessionName: string): string[] {
  const mode = opts.mode ?? 'new-tab';
  const args: string[] =
    mode === 'new-window'
      ? ['new-session', '-d', '-s', sessionName, '-P', '-F', '#{pane_tty}']
      : ['new-window', '-t', session ?? '', '-P', '-F', '#{pane_tty}'];
  // Mac 的 new-tab-background 不把新 tab 选为当前 → tmux 的 -d 不切过去
  if (mode === 'new-tab-background') args.splice(1, 0, '-d');
  if (opts.cwd) args.push('-c', opts.cwd);
  return args;
}

/** 新建 session 的名字（`new-window` 模式用）——带时间戳后缀避免与已有 session 撞名。 */
export function newSessionName(now = Date.now()): string {
  return `${MCHAT_SESSION}-${now.toString(36)}`;
}

/**
 * 开新 pane，返回它的 tty。
 * 三种 mode 的语义见 `buildNewTabArgs`。
 */
export async function newTab(opts: NewTabOptions = {}): Promise<string> {
  // new-window 模式要建独立 session，不需要（也不该）先确保现有 session 存在。
  // 用 null 而不是空字符串表达「这个分支根本不需要 session」—— 哨兵空串容易被后来人当成合法值误用。
  const session = opts.mode === 'new-window' ? null : await ensureSession();
  const out = await runTmux(buildNewTabArgs(opts, session, newSessionName()));
  const tty = out.trim();
  if (!tty) throw new Error('tmux 新建 pane 没返回 tty');
  return tty;
}

/** 硬关 pane。 */
export async function closeTab(tty: string): Promise<boolean> {
  const pane = await resolvePane(tty);
  if (!pane) return false;
  return (await runTmuxSoft(['kill-pane', '-t', pane])) !== null;
}

/**
 * 「谁在最前」。
 *
 * tmux 没有 GUI 焦点这一维 —— 按键注入不依赖焦点，所以这里恒报 `terminalFrontmost: true`
 * （语义是「终端可用、可以送按键」，keystroke 类守卫据此放行是正确的）。
 * `tty` 给的是当前 active window 的 active pane，没有就 null。
 *
 * ⚠ 前提假设：**只有一个 session**（`ensureSession()` 优先复用已存在的）。`#{window_active}` 是
 * 按 session 各自独立的，用户若在 daemon 之外另开了 session，会有多个 pane 同时 active，
 * 这里只取第一个。唯一消费点是「attach 老 tab 还是开新 tab」的启发式判断，判错只多开一个 tab。
 */
export async function getUserFocus(): Promise<UserFocus> {
  const rows = await listPaneRows();
  const active = rows.find((r) => r.windowFrontmost);
  return { terminalFrontmost: true, tty: active?.tty ?? null };
}
