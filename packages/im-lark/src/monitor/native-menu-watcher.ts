/**
 * 原生菜单镜像 —— 把 agent **自己弹的**选择菜单推成飞书卡，让手机端能看见并作答。
 *
 * 补的是这个缺口：`AskUserQuestion` 走 PreToolUse hook 能镜像，但 agent 的原生菜单不走 hook。
 * 最典型的是 codex 的命令审批（由它自己的 `approval_policy` 触发）——我们的审批闸只在**自己的**
 * riskTier 判定命中时才发卡，判为 passthrough 的命令会由 codex 自己弹菜单，而那个菜单**没有任何
 * hook 事件**，daemon 只能从屏幕上看见它。用户 2026-09-14 实测：手机端一直收不到选择框、会话卡死。
 *
 * 实现上**不新造一套问答**，全程复用既有机制：
 *   屏幕识别（本模块）→ `originShellPushCard` 的选项按钮（与 AskUserQuestion 同一张卡）
 *   → `chat.askArm`（飞书点选项 / 直接回数字都能驱动）→ `driveAskSelect` 往 pty 写数字。
 * 答题路径与既有的 AskUserQuestion 远程作答**完全同源**，锁屏可用。
 *
 * 零额外宿主调用：只读 `watcher` 的缓存（它每 tick 已经拉过 tab 和 history）。
 *
 * ⚠ 三条在评审中用真代码验证出来的纪律，改动本文件前务必先读：
 *  1. **闸门只认 agent 专属成对措辞**（`adapter.nativeMenuPatterns`，AND），**不能**用
 *     `inferTabStatus`/通用 WAITING_PATTERNS —— 后者会被「assistant 自己写的编号式是非问句」命中，
 *     那等于往正在干活的 tab 里注入数字。
 *  2. **不抢占别的 tty 的 askArm**：askArm 是 per-chat 单槽位，覆盖掉别人的会让那张卡的按钮直接失效，
 *     而 AskUserQuestion 没有"未作答"的补救路径。
 *  3. **菜单消失要主动 disarm**：codex 没有 PostToolUse 那种"本地已作答"的 hook，
 *     人在电脑前直接按了键的话，arm 会一直悬到 5 分钟 TTL，期间任何一条纯数字消息都会被注进这个 tty。
 *
 * 配置：
 *  NATIVE_MENU_MIRROR=0        关闭本模块（默认开）
 *  NATIVE_MENU_STABLE_TICKS=2  连续几次看到同一个菜单才推（默认 2，防半绘制的屏幕）
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import { homedir } from 'node:os';
import {
  logger,
  detectAgentFromProcs,
  isNativeMenuScreen,
  parseNativeMenu,
  redact,
  type NativeMenu,
} from 'multiagent-orchestrator';
import { watcher } from './watcher.js';
import { sanitizeTerminalOutput } from './sanitize.js';
import { listAllChats, mutateChat } from '../chats/store.js';
import { sendCardMessage } from '../lark/api.js';
import { originShellPushCard } from '../lark/cards.js';
import { ASK_ARM_TTL_MS } from '../chats/types.js';

const POLL_MS = 3_000;
/** watcher 缓存超过这个久 → 视为它没在跑，跳过（别拿陈旧屏幕推卡） */
const CACHE_STALE_MS = 60_000;
/** 卡片正文最多带多少行（excerpt 通常远小于此） */
const BODY_MAX_LINES = 80;
/** 超长时保留的头部行数（问句 + 紧随其后的命令块） */
const BODY_HEAD_LINES = 45;
/** 超长时保留的尾部行数（选项 + 提交提示） */
const BODY_TAIL_LINES = 25;

function envNum(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
}
const STABLE_TICKS = envNum('NATIVE_MENU_STABLE_TICKS', 2);

interface MenuState {
  fingerprint: string;
  /** 连续看到同一个 fingerprint 的次数 */
  seen: number;
  /**
   * **已经收到这个菜单的 chat**（按 chatId 记，不是一个全局 bool）。
   * 早先用一个 bool：只要有任意一个 chat 推成功就置位，那些因为"正等别的 tab 作答"被跳过的 chat
   * 会对这个菜单**永久收不到卡**（静默漏送）。按 chat 记就能只给漏掉的那些补推。
   */
  pushedTo: Set<string>;
  /** 这个菜单至少推给过一个 chat（决定菜单消失时要不要 disarm） */
  everPushed: boolean;
}

/** per-tty 状态。菜单消失就删掉，于是下一个菜单能重新推。 */
const states = new Map<string, MenuState>();

let timer: NodeJS.Timeout | null = null;
/** tick 重入守卫：上一次还没跑完就跳过这一拍 */
let ticking = false;

function shortTty(tty: string): string {
  return tty.startsWith('/dev/') ? tty.slice(5) : tty;
}

/**
 * 卡片正文：**从提问行到屏幕末尾的原文**（含中间那段要批准的命令），脱噪后。
 *
 * 不是"屏幕尾部固定 N 行" —— 固定窗口比命令块短时，用户在手机上只会看到选项，
 * 那是**盲批**（security 评审 2026-09-15 指出，与公函「内容必须先于确认按钮到人眼前」冲突）。
 * 实在超长时从**顶部**截断并如实标注，而不是无声丢弃。
 */
export function bodyFromMenu(menu: NativeMenu): string {
  const lines = sanitizeTerminalOutput(menu.excerpt).split('\n');
  if (lines.length <= BODY_MAX_LINES) return lines.join('\n').trim();

  // ⚠ 超长时**头尾都要留**，只省中间。
  // 只留尾部的话，攻击面是「在危险命令后面塞 N 行无害输出」把命令挤出可见区；
  // 只留头部的话，反过来塞在前面即可。头（问句 + 紧随其后的命令块）与尾（选项）都是必须到人眼前的，
  // 省略处必须**显式可见**，不能是一句容易划过去的小字。
  const head = lines.slice(0, BODY_HEAD_LINES);
  const tail = lines.slice(-BODY_TAIL_LINES);
  const omitted = lines.length - head.length - tail.length;
  return [
    ...head,
    '',
    `⚠️ **中间省略 ${omitted} 行** —— 手机上看不到全部内容，拿不准就别批准（到电脑前看完整屏幕）`,
    '',
    ...tail,
  ].join('\n').trim();
}

/**
 * 清掉所有指向该 tty 的 askArm —— 等价于 `ask.disarm`，但走进程内（im-lark 本来就在 daemon 进程里）。
 * 用于「菜单消失」：codex 没有 PostToolUse 那种本地作答回执，只能靠屏幕上菜单没了来判断。
 */
async function disarmTty(tty: string): Promise<number> {
  const chats = await listAllChats();
  let n = 0;
  for (const chat of chats) {
    // 只清**自己设的**那把：askArm 与 AskUserQuestion 共用同一个槽位，
    // 同一 tty 在窄窗口内换了 agent 时，别把人家刚设好的 arm 当成自己的删掉
    if (chat.askArm?.tty !== tty || chat.askArm.source !== 'native-menu') continue;
    try {
      await mutateChat(chat.chatId, (c) => {
        if (c.askArm?.tty === tty && c.askArm.source === 'native-menu') delete c.askArm;
      });
      n++;
    } catch (e) {
      logger.warn('disarm askArm 失败', { chatId: chat.chatId, tty, err: (e as Error).message });
    }
  }
  return n;
}

/**
 * 推一张菜单卡给相关的 chat 并 arm。返回推成功的 chat 数（0 = 没人在看 / 全被占用）。
 *
 * 目标 chat：`activeTty === 该 tty`（任务多半就是从这个会话发出去的）或开了 `/watch on` 的。
 *
 * ⚠ **不抢占别的 tty 的 arm**：若该 chat 已有未过期、且指向**别的 tty** 的 askArm，本轮跳过它。
 * 覆盖的后果不只是"回的数字路由错 tab"——被覆盖那张卡的按钮会直接失效
 * （`driveAskSelectFromCard` 要求 `arm.tty === tty`），而 AskUserQuestion 没有"未作答"的补救路径，
 * 用户只能去电脑前手动操作。跳过则是自愈的：对方答完 / 过期后，下一个 tick 自然会推。
 */
async function pushMenu(
  client: Lark.Client,
  tty: string,
  cwd: string | undefined,
  menu: NativeMenu,
  alreadyPushed: Set<string>,
): Promise<{ sent: number; deferred: number; pending: number }> {
  const chats = await listAllChats();
  const targets = chats.filter(
    (c) => (c.activeTty === tty || c.watchAllTabs === true) && !alreadyPushed.has(c.chatId),
  );
  if (targets.length === 0) return { sent: 0, deferred: 0, pending: 0 };

  const card = originShellPushCard({
    tty,
    ...(cwd ? { cwd } : {}),
    home: homedir(),
    body: bodyFromMenu(menu),
    question: true,
    quickAnswerOptions: menu.labels,
  });

  let sent = 0;
  let deferred = 0;
  for (const chat of targets) {
    const arm = chat.askArm;
    if (arm && arm.tty !== tty && Date.now() - arm.at <= ASK_ARM_TTL_MS) {
      deferred++;   // 这个 chat 正等着别的 tab 作答 → 本轮不打扰、也不覆盖
      continue;
    }
    try {
      await sendCardMessage(client, chat.chatId, card);
      // arm：飞书点选项 / 直接回数字都经这里驱动本地菜单（与 AskUserQuestion 同一条路）
      await mutateChat(chat.chatId, (c) => {
        c.askArm = { tty, options: menu.labels, at: Date.now(), source: 'native-menu' };
      });
      alreadyPushed.add(chat.chatId);
      sent++;
    } catch (e) {
      logger.warn('原生菜单卡推送失败', { chatId: chat.chatId, tty, err: (e as Error).message });
    }
  }
  return { sent, deferred, pending: targets.length - sent };
}

/** 单个 tab 的处理。抛错由调用方吞掉并继续下一个 tab。 */
async function tickTab(client: Lark.Client, tab: { tty: string; cwd?: string; processes: string[] }): Promise<void> {
  const screen = watcher.getCachedHistory(tab.tty);
  const prev = states.get(tab.tty);

  // 该 tab 跑的是哪个 agent → 用它**自己**的成对措辞做闸门。
  // 刻意不用 inferTabStatus/通用 WAITING_PATTERNS：那套是给"显示提示"用的，宽得能被
  // assistant 自己写的编号问句命中，而这里的下一步是往 pty 注入数字。
  const adapter = detectAgentFromProcs(tab.processes);
  // ⚠ 顺序很关键：**先结构解析拿到有界的 excerpt，再用 excerpt 过成对措辞闸门**。
  // 反过来（拿整屏过闸）会被 scrollback 毒化：`getCachedHistory` 给的是**全量历史**，
  // 这个 tty 里只要**曾经**弹过一次真审批，那两句话就永久留在历史里 → 闸门对该 tty 永久为真，
  // 退化成只剩结构判据，而结构判据挡不住「模型自己写的编号问句」（两个 reviewer 各自用真代码复现过）。
  // 门槛还极低：这两句魔法短语逐字写在本仓库源码注释里，agent 自审 `cat` 一下就会点燃。
  const candidate = screen && adapter ? parseNativeMenu(screen) : null;
  const menu =
    candidate
    && adapter
    // 没找到提问行 = 命令块与问句都不在 excerpt 里 → 推出去就是让人**盲批**，直接不镜像
    && candidate.questionFound
    && isNativeMenuScreen(candidate.excerpt, adapter.nativeMenuPatterns)
      ? candidate
      : null;

  if (!menu) {
    // 菜单没了：若之前推过卡，说明这一轮已经被答掉（本地按键 or 远程数字）→ 主动 disarm。
    // 不做的话 arm 会悬到 5 分钟 TTL，期间任何一条纯数字消息都会被注进这个已经翻篇的 tty。
    if (prev?.everPushed) {
      const n = await disarmTty(tab.tty);
      if (n > 0) logger.info('原生菜单已消失，askArm 已解除', { tty: shortTty(tab.tty), chats: n });
    }
    states.delete(tab.tty);
    return;
  }

  if (!prev || prev.fingerprint !== menu.fingerprint) {
    // 新菜单（或菜单变了）→ 重新计稳定次数。菜单变了同样要先解掉旧 arm
    if (prev?.everPushed) await disarmTty(tab.tty);
    states.set(tab.tty, { fingerprint: menu.fingerprint, seen: 1, pushedTo: new Set(), everPushed: false });
    return;
  }
  prev.seen++;
  if (prev.seen < STABLE_TICKS) return;          // 还不够稳定（可能是半绘制的屏幕）

  // 已推过的 chat 会在 pushMenu 里被过滤掉；被 defer 的下个 tick 自然补推（自愈）
  const { sent, deferred, pending } = await pushMenu(client, tab.tty, tab.cwd, menu, prev.pushedTo);
  if (sent === 0) {
    if (deferred > 0) {
      logger.info('原生菜单暂缓推送（该会话正等别的 tab 作答）', { tty: shortTty(tab.tty), deferred });
    }
    return;
  }
  prev.everPushed = true;
  if (pending > 0) {
    logger.info('原生菜单部分推送，其余下轮补推', { tty: shortTty(tab.tty), sent, pending });
  }
  logger.info('原生菜单已镜像到飞书', {
    tty: shortTty(tab.tty),
    agent: adapter?.kind,
    options: menu.labels.length,
    // 屏幕原文可能含凭证 → 落本地日志前也过一遍脱敏，与出站路径保持一致
    question: redact(menu.question).clean.slice(0, 60),
    chats: sent,
  });
}

async function tick(client: Lark.Client): Promise<void> {
  if (watcher.getCacheAge() > CACHE_STALE_MS) return;
  const tabs = watcher.getCachedTabs();
  const alive = new Set<string>();

  for (const tab of tabs) {
    alive.add(tab.tty);
    // per-tab 兜底：一个 tab 出问题不该让同一 tick 里后面的 tab 全部漏检
    try {
      await tickTab(client, tab);
    } catch (e) {
      logger.warn('原生菜单检测失败', { tty: shortTty(tab.tty), err: (e as Error).message });
    }
  }

  // tab 没了 → 清状态，别让 Map 无限长
  for (const tty of [...states.keys()]) {
    if (!alive.has(tty)) states.delete(tty);
  }
}

/**
 * 启动原生菜单镜像。`NATIVE_MENU_MIRROR=0` 关闭。
 * 与 fleet-monitor 一样是纯读 watcher 缓存的旁路模块，挂了不影响主链路。
 */
export function startNativeMenuMirror(client: Lark.Client): void {
  if (process.env['NATIVE_MENU_MIRROR'] === '0') {
    logger.info('原生菜单镜像已关闭（NATIVE_MENU_MIRROR=0）');
    return;
  }
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    // 重入守卫（照 watcher.ts 的做法）：sendCardMessage 走 withRetry，飞书抖动时单次 tick
    // 轻松超过 POLL_MS；没有这个守卫时两次 tick 会拿到**同一个** MenuState 引用，
    // 各自判定"该推了"→ 同一张卡推两遍、askArm 被覆写两次。
    if (ticking) return;
    ticking = true;
    void tick(client)
      .catch((e) => logger.warn('原生菜单镜像 tick 失败', { err: (e as Error).message }))
      .finally(() => { ticking = false; });
  }, POLL_MS);
  timer.unref?.();
  logger.info('原生菜单镜像已启动', { pollMs: POLL_MS, stableTicks: STABLE_TICKS });
}

/** 停止（测试 / 需要时清理定时器） */
export function stopNativeMenuMirror(): void {
  if (timer) clearInterval(timer);
  timer = null;
  states.clear();
}
