import { spawn } from 'node:child_process';

export interface RunScriptResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * osascript 子进程默认超时（ms）。
 * `do script` 只是启动命令、立即返回，正常 osascript 都在 1s 内退出；唯一会长时间阻塞的
 * 是 macOS 弹「自动化 / 辅助功能」授权框——osascript 会同步挂在那条 Apple Event 上直到用户
 * 点授权。没有超时时这里会永久 pending，上层（newTab / forceEnter …）永不返回 →
 * 飞书端「没反应」。超时后 kill 进程并抛错，让失败可见、可诊断。
 */
function resolveDefaultTimeout(): number {
  const raw = process.env['MCHAT_OSASCRIPT_TIMEOUT_MS'];
  if (raw) {
    const n = Number(raw);
    // 只接受正有限数；0/负数/非数字回退到内置默认（0 会被当「禁用超时」，不允许经 env 误设）。
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 10_000;
}

export const DEFAULT_OSASCRIPT_TIMEOUT_MS = resolveDefaultTimeout();

export function runScript(
  script: string,
  args: string[] = [],
  timeoutMs: number = DEFAULT_OSASCRIPT_TIMEOUT_MS,
): Promise<RunScriptResult> {
  return new Promise((resolveP, rejectP) => {
    const proc = spawn('osascript', ['-', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        // 先 SIGTERM，2s 后仍在则 SIGKILL 兜底（授权框阻塞时 SIGTERM 通常足够）
        try {
          proc.kill('SIGTERM');
        } catch {
          /* 进程可能已退出 */
        }
        setTimeout(() => {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }, 2000).unref?.();
        rejectP(
          new Error(
            `osascript 超时（${timeoutMs}ms）——多半卡在 macOS 自动化/辅助功能授权弹框。` +
              `请到「系统设置 → 隐私与安全性 → 自动化 / 辅助功能」给「终端」授权后重试。`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
    }

    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectP(err);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveP({ stdout, stderr, code: code ?? -1 });
    });
    proc.stdin.write(script);
    proc.stdin.end();
  });
}

export async function runScriptOrThrow(
  script: string,
  args: string[] = [],
): Promise<string> {
  const r = await runScript(script, args);
  if (r.code !== 0) {
    throw new Error(`osascript exit ${r.code}: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}
