import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { approvals } from 'multiagent-orchestrator';
import { getAgentAdapter } from 'multiagent-orchestrator';
import { loadChat, saveChat } from '../chats/store.js';
import { recall, tokenize } from 'multiagent-orchestrator';
import { memoryStore } from 'multiagent-orchestrator';
import {
  listSubagents,
  getSubagent,
  deleteSubagent,
} from 'multiagent-orchestrator';
import { chainManager } from '../monitor/chains.js';
import { pendingTracker } from '../monitor/pending.js';
import { watcher } from '../monitor/watcher.js';
import {
  deletePreset,
  expandPrompt,
  extractPlaceholders,
  getPreset,
  resolveSopConfig,
  isValidName,
  listPresets,
  parseRunArgs,
  savePreset,
  type Preset,
} from 'multiagent-orchestrator';
import { listRecentCwds } from 'multiagent-host-mac';
import { getHistory, listTabs, newTab } from 'multiagent-host-mac';
import { inferTabStatus, type TabStatusInfo } from 'multiagent-host-mac';
import { resolveCdTarget } from 'multiagent-host-mac';
import {
  addBookmark,
  getBookmark,
  listBookmarks,
  removeBookmark,
  getDirIndex,
  refreshDirIndex,
  searchDirs,
  type DirEntry,
} from 'multiagent-host-mac';
import {
  chooseDirCard,
  dashboardCard,
  tabsCard,
  templateDetailCard,
  templateListCard,
  type ChooseDirEntry,
  type DashboardPendingItem,
  type DashboardSopTaskRow,
  type TemplateListItem,
} from './cards.js';
import { getTask, listTasks, markTaskAborted } from 'multiagent-orchestrator';
import { send as terminalSend } from 'multiagent-host-mac';
import { buildStageProgressCardFromTask } from './task-render.js';

export type ReplyAction =
  | { kind: 'text'; text: string }
  | { kind: 'card'; card: unknown }
  | {
      kind: 'execute';
      text: string;             // 展开后的 prompt（含 @target 前缀，若有）
      sop?: SopActionData;       // SOP 模式：framework 会建 task + 包 SOP wrapper 再发到 tab
    }
  | {
      /** 未匹配 mchat 命令但是 Claude Code 内建 slash（/help / /config etc.）
       *  → 上层把原文本当普通消息发到 activeTty，让 claude session 自己处理。 */
      kind: 'forward-slash-to-tab';
      text: string;
      reason: 'claude-native';
    }
  | {
      kind: 'gen-subagent';
      desc: string;              // 用户描述的域
    }
  | {
      kind: 'tweak-subagent';
      name: string;
      feedback: string;
      currentDef: {
        name: string;
        description?: string;
        tools?: string[];
        model?: string;
        color?: string;
        body: string;
      };
    };

export interface SopActionData {
  presetName: string;
  stages: string[];
  gates: string[];
  loops: import('multiagent-orchestrator').LoopRule[];
  artifactDir?: string;          // 用户没给则 framework 默认 ./docs/tasks/<task-id>
  userPrompt: string;            // 原始用户 prompt（不含 @target 前缀），写入 task.userPrompt
}

export function isCommand(text: string): boolean {
  // `//foo` 是"显式转发到 activeTty"语法，不算 daemon 命令
  if (text.startsWith('//')) return false;
  return text.startsWith('/');
}

/**
 * 用户显式转发语法：`//foo` → 剥掉一层 `/` 当普通文本发到 activeTty。
 * 用于避免和 mchat 内建 slash 命令冲突（如 claude 内置 /help、用户 skill 命令等）。
 */
export function isForwardSlash(text: string): boolean {
  return text.startsWith('//');
}
export function stripForwardSlash(text: string): string {
  return text.startsWith('//') ? text.slice(1) : text;
}

/**
 * Claude Code 内置常见 slash 命令白名单 —— 收到这些时不算 mchat 未知命令，静默
 * 转发到 activeTty 让 claude session 自己处理。列表参考官方文档，可能不全，随
 * Claude Code 更新可扩展。
 *
 * 注意：这些命令名跟 mchat 内建**不冲突**（我们已避开）。如果哪天 mchat 加了
 * 同名命令，白名单里那条要移除或改约定。
 */
// 内建 slash 白名单从 claude adapter 取（单一真源，见 orchestrator/agents/claude.ts）。
// 注意：`/help` 不在白名单 —— mchat 自己有 /help 优先响应，想看 Claude Code 的 help 用 `//help`。
// 未来按 active tab 的 agent 种类选对应 adapter 的白名单（codex 内建 slash 不同）。
const CLAUDE_CODE_NATIVE_SLASH = new Set(getAgentAdapter('claude')!.builtinSlashCommands);

export function isClaudeNativeSlash(name: string): boolean {
  return CLAUDE_CODE_NATIVE_SLASH.has(name.toLowerCase());
}

const ALIAS: Record<string, string> = {
  d: 'dashboard',
  s: 'shells',
  h: 'history',
  w: 'where',
  n: 'new',
  u: 'use',
  p: 'presets',
  a: 'approvals',
  r: 'recall',
  ls: 'shells',
  tabs: 'shells',
  pwd: 'where',
  '?': 'help',
  // /template 系列
  t: 'template',
  templates: 'template',
  tpl: 'template',
  // /chain 系列
  c: 'chain',
  // /subagent 系列 —— HELP_TEXT 早就写了 /sa 但 ALIAS 之前漏了导致失效
  sa: 'subagent',
  sub: 'subagent',
  subagents: 'subagent',
  // /pin 收藏目录
  pins: 'pin',
  bookmark: 'pin',
  bookmarks: 'pin',
  // Web dashboard URL 快捷（多个别名任选）
  wd: 'webdash',       // 首选短别名
  web: 'webdash',
};

function parseCommand(text: string): { name: string; rest: string } {
  const trimmed = text.trim();
  const sp = trimmed.indexOf(' ');
  let name: string;
  let rest: string;
  if (sp < 0) {
    name = trimmed.slice(1).toLowerCase();
    rest = '';
  } else {
    name = trimmed.slice(1, sp).toLowerCase();
    rest = trimmed.slice(sp + 1).trim();
  }
  name = ALIAS[name] ?? name;
  return { name, rest };
}

function homeify(p: string): string {
  const home = homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function truncatePrompt(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length <= n ? oneLine : oneLine.slice(0, n - 1) + '…';
}

/**
 * 组装 web dashboard 访问 URL —— 各种网络可达路径都列出来（Cloudflared tunnel /
 * LAN / hostname / localhost），用户在飞书 chat 里一 tap 就能开对应 URL。
 *
 * 优先级：
 *   1. `WEB_DASHBOARD_PUBLIC_URL` env override（用户手动配的稳定 URL）
 *   2. `/tmp/mchat-cf-tunnel.log` grep 出 trycloudflare 域名（quick tunnel 场景）
 *   3. LAN IPv4 从 os.networkInterfaces()
 *   4. mDNS hostname (`xxx.local`)
 *   5. localhost（本机测试）
 *
 * 缺 WEB_DASHBOARD_TOKEN 时提示未启用。
 */
async function buildWebDashInfo(): Promise<ReplyAction> {
  const token = process.env['WEB_DASHBOARD_TOKEN'];
  const port = process.env['WEB_DASHBOARD_PORT'] ?? '3940';
  if (!token) {
    return {
      kind: 'text',
      text:
        '⚠️ Web dashboard 未启用（缺 WEB_DASHBOARD_TOKEN）\n\n' +
        '要启用：\n' +
        '1. `openssl rand -hex 32` 生 token\n' +
        '2. .env 加 `WEB_DASHBOARD_TOKEN=<hex>` 和 `WEB_DASHBOARD_PORT=3940`\n' +
        '3. 重启 dev（`pnpm dev`）\n' +
        '4. `/webdash` 会给你 URL 列表',
    };
  }

  const frag = `#token=${token}`;
  const items: string[] = [];

  // 1. env override（如果用户配了 named tunnel 稳定域名）
  const publicOverride = process.env['WEB_DASHBOARD_PUBLIC_URL'];
  if (publicOverride) {
    const base = publicOverride.replace(/\/$/, '');
    items.push(`🌐 **公网（env 配置）**\n${base}/${frag}`);
  }

  // 2. cloudflared quick tunnel（读 log 抽 URL）
  try {
    const log = await readFile('/tmp/mchat-cf-tunnel.log', 'utf8');
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log);
    if (m) {
      items.push(`🌐 **Cloudflared tunnel**（重启 tunnel 会变）\n${m[0]}/${frag}`);
    }
  } catch {
    /* tunnel 未起，忽略 */
  }

  // 3. LAN IPv4
  const nets = networkInterfaces();
  const lanIps: string[] = [];
  for (const ifs of Object.values(nets)) {
    if (!ifs) continue;
    for (const iface of ifs) {
      if (iface.family === 'IPv4' && !iface.internal) {
        lanIps.push(iface.address);
      }
    }
  }
  for (const ip of lanIps) {
    items.push(`📡 **LAN (${ip})**\nhttp://${ip}:${port}/${frag}`);
  }

  // 4. hostname (mDNS)
  const host = hostname().replace(/\.local$/, '');
  items.push(`🏷 **mDNS**\nhttp://${host}.local:${port}/${frag}`);

  // 5. localhost
  items.push(`💻 **localhost**（本机测试）\nhttp://127.0.0.1:${port}/${frag}`);

  return {
    kind: 'text',
    text:
      '📱 Web Dashboard · 访问入口\n\n' +
      items.join('\n\n') +
      '\n\n' +
      '💡 4G 网络用 Cloudflared 那条；同 WiFi 用 LAN 或 mDNS。加书签下次一键打开。',
  };
}

function fmtAgoSec(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return `${Math.floor(d / 1000)}s 前`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m 前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h 前`;
  return `${Math.floor(d / 86_400_000)}d 前`;
}

const HELP_TEXT = [
  '**这是 multiAgentChat 的 /help**，跟 Claude Code 内建 `/help` 不一样。想看 Claude Code 内建 → 发 `//help`（前面加多一个 /）',
  '',
  '可用命令（短 alias 加粗）：',
  '  **/d**  /dashboard            概览：active tab + pending 任务 + 最近完成',
  '  **/s**  /shells               列所有 Terminal tab（可点切换）',
  '  **/n**  /new [path|@alias|关键词]  开新 tab',
  '       /new                    无参数弹选目录卡片（含浏览器/收藏/git 项目）',
  '       /new ~/code/foo         精确路径',
  '       /new @mac               用收藏（/pin 存的别名）',
  '       /new pigeon             关键词模糊匹配已知目录',
  '  **/pin**                    列所有收藏',
  '       /pin <alias> [path]     收藏目录（省 path 用当前 active tab 的 cwd）',
  '       /pin del <alias>        删收藏（或 /unpin <alias>）',
  '  /dirindex refresh          手动刷 git 项目索引',
  '  **/u**  /use <tty>            切换本会话 active tab',
  '  **/w**  /where                当前 active tab 信息',
  '  **/h**  /history [-n N]       active tab 的屏幕历史 tail',
  '  **/t**  /template             列任务模板（卡片）',
  '       /template save <name> [--stages a,b,c] [--gates after-x] [--loops a→b*N] [@target] <prompt>',
  '       /template show/delete <name>',
  '       /run <name> [k=v ...] | [pos1 pos2 ...]',
  '       /run --sop [--stages ...] [@target] <prompt>   临时 SOP，不需要先存模板',
  '       /p /presets              旧名：列模板（文本）',
  '  **/task** 或 /tk              SOP 任务列表 / 详情',
  '       /task <task-id>          单个 task 详情卡（stage 时间线）',
  '       /task abort [<task-id>] [hard]  中止（无 id 时自动找本会话进行中的 task）',
  '       /task here               列本会话进行中的 SOP',
  '  **/subagent** 或 /sa          Claude Code 自定义 subagent 管理',
  '       /subagent list           列所有可用 subagent',
  '       /subagent <name>         看单个详情（含 system prompt 前 800 字）',
  '       /subagent delete <name>',
  '       /subagent gen <域描述>   LLM 自动为该域生成 3-5 个 subagent + 组合 template',
  '  **/c**  /chain                列运行中链路 + 最近完成',
  '       /chain cancel <id>       终止指定链路',
  '       消息体语法：`@a X >> @b Y >> @c Z`（一行内串联）',
  '  **/a**  /approvals            待审批列表 + 最近历史',
  '       /audit [N]               审批历史（最近 N 条）',
  '  **/tapd**                     我的 TAPD 列表卡（指派给我的未结束缺陷/需求；每条带「🔄 改状态」）',
  '       /tapd new [标题]          建 TAPD 需求：①选项目 → ②表单填主题+内容 → 建（标题可选）',
  '  **/report** day|week|month|year [--brief]  工作总结：日/周=简报md，月/年=PPT(加 --brief 出简报)',
  '  **/r**  /recall [关键词]      搜任务历史；不带关键词 = 最近 10 条',
  '  **/wt** /worktasks [关键词]   列/搜任务工作目录（目录↔分支↔干啥；TAPD/perf 认领时自动落记录）',
  '       /watch on/off            本地任务监听（你在 Mac 直接发的命令也推送到飞书）',
  '  **/wd** 或 /web /webdash        web dashboard 访问 URL（公网/LAN/mDNS/localhost 多路径）',
  '  **/quiet on/off**              静默模式：长任务只发首次+完成，中间不刷进度卡',
  '                                 （关闭状态下走自适应节流：3.5s→15s→30s→60s 随任务时长）',
  '  /help                         本帮助',
  '',
  '**转发到 tab（Claude Code / skill 命令）**',
  '  `/help` `/config` `/model` `/agents` `/skills` 等 Claude Code 内建 → 自动转发到 active tab',
  '  `//foo` → 强制转发（前面加多一个 /），任何未识别 slash 命令都能这样发到 tab',
  '',
  '**普通文本** → 默认发到 active tab',
  '**@target text** → 发到指定 tab（不切 active）',
  '  target 支持 ttys001 / cwd 末尾的目录名 / tab 标题',
  '  多行 @ 不同 target = 批量并发：',
  '    @myapp 跑测试',
  '    @logs tail -f /var/log/foo',
  '',
  'TUI（vim/htop 等）自动拦截。任务进度卡实时更新输出。',
].join('\n');

const SEARCH_PATHS = ['~/code', '~/Projects', '~/projects'];

async function scanSearchPaths(): Promise<string[]> {
  const out: string[] = [];
  const home = homedir();
  for (const sp of SEARCH_PATHS) {
    const abs = sp.startsWith('~/') ? join(home, sp.slice(2)) : sp;
    if (!existsSync(abs)) continue;
    try {
      const entries = await readdir(abs, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.')) {
          out.push(join(abs, e.name));
        }
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

async function createTabAndAck(chatId: string, cwd: string): Promise<ReplyAction> {
  try {
    const tty = await newTab({ cwd });
    const chat = await loadChat(chatId);
    chat.activeTty = tty;
    chat.lastActiveAt = Date.now();
    await saveChat(chat);
    return {
      kind: 'text',
      text: `🆕 新 tab \`${tty}\`  cwd: ${homeify(cwd)}\n★ 已设为本会话 active`,
    };
  } catch (e) {
    return { kind: 'text', text: `❌ 开 tab 失败：${(e as Error).message}` };
  }
}

async function buildFuzzyMatchCard(
  query: string,
  matches: DirEntry[],
): Promise<ReplyAction> {
  const home = homedir();
  const entries: ChooseDirEntry[] = matches.map((m) => ({
    cwd: m.path,
    label: m.name,
    hint: m.isGitRepo ? '📦 git' : undefined,
  }));
  return {
    kind: 'card',
    card: chooseDirCard({
      quickEntries: entries,
      dropdownEntries: [],
      home,
      defaultCwd: home,
      title: `🔍 关键词 "${query}" 有 ${matches.length} 个匹配`,
    }),
  };
}

async function handlePinCommand(
  chatId: string,
  rest: string,
): Promise<ReplyAction> {
  // /pin        → 列
  // /pin <alias> [path]  → 加（省 path 就用 active tab cwd）
  // /pin del <alias>     → 删
  if (!rest) {
    const bms = await listBookmarks();
    if (bms.length === 0) {
      return {
        kind: 'text',
        text: '还没有收藏。\n`/pin <alias> [path]` 添加（省 path 就用 active tab 的 cwd）\n`/new @<alias>` 用收藏开 tab',
      };
    }
    const lines = bms.map((b) => `  📌 @${b.alias}  →  ${homeify(b.path)}`);
    return {
      kind: 'text',
      text: `📌 收藏 (${bms.length})：\n${lines.join('\n')}\n\n/new @<alias> 秒开 tab`,
    };
  }

  const parts = rest.split(/\s+/);
  if (parts[0] === 'del' || parts[0] === 'remove' || parts[0] === 'rm') {
    const alias = parts[1];
    if (!alias) return { kind: 'text', text: '用法：/pin del <alias>' };
    const ok = await removeBookmark(alias);
    return {
      kind: 'text',
      text: ok ? `✅ 删除收藏 @${alias}` : `❌ 收藏 @${alias} 不存在`,
    };
  }

  const alias = parts[0]!;
  let pathArg = parts.slice(1).join(' ').trim();
  if (!pathArg) {
    // 用 active tab 的 cwd
    const chat = await loadChat(chatId);
    if (!chat.activeTty) {
      return {
        kind: 'text',
        text: '本会话没有 active tab，请显式给路径：/pin <alias> <path>',
      };
    }
    const tabs = await listTabs();
    const t = tabs.find((x) => x.tty === chat.activeTty);
    if (!t?.cwd) {
      return {
        kind: 'text',
        text: 'active tab 拿不到 cwd，请显式给路径：/pin <alias> <path>',
      };
    }
    pathArg = t.cwd;
  }
  const r = await resolveCdTarget(pathArg, resolve('.'));
  if (!r.ok) return { kind: 'text', text: `❌ ${r.error}` };
  await addBookmark(alias, r.path);
  return {
    kind: 'text',
    text: `✅ 收藏 @${alias} → ${homeify(r.path)}\n以后 /new @${alias} 秒开`,
  };
}

async function buildChooseDirCard(): Promise<ReplyAction> {
  const home = homedir();
  const quickEntries: ChooseDirEntry[] = [];
  const seen = new Set<string>();

  const pushQuick = (cwd: string, label: string, hint?: string) => {
    if (seen.has(cwd)) return;
    seen.add(cwd);
    const e: ChooseDirEntry = { cwd, label };
    if (hint) e.hint = hint;
    quickEntries.push(e);
  };

  // 1. 📌 收藏（最优先）
  for (const bm of await listBookmarks()) {
    pushQuick(bm.path, `📌 @${bm.alias}`, homeify(bm.path));
  }

  // 2. 🚀 已开 tab 的 cwd
  try {
    const tabs = await listTabs();
    for (const t of tabs) {
      if (!t.cwd) continue;
      pushQuick(t.cwd, `🚀 ${t.tty} 在用`, t.title ? `"${t.title}"` : undefined);
    }
  } catch {
    /* ignore */
  }

  // 3. 🕓 最近用过
  for (const cwd of await listRecentCwds()) {
    pushQuick(cwd, '🕓 最近用过');
  }

  // 4. Home + 项目根 + 常见入口（兜底）
  pushQuick(home, '🏠 Home');
  pushQuick(resolve('.'), '📁 项目根目录');
  for (const sp of ['~/Desktop', '~/Downloads', '~/Documents']) {
    const abs = sp.startsWith('~/') ? join(home, sp.slice(2)) : sp;
    if (existsSync(abs)) pushQuick(abs, sp);
  }

  const quickFinal = quickEntries.slice(0, 8);

  // dropdown：全机 git 项目 + 顶层容器（dir-index 提供）
  const dropdownEntries: ChooseDirEntry[] = [];
  const dropSeen = new Set<string>();
  try {
    const idx = await getDirIndex();
    // git 项目排前面
    const sorted = [...idx.dirs].sort((a, b) => {
      if (a.isGitRepo !== b.isGitRepo) return a.isGitRepo ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const d of sorted) {
      if (dropSeen.has(d.path)) continue;
      if (quickFinal.some((q) => q.cwd === d.path)) continue;
      dropSeen.add(d.path);
      const prefix = d.isGitRepo ? '📦 ' : '📂 ';
      dropdownEntries.push({ cwd: d.path, label: prefix + homeify(d.path) });
    }
  } catch {
    /* ignore, fallback 用旧 scanSearchPaths */
    for (const p of await scanSearchPaths()) {
      if (dropSeen.has(p)) continue;
      if (quickFinal.some((q) => q.cwd === p)) continue;
      dropSeen.add(p);
      dropdownEntries.push({ cwd: p, label: homeify(p) });
    }
  }

  return {
    kind: 'card',
    card: chooseDirCard({
      quickEntries: quickFinal,
      dropdownEntries: dropdownEntries.slice(0, 90),
      home,
      defaultCwd: home,
      browseStart: home,
    }),
  };
}

async function buildDashboardCard(chatId: string): Promise<ReplyAction> {
  // 优先用 watcher cache（每 3s 已刷新一次，避免 dashboard 重复 osascript）
  const cached = watcher.getCachedTabs();
  const cacheAge = watcher.getCacheAge();
  let tabs;
  if (cached.length > 0 && cacheAge < 10_000) {
    tabs = cached;
  } else {
    tabs = await listTabs();
  }
  const chat = await loadChat(chatId);

  // 对每个 claude tab 并发拿 history（优先用 cache，缺则现拿）
  const claudeTabs = tabs.filter((t) =>
    t.processes.some((p) => p.toLowerCase().includes('claude')),
  );
  const tails = await Promise.all(
    claudeTabs.map(async (t) => {
      const cachedHist = watcher.getCachedHistory(t.tty);
      if (cachedHist !== undefined) {
        return [t.tty, cachedHist.split('\n').slice(-30).join('\n')] as const;
      }
      try {
        const h = await getHistory(t.tty);
        return [t.tty, h.split('\n').slice(-30).join('\n')] as const;
      } catch {
        return [t.tty, ''] as const;
      }
    }),
  );
  const tailByTty = new Map<string, string>(tails);

  // 综合分类
  let shellIdle = 0;
  let shellBusy = 0;
  let claudeActive = 0;
  let claudeWaiting = 0;
  let claudeLogin = 0;
  let tui = 0;
  const attention: Array<{ tty: string; statusLabel: string; cwd: string }> = [];

  for (const t of tabs) {
    const info = inferTabStatus(t, tailByTty.get(t.tty));
    switch (info.kind) {
      case 'shell-idle': shellIdle++; break;
      case 'shell-busy': shellBusy++; break;
      case 'claude-active': claudeActive++; break;
      case 'claude-waiting':
        claudeWaiting++;
        attention.push({
          tty: t.tty,
          statusLabel: info.label,
          cwd: t.cwd ?? '?',
        });
        break;
      case 'claude-login':
        claudeLogin++;
        attention.push({
          tty: t.tty,
          statusLabel: info.label,
          cwd: t.cwd ?? '?',
        });
        break;
      case 'tui': tui++; break;
    }
  }

  const activeTab = chat.activeTty ? tabs.find((t) => t.tty === chat.activeTty) : undefined;
  const pendingItems: DashboardPendingItem[] = pendingTracker.all().map((p) => {
    const item: DashboardPendingItem = {
      tty: p.tty,
      taskDescription: p.taskDescription,
      startedAt: p.sentAt,
    };
    if (p.progressMessageId) item.progressMessageId = p.progressMessageId;
    return item;
  });
  const recentDone = pendingTracker.recentDone(8).map((r) => ({
    tty: r.tty,
    taskDescription: r.taskDescription,
    doneAt: r.doneAt,
  }));

  // 活跃的 SOP 任务（running + awaiting-gate）
  const [runningTasks, gatedTasks] = await Promise.all([
    listTasks({ status: 'running', chatId }),
    listTasks({ status: 'awaiting-gate', chatId }),
  ]);
  const sopTasks: DashboardSopTaskRow[] = [...gatedTasks, ...runningTasks].map((t) => {
    const row: DashboardSopTaskRow = {
      taskId: t.taskId,
      tty: t.tty,
      status: t.status === 'done' || t.status === 'failed' ? 'running' : t.status,
      currentStageIdx: t.currentStageIdx,
      stages: t.stages,
      startedAt: t.startedAt,
    };
    if (t.presetName) row.presetName = t.presetName;
    if (t.awaitingGate) row.awaitingGate = t.awaitingGate;
    return row;
  });

  return {
    kind: 'card',
    card: dashboardCard({
      ...(activeTab ? { activeTty: activeTab.tty, activeCwd: activeTab.cwd ?? '?' } : {}),
      totalTabs: tabs.length,
      shellIdleTabs: shellIdle,
      shellBusyTabs: shellBusy,
      claudeActiveTabs: claudeActive,
      claudeWaitingTabs: claudeWaiting,
      claudeLoginTabs: claudeLogin,
      tuiTabs: tui,
      pendingItems,
      recentDone,
      attentionTabs: attention,
      sopTasks,
      home: homedir(),
    }),
  };
}

async function buildTabsCard(chatId: string): Promise<ReplyAction> {
  const tabs = await listTabs();
  const chat = await loadChat(chatId);
  const data: Parameters<typeof tabsCard>[0] = { tabs, home: homedir() };
  if (chat.activeTty) data.activeTty = chat.activeTty;
  return { kind: 'card', card: tabsCard(data) };
}

async function buildTemplateListCard(): Promise<ReplyAction> {
  const all = await listPresets();
  const items: TemplateListItem[] = all.map((p) => {
    const it: TemplateListItem = {
      name: p.name,
      promptPreview: p.prompt,
      placeholders: extractPlaceholders(p.prompt),
    };
    if (p.description) it.description = p.description;
    if (p.target) it.target = p.target;
    if (p.stages && p.stages.length > 0) it.stages = p.stages;
    if (p.gates && p.gates.length > 0) it.gates = p.gates;
    if (p.updatedAt) it.updatedAt = p.updatedAt;
    return it;
  });
  return { kind: 'card', card: templateListCard(items) };
}

/**
 * /template <subcommand> 路由
 *
 * - (空) | list                 → 列表卡
 * - show <name>                 → 详情卡
 * - save <name> [@target] <prompt>
 * - delete <name>
 */
async function handleTemplateCmd(rest: string): Promise<ReplyAction> {
  const trimmed = rest.trim();
  if (!trimmed || trimmed === 'list' || trimmed === 'ls') {
    return buildTemplateListCard();
  }

  const sp = trimmed.indexOf(' ');
  const sub = sp < 0 ? trimmed : trimmed.slice(0, sp);
  const after = sp < 0 ? '' : trimmed.slice(sp + 1).trim();

  if (sub === 'show') {
    if (!after) return { kind: 'text', text: '用法：/template show <name>' };
    const p = await getPreset(after);
    if (!p) return { kind: 'text', text: `❌ 模板 "${after}" 不存在` };
    const detail: Parameters<typeof templateDetailCard>[0] = {
      name: p.name,
      prompt: p.prompt,
      placeholders: extractPlaceholders(p.prompt),
    };
    if (p.description) detail.description = p.description;
    if (p.target) detail.target = p.target;
    if (p.stages && p.stages.length > 0) detail.stages = p.stages;
    if (p.gates && p.gates.length > 0) detail.gates = p.gates;
    if (p.artifactDir) detail.artifactDir = p.artifactDir;
    if (p.createdAt) detail.createdAt = p.createdAt;
    if (p.updatedAt) detail.updatedAt = p.updatedAt;
    return { kind: 'card', card: templateDetailCard(detail) };
  }

  if (sub === 'delete' || sub === 'rm') {
    if (!after) return { kind: 'text', text: '用法：/template delete <name>' };
    const ok = await deletePreset(after);
    return {
      kind: 'text',
      text: ok ? `✅ 已删除模板 "${after}"` : `❌ 模板 "${after}" 不存在`,
    };
  }

  if (sub === 'save' || sub === 'add' || sub === 'set') {
    // 语法：save <name> [@target] <prompt...>
    if (!after) {
      return {
        kind: 'text',
        text:
          '用法：\n`/template save <name> [@target] <prompt with {key}>`\n例：\n`/template save research @studio 调研 {topic}，写到 docs/{slug}.md`',
      };
    }
    const m = after.match(/^(\S+)\s+(.*)$/s);
    if (!m) {
      return {
        kind: 'text',
        text: `用法：/template save <name> [@target] [--stages a,b,c] [--gates after-X] <prompt>\n（"${after}" 缺 prompt 部分）`,
      };
    }
    const tplName = m[1]!;
    let body = m[2]!.trim();
    if (!isValidName(tplName)) {
      return {
        kind: 'text',
        text: `❌ 非法名字 "${tplName}"：只允许 a-z A-Z 0-9 _ -，最长 64`,
      };
    }

    // 提取 --stages 和 --gates（在剥 @target 之前；它们可以混在任何位置）
    const stagesExtract = extractValuedFlag(body, 'stages');
    body = stagesExtract.rest;
    const gatesExtract = extractValuedFlag(body, 'gates');
    body = gatesExtract.rest;
    const loopsExtract = extractValuedFlag(body, 'loops');
    body = loopsExtract.rest;
    const artifactExtract = extractValuedFlag(body, 'artifact-dir');
    body = artifactExtract.rest;

    // 可选 @target 前缀
    let target: string | undefined;
    const tgtMatch = body.match(/^@(\S+)\s+(.*)$/s);
    if (tgtMatch) {
      target = tgtMatch[1]!;
      body = tgtMatch[2]!.trim();
    }
    if (!body) {
      return { kind: 'text', text: `❌ prompt 不能为空` };
    }
    const preset: Preset = { name: tplName, prompt: body };
    if (target) preset.target = target;
    if (stagesExtract.value) {
      preset.stages = stagesExtract.value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    if (gatesExtract.value) {
      preset.gates = gatesExtract.value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    if (artifactExtract.value) {
      preset.artifactDir = artifactExtract.value;
    }
    if (loopsExtract.value) {
      // 语法：tester→coder*2,regression-checker→coder*1
      const rules: import('multiagent-orchestrator').LoopRule[] = [];
      for (const segRaw of loopsExtract.value.split(',')) {
        const seg = segRaw.trim();
        if (!seg) continue;
        const m = seg.match(/^(\S+?)\s*(?:->|→)\s*(\S+?)(?:\s*\*\s*(\d+))?$/);
        if (!m) {
          return {
            kind: 'text',
            text: `❌ --loops 段 "${seg}" 解析失败。语法：on→retryFrom[*maxRetries]，多条逗号分隔。例：tester→coder*2,regression-checker→coder*1`,
          };
        }
        const rule: import('multiagent-orchestrator').LoopRule = {
          on: m[1]!,
          retryFrom: m[2]!,
        };
        if (m[3]) rule.maxRetries = parseInt(m[3], 10);
        rules.push(rule);
      }
      if (rules.length > 0) preset.loops = rules;
    }
    let saved: Preset;
    try {
      saved = await savePreset(preset);
    } catch (e) {
      return { kind: 'text', text: `❌ 保存失败：${(e as Error).message}` };
    }
    const placeholders = extractPlaceholders(saved.prompt);
    const lines: string[] = [`✅ 已保存模板 \`${tplName}\``];
    if (target) lines.push(`目标：@${target}`);
    if (placeholders.length)
      lines.push(`占位符：${placeholders.map((p) => `\`{${p}}\``).join(' ')}`);
    if (saved.stages && saved.stages.length > 0) {
      lines.push(`🎯 SOP stages：${saved.stages.join(' → ')}`);
      if (saved.gates && saved.gates.length > 0) {
        lines.push(`⏸ gates：${saved.gates.join(', ')}`);
      }
      if (saved.loops && saved.loops.length > 0) {
        const loopStrs = saved.loops.map(
          (l) => `${l.on}→${l.retryFrom}*${l.maxRetries ?? 2}`,
        );
        lines.push(`🔁 loops：${loopStrs.join(', ')}`);
      }
      if (saved.artifactDir) {
        lines.push(`📂 artifactDir：${saved.artifactDir}`);
      }
      // stage 名不在 subagent registry 里 → 警告（不阻止保存）
      // Claude Code 内置 subagent 也允许（Explore / Plan / general-purpose / ...）
      const CLAUDE_BUILTINS = new Set([
        'Explore', 'Plan', 'general-purpose', 'claude', 'claude-code-guide', 'statusline-setup',
      ]);
      const available = await listSubagents({ projectRoot: process.cwd() });
      const availableNames = new Set(available.map((s) => s.name));
      const unknownStages = saved.stages.filter(
        (s) => !availableNames.has(s) && !CLAUDE_BUILTINS.has(s),
      );
      if (unknownStages.length > 0) {
        lines.push('');
        lines.push(`⚠️ stage 未找到对应 subagent（保存成功但跑时可能报 unknown）：`);
        for (const s of unknownStages) lines.push(`  - ${s}`);
        lines.push(`可用：\`/subagent list\` 查所有；\`/subagent gen <desc>\` 让主 agent 生成`);
      }
    }
    lines.push(`触发：\`/run ${tplName}${placeholders.length ? ' ...' : ''}\``);
    return { kind: 'text', text: lines.join('\n') };
  }

  return {
    kind: 'text',
    text:
      '/template 用法：\n' +
      '  `/template`                                列模板（卡片）\n' +
      '  `/template show <name>`                    详情卡\n' +
      '  `/template save <name> [@target] <prompt>`\n' +
      '  `/template save <name> --stages a,b,c [--gates after-x] [--loops tester→coder*2] [@target] <prompt>`    SOP 模板\n' +
      '  `/template delete <name>`\n' +
      '触发：`/run <name> [k=v ...]`',
  };
}

/**
 * ad-hoc SOP：`/run --sop [--stages a,b,c] [--gates after-x] [--loops a→b*N] [--artifact-dir D] [@target] <prompt>`
 * 不依赖任何 preset，flags 全在一行解析，剩下的当 user prompt。
 */
async function handleAdHocSopRun(line: string): Promise<ReplyAction> {
  let body = line;

  // 是否带 --sop（仅 flag，无值）
  const sopRe = /(^|\s)--sop(?=\s|$)/i;
  const hasSop = sopRe.test(body);
  if (hasSop) body = body.replace(sopRe, ' ').trim();

  // 抠各 valued flag
  const stagesExtract = extractValuedFlag(body, 'stages');
  body = stagesExtract.rest;
  const gatesExtract = extractValuedFlag(body, 'gates');
  body = gatesExtract.rest;
  const loopsExtract = extractValuedFlag(body, 'loops');
  body = loopsExtract.rest;
  const artifactExtract = extractValuedFlag(body, 'artifact-dir');
  body = artifactExtract.rest;

  // 模拟一个"空 preset" 让 resolveSopConfig 决策
  const pseudoPreset: import('multiagent-orchestrator').Preset = {
    name: '__adhoc__',
    prompt: '',
  };
  if (stagesExtract.value) {
    pseudoPreset.stages = stagesExtract.value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (gatesExtract.value) {
    pseudoPreset.gates = gatesExtract.value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (loopsExtract.value) {
    const rules: import('multiagent-orchestrator').LoopRule[] = [];
    for (const segRaw of loopsExtract.value.split(',')) {
      const seg = segRaw.trim();
      if (!seg) continue;
      const m = seg.match(/^(\S+?)\s*(?:->|→)\s*(\S+?)(?:\s*\*\s*(\d+))?$/);
      if (!m) {
        return {
          kind: 'text',
          text: `❌ --loops 段 "${seg}" 解析失败。语法：on→retryFrom[*maxRetries]，多条逗号分隔`,
        };
      }
      const rule: import('multiagent-orchestrator').LoopRule = { on: m[1]!, retryFrom: m[2]! };
      if (m[3]) rule.maxRetries = parseInt(m[3], 10);
      rules.push(rule);
    }
    if (rules.length > 0) pseudoPreset.loops = rules;
  }
  if (artifactExtract.value) pseudoPreset.artifactDir = artifactExtract.value;

  // 让 resolveSopConfig 决定 stages（用 --sop 或 pseudoPreset.stages 任一）
  const sopFlags = hasSop ? ['sop'] : [];
  const sopConfig = resolveSopConfig(pseudoPreset, sopFlags);
  if (!sopConfig) {
    return {
      kind: 'text',
      text:
        '❌ ad-hoc /run 必须有 `--sop` 或 `--stages a,b,c`，否则没法构成任务。\n' +
        '例：`/run --sop @ttys009 实现 ping 命令`',
    };
  }

  const prompt = body.trim();
  if (!prompt) {
    return {
      kind: 'text',
      text:
        '❌ 没有 prompt 文本。\n例：`/run --sop @ttys009 实现 ping 命令`\n' +
        '若要 fallback 到 active tab：`/run --sop 实现 ping 命令`',
    };
  }

  const sop: SopActionData = {
    presetName: 'ad-hoc',
    stages: sopConfig.stages,
    gates: sopConfig.gates,
    loops: sopConfig.loops,
    userPrompt: prompt,
  };
  if (sopConfig.artifactDir) sop.artifactDir = sopConfig.artifactDir;
  return { kind: 'execute', text: prompt, sop };
}

/**
 * 从一行字符串里抠出 `--flag value` / `--flag=value` / `--flag "v with spaces"`。
 * 返回 value（不含引号）和剥掉这个 flag 后剩下的字符串。
 */
function extractValuedFlag(
  body: string,
  flagName: string,
): { value: string | undefined; rest: string } {
  // --flag=value（不含空格的 value） | --flag="value with spaces"
  const eqRe = new RegExp(
    `(^|\\s)--${flagName}=(?:"([^"]*)"|'([^']*)'|(\\S+))`,
    'i',
  );
  const eqM = body.match(eqRe);
  if (eqM) {
    const val = (eqM[2] ?? eqM[3] ?? eqM[4]) ?? '';
    return { value: val, rest: body.replace(eqRe, eqM[1] ?? '').trim() };
  }
  // --flag value | --flag "value with spaces"
  const spRe = new RegExp(
    `(^|\\s)--${flagName}\\s+(?:"([^"]*)"|'([^']*)'|(\\S+))`,
    'i',
  );
  const spM = body.match(spRe);
  if (spM) {
    const val = (spM[2] ?? spM[3] ?? spM[4]) ?? '';
    return { value: val, rest: body.replace(spRe, spM[1] ?? '').trim() };
  }
  return { value: undefined, rest: body };
}

function statusIconForChainStep(s: string): string {
  switch (s) {
    case 'pending': return '⏳';
    case 'running': return '🟢';
    case 'done': return '✓';
    case 'failed': return '💀';
    case 'cancelled': return '⊘';
    case 'skipped': return '—';
    default: return '?';
  }
}

async function handleChainCmd(rest: string): Promise<ReplyAction> {
  const trimmed = rest.trim();

  // /chain cancel <id>
  if (trimmed.startsWith('cancel') || trimmed.startsWith('stop')) {
    const after = trimmed.replace(/^(cancel|stop)\s*/, '').trim();
    if (!after) {
      return { kind: 'text', text: '用法：/chain cancel <chainId>' };
    }
    const ok = chainManager.cancel(after);
    return {
      kind: 'text',
      text: ok ? `⊘ 已终止 chain \`${after}\`` : `❌ chain \`${after}\` 不存在或已完成`,
    };
  }

  // /chain (默认) → 列 active + recent
  const active = chainManager.listActive();
  const recent = chainManager.recentDone(5);
  const lines: string[] = [];

  if (active.length === 0) {
    lines.push('⛓ **运行中链路：** (空)');
  } else {
    lines.push(`⛓ **运行中链路 ${active.length} 条：**`);
    for (const c of active) {
      const progress = `${c.steps.filter((s) => s.status === 'done').length}/${c.steps.length}`;
      lines.push(`  • \`${c.id}\` · ${progress}`);
      for (const s of c.steps) {
        lines.push(
          `    ${statusIconForChainStep(s.status)} @${s.target} · ` +
            `<font color='grey'>${truncatePrompt(s.prompt, 60)}</font>`,
        );
      }
    }
  }
  lines.push('');
  if (recent.length === 0) {
    lines.push('📜 **最近完成：** (空)');
  } else {
    lines.push(`📜 **最近完成：**`);
    for (const c of recent) {
      const icon =
        c.status === 'done' ? '✓' :
        c.status === 'failed' ? '💀' :
        c.status === 'cancelled' ? '⊘' :
        '?';
      const dur = c.endedAt ? Math.round((c.endedAt - c.createdAt) / 1000) : 0;
      lines.push(
        `  ${icon} \`${c.id}\` · ${c.steps.length} 步 · ${dur}s · ` +
          `<font color='grey'>${fmtAgoSec(c.endedAt ?? c.createdAt)}</font>`,
      );
    }
  }
  return { kind: 'text', text: lines.join('\n') };
}

async function buildStageProgressCard(taskId: string): Promise<ReplyAction> {
  const task = await getTask(taskId);
  if (!task) return { kind: 'text', text: `❌ task 不存在：${taskId}` };
  return { kind: 'card', card: buildStageProgressCardFromTask(task, homedir()) };
}

async function handleSubagentCmd(rest: string): Promise<ReplyAction> {
  const trimmed = rest.trim();
  const projectRoot = process.cwd();

  // /subagent  或 /subagent list
  if (!trimmed || trimmed === 'list' || trimmed === 'ls') {
    const defs = await listSubagents({ projectRoot });
    if (defs.length === 0) {
      return {
        kind: 'text',
        text:
          '（还没有 subagent）\n' +
          '手工加：`agent subagent add <name> ...`\n' +
          '或飞书里 `/subagent gen <描述>` （P0 待做）让主 agent 自动生成',
      };
    }
    const lines = [`🤖 **${defs.length} 个 subagent**`, ''];
    // 分组：project 先，user 后
    const project = defs.filter((d) => d.location === 'project');
    const user = defs.filter((d) => d.location === 'user');
    if (project.length > 0) {
      lines.push('📁 **项目本地：**');
      for (const d of project) {
        lines.push(`  • **${d.name}**${d.description ? ` — ${truncateSA(d.description, 60)}` : ''}`);
        if (d.tools?.length) lines.push(`    tools: \`${d.tools.join(', ')}\``);
      }
      lines.push('');
    }
    if (user.length > 0) {
      lines.push('🏠 **全局（~/.claude/agents/）：**');
      for (const d of user) {
        lines.push(`  • **${d.name}**${d.description ? ` — ${truncateSA(d.description, 60)}` : ''}`);
        if (d.tools?.length) lines.push(`    tools: \`${d.tools.join(', ')}\``);
      }
    }
    lines.push('');
    lines.push('看详情：`/subagent <name>`');
    lines.push('删除：`/subagent delete <name>`');
    lines.push('（生成新的 `/subagent gen <描述>` — P0 待做）');
    return { kind: 'text', text: lines.join('\n') };
  }

  // /subagent delete <name>
  if (trimmed.startsWith('delete ') || trimmed.startsWith('rm ')) {
    const name = trimmed.replace(/^(delete|rm)\s+/, '').trim();
    if (!name) return { kind: 'text', text: '用法：`/subagent delete <name>`' };
    const deleted = await deleteSubagent(name, { projectRoot });
    return {
      kind: 'text',
      text: deleted ? `✗ 已删除 subagent \`${name}\`` : `❌ subagent 不存在：${name}`,
    };
  }

  // /subagent gen <desc>
  if (trimmed.startsWith('gen ') || trimmed === 'gen') {
    const desc = trimmed.slice(3).trim();
    if (!desc) {
      return {
        kind: 'text',
        text:
          '用法：`/subagent gen <域描述>`\n' +
          '例：`/subagent gen 视频剪辑：ffmpeg 剪 mp4 + 加字幕 + 生成缩略图`',
      };
    }
    return {
      kind: 'gen-subagent',
      desc,
    };
  }

  // /subagent tweak <name> <feedback>
  if (trimmed.startsWith('tweak ') || trimmed === 'tweak') {
    const after = trimmed.slice(5).trim();
    const m = after.match(/^(\S+)\s+(.+)$/s);
    if (!m) {
      return {
        kind: 'text',
        text:
          '用法：`/subagent tweak <name> <改动指令>`\n' +
          '例：`/subagent tweak data-fetcher 让它不用生成 preview，直接输出数据`',
      };
    }
    const name = m[1]!;
    const feedback = m[2]!.trim();
    const existing = await getSubagent(name, { projectRoot });
    if (!existing) {
      return { kind: 'text', text: `❌ subagent 不存在：\`${name}\`` };
    }
    return {
      kind: 'tweak-subagent',
      name,
      feedback,
      currentDef: {
        name: existing.name,
        body: existing.body,
        ...(existing.description !== undefined ? { description: existing.description } : {}),
        ...(existing.tools !== undefined ? { tools: existing.tools } : {}),
        ...(existing.model !== undefined ? { model: existing.model } : {}),
        ...(existing.color !== undefined ? { color: existing.color } : {}),
      },
    };
  }

  // /subagent <name> — show detail
  const name = trimmed.split(/\s+/)[0]!;
  const def = await getSubagent(name, { projectRoot });
  if (!def) {
    return { kind: 'text', text: `❌ subagent 不存在：\`${name}\`\n看所有：\`/subagent\`` };
  }
  const lines: string[] = [];
  lines.push(`🤖 **${def.name}** <font color='grey'>(${def.location})</font>`);
  if (def.description) lines.push(`**描述**：${def.description}`);
  if (def.tools?.length) lines.push(`**工具**：\`${def.tools.join(', ')}\``);
  if (def.model) lines.push(`**模型**：\`${def.model}\``);
  if (def.color) lines.push(`**颜色**：${def.color}`);
  lines.push(`**文件**：\`${def.filePath}\``);
  lines.push('');
  lines.push('**System prompt**（前 800 字）：');
  lines.push('```\n' + def.body.slice(0, 800) + (def.body.length > 800 ? '\n\n...(截断)' : '') + '\n```');
  return { kind: 'text', text: lines.join('\n') };
}

function truncateSA(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

async function handleTaskCmd(rest: string, chatId: string): Promise<ReplyAction> {
  const trimmed = rest.trim();

  // /task abort [<id>] [hard]
  if (trimmed === 'abort' || trimmed.startsWith('abort ') || trimmed.startsWith('abort\t')) {
    const argsRaw = trimmed.slice('abort'.length).trim();
    const tokens = argsRaw.split(/\s+/).filter(Boolean);
    const hard = tokens.includes('hard') || tokens.includes('--hard');
    const idArg = tokens.find((t) => t.startsWith('task-'));
    let taskId = idArg;
    if (!taskId) {
      // 自动找当前 chat 的进行中 task
      const [running, gated] = await Promise.all([
        listTasks({ status: 'running', chatId }),
        listTasks({ status: 'awaiting-gate', chatId }),
      ]);
      const all = [...gated, ...running];
      if (all.length === 0) {
        return { kind: 'text', text: '本会话没有进行中的 SOP 任务' };
      }
      if (all.length > 1) {
        const lines = ['本会话有多个进行中的 task，请显式指定：'];
        for (const t of all) {
          const stageLabel =
            t.currentStageIdx < 0
              ? '(未开始)'
              : t.currentStageIdx >= t.stages.length
                ? '(全部完成)'
                : `stage ${t.currentStageIdx + 1}/${t.stages.length} ${t.stages[t.currentStageIdx]}`;
          lines.push(`  /task abort ${t.taskId}  ← ${t.presetName ?? 'ad-hoc'} · ${stageLabel}`);
        }
        return { kind: 'text', text: lines.join('\n') };
      }
      taskId = all[0]!.taskId;
    }
    const result = await markTaskAborted(taskId, 'feishu /task abort', hard);
    if (!result) return { kind: 'text', text: `❌ task ${taskId} 不存在或已结束` };
    // 投递 🛑 到 tab
    if (result.tty) {
      const banner = [
        '',
        '',
        `🛑 [SOP 中止] task-id ${taskId} 已被中止${hard ? '（hard）' : '（soft）'}`,
        hard
          ? '请立刻停手，不要继续 stage 协议，不要写收尾'
          : '请停止 stage 协议；已完成 stage 的产出保留，可 agent lark send-text 简短总结',
        '',
      ].join('\n');
      void terminalSend(result.tty, banner).catch(() => {});
    }
    return {
      kind: 'text',
      text: `🛑 已${hard ? '硬' : '软'}中止 ${taskId}\n   tty: ${result.tty}\n   reason: ${result.failReason}`,
    };
  }

  // /task here  → 列当前 chat 进行中 task
  if (trimmed === 'here') {
    const [running, gated] = await Promise.all([
      listTasks({ status: 'running', chatId }),
      listTasks({ status: 'awaiting-gate', chatId }),
    ]);
    const all = [...gated, ...running];
    if (all.length === 0) {
      return { kind: 'text', text: '本会话没有进行中的 SOP 任务' };
    }
    const lines = ['🎯 本会话进行中的 SOP：', ''];
    for (const t of all) {
      const stageLabel =
        t.currentStageIdx < 0
          ? '(未开始)'
          : t.currentStageIdx >= t.stages.length
            ? '(全部完成)'
            : `stage ${t.currentStageIdx + 1}/${t.stages.length} ${t.stages[t.currentStageIdx]}`;
      lines.push(`• ${t.presetName ?? 'ad-hoc'} · \`${t.taskId}\``);
      lines.push(`  \`${t.tty}\` · ${stageLabel}`);
      if (t.awaitingGate) lines.push(`  ⏸ gate: ${t.awaitingGate}`);
    }
    lines.push('');
    lines.push('看详情：/task <task-id>');
    lines.push('中止：/task abort [<task-id>]');
    return { kind: 'text', text: lines.join('\n') };
  }

  if (!trimmed || trimmed === 'list' || trimmed === 'ls') {
    const [running, gated] = await Promise.all([
      listTasks({ status: 'running', chatId }),
      listTasks({ status: 'awaiting-gate', chatId }),
    ]);
    const tasks = [...gated, ...running];
    if (tasks.length === 0) {
      return { kind: 'text', text: '（本会话没有进行中的 SOP 任务）' };
    }
    const lines = ['🎯 **进行中的 SOP 任务**', ''];
    for (const t of tasks) {
      const stageInfo =
        t.currentStageIdx < 0
          ? '(未开始)'
          : t.currentStageIdx >= t.stages.length
            ? '(全部完成)'
            : `[${t.currentStageIdx + 1}/${t.stages.length}] ${t.stages[t.currentStageIdx]}`;
      const gate = t.awaitingGate ? `  ⏸ ${t.awaitingGate}` : '';
      const preset = t.presetName ? `\`${t.presetName}\` · ` : '';
      lines.push(`• ${preset}\`${t.taskId}\`  ${stageInfo}${gate}`);
      lines.push(`  \`${t.tty}\``);
    }
    lines.push('');
    lines.push('看详情：`/task <task-id>`');
    return { kind: 'text', text: lines.join('\n') };
  }
  // 首参当 task-id（允许 'task-mqxxx-yyyy' 前缀模糊）
  const id = trimmed.split(/\s+/)[0]!;
  return buildStageProgressCard(id);
}

export async function handleCommand(
  chatId: string,
  text: string,
): Promise<ReplyAction> {
  const { name, rest } = parseCommand(text);

  if (name === 'help' || name === '?') return { kind: 'text', text: HELP_TEXT };

  if (name === 'tapd') {
    const orch = await import('multiagent-orchestrator');
    const cfg = orch.loadTapdConfig();
    if (!cfg.enabled) {
      return { kind: 'text', text: 'TAPD 未配置（.env 缺 TAPD_MCP_URL / TAPD_MCP_TOKEN / TAPD_NICK）' };
    }
    const flow = await import('./tapd-flow.js');
    const rst = rest.trim();
    // /tapd new [标题] —— 建需求两步卡：①选项目 → ②表单填主题+内容 → 建（标题可选，预填表单）
    if (rst === 'new' || rst.startsWith('new ')) {
      const r = await flow.startCreateFlow(chatId, rst.slice(3).trim());
      return r.error ? { kind: 'text', text: `❌ ${r.error}` } : { kind: 'card', card: r.card };
    }
    // /tapd —— 我的 TAPD 列表卡（每条带「🔄 改状态」）
    const r = await flow.buildMyTapdListCard();
    return r.error ? { kind: 'text', text: `❌ ${r.error}` } : { kind: 'card', card: r.card };
  }

  if (name === 'presets' || name === 'p') {
    const all = await listPresets();
    if (all.length === 0) {
      return {
        kind: 'text',
        text: '还没有预设。\n建个 JSON 文件丢 `~/.multiagent-chat/presets/<name>.json`\n格式：`{"name":"...", "target":"...", "prompt":"... {1} ..."}`',
      };
    }
    const lines = ['📋 任务预设：', ''];
    for (const p of all) {
      lines.push(`• **${p.name}**${p.target ? ` → @${p.target}` : ''}`);
      if (p.description) lines.push(`  ${p.description}`);
      lines.push(`  发 \`/preset ${p.name} <args>\` 触发`);
      lines.push('');
    }
    return { kind: 'text', text: lines.join('\n') };
  }

  if (name === 'preset' || name === 'run') {
    const trimmed = rest.trim();
    if (!trimmed) {
      return {
        kind: 'text',
        text:
          '用法：\n' +
          '  `/run <preset> [key=value ...]`            跑已存模板\n' +
          '  `/run --sop [@target] <prompt>`             临时 SOP（默认 6 stage + 1 gate + 失败回环），无需建模板\n' +
          '  `/run --sop --stages a,b,c [--gates after-a] [--loops a→b*2] [@target] <prompt>`   自定义 SOP\n' +
          '看所有：/template',
      };
    }

    // ad-hoc SOP 模式：第一个非空 token 以 -- 开头 → 不查 preset，全行当 flag-bag + 末尾 prompt
    if (trimmed.startsWith('--')) {
      return handleAdHocSopRun(trimmed);
    }

    const firstSpace = trimmed.indexOf(' ');
    const presetName = firstSpace < 0 ? trimmed : trimmed.slice(0, firstSpace);
    const argsRaw = firstSpace < 0 ? '' : trimmed.slice(firstSpace + 1);
    const preset = await getPreset(presetName);
    if (!preset) {
      return {
        kind: 'text',
        text: `❌ 模板 "${presetName}" 不存在\n看所有：/template\n临时跑 SOP 用：/run --sop <prompt>`,
      };
    }
    const { positional, named, flags } = parseRunArgs(argsRaw);
    const expanded = expandPrompt(preset.prompt, positional, named);
    const targetPrefix = preset.target ? `@${preset.target} ` : '';

    // SOP 触发：preset.stages 非空 或 --sop flag
    const sopConfig = resolveSopConfig(preset, flags);
    if (sopConfig) {
      const sop: SopActionData = {
        presetName: preset.name,
        stages: sopConfig.stages,
        gates: sopConfig.gates,
        loops: sopConfig.loops,
        userPrompt: expanded,
      };
      if (sopConfig.artifactDir) sop.artifactDir = sopConfig.artifactDir;
      return { kind: 'execute', text: `${targetPrefix}${expanded}`, sop };
    }
    return { kind: 'execute', text: `${targetPrefix}${expanded}` };
  }

  if (name === 'template') {
    return handleTemplateCmd(rest);
  }

  if (name === 'task' || name === 'tk') {
    return handleTaskCmd(rest, chatId);
  }

  if (name === 'subagent' || name === 'subagents' || name === 'sa') {
    return handleSubagentCmd(rest);
  }

  if (name === 'chain' || name === 'chains') {
    return handleChainCmd(rest);
  }

  if (name === 'approvals' || name === 'a') {
    const active = approvals.listActive();
    const recent = await approvals.listRecent(10);
    const recentDone = recent.filter((r) => r.status !== 'pending');
    const lines: string[] = [];
    if (active.length === 0) {
      lines.push('⏳ **待审批：** (空)');
    } else {
      lines.push(`⏳ **待审批：${active.length} 条**`);
      for (const r of active) {
        const ago = fmtAgoSec(r.createdAt);
        lines.push(`  • \`${r.id}\` · ${r.title}  <font color='grey'>(${ago})</font>`);
      }
    }
    lines.push('');
    if (recentDone.length === 0) {
      lines.push('📜 **最近历史：** (空)');
    } else {
      lines.push(`📜 **最近历史：**`);
      for (const r of recentDone) {
        const icon =
          r.status === 'approved' ? '✅' :
          r.status === 'rejected' ? '❌' :
          '⌛';
        const ago = fmtAgoSec(r.resolvedAt ?? r.createdAt);
        lines.push(`  ${icon} \`${r.id}\` · ${r.title}  <font color='grey'>${ago}</font>`);
      }
    }
    return { kind: 'text', text: lines.join('\n') };
  }

  if (name === 'worktasks' || name === 'wt') {
    const orch = await import('multiagent-orchestrator');
    const { worktasksCard } = await import('./cards.js');
    const q = rest.trim();
    const tasks = q ? await orch.searchWorkTasks(q, 20) : await orch.listWorkTasks(20);
    if (tasks.length === 0) {
      return { kind: 'text', text: q ? `🔍 没找到 "${q}" 相关的任务工作目录` : '(还没有任务工作目录记录；TAPD/perf 认领时自动落记录)' };
    }
    return { kind: 'card', card: worktasksCard(tasks, process.env['HOME'] ?? '', q || undefined) };
  }

  if (name === 'recall' || name === 'r') {
    const query = rest.trim();
    if (!query) {
      // 没参数 → 列最近 10 条 memory
      const recent = await memoryStore.listRecent(10);
      if (recent.length === 0) return { kind: 'text', text: '(没有任务历史)' };
      const lines: string[] = ['📚 **最近任务历史**'];
      for (const m of recent) {
        const ago = fmtAgoSec(m.endedAt);
        lines.push(`• ${ago} · \`${homeify(m.cwd)}\`\n  "${truncatePrompt(m.prompt, 70)}"`);
      }
      lines.push('', '用 `/recall <关键词>` 搜历史');
      return { kind: 'text', text: lines.join('\n') };
    }
    const keywords = tokenize(query);
    const results = await recall({ keywords, limit: 10, minScore: 0.3 });
    if (results.length === 0) {
      return { kind: 'text', text: `🔍 没找到 "${query}" 相关的任务历史` };
    }
    const lines: string[] = [`🔍 **找到 ${results.length} 条相关任务**`];
    for (const r of results) {
      const m = r.memory;
      const ago = fmtAgoSec(m.endedAt);
      const files = m.filesProduced?.length
        ? `\n  📎 ${m.filesProduced.slice(0, 2).join('  ')}`
        : '';
      lines.push(
        `**${r.score.toFixed(1)}** · ${ago} · \`${homeify(m.cwd)}\`\n  "${truncatePrompt(m.prompt, 80)}"${files}`,
      );
    }
    return { kind: 'text', text: lines.join('\n\n') };
  }

  if (name === 'audit') {
    const limit = Number(rest) || 30;
    const all = await approvals.listRecent(limit);
    if (all.length === 0) return { kind: 'text', text: '(没有审批历史)' };
    const lines: string[] = [`📜 **审批历史**（最近 ${all.length} 条）`];
    for (const r of all) {
      const icon =
        r.status === 'pending' ? '⏳' :
        r.status === 'approved' ? '✅' :
        r.status === 'rejected' ? '❌' :
        '⌛';
      const time = new Date(r.createdAt).toLocaleString('zh-CN');
      const by = r.resolvedBy ? `\n  by ${r.resolvedBy}` : '';
      lines.push(`${icon} \`${r.id}\`  ${time}\n  ${r.title}${by}`);
    }
    return { kind: 'text', text: lines.join('\n\n') };
  }

  if (name === 'watch') {
    const arg = rest.toLowerCase().trim();
    const chat = await loadChat(chatId);
    if (arg === '' || arg === 'status') {
      return {
        kind: 'text',
        text: `本地任务监听：${chat.watchAllTabs ? '✓ 开启' : '✗ 关闭'}\n用法：/watch on  /watch off\n\n说明：只 gate 两件事 —— (1) 你在 pc shell 直接敲命令时的自动推送；(2) Stop hook auto push。不影响你从飞书发命令的进度卡（那是必然反馈）。想让长任务少刷 → 用 /quiet on`,
      };
    }
    if (arg === 'on' || arg === 'true' || arg === '1') {
      chat.watchAllTabs = true;
      chat.lastActiveAt = Date.now();
      await saveChat(chat);
      return {
        kind: 'text',
        text: '✓ 本地任务监听已开启\n所有 claude tab 里的本地操作（你直接在 Mac 上发的命令）现在都会自动推送进度卡片到本会话。\n关闭：/watch off',
      };
    }
    if (arg === 'off' || arg === 'false' || arg === '0') {
      chat.watchAllTabs = false;
      chat.lastActiveAt = Date.now();
      await saveChat(chat);
      return { kind: 'text', text: '✗ 本地任务监听已关闭' };
    }
    return { kind: 'text', text: `未知参数：${arg}\n用法：/watch on  /watch off` };
  }

  if (name === 'quiet') {
    const arg = rest.toLowerCase().trim();
    const chat = await loadChat(chatId);
    if (arg === '' || arg === 'status') {
      return {
        kind: 'text',
        text: `静默模式：${chat.quietMode ? '✓ 开启（长任务中途不刷卡，只发首次+完成）' : '✗ 关闭（进度卡实时 patch，自适应节流 3.5s→60s）'}\n用法：/quiet on  /quiet off`,
      };
    }
    if (arg === 'on' || arg === 'true' || arg === '1') {
      chat.quietMode = true;
      chat.lastActiveAt = Date.now();
      await saveChat(chat);
      return {
        kind: 'text',
        text: '🔇 静默模式已开启\n所有活跃 & 新建的 pending 只发首次卡 + 最终收尾卡，中间不再 patch 进度。\n关闭：/quiet off',
      };
    }
    if (arg === 'off' || arg === 'false' || arg === '0') {
      chat.quietMode = false;
      chat.lastActiveAt = Date.now();
      await saveChat(chat);
      return { kind: 'text', text: '🔊 静默模式已关闭，恢复实时进度卡（自适应节流 3.5s→60s）' };
    }
    return { kind: 'text', text: `未知参数：${arg}\n用法：/quiet on  /quiet off  /quiet status` };
  }

  if (name === 'webdash' || name === 'wd' || name === 'web') {
    return await buildWebDashInfo();
  }

  if (name === 'dashboard') return buildDashboardCard(chatId);

  if (name === 'shells' || name === 'tabs' || name === 'ls') {
    return buildTabsCard(chatId);
  }

  if (name === 'new') {
    if (!rest) return buildChooseDirCard();

    // /new @<alias> → 用收藏
    if (rest.startsWith('@')) {
      const alias = rest.slice(1).trim();
      const bm = await getBookmark(alias);
      if (!bm) {
        return {
          kind: 'text',
          text: `❌ 没找到收藏 @${alias}\n/pin 看所有收藏`,
        };
      }
      return createTabAndAck(chatId, bm.path);
    }

    // /new <path>：绝对路径 / 相对路径 / ~
    if (rest.startsWith('/') || rest.startsWith('~') || rest.startsWith('./') || rest.startsWith('../')) {
      const r = await resolveCdTarget(rest, resolve('.'));
      if (!r.ok) return { kind: 'text', text: `❌ ${r.error}` };
      return createTabAndAck(chatId, r.path);
    }

    // /new <keyword> → fuzzy match dir index
    const matches = await searchDirs(rest, 8);
    if (matches.length === 0) {
      return {
        kind: 'text',
        text: `❌ 没匹配到目录：\`${rest}\`\n可选：/new <绝对路径> · /new @<收藏> · /new（弹选择器）`,
      };
    }
    if (matches.length === 1) {
      return createTabAndAck(chatId, matches[0]!.path);
    }
    // 多个匹配 → 展示卡片让用户挑
    return buildFuzzyMatchCard(rest, matches);
  }

  if (name === 'pin' || name === 'unpin') {
    return handlePinCommand(chatId, name === 'unpin' ? `del ${rest}` : rest);
  }

  if (name === 'dirindex') {
    if (rest === 'refresh') {
      const idx = await refreshDirIndex(true);
      return {
        kind: 'text',
        text: `✅ 目录索引刷新完成，共 ${idx.dirs.length} 条`,
      };
    }
    const idx = await getDirIndex();
    return {
      kind: 'text',
      text: `📇 目录索引 ${idx.dirs.length} 条（更新于 ${fmtAgoSec(idx.updatedAt)}）\n/dirindex refresh 手动刷新`,
    };
  }

  if (name === 'use') {
    if (!rest) return { kind: 'text', text: '用法：/use <tty>（例：/use /dev/ttys001）' };
    const tabs = await listTabs();
    const tab = tabs.find((t) => t.tty === rest);
    if (!tab) return { kind: 'text', text: `❌ tab 不存在：${rest}` };
    const chat = await loadChat(chatId);
    chat.activeTty = tab.tty;
    chat.lastActiveAt = Date.now();
    // 显式切 active → 清 pending / sticky，避免旧粘性抢新 activeTty 的路由
    delete chat.pendingAnswerTty;
    delete chat.pendingAnswerAt;
    delete chat.recentReplyTty;
    delete chat.recentReplyAt;
    await saveChat(chat);
    return {
      kind: 'text',
      text: `★ 切到 \`${tab.tty}\`\n  cwd: ${homeify(tab.cwd ?? '?')}${tab.title ? `\n  title: ${tab.title}` : ''}`,
    };
  }

  if (name === 'where' || name === 'pwd') {
    const chat = await loadChat(chatId);
    if (!chat.activeTty) {
      return {
        kind: 'text',
        text: '本会话还没有 active tab。\n发送 `/shells` 选一个，或 `/new` 开新的。',
      };
    }
    const tabs = await listTabs();
    const t = tabs.find((x) => x.tty === chat.activeTty);
    if (!t) {
      return {
        kind: 'text',
        text: `★ ${chat.activeTty}（在 Terminal 里已经不存在了，请 /shells 重新选）`,
      };
    }
    const procs = t.processes.length ? `\n  procs: ${t.processes.join(', ')}` : '';
    return {
      kind: 'text',
      text: `★ \`${t.tty}\`\n  cwd: ${homeify(t.cwd ?? '?')}\n  busy: ${t.busy}${t.hasTUI ? ' ⚠TUI' : ''}${t.title ? `\n  title: ${t.title}` : ''}${procs}`,
    };
  }

  if (name === 'history') {
    const chat = await loadChat(chatId);
    if (!chat.activeTty) {
      return { kind: 'text', text: '本会话还没有 active tab。' };
    }
    const lines = (() => {
      const m = rest.match(/-n\s+(\d+)/);
      return m ? Number(m[1]) : 60;
    })();
    const { getHistory } = await import('multiagent-host-mac');
    const { sanitizeTerminalOutput } = await import('../monitor/sanitize.js');
    const full = await getHistory(chat.activeTty);
    const arr = full.split('\n');
    const tail = arr.slice(-lines).join('\n');
    // sanitize：剥 ANSI/OSC、折叠 \r 重绘、连续同行去重
    // 走 card（单 lark_md div）：正文包在 ``` 里当纯文本渲染 —— 里面的 `#`/`---`/prompt
    // 分隔符 `─────` 都不会被 Feishu 二次解析成 heading/hr（这就是之前"一对横线"的根源）
    const cleaned = sanitizeTerminalOutput(tail);
    const meta = `📜 \`${chat.activeTty}\` · tail ${lines}/${arr.length}`;
    return {
      kind: 'card',
      card: {
        config: { wide_screen_mode: true },
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: `${meta}\n\`\`\`\n${cleaned}\n\`\`\``,
            },
          },
        ],
      },
    };
  }

  // ---- 未匹配 mchat 命令 ----
  // 若是 Claude Code 常见内建 slash（/help /config /model ...）→ 转发到 activeTty
  // 让 tab 里的 claude 自己响应
  if (isClaudeNativeSlash(name)) {
    return {
      kind: 'forward-slash-to-tab',
      text: text,  // 保留原 `/foo bar` 完整文本
      reason: 'claude-native',
    };
  }
  // 其他 → 报错 + 提示 // 转发语法
  return {
    kind: 'text',
    text: `未知命令：/${name}\n\n如果这是 tab 里 claude 的 skill / 插件命令，用 \`//${name}\` 强制转发到 active tab（前面加一个 /）。\n查 mchat 命令：/help`,
  };
}
