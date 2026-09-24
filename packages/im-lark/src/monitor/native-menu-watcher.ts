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
import { createHash } from 'node:crypto';
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
/**
 * 审批正文的展示预算 —— **超出就 fail-closed（发无按钮的提示卡、不 arm），绝不截断展示**。
 *
 * 早先是「>80 行则留头 45 + 尾 25、中间显式省略」。两位 reviewer 2026-09-15 各用真代码证明任何截断都能被
 * 模型可控的命令体利用：诱饵头行放很上面把 excerpt 撑长 / 命令前后各塞几十行 → 真命令恰好落进省略区，
 * 卡片按钮照常可点 = 盲批。所以现在只有两种结果：整段 excerpt 原样进卡片，或明确告诉人"太长看不全，去电脑前"。
 * 行数预算 ≥ SNAPSHOT_SLACK（80）+ 一段正常审批 + 选项尾窗（40），正常永远够用；超预算多半是扫全屏兜到了大段旧历史。
 * 字节预算按 **UTF-8 字节**算（中文一个字 3 字节）：飞书交互卡整卡 JSON 上限 30KB，正文之外还有页脚、
 * 按钮（`value.label` 带完整选项原文 ×3）、脱敏后可能变长的占位；12KB 给正文留足余量。
 * 数字有没有事实依据是 code-reviewer 2026-09-15 追问的点：早先写 2 万**字符**，中文按字节早已顶破 30KB，
 * 而发送失败会被吞成一条 warn、用户什么都收不到 —— 比"提示看不了"更糟。已用真实 chat 发一张 ~12KB 的卡验证。
 */
const BODY_MAX_LINES = 260;
const BODY_MAX_BYTES = 12_000;

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

/**
 * per-tty「菜单出现之前的屏幕」指纹片段 —— 给 `parseNativeMenu({ scanFloor })` 定**时间下界**用。
 *
 * 为什么需要一个非文本的下界：提问行取"最上面的严格头行"是唯一不可伪造的方向，但"最上面"要有个底，
 * 否则缓冲区里所有旧审批都会被带上；而任何靠文本结构定的底（固定行数窗口 / 编号行哨兵 / 锚点切段）
 * 都被 security 评审 2026-09-15 用真代码逐一伪造过。唯一伪造不了的是**时间**：攻击者能写的文本都是在
 * 菜单出现之后打印的，一定在"菜单出现之前的屏幕内容"之下。
 *
 * 做法：每个**没有菜单**的 tick，从屏幕底部往上跳过 SNAPSHOT_SLACK 行（TUI 会重绘视口区域，那一段不稳定），
 * 取连续 3 行作片段。菜单出现时在当前屏幕里找该片段的**第一次**出现，其后一行就是扫描下界。
 * 取第一次而非最后一次：攻击者可在命令体里照抄这 3 行，最后一次可能是伪造的；第一次必是真实历史
 * （或更早的重复 → 下界更低 → excerpt 只会更大，安全方向）。找不到 → 下界 0（扫全屏 → 多半撞预算 → fail-closed）。
 *
 * ⚠ 两条采集纪律（security 评审 2026-09-15 第四轮 PoC：快照采自"同一次审批渲染到一半"的屏幕 —— 头行已出、
 * 选项未出、中间已有 >80 行 —— 片段落在真头行之下，下界越过真头行）：
 *  1. **连续两个无菜单 tick 取到同一片段、且「底部 SLACK 行之外整段屏幕」指纹相同才生效**（`pending` → `frag`）。
 *     渲染中的中间态在 3s 内一定会变（选项随即出现 → 变成有菜单 tick），采不到"稳定"；只有真正停下来的
 *     屏幕才会成为快照。为什么是区域指纹而不是片段/行数：见 `Snapshot.pending` 注释（第五、六轮 PoC）。
 *  2. **片段上方 SNAPSHOT_GUARD_ABOVE 行内（含片段自身位置）不能有严格头行**：有就把片段挪到那个头行之上
 *     再取（`takeSnapshotFragment(lines, anchor)`）。片段**下方**的头行不用管——下界在片段之后，那段审批
 *     整个落在下界之下，只会被带进 excerpt（超集 + 标注"以最下面一段为准"）。守卫只往上挪，必然终止。
 * 残余：渲染中途**停顿 ≥3s**（头行与选项之间）且停顿期间屏幕完全不变、再配诱饵头行。codex 的审批提示
 * 是模型输出完成后由 TUI 一次性绘制的，不是逐行流式，实际可达性极低；写在这里是为了让它可见。
 */
interface Snapshot {
  /** 已生效的片段（连续两 tick 一致） */
  frag: string[] | null;
  /**
   * 上一个无菜单 tick 取到的候选 + 当时「底部 SLACK 行之外整段屏幕」的 sha256，等下一 tick 确认。
   * ⚠ 一致性 = 片段字节相同 **且该区域指纹相同**。
   *  - 只比片段：自我重复的填充（同一句进度提示刷几百行）让"离底部 N 行"处采到的三行永远相同，屏幕在长
   *    却被判"稳定"（security 第五轮 PoC）。
   *  - 比行数：tmux `capture-pane -S -3000` 是固定深度滑动窗口，历史一超 3000 行行数就恒定；`\r` 原地重绘
   *    也不改行数（security 第六轮 PoC，且 CLAUDE.md 早就写过"不要用行数判变化"）。
   *  - 比区域内容指纹：任何增长 / 滚动 / 覆盖都会改变这段内容；spinner 等原地重绘只发生在视口（底部 SLACK 行内），
   *    不在指纹范围。残余：整个抓取窗口被**完全均匀**的填充灌满时滚动不改内容——但那时真头行已不在缓冲区里，
   *    任何只看屏幕的方案都无解（见 CHANGELOG）。
   */
  pending: { frag: string[]; regionHash: string } | null;
}
const snapshots = new Map<string, Snapshot>();
/**
 * 片段离屏幕底部的距离（行），同时也是「稳定性指纹」排除的底部区域。要大于 TUI 一帧重绘覆盖的**视口行数**
 * （TUI 只能重绘视口，视口之上的 scrollback 不可寻址），又不能大到把上一段审批常态性地带进来。
 * 本机大屏实测视口 ≈ 60-90 行，取 120；`NATIVE_MENU_SNAPSHOT_SLACK` 可调。
 */
const SNAPSHOT_SLACK = envNum('NATIVE_MENU_SNAPSHOT_SLACK', 120);
/** 3 行片段里至少要有这么多非空白字符，避免拿空行/分隔线当指纹造成过早的假匹配 */
const SNAPSHOT_MIN_INK = 20;
/** 片段上方多少行内出现严格头行就把片段挪到它之上（防"渲染到一半、头行已出"的屏幕把片段落在头行之下） */
const SNAPSHOT_GUARD_ABOVE = 200;

/**
 * 从无菜单的屏幕取指纹片段；缓冲区太短返回 []（= 下界 0，此时扫全屏本来也便宜且安全）。
 * 给了 `anchor`（agent 的严格头行）时：片段位置往上跳过 SLACK 后，若 [f - GUARD_ABOVE, f + 3) 里有头行，
 * 就把 f 挪到其中最上面那个头行之上再试（top ≤ f + 2 → f 严格递减，必然终止）。
 */
export function takeSnapshotFragment(lines: readonly string[], anchor?: RegExp): string[] {
  const ink = (s: string) => s.replace(/\s+/g, '').length;
  let f = lines.length - SNAPSHOT_SLACK - 3;
  while (f >= 0) {
    if (anchor) {
      let top = -1;
      for (let i = Math.max(0, f - SNAPSHOT_GUARD_ABOVE); i < Math.min(lines.length, f + 3); i++) {
        if (anchor.test(lines[i]!.trim())) { top = i; break; }
      }
      if (top >= 0) { f = top - 3; continue; }   // 片段必须整体位于该头行之上
    }
    const frag = [lines[f]!, lines[f + 1]!, lines[f + 2]!].map((l) => l.trimEnd());
    if (ink(frag[0]!) + ink(frag[1]!) + ink(frag[2]!) >= SNAPSHOT_MIN_INK) return frag;
    f--;
  }
  return [];
}

/** 「底部 SLACK 行之外整段屏幕」的内容指纹。 */
export function regionHashOf(lines: readonly string[]): string {
  const region = lines.slice(0, Math.max(0, lines.length - SNAPSHOT_SLACK));
  return createHash('sha256').update(region.join('\n')).digest('hex');
}

/**
 * 无菜单 tick 的快照推进：候选与上一 tick **片段相同且区域指纹相同**才生效。返回新的 Snapshot（纯函数，便于测试）。
 */
export function advanceSnapshot(prev: Snapshot | undefined, candidate: string[], regionHash: string): Snapshot {
  // 空候选（缓冲区太短 / 全程墨量不足）不算片段：`[]` 是 truthy、`[].every` 恒 true，不拦会把"啥都没采到"
  // 升成 frag，下游 floor 虽仍为 0，但 `bootstrap = !snap?.frag` 会误判成"已有基线"（code-reviewer low）
  const cand = candidate.length === 3 ? candidate : null;
  const p = prev?.pending;
  const same = !!cand && !!p && p.regionHash === regionHash && p.frag.every((l, i) => l === cand[i]);
  return { frag: same ? cand : (prev?.frag ?? null), pending: cand ? { frag: cand, regionHash } : null };
}

/** 在当前屏幕里定位片段的**第一次**出现，返回其后一行的下标作扫描下界；没有片段 / 找不到 → 0 */
export function floorFromSnapshot(lines: readonly string[], frag: readonly string[]): number {
  if (frag.length !== 3) return 0;
  for (let j = 0; j + 2 < lines.length; j++) {
    if (lines[j]!.trimEnd() === frag[0] && lines[j + 1]!.trimEnd() === frag[1] && lines[j + 2]!.trimEnd() === frag[2]) {
      return j + 3;
    }
  }
  return 0;
}

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
  // 提问行取的是窗口内**最上面**的严格头行（不可伪造的安全方向），两次审批落在同一窗口时会把上一段也带上。
  // 不能靠文本规则切掉（可伪造），只能如实标注。
  if (menu.anchorHits >= 2) {
    lines.unshift(`⚠️ **屏幕上有 ${menu.anchorHits} 段审批文案，以最下面一段为准**（上面的是更早已处理过的）`, '');
  }
  // 不截断：超预算的由 menuFitsCard 拦在前面，走 fail-closed 提示卡
  return lines.join('\n').trim();
}

/**
 * 这段审批正文能不能**完整**放进一张卡。放不下 → 调用方发无按钮提示卡 + 不 arm（fail-closed），
 * 而不是截断后照样给按钮。
 */
export function menuFitsCard(menu: NativeMenu): { ok: true } | { ok: false; lines: number; bytes: number } {
  const body = bodyFromMenu(menu);
  const lines = body.split('\n').length;
  const bytes = Buffer.byteLength(body, 'utf8');
  if (lines <= BODY_MAX_LINES && bytes <= BODY_MAX_BYTES) return { ok: true };
  return { ok: false, lines, bytes };
}

/** fail-closed 提示卡的原因：决定第一句怎么写，别把 API 错误也说成"太长" */
export type NoticeReason =
  | { kind: 'oversize'; lines: number; bytes: number; bootstrap: boolean }
  | { kind: 'send-failed'; error: string };

/** fail-closed 时推的提示卡正文：不带任何命令片段（半截命令比没有更误导） */
export function oversizeNoticeBody(menu: NativeMenu, reason: NoticeReason): string {
  const head = reason.kind === 'oversize'
    ? [
        `⚠️ **终端弹出了一个审批菜单，但内容太长（${reason.lines} 行 / ${Math.round(reason.bytes / 1024)}KB），手机上无法完整展示。**`,
        ...(reason.bootstrap
          ? ['（daemon 刚重启，还没有这段审批**之前**的屏幕基线，只能把整屏历史都算进来；这一条请到电脑前处理，下一次审批起会恢复正常。）']
          : []),
      ]
    : [`⚠️ **终端弹出了一个审批菜单，但卡片发送失败（${reason.error.slice(0, 80)}）。**`];
  return [
    ...head,
    '为避免看不全就批准，这次**不提供远程作答**，请到电脑前处理。',
    '',
    `问句：${menu.question}`,
    `选项：${menu.labels.map((l, i) => `${i + 1}. ${l.slice(0, 40)}`).join(' / ')}`,
  ].join('\n');
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
  bootstrap = false,
): Promise<{ sent: number; deferred: number; pending: number }> {
  const chats = await listAllChats();
  const targets = chats.filter(
    (c) => (c.activeTty === tty || c.watchAllTabs === true) && !alreadyPushed.has(c.chatId),
  );
  if (targets.length === 0) return { sent: 0, deferred: 0, pending: 0 };

  const fits = menuFitsCard(menu);
  const body = bodyFromMenu(menu);
  // fail-closed 提示卡：无按钮、不 arm。半截正文 + 按钮 = 盲批（评审 2026-09-15）
  const noticeCard = (reason: NoticeReason) => originShellPushCard({
    tty,
    ...(cwd ? { cwd } : {}),
    home: homedir(),
    body: oversizeNoticeBody(menu, reason),
    question: false,
  });
  const oversizeCard = fits.ok ? null : noticeCard({ kind: 'oversize', ...fits, bootstrap });
  const card = fits.ok
    ? originShellPushCard({
        tty,
        ...(cwd ? { cwd } : {}),
        home: homedir(),
        body,
        question: true,
        quickAnswerOptions: menu.labels,
      })
    : oversizeCard!;
  if (!fits.ok) logger.warn('原生菜单超出展示预算，改发无按钮提示卡（不 arm）', { tty: shortTty(tty), ...fits, bootstrap });

  let sent = 0;
  let deferred = 0;
  for (const chat of targets) {
    const arm = chat.askArm;
    if (arm && arm.tty !== tty && Date.now() - arm.at <= ASK_ARM_TTL_MS) {
      deferred++;   // 这个 chat 正等着别的 tab 作答 → 本轮不打扰、也不覆盖
      continue;
    }
    let armed = false;
    try {
      await sendCardMessage(client, chat.chatId, card);
      armed = fits.ok;
    } catch (e) {
      // 预算内的卡也可能被飞书拒（整卡 JSON 超 30KB / 元素超限等）。不能静默：那样用户什么都收不到，
      // 而这个 chat 不进 alreadyPushed 又会每 tick 重试刷 warn。降级发小提示卡（不 arm），仍是 fail-closed。
      logger.warn('原生菜单卡推送失败，降级为无按钮提示卡', { chatId: chat.chatId, tty, err: (e as Error).message });
      if (!fits.ok) continue;   // 提示卡自己失败，没有更小的可降级了
      try {
        await sendCardMessage(client, chat.chatId, noticeCard({ kind: 'send-failed', error: (e as Error).message }));
      } catch (e2) {
        logger.warn('原生菜单提示卡也推送失败', { chatId: chat.chatId, tty, err: (e2 as Error).message });
        continue;
      }
    }
    if (armed) {
      // arm：飞书点选项 / 直接回数字都经这里驱动本地菜单（与 AskUserQuestion 同一条路）
      await mutateChat(chat.chatId, (c) => {
        c.askArm = { tty, options: menu.labels, at: Date.now(), source: 'native-menu' };
      });
    }
    alreadyPushed.add(chat.chatId);
    sent++;
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
  const lines = screen ? screen.split('\n') : [];
  const snap = snapshots.get(tab.tty);
  const candidate = screen && adapter
    ? parseNativeMenu(screen, adapter.nativeMenuQuestion
        // 惰性：只有尾部真有选项块时才做全屏定位（无菜单 tick 不付这笔 O(n)）
        ? { questionAnchor: adapter.nativeMenuQuestion, scanFloor: () => (snap?.frag ? floorFromSnapshot(lines, snap.frag) : 0) }
        : {})
    : null;
  const menu =
    candidate
    && adapter
    // 没找到提问行 = 命令块与问句都不在 excerpt 里 → 推出去就是让人**盲批**，直接不镜像
    && candidate.questionFound
    && isNativeMenuScreen(candidate.excerpt, adapter.nativeMenuPatterns)
      ? candidate
      : null;

  if (!menu) {
    // 没有菜单的 tick：推进"菜单出现之前的屏幕"指纹（连续两 tick 一致才生效；下一个菜单的扫描下界从这里来）
    if (screen) snapshots.set(tab.tty, advanceSnapshot(snap, takeSnapshotFragment(lines, adapter?.nativeMenuQuestion), regionHashOf(lines)));
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
  const { sent, deferred, pending } = await pushMenu(client, tab.tty, tab.cwd, menu, prev.pushedTo, !snap?.frag);
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
  for (const tty of [...snapshots.keys()]) {
    if (!alive.has(tty)) snapshots.delete(tty);
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
  snapshots.clear();
}
