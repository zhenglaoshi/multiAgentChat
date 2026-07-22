/**
 * Fleet 主动监控 —— 让 daemon 主动盯着 tab 舰队、该说话时说话（用户点选的 A 主动副驾 + C 异常哨兵）。
 *
 * 三件事：
 *  ① 卡住哨兵（C）：claude 忙碌(claude-active)但 history 连续 M 分钟无变化 → 推「可能卡住」告警（一次/次卡住）。
 *  ② 闲置提议（A）：tab 任务 done 后闲置 N 分钟(非 busy + 无 active pending) → 推「要继续吗」建议卡（一次/次 done）。
 *  ③ 每早摘要（A）：每天到点推「昨夜舰队干了啥」跨 tab 汇总（done + 在跑）。
 *
 * 零额外 AppleScript：全部读 `watcher` 单例的缓存（它已每 tick 拉全 tab + 缓存 busy/pending tab 的 history）
 * + `pendingTracker.recentDone()`。推送只发给 `watchAllTabs===true` 的 chat（没在看的不打扰）。
 *
 * 配置（env）：
 *  FLEET_MONITOR_ENABLED=0   关闭整个模块（默认开）
 *  FLEET_STUCK_MIN=8         卡住阈值分钟（默认 8）
 *  FLEET_IDLE_MIN=10         闲置提议阈值分钟（默认 10）
 *  FLEET_DIGEST_AT=09:00     每早摘要时间（默认 09:00，北京时区/本机时区）
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { logger } from 'multiagent-orchestrator';
import { inferTabStatus } from 'multiagent-host-mac';
import { watcher } from './watcher.js';
import { pendingTracker } from './pending.js';
import { listAllChats } from '../chats/store.js';
import { sendCardMessage } from '../lark/api.js';
import { ackCard } from '../lark/cards.js';
import { stuckDecision, digestDue, localDayStr, type StallState } from './fleet-monitor-logic.js';

const POLL_MS = 30_000;
const DIGEST_TICK_MS = 15 * 60_000;
const CACHE_STALE_MS = 3 * 60_000; // watcher 缓存超过这个久 → 视为 watcher 没在跑，跳过
const STATE_FILE = resolve('./data/fleet-monitor.json');

function envMin(name: string, def: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
}
const STUCK_MS = envMin('FLEET_STUCK_MIN', 8) * 60_000;
const IDLE_MS = envMin('FLEET_IDLE_MIN', 10) * 60_000;
const DIGEST_AT = process.env['FLEET_DIGEST_AT'] ?? '09:00';

function shortTty(tty: string): string {
  return tty.startsWith('/dev/') ? tty.slice(5) : tty;
}
function homeify(p: string): string {
  const h = homedir();
  return p.startsWith(h) ? '~' + p.slice(h.length) : p;
}
function trunc(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

const stall = new Map<string, StallState>();
const nudged = new Map<string, number>(); // tty → 已提醒过的 doneAt

interface FleetState {
  lastDigestDay?: string;
}
function loadState(): FleetState {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as FleetState;
  } catch {
    /* ignore */
  }
  return {};
}
function saveState(s: FleetState): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(s) + '\n', 'utf8');
  } catch (e) {
    logger.warn('fleet-monitor 状态持久化失败', { err: (e as Error).message });
  }
}

async function watchingChatIds(): Promise<string[]> {
  const chats = await listAllChats();
  return chats.filter((c) => c.watchAllTabs === true).map((c) => c.chatId);
}
async function pushAll(client: Lark.Client, chatIds: string[], card: unknown): Promise<void> {
  for (const chatId of chatIds) {
    try {
      await sendCardMessage(client, chatId, card);
    } catch (e) {
      logger.warn('fleet-monitor 推送失败', { chatId, err: (e as Error).message });
    }
  }
}

async function monitorTick(client: Lark.Client): Promise<void> {
  if (watcher.getCacheAge() > CACHE_STALE_MS) return; // watcher 没在跑 → 跳过
  const tabs = watcher.getCachedTabs();
  const now = Date.now();
  const live = new Set(tabs.map((t) => t.tty));
  for (const tty of [...stall.keys()]) if (!live.has(tty)) stall.delete(tty);
  for (const tty of [...nudged.keys()]) if (!live.has(tty)) nudged.delete(tty);

  const chatIds = await watchingChatIds();
  if (chatIds.length === 0) {
    // 没人看 → 仍更新 stall 快照(避免恢复看时误报存量停滞)，但不推送
    for (const tab of tabs) {
      const hist = watcher.getCachedHistory(tab.tty);
      if (typeof hist === 'string' && inferTabStatus(tab, hist).kind === 'claude-active') {
        stall.set(tab.tty, stuckDecision(stall.get(tab.tty), hist.length, now, STUCK_MS).state);
      } else stall.delete(tab.tty);
    }
    return;
  }

  for (const tab of tabs) {
    const hist = watcher.getCachedHistory(tab.tty);
    const kind = inferTabStatus(tab, hist).kind;

    // ① 卡住哨兵：claude 忙 + 有缓存 history + 停滞
    if (kind === 'claude-active' && typeof hist === 'string') {
      const dec = stuckDecision(stall.get(tab.tty), hist.length, now, STUCK_MS);
      stall.set(tab.tty, dec.state);
      if (dec.alert) {
        const mins = Math.round(STUCK_MS / 60_000);
        await pushAll(
          client,
          chatIds,
          ackCard({
            title: `🟠 ${shortTty(tab.tty)} 可能卡住了`,
            body:
              `claude 忙碌中但已 **${mins} 分钟无输出变化**${tab.cwd ? `\n📁 \`${homeify(tab.cwd)}\`` : ''}\n\n` +
              `若真卡住：\`/keys ${shortTty(tab.tty)} ctrl+c\` 打断，或 \`/shells\` 看看它在干嘛。`,
            template: 'orange',
          }),
        );
        logger.info('fleet: stuck alert', { tty: tab.tty, mins });
      }
    } else {
      stall.delete(tab.tty); // 非忙碌态 → 清停滞快照
    }

    // ② 闲置提议：非 busy + 无 active pending + 最近 done 距今 ≥ 阈值 + 没提醒过
    if (!tab.busy && pendingTracker.forTty(tab.tty).length === 0) {
      const done = pendingTracker.recentDone(30).find((d) => d.tty === tab.tty);
      if (done && now - done.doneAt >= IDLE_MS && nudged.get(tab.tty) !== done.doneAt) {
        const mins = Math.round((now - done.doneAt) / 60_000);
        await pushAll(
          client,
          chatIds,
          ackCard({
            title: `💡 ${shortTty(tab.tty)} 闲置 ${mins}min`,
            body:
              `上个任务「${trunc(done.taskDescription, 40)}」完成后已闲置 **${mins} 分钟**${tab.cwd ? `\n📁 \`${homeify(tab.cwd)}\`` : ''}\n\n` +
              `要继续用它派活吗？直接 @${shortTty(tab.tty)} 发命令，或 \`/shells\` 看全部 tab。`,
            template: 'blue',
          }),
        );
        nudged.set(tab.tty, done.doneAt);
        logger.info('fleet: idle nudge', { tty: tab.tty, mins });
      }
    }
  }
}

async function maybeDigest(client: Lark.Client): Promise<void> {
  const now = Date.now();
  const st = loadState();
  if (!digestDue(now, DIGEST_AT, st.lastDigestDay)) return;
  const chatIds = await watchingChatIds();
  // 即便没人看也标记今天已处理，避免恢复看时补推昨天的
  saveState({ lastDigestDay: localDayStr(now) });
  if (chatIds.length === 0) return;

  const done = pendingTracker.recentDone(30).filter((d) => now - d.doneAt < 24 * 3_600_000);
  const active = pendingTracker.all();
  const lines: string[] = [`过去 24h 完成 **${done.length}** 个任务：`];
  for (const d of done.slice(0, 15)) {
    lines.push(`✓ \`${shortTty(d.tty)}\` ${trunc(d.taskDescription, 46)}`);
  }
  if (done.length === 0) lines.push('（无）');
  if (active.length) {
    lines.push(`\n当前在跑 **${active.length}** 个：`);
    for (const p of active.slice(0, 10)) {
      lines.push(`⏳ \`${shortTty(p.tty)}\` ${trunc(p.taskDescription ?? p.originalPrompt ?? '', 46)}`);
    }
  }
  await pushAll(
    client,
    chatIds,
    ackCard({ title: '🌅 昨夜舰队摘要', body: lines.join('\n'), template: 'green' }),
  );
  logger.info('fleet: morning digest pushed', { done: done.length, active: active.length });
}

/**
 * 启动 fleet 主动监控。默认开启；`FLEET_MONITOR_ENABLED=0` 关闭。
 * 监控 tick 每 30s，摘要 tick 每 15min（首个摘要检查延迟 30s）。
 */
export function startFleetMonitor(client: Lark.Client): void {
  if (process.env['FLEET_MONITOR_ENABLED'] === '0') {
    logger.info('fleet-monitor disabled (FLEET_MONITOR_ENABLED=0)');
    return;
  }
  setInterval(() => {
    void monitorTick(client).catch((e) => logger.warn('fleet monitor tick 失败', { err: (e as Error).message }));
  }, POLL_MS);
  setInterval(() => {
    void maybeDigest(client).catch((e) => logger.warn('fleet digest tick 失败', { err: (e as Error).message }));
  }, DIGEST_TICK_MS);
  setTimeout(() => void maybeDigest(client).catch(() => {}), 30_000);
  logger.info('fleet-monitor started', {
    stuckMin: STUCK_MS / 60_000,
    idleMin: IDLE_MS / 60_000,
    digestAt: DIGEST_AT,
  });
}
