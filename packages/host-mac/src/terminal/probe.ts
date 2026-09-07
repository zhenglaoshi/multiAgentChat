import { runScript } from './applescript.js';

/**
 * 探测 System Events 的 AppleScript 术语解析是否正常。
 *
 * sendKeys（方向键驱动 AskUserQuestion / Ctrl-C 解卡 / Cmd-W 关 tab）以及 forceEnter 的
 * `MCHAT_ENTER_MODE=keystroke` 兜底模式都靠 `key code`（System Events 专有术语）发真按键。
 * 若 System Events 被挂起（进程 T 态）/ LaunchServices 注册损坏 / 术语字典加载失败，`key code` 会在
 * **编译期**就报语法错 → 这些按键注入静默失败。
 * （实测诱因：Mac 严重过载 + 长时间未重启，把 System Events helper 拖挂。）
 * 注：默认的回车提交（forceEnter pty 直写）不经 System Events，不受此故障影响。
 *
 * 探针把 `key code 36` 放进恒 false 分支：编译时照样要解析 `key code` 术语（术语坏
 * 就编译失败被我们捕获），但运行时永不真按键。术语正常 → 脚本返回 "ok"。
 */
const PROBE_SCRIPT = `
tell application "System Events"
  if false then
    key code 36
  end if
end tell
return "ok"
`;

export interface SystemEventsProbeResult {
  ok: boolean;
  /** 失败时的 osascript stderr（截断 300 字）；ok 时为 undefined */
  err?: string;
}

/**
 * 跑一次探针。绝不真按键。ok=true 表示 System Events `key code` 按键通路可用（sendKeys / keystroke 兜底）。
 */
export async function probeSystemEvents(): Promise<SystemEventsProbeResult> {
  try {
    const r = await runScript(PROBE_SCRIPT);
    if (r.code === 0 && r.stdout.trim() === 'ok') return { ok: true };
    const err = (r.stderr || r.stdout || `osascript exit ${r.code}`)
      .trim()
      .slice(0, 300);
    return { ok: false, err };
  } catch (e) {
    return { ok: false, err: ((e as Error).message ?? String(e)).slice(0, 300) };
  }
}
