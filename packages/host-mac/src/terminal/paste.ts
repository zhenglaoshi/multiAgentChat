import { execFile, spawn } from 'node:child_process';
import { sendKeys } from './keys.js';

/**
 * 往目标 tab 当前的输入框「粘贴」一段文本（剪贴板 + ⌘V，走 System Events，会抢焦点、锁屏不可用）。
 *
 * 为什么不逐字 keystroke：System Events 打字依赖输入法，**中文基本打不进去**；而 Claude Code 的输入框
 * 接受 bracketed paste（Terminal 的 ⌘V 会包成 paste 序列），中文 / 空格 / 符号原样进去（伪终端实测）。
 *
 * 会临时占用剪贴板：粘贴前保存、粘贴后恢复。⚠ 只能保存 / 恢复**纯文本**剪贴板 ——
 * 原来是图片 / 文件时恢复后会变成空文本（pbpaste 拿不到非文本内容）。
 */
export function pasteText(tty: string, text: string): Promise<void> {
  // 剪贴板是全局共享的：多个 tab 同时走到「自由输入」时，后一次 pbcopy 会覆盖前一次还没被 ⌘V 读走的内容，
  // 答案被静默串掉（事后只查「菜单还在不在」看不出来）→ 进程内串行
  const run = pasteChain.then(() => pasteOnce(tty, text));
  pasteChain = run.catch(() => undefined);
  return run;
}

let pasteChain: Promise<void> = Promise.resolve();

async function pasteOnce(tty: string, text: string): Promise<void> {
  const prev = await pbpaste();
  await pbcopy(text);
  try {
    await sendKeys(tty, 'cmd+v');
    // Terminal 在按键事件里同步读剪贴板，但给它一点余量再恢复，免得读到恢复后的内容
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    if (prev !== null) await pbcopy(prev).catch(() => undefined);
  }
}

function pbpaste(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/usr/bin/pbpaste', [], { timeout: 2000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

function pbcopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('/usr/bin/pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pbcopy exit ${code}`))));
    p.stdin.end(text);
  });
}
