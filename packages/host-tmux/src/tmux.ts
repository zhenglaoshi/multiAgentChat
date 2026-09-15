/**
 * tmux CLI 封装 —— 本包**唯一**与外部进程打交道的地方。
 *
 * 安全底线：所有调用一律 `execFile('tmux', [...argv])`，**绝不拼 shell 字符串、绝不过 shell**。
 * 送进 pane 的文本来自飞书消息 / CareyClaw 外部公函正文这类不可信输入，一旦经 shell 就是命令注入
 * （本项目的威胁模型见 CLAUDE.md：外部输入最终会被写进终端并回车执行）。
 */

import { execFile } from 'node:child_process';
import { logger } from 'multiagent-orchestrator';

/**
 * tmux 命令跑不起来（没装 / server 起不来 / target 不存在）。
 *
 * ⚠ **message 里绝不能出现 argv 原文**。Node 的 `execFile` 默认错误消息是
 * `Command failed: <cmd> <arg1> <arg2> …`，而我们的 argv 里带着**送进终端的字面文本** ——
 * `/keys '<原文>'` 这类用法的典型场景就是替用户打登录口令。那条错误会被上层 catch 后
 * 原样 `sendText` 回飞书，而回显脱敏（orchestrator/secrets）是**按已知模式**匹配的，
 * 认不出不带上下文的裸口令 → 明文永久留在聊天记录里。
 * 所以这里只保留「命令名 + 退出码 + 截断的 stderr」，原文只放进不外传的 `argv` 字段。
 */
export class TmuxError extends Error {
  constructor(message: string, readonly argv: string[], readonly stderr: string) {
    super(message);
    this.name = 'TmuxError';
    // argv/stderr 设为**不可枚举**：构造参数属性默认是自身可枚举属性，一旦哪天有人写成
    // `logger.error('x', e)`（传整个 Error 而不是 e.message），util.inspect 会把它们连同
    // 堆栈一起打进日志——里面就是送进终端的原文。现有调用点都只取 .message，但这条不变式
    // 不该只靠人守规矩，这里用属性描述符把它钉死。
    Object.defineProperty(this, 'argv', { enumerable: false });
    Object.defineProperty(this, 'stderr', { enumerable: false });
  }
}

const DEFAULT_TIMEOUT_MS = 5000;

/** stderr 截断长度 —— 够诊断又不至于把整屏内容带进错误消息。 */
const STDERR_MAX = 300;

/**
 * 构造**不含 argv 原文**的错误消息。纯函数，便于单测钉住"原文不外泄"这条不变式。
 * `stderr` 仍可能含少量上下文（tmux 自己的报错，如 "can't find pane"），截断后保留。
 */
export function buildTmuxErrorMessage(
  subcommand: string,
  // ⚠ 用结构化入参而不是 NodeJS.ErrnoException：execFile 回调给的是 ExecFileException，
  // 它的 code 是 `string | number | null`（超时是 'ETIMEDOUT'，非零退出是数字），两者不兼容。
  err: { code?: string | number | null },
  stderr: string,
): string {
  const code = typeof err.code === 'number' ? `exit ${err.code}` : (err.code ?? 'unknown');
  const tail = stderr.trim().slice(0, STDERR_MAX);
  return `tmux ${subcommand} 失败（${code}）${tail ? `：${tail}` : ''}`;
}

/**
 * 跑一条 tmux 命令，返回 stdout。
 *
 * ⚠ `args` 里任何一个元素**恰好等于 `';'`** 都会被 tmux 当成命令分隔符（不是被当数据）。
 * 这不是 shell 注入（没过 shell），但会让一次 send-keys 被劈成两条命令。
 * 送字面文本的路径已在 `sendLiteral()` 里绕开这个形状，见那里的说明。
 */
export function runTmux(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('tmux', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const se = String(stderr ?? '');
        // 注意：这里**不能**用 err.message —— 它含完整 argv（见 TmuxError 的说明）
        reject(new TmuxError(buildTmuxErrorMessage(args[0] ?? '', err, se), args, se));
        return;
      }
      resolve(String(stdout ?? ''));
    });
  });
}

/** 跑 tmux，失败不抛、返回 null（探测类调用用）。 */
export async function runTmuxSoft(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string | null> {
  try {
    return await runTmux(args, timeoutMs);
  } catch (e) {
    // 同样只记命令名，不记 argv 原文：以后若有人用 runTmuxSoft 包一次带字面文本的调用，
    // 完整 argv 会明文落进本地 daemon 日志，长期留存。
    logger.warn('tmux 命令失败', { subcommand: args[0] ?? '', err: (e as Error).message });
    return null;
  }
}

/** 本机有没有可用的 tmux（`tmux -V` 跑得通）。宿主装配前的前置检查。 */
export async function tmuxAvailable(): Promise<boolean> {
  return (await runTmuxSoft(['-V'], 2000)) !== null;
}

/** 本包托管的 session 名 —— 没有任何 session 时 `new-window` 无处可开，得先造一个。 */
export const MCHAT_SESSION = process.env['MCHAT_TMUX_SESSION'] ?? 'mchat';

/** 确保至少有一个 session 存在（幂等）。返回可用的 session 名。 */
export async function ensureSession(): Promise<string> {
  const list = await runTmuxSoft(['list-sessions', '-F', '#{session_name}']);
  const names = (list ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (names.includes(MCHAT_SESSION)) return MCHAT_SESSION;
  if (names.length > 0) return names[0]!;   // 用户已有 session → 用它，别平白多造一个
  await runTmux(['new-session', '-d', '-s', MCHAT_SESSION]);
  return MCHAT_SESSION;
}

/**
 * 送**字面文本**进 pane（不带回车）。
 *
 * 用 `send-keys -l --`：`-l` = literal（不把内容当按键名解析，否则文本里的 "Enter"/"C-c" 会被当按键），
 * `--` = 停止选项解析（否则以 `-` 开头的文本会被当 flag）。
 *
 * ⚠ **结尾的裸 `;` 会被 tmux 吞掉**（2026-09-14 用真实 tmux 3.7c 逐例实测）：
 *   `;` → 一个字符都进不去；`x;` → 落地 `x`；`;;` → 落地 `;`；`;x;` → 落地 `;x`。
 *   而 `;` 在**中间**（`a;b`）完全无损。
 *   实测同时**证伪了命令注入**：`hello; new-window` 整串原样敲进 pane，tmux 并没有真的多开 window
 *   （`list-windows` 核对过）—— 所以这不是安全问题，是**数据保真**问题：送进终端的文本比原文少一个字符。
 *
 * 修法：把结尾连续的 `;` 全部剥下来，正文走 `-l`，这些分号按十六进制字节（3b）用 `-H` 补发 —— 
 * `-H` 不经命令解析，不会被吞。
 *
 * ⚠ 哪条路径真的会命中，别弄反了：`tabs.ts` 的 `sendKeysRaw` 传进来的永远是 `text + '\r'`，
 * **天然不以 `;` 结尾**，那条主路径本来就免疫；真正会命中的是 `keys.ts` 里**不带 `\r`** 的
 * 字面文本分支（`/keys "'以分号结尾的一段话;'"`）。
 */
export async function sendLiteral(pane: string, text: string, run: TmuxRunner = runTmux): Promise<void> {
  if (text === '') return;
  const stripped = text.replace(/;+$/, '');
  const trailingSemis = text.length - stripped.length;
  if (trailingSemis === 0) {
    await run(['send-keys', '-t', pane, '-l', '--', text]);
    return;
  }
  if (stripped !== '') {
    // 剥掉结尾分号后的正文，按构造不可能再以 `;` 结尾
    await run(['send-keys', '-t', pane, '-l', '--', stripped]);
  }
  await run(['send-keys', '-t', pane, '-H', ...Array<string>(trailingSemis).fill('3b')]);
}

/** 送**按键名**进 pane（'Enter' / 'C-c' / 'Escape' / 'Up' …）。不经 shell、不需要焦点。 */
export async function sendKeyName(pane: string, ...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await runTmux(['send-keys', '-t', pane, ...keys]);
}

/**
 * `sendLiteral` 的可注入执行器 —— **生产不传，单测注入**。
 * 这段（`-l --` 与 `;` 特判）是全包最脆弱、最难靠读代码确认正确性的一处，
 * 而它又只能在真机上端到端验证；注入点让 argv 形状本身可以被断言钉住。
 * （项目既有教训：涉真实终端的模块用依赖注入测，别用 vi.mock。）
 */
export type TmuxRunner = (args: string[]) => Promise<unknown>;
