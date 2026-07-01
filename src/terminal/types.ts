export interface TerminalTab {
  tty: string;              // /dev/ttys001 — 主键
  windowId: number;         // AppleScript window id (稳定)
  windowFrontmost: boolean; // 是否是 front window（do script 默认目标）
  tabIndex: number;         // window 内 1-based 索引
  title: string;
  busy: boolean;
  processes: string[];      // ['login', '-zsh', 'claude'] 等
  cwd?: string;             // ps + lsof 拿
  hasTUI?: boolean;         // 是否在跑 vim/htop 等会被 do script 弄坏的程序
}

export interface TerminalWindow {
  windowId: number;
  frontmost: boolean;
  tabs: TerminalTab[];
}

export interface SendResult {
  ok: boolean;
  reason?: string;          // 失败/拒绝原因
  before?: number;          // history 行数（送前）
  after?: number;           // history 行数（送后）
  diff?: string;            // 截取的新增内容
}
