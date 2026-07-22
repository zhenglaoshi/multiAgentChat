/**
 * 高危 shell 命令识别 —— 权限审批卡（scope A）的策略核心。
 *
 * PreToolUse(Bash) hook 用它决定"要不要弹飞书审批卡拦一下"：命中 → 阻塞式推审批卡，
 * 你手机点批准/拒绝才放行/拦下；不命中 → 放行（走 claude 正常流程，不打扰）。
 *
 * 原则：**宁可少拦、不可错放**要平衡——列表太宽每步都弹卡很烦，太松危险命令溜过去。
 * 只收"一旦跑错代价大且不可逆"的模式（删除/强推/提权/覆盖设备/毁库/管道执行远程脚本）。
 * 常规读写、构建、测试、git add/commit/pull 等一律不拦。
 */

export interface RiskVerdict {
  risky: boolean;
  /** 命中的风险类别（给审批卡展示） */
  reason?: string;
}

interface RiskRule {
  reason: string;
  re: RegExp;
}

const RULES: RiskRule[] = [
  { reason: '递归强制删除 (rm -rf)', re: /\brm\s+(?:-\w*\s+)*-?\w*r\w*f\w*|\brm\s+(?:-\w*\s+)*-?\w*f\w*r\w*|\brm\s+-[a-z]*r[a-z]*\s+-[a-z]*f|\brm\s+-[a-z]*f[a-z]*\s+-[a-z]*r/i },
  { reason: 'git 强制推送 (push --force)', re: /\bgit\s+push\b[^\n]*(?:--force\b|--force-with-lease\b|(?:^|\s)-f(?:\s|$)|\s\+[\w./-]+:)/i },
  { reason: 'git 硬重置 (reset --hard)', re: /\bgit\s+reset\s+--hard\b/i },
  { reason: 'git 强制清理 (clean -f)', re: /\bgit\s+clean\s+-[a-z]*f/i },
  { reason: '提权执行 (sudo)', re: /(?:^|\s|&&|\||;)\s*sudo\s/i },
  { reason: '放开全部权限 (chmod 777)', re: /\bchmod\s+(?:-[a-zA-Z]+\s+)*[0-7]?777\b/i },
  { reason: '写入 .env（凭证文件）', re: /(?:>>?|(?:^|\s)tee\s+(?:-a\s+)?)\s*\S*\.env(?:\.\w+)?(?:\s|$)/i },
  { reason: '管道执行远程脚本 (curl|sh)', re: /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python\d?)\b/i },
  { reason: '写裸设备 / dd', re: /\bdd\b[^\n]*\bof=\/dev\/|>\s*\/dev\/(?:disk|sd|rdisk|null)?[a-z0-9]/i },
  { reason: '格式化磁盘 (mkfs/diskutil erase)', re: /\bmkfs\b|\bdiskutil\s+(?:erase|reformat)/i },
  { reason: '删库/清表 (DROP/TRUNCATE)', re: /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+(?:TABLE\s+)?)\b/i },
  { reason: 'fork bomb', re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { reason: '强杀进程 (kill -9 / killall)', re: /\bkill\s+-9\s+-1\b|\bkillall\s+-9\b/i },
  { reason: '改 git 远程地址 (remote set-url)', re: /\bgit\s+remote\s+set-url\b/i },
];

/**
 * 判断一条命令是否高危。命令可能含多段（&&、;、|）；任一段命中即高危。
 * 只做保守正则匹配，不执行、不展开变量。
 */
export function isHighRiskCommand(command: string): RiskVerdict {
  if (!command || !command.trim()) return { risky: false };
  for (const rule of RULES) {
    if (rule.re.test(command)) return { risky: true, reason: rule.reason };
  }
  return { risky: false };
}
