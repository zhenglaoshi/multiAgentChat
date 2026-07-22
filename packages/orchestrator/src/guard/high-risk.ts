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
  { reason: '提权执行 (sudo)', re: /(?:^|[\s&|;"'`])\s*sudo\s/i },
  { reason: '放开全部权限 (chmod 777)', re: /\bchmod\s+(?:-[a-zA-Z]+\s+)*[0-7]?777\b/i },
  { reason: '写入 .env（凭证文件）', re: /(?:>>?|(?:^|\s)tee\s+(?:-a\s+)?)\s*\S*\.env(?:\.\w+)?(?:\s|$)/i },
  { reason: '管道执行远程脚本 (curl|sh)', re: /\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python\d?)\b/i },
  // 只保留 dd 擦写裸设备(dd 在 dev 命令里几乎不出现,不误报)。
  // 原来还匹配 `> /dev/…` 重定向 → 把 ubiquitous 的 `2>/dev/null` 也误当高危,已去掉。
  { reason: 'dd 擦写裸设备', re: /\bdd\b[^\n]*\bof=\/dev\/[a-z]/i },
  { reason: '格式化磁盘 (mkfs/diskutil erase)', re: /\bmkfs\b|\bdiskutil\s+(?:erase|reformat)/i },
  { reason: '删库/清表 (DROP/TRUNCATE)', re: /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+(?:TABLE\s+)?)\b/i },
  { reason: 'fork bomb', re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { reason: '强杀进程 (kill -9 / killall)', re: /\bkill\s+-9\s+-1\b|\bkillall\s+-9\b/i },
  { reason: '改 git 远程地址 (remote set-url)', re: /\bgit\s+remote\s+set-url\b/i },
];

/**
 * 剥掉命令里的"数据"部分（引号串 / heredoc 体 / `#` 注释），只留"代码"做高危匹配。
 * 避免 `echo "rm -rf /"`、`git commit -m "…rm -rf…"`、写文档提到危险命令等**误报**
 * （那些危险文本是数据、不会执行）。
 */
function stripDataLiterals(cmd: string): string {
  let s = cmd;
  // heredoc 体：<<['"]?DELIM ... 换行 DELIM
  s = s.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[\s\S]*?\n\s*\2(?=\s|$)/g, ' ');
  s = s.replace(/'[^']*'/g, " '' "); // 单引号串
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, ' "" '); // 双引号串
  s = s.replace(/(^|\s)#[^\n]*/g, '$1'); // # 注释
  return s;
}

/**
 * "把引号内容当命令执行"的包装：`eval`、`sh/bash -c "…"`、`mysql -e "…"`、`node -e "…"` 等。
 * 命中这些时，引号里的内容其实要跑 → 连**原始命令**一起扫（不放过 `sh -c "rm -rf /"`、
 * `mysql -e "DROP DATABASE"`），不能只看剥掉数据后的视图。
 */
const EXEC_STRING_RE =
  /\beval\b|\b(?:sh|bash|zsh|dash|ksh)\s+-\w*c\b|\b(?:mysql|psql|mongosh|mongo|redis-cli|sqlite3|clickhouse-client)\b[^\n]*\s-[ec]\b|\b(?:node|python3?|ruby|perl)\s+-e\b/i;

/**
 * 判断一条命令是否高危。命令可能含多段（&&、;、|）；任一段命中即高危。
 * 只做保守正则匹配，不执行、不展开变量。先剥数据字面量再匹配（防误报）；
 * 含"执行字符串"包装时连原始命令一起扫（防漏报）。
 */
export function isHighRiskCommand(command: string): RiskVerdict {
  if (!command || !command.trim()) return { risky: false };
  const stripped = stripDataLiterals(command);
  const targets = EXEC_STRING_RE.test(stripped) ? [stripped, command] : [stripped];
  for (const rule of RULES) {
    for (const t of targets) {
      if (rule.re.test(t)) return { risky: true, reason: rule.reason };
    }
  }
  return { risky: false };
}
