// ⚠ 必须保留：整个 daemon 的 .env 是靠 im-lark 包被 import 时这一行加载的（ESM import 提升，早于 main()）。
// 原来挂在 config.ts 上、由 client.ts / health-check.ts 间接引入；多 bot 改造把它们改成读本文件后 config.ts 无人引用，
// .env 不再加载 → daemon 启动即报「缺 LARK_APP_ID」并在 launchd 下崩溃循环（2026-10-19 真机事故）。
// 回归保护：tests/lark-bots.test.ts「import im-lark 会加载 cwd 下的 .env」。
import 'dotenv/config';
import type * as Lark from '@larksuiteoapi/node-sdk';
import { logger } from 'multiagent-orchestrator';

/**
 * 多飞书机器人（多应用）支持 —— 单一事实源。
 *
 * 背景：同一个 daemon 要同时接「本机 multiAgentChat bot」和「数字员工 bot」两个飞书自建应用，
 * 让数字员工的会话在飞书里是另一个机器人、与本机运维/派 tab 的消息分开。
 *
 * 约定：
 *  - 默认 bot id 固定为 `local`，凭证仍读 `LARK_APP_ID / LARK_APP_SECRET`，它的 chatId **不带前缀**
 *    （裸 `oc_xxx`），老的 data/chats、pending、memory 全部零迁移。
 *  - 其它 bot 从 `LARK_BOT_<ID>_APP_ID / LARK_BOT_<ID>_APP_SECRET` 读（`<ID>` 大写，解析后小写成 bot id），
 *    可选 `LARK_BOT_<ID>_ROLE`（`tabs` 默认 = 与 local 同一套派 tab 逻辑；`digital-staff` = 数字员工适配器）
 *    与 `LARK_BOT_<ID>_LABEL`（日志 / 页脚用的展示名）。
 *  - 非默认 bot 收到的 chat 一律写成 `<botId>:oc_xxx`，**chatId 决定走哪个 bot 发**：发送层（api.ts / reply.ts）
 *    按前缀反查 client 并剥掉前缀再调飞书 API；调用方传进来的 client 只是「没前缀时的默认」。
 *    这样 `agent lark send-text --chat staff:oc_xxx`、ask 卡、进度卡都自然回到正确的 bot，
 *    上层十几个 monitor / server 调用点不用逐个改。
 */

export type LarkBotRole = 'tabs' | 'digital-staff';

export interface LarkBotProfile {
  /** 小写短 id：`local` 固定给默认 bot；其它来自 env 名里的 `<ID>` */
  id: string;
  appId: string;
  appSecret: string;
  role: LarkBotRole;
  label: string;
}

export const DEFAULT_LARK_BOT_ID = 'local';

/** 不允许当 bot id 的前缀：与现有 chatId 命名空间 / 平台名冲突 */
const RESERVED_IDS = new Set(['local', 'lark', 'wecom', 'user', 'chat']);
const BOT_ID_RE = /^[a-z][a-z0-9_-]{0,15}$/;
const ENV_RE = /^LARK_BOT_([A-Z][A-Z0-9_]*)_APP_ID$/;

function parseRole(raw: string | undefined): LarkBotRole {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'digital-staff' || v === 'digital_staff' || v === 'staff') return 'digital-staff';
  return 'tabs';
}

/**
 * 从 env 解析全部 bot profile。纯函数（传 env 便于测试），不缓存。
 * 默认 bot 缺凭证时不在列表里（daemon 启动前已单独 assert LARK_APP_ID/SECRET）。
 * 非默认 bot：id 不合法 / 与保留字冲突 / 缺 secret → 跳过并把原因收进 `skipped`，调用方打日志。
 */
export function parseLarkBotProfiles(env: NodeJS.ProcessEnv = process.env): {
  profiles: LarkBotProfile[];
  skipped: string[];
} {
  const profiles: LarkBotProfile[] = [];
  const skipped: string[] = [];
  const appId = env['LARK_APP_ID']?.trim();
  const appSecret = env['LARK_APP_SECRET']?.trim();
  if (appId && appSecret) {
    profiles.push({ id: DEFAULT_LARK_BOT_ID, appId, appSecret, role: 'tabs', label: env['LARK_BOT_LABEL']?.trim() || '本机' });
  }
  const seen = new Set<string>();
  for (const key of Object.keys(env).sort()) {
    const m = ENV_RE.exec(key);
    if (!m) continue;
    const upper = m[1]!;
    const id = upper.toLowerCase().replace(/_/g, '-');
    const botAppId = env[key]?.trim();
    const botSecret = env[`LARK_BOT_${upper}_APP_SECRET`]?.trim();
    if (!botAppId) continue; // 留空 = 没配，静默跳过（.env.example 里注释掉的占位）
    if (!BOT_ID_RE.test(id) || RESERVED_IDS.has(id)) {
      skipped.push(`${key}: bot id「${id}」不合法或是保留字（允许 a-z0-9_-，不能是 ${[...RESERVED_IDS].join('/')}）`);
      continue;
    }
    if (!botSecret) {
      skipped.push(`${key}: 缺 LARK_BOT_${upper}_APP_SECRET`);
      continue;
    }
    if (seen.has(id)) {
      skipped.push(`${key}: bot id「${id}」重复`);
      continue;
    }
    seen.add(id);
    profiles.push({
      id,
      appId: botAppId,
      appSecret: botSecret,
      role: parseRole(env[`LARK_BOT_${upper}_ROLE`]),
      label: env[`LARK_BOT_${upper}_LABEL`]?.trim() || id,
    });
  }
  return { profiles, skipped };
}

let cachedProfiles: LarkBotProfile[] | null = null;

/** 进程级缓存的 profile 列表（env 在进程生命周期内不变；测试用 `__resetLarkBotsForTest`）。 */
export function getLarkBotProfiles(): LarkBotProfile[] {
  if (!cachedProfiles) cachedProfiles = parseLarkBotProfiles().profiles;
  return cachedProfiles;
}

export function getLarkBotProfile(botId: string): LarkBotProfile | undefined {
  return getLarkBotProfiles().find((p) => p.id === botId);
}

// ---------------- chatId 命名空间 ----------------

const PREFIX_RE = /^([a-z][a-z0-9_-]{0,15}):(.+)$/;

/** 给某个 bot 收到的原生 chat_id 加命名空间：默认 bot 不加（兼容老数据），其它 → `<botId>:oc_xxx`。 */
export function namespaceChatId(botId: string, nativeChatId: string): string {
  if (botId === DEFAULT_LARK_BOT_ID) return nativeChatId;
  return `${botId}:${nativeChatId}`;
}

/** chatId 属于哪个 bot：有已知 bot 前缀 → 该 bot；否则默认 bot。`wecom:` 等非 bot 前缀也归默认（由调用方自己先分流）。 */
export function botIdForChat(chatId: string): string {
  const m = PREFIX_RE.exec(chatId);
  if (m && getLarkBotProfile(m[1]!)) return m[1]!;
  return DEFAULT_LARK_BOT_ID;
}

/** 剥掉 bot 前缀，拿到能直接喂飞书 API 的 `oc_xxx`。没有已知 bot 前缀原样返回。 */
export function toNativeChatId(chatId: string): string {
  const m = PREFIX_RE.exec(chatId);
  if (m && getLarkBotProfile(m[1]!)) return m[2]!;
  return chatId;
}

// ---------------- client 注册表 ----------------

const clients = new Map<string, Lark.Client>();

export function registerLarkClient(botId: string, client: Lark.Client): void {
  clients.set(botId, client);
}

export function getLarkClient(botId: string): Lark.Client | undefined {
  return clients.get(botId);
}

/**
 * 发送层用：按 chatId 的 bot 前缀选 client；没前缀 / 该 bot 没注册 → 用调用方传进来的 fallback。
 * 这是「chatId 决定 bot」这条不变量的落点。
 */
const fallbackWarned = new Set<string>();
export function resolveLarkClient(fallback: Lark.Client, chatId: string): Lark.Client {
  const m = PREFIX_RE.exec(chatId);
  if (!m) return fallback;
  const hit = clients.get(m[1]!);
  if (hit) return hit;
  // 前缀是已配置的 bot 但它没起来（凭证错 / 启动失败）：回退默认 bot 发会**换身份**，必须可追溯。
  // 每个 bot 只告警一次，避免刷屏；真正的发送失败（默认 bot 不在那个群）由调用方照常报错。
  if (getLarkBotProfile(m[1]!) && !fallbackWarned.has(m[1]!)) {
    fallbackWarned.add(m[1]!);
    logger.warn('lark bot client 未就绪，消息回退到默认 bot 发送（身份已变）', { bot: m[1], chatId });
  }
  return fallback;
}

/** 已注册的 bot 数量（日志 / doctor 用） */
export function registeredLarkBotIds(): string[] {
  return [...clients.keys()];
}

/** 仅测试用：清空 profile 缓存与 client 注册表 */
export function __resetLarkBotsForTest(): void {
  cachedProfiles = null;
  clients.clear();
  fallbackWarned.clear();
}
