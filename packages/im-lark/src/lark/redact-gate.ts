/**
 * 回显脱敏闸门（redact-on-echo）—— 所有出站到飞书的文本/卡片在这里过一遍脱敏。
 *
 * 为什么在这层做：本项目最大的明文泄露口不是"我主动 echo"，而是**自动推送**——
 * Stop hook 把 last_assistant_message 推飞书、watcher 把终端 scrollback 塞进卡片。
 * 这些不经过助手判断，只有卡在 api.ts 的发送函数里统一脱敏才挡得住（光靠 SKILL 提示没用）。
 *
 * 开关：本项目是**单用户**系统，所以用一个**全局** unmask 开关就够（不必 per-chat）：
 *   - 默认脱敏（unmask=false）。
 *   - `/raw on` → unmask=true（"明确说要明文"），`/raw off` 关。持久化到 data/，重启不丢。
 *   - 环境变量 `MCHAT_REDACT_SECRETS=0` → 整体停用脱敏（调试用）。
 *
 * 用的是 orchestrator 的单一事实源 redact()（与静态文件脱敏同一套规则）。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { redact } from 'multiagent-orchestrator';
import { logger } from 'multiagent-orchestrator';

const STATE_PATH = resolve('./data/secret-guard.json');

/** 明文模式自动恢复脱敏的时长：10 分钟。防止 /raw on 后忘关、明文长期外泄。 */
export const UNMASK_AUTO_REVERT_MS = 10 * 60 * 1000;

/** 明文模式的绝对到期时间戳（ms）。0/过期 = 脱敏中。用到期戳而非布尔 → 重启后仍会自动恢复。 */
let unmaskUntil = 0;
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (existsSync(STATE_PATH)) {
      const j = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as { unmaskUntil?: number };
      unmaskUntil = typeof j.unmaskUntil === 'number' ? j.unmaskUntil : 0;
    }
  } catch {
    /* 读失败 → 保持默认脱敏 */
  }
}

/** 脱敏是否被整体停用（明文模式未过期，或环境变量）。 */
function redactionOff(): boolean {
  if (process.env['MCHAT_REDACT_SECRETS'] === '0') return true;
  load();
  return unmaskUntil > Date.now();
}

/** 当前是否明文模式（未过期）。 */
export function getUnmaskSecrets(): boolean {
  load();
  return unmaskUntil > Date.now();
}

/** 明文模式剩余秒数（0 = 已脱敏）。 */
export function unmaskRemainingSec(): number {
  load();
  return Math.max(0, Math.ceil((unmaskUntil - Date.now()) / 1000));
}

/** 设置明文模式（`/raw on|off`）。on → 到期戳 = now+10min（重启也会自动恢复）；持久化。 */
export function setUnmaskSecrets(on: boolean): void {
  load();
  unmaskUntil = on ? Date.now() + UNMASK_AUTO_REVERT_MS : 0;
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify({ unmaskUntil }) + '\n', 'utf8');
  } catch (e) {
    logger.warn('secret-guard 状态持久化失败', { err: (e as Error).message });
  }
}

/** 文本回显脱敏（除非明文模式）。 */
export function redactMaybe(text: string): string {
  if (redactionOff()) return text;
  return redact(text).clean;
}

/**
 * 卡片回显脱敏：深度遍历卡片对象，对所有 string 值做脱敏（除非明文模式）。
 * redact() 只改命中的敏感子串，结构性字符串（tag/action 名/tty 路径/按钮文案）不会误伤。
 * 覆盖所有卡片（进度卡里的终端输出、originShell body、任务结果卡…），无需逐个改卡片构造器。
 */
export function redactCardMaybe<T>(card: T): T {
  if (redactionOff()) return card;
  return deepRedact(card) as T;
}

function deepRedact(v: unknown): unknown {
  if (typeof v === 'string') return redact(v).clean;
  if (Array.isArray(v)) return v.map(deepRedact);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = deepRedact(val);
    }
    return out;
  }
  return v;
}
