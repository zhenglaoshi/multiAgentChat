#!/usr/bin/env bash
#
# WSL 侧一键装机 —— docs/windows-setup.md 里**能自动化的那部分**。
#
# 设计目标：让 agent（或人）跑**一条命令**就把 WSL 内的环境配好，而不是逐段抄文档。
# 三条纪律：
#   1. **幂等** —— 重复跑安全。每步先探测"是不是已经好了"，是就跳过并打印 skip。
#   2. **失败即停** —— `set -euo pipefail`，任何一步失败立刻退出并说清楚卡在哪、下一步该干什么。
#   3. **不碰需要人的事** —— 管理员权限、交互式登录、飞书凭证一律**不猜不代劳**，
#      到了这些地方就停下来、打印"该你了"的清单（见文档 §0 的人机分工）。
#
# 用法（在 WSL 里）：
#   bash scripts/wsl-setup.sh            # 装环境
#   bash scripts/wsl-setup.sh --check    # 只自检，不改任何东西
#
# 不做的事（**故意**）：装 WSL 本身、改 Windows 电源策略、注册任务计划、填 .env 凭证、
# 登录 claude/codex。这些要么需要管理员、要么需要人交互，见文档 §0。

set -euo pipefail

CHECK_ONLY=0
[[ "${1:-}" == "--check" ]] && CHECK_ONLY=1

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_MIN=22

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
skip() { printf '  \033[90m·\033[0m %s（已就绪，跳过）\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$1" >&2; [[ -n "${2:-}" ]] && printf '  → %s\n' "$2" >&2; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# ── 0. 环境前提 ──────────────────────────────────────────────────────────────
step "0. 环境检查"

if ! grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null && [[ -z "${WSL_DISTRO_NAME:-}" ]]; then
  warn "看起来不在 WSL 里跑。脚本仍可用于普通 Linux，但电源/自启那几节（文档 §3 §4）不适用"
fi
[[ -f "$REPO_DIR/package.json" ]] || die "没找到 $REPO_DIR/package.json" "确认在本仓库里跑这个脚本"
ok "仓库目录：$REPO_DIR"

case "$REPO_DIR" in
  /mnt/*) die "仓库放在 $REPO_DIR（Windows 盘）" \
              "移到 WSL 文件系统内（如 ~/multiAgentChat）：跨文件系统 IO 慢一个量级，且 inotify 在 /mnt 上不工作 → tsx watch 收不到文件变更。见文档 §7" ;;
esac
ok "仓库在 WSL 文件系统内（不是 /mnt/c）"

# ── 1. 系统依赖 ──────────────────────────────────────────────────────────────
step "1. 系统依赖（tmux / git / curl / build-essential）"

# ⚠ 这份名单必须与 docs/windows-setup.md §2.3 一致 —— 文档说「脚本做的就是这些事」。
# build-essential 当前其实用不上（esbuild/tsx 都是预编译二进制，没有要 node-gyp 编译的依赖），
# 但保留：一旦将来引入任何原生依赖，缺 gcc/make 会让 `pnpm install` 报一个跟"环境没装好"
# 毫不相干的编译错误，而不是这里友好的 die 提示。
PKGS=(tmux git curl build-essential)
MISSING=()
for b in "${PKGS[@]}"; do
  # build-essential 是包名不是命令 —— 用 dpkg 查；其余按可执行文件探测
  if [[ "$b" == build-essential ]]; then
    if command -v dpkg-query >/dev/null 2>&1; then
      dpkg-query -W -f='${Status}' build-essential 2>/dev/null | grep -q '^install ok installed$' || MISSING+=("$b")
    fi   # 非 dpkg 系统（本机 macOS 之类）跳过这项，不误报
  else
    command -v "$b" >/dev/null 2>&1 || MISSING+=("$b")
  fi
done

if [[ ${#MISSING[@]} -eq 0 ]]; then
  skip "${PKGS[*]}"
  command -v tmux >/dev/null 2>&1 && ok "tmux $(tmux -V | awk '{print $2}')"
elif [[ $CHECK_ONLY -eq 1 ]]; then
  die "缺少：${MISSING[*]}" "跑 sudo apt install -y ${MISSING[*]}"
else
  warn "缺少：${MISSING[*]} —— 下面这条会要 sudo 密码（脚本不会代填）"
  sudo apt-get update -qq
  sudo apt-get install -y "${MISSING[@]}"
  ok "已装 ${MISSING[*]}（tmux $(tmux -V | awk '{print $2}')）"
fi

# ── 2. Node ─────────────────────────────────────────────────────────────────
step "2. Node ≥ $NODE_MIN"

node_major() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }

if command -v node >/dev/null 2>&1 && [[ "$(node_major)" -ge $NODE_MIN ]]; then
  skip "Node $(node -v)"
elif [[ $CHECK_ONLY -eq 1 ]]; then
  die "Node 缺失或过老（需 ≥ $NODE_MIN，当前 $(node -v 2>/dev/null || echo '未安装')）" "用 nvm 装：见文档 §2.3"
else
  if [[ ! -d "${NVM_DIR:-$HOME/.nvm}" ]]; then
    warn "装 nvm（从 github 拉脚本）"
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # shellcheck disable=SC1090
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}" && . "$NVM_DIR/nvm.sh"
  nvm install "$NODE_MIN"
  nvm alias default "$NODE_MIN"
  ok "Node $(node -v)"
fi

if command -v pnpm >/dev/null 2>&1; then
  skip "pnpm $(pnpm -v)"
elif [[ $CHECK_ONLY -eq 1 ]]; then
  die "pnpm 未安装" "npm i -g pnpm"
else
  npm i -g pnpm >/dev/null
  ok "pnpm $(pnpm -v)"
fi

# ── 3. 依赖安装 ──────────────────────────────────────────────────────────────
step "3. 项目依赖"

if [[ $CHECK_ONLY -eq 1 ]]; then
  if [[ -d "$REPO_DIR/node_modules" ]]; then
    skip "node_modules 已存在"
  else
    die "依赖未安装" "pnpm install"
  fi
else
  (cd "$REPO_DIR" && pnpm install)
  ok "pnpm install 完成"
fi

# ── 4. .env（**只建骨架，绝不代填凭证**）──────────────────────────────────────
step "4. .env"

ENV_FILE="$REPO_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  skip ".env 已存在（不覆盖）"
elif [[ $CHECK_ONLY -eq 1 ]]; then
  die ".env 不存在" "cp .env.example .env 后填飞书凭证"
else
  # 用 install -m 600 原子地建好并设权限，**不要** cp 之后再 chmod ——
  # 那中间有个窗口期文件是 umask 决定的权限（本机 022 → 644，同机其他用户可读）。
  # 此刻文件里还只是占位符、不泄露真东西，但这个模式一旦被复制到将来会预填真实密钥的脚本里
  # 就是真风险（security 评审 2026-09-15 的建议）。
  install -m 600 "$REPO_DIR/.env.example" "$ENV_FILE"
  ok "已从 .env.example 生成 .env（权限 600）"
fi

# 显式写上宿主，便于日志/doctor 一眼看出（非 macOS 本来就会自动选 tmux）
if grep -q '^MCHAT_HOST=' "$ENV_FILE" 2>/dev/null; then
  skip "MCHAT_HOST 已配置"
elif [[ $CHECK_ONLY -eq 1 ]]; then
  warn "MCHAT_HOST 未显式配置（非 macOS 会自动选 tmux，不影响功能，但日志里看不出宿主是谁）"
else
  printf '\nMCHAT_HOST=tmux\n' >> "$ENV_FILE"
  ok "已写入 MCHAT_HOST=tmux"
fi

# 凭证是否已填 —— 只看"还是不是占位符"，不打印值
NEED_CREDS=0
for k in LARK_APP_ID LARK_APP_SECRET; do
  v="$(grep -E "^${k}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  if [[ -z "$v" || "$v" == *xxxx* ]]; then NEED_CREDS=1; fi
done
if [[ $NEED_CREDS -eq 1 ]]; then
  warn "LARK_APP_ID / LARK_APP_SECRET 还是占位符 —— **必须由人填**（见 docs/feishu-bot-setup.md）"
else
  ok "飞书凭证已填"
fi

# ── 5. tmux session ─────────────────────────────────────────────────────────
step "5. tmux session"

SESSION="${MCHAT_TMUX_SESSION:-mchat}"
if tmux has-session -t "$SESSION" 2>/dev/null; then
  skip "session '$SESSION' 已存在"
elif [[ $CHECK_ONLY -eq 1 ]]; then
  warn "session '$SESSION' 不存在（daemon 启动时会自动建，不算错）"
else
  tmux new-session -d -s "$SESSION"
  ok "已建 session '$SESSION'"
fi

# ── 6. 机器门 ───────────────────────────────────────────────────────────────
step "6. 机器验证（能不能起来）"

if [[ $CHECK_ONLY -eq 1 ]]; then
  skip "--check 模式不跑构建"
else
  (cd "$REPO_DIR" && npm run check:boot) || die "check:boot 失败" "上面有具体报错；这说明代码装配不起来，先修它再谈起服务"
  ok "check:boot 通过"
fi

# ── 收尾：还需要人做的事 ─────────────────────────────────────────────────────
step "还需要**人**做的（脚本不代劳 —— 见 docs/windows-setup.md §0「人工操作清单」）"

# 只列**还没做**的；每条直接给出可复制的命令，不让人再去翻文档
TODO=0

if [[ $NEED_CREDS -eq 1 ]]; then
  TODO=1
  printf '\n  \033[33m□ 填飞书凭证\033[0m（值只有你有，脚本不会猜）\n'
  printf '     编辑 %s，把这两行的占位符换成真值：\n' "$ENV_FILE"
  printf '       LARK_APP_ID=cli_...\n       LARK_APP_SECRET=...\n'
  printf '     怎么拿：docs/feishu-bot-setup.md\n'
fi

if ! command -v claude >/dev/null 2>&1; then
  TODO=1
  printf '\n  \033[33m□ 装并登录 claude\033[0m\n'
  printf '     npm i -g @anthropic-ai/claude-code\n'
  printf '     claude          # 按提示完成浏览器登录，然后 /exit\n'
else
  # ⚠ 只能确认"装了"，**无法确认"登录了"**（登录态在 ~/.claude 的凭证里，格式不稳定、不该去猜）。
  # 所以这条**永远会出现**，不是一个"做完就消失"的检查项 —— 措辞上必须说清楚，
  # 否则消费这份清单的人/agent 会把"清单清空"当成配置完成的判据，然后被反复要求去登录。
  TODO=1
  printf '\n  \033[33m□ 确认 claude 已登录\033[0m（脚本只能看到它装了，看不到登录态）\n'
  printf '     claude          # 能进 TUI 且不提示登录就是好的，然后 /exit\n'
fi

TODO=1
printf '\n  \033[33m□ 电源 + 自启\033[0m【管理员 PowerShell】\n'
printf '     ⚠ WSL interop 没有管理员权限，改电源方案必须在 Windows 侧管理员窗口跑\n'
printf '        （从 WSL 调会怎样**未实测** —— 可能报错也可能返回 0 但不生效，按保守取值处理）\n'
printf '     powercfg /change standby-timeout-ac 0\n'
printf '     powercfg /change hibernate-timeout-ac 0\n'
printf '     powercfg -setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0\n'
printf '     powercfg -setactive SCHEME_CURRENT\n'
printf '     schtasks /Create /TN "mchat-wsl" /TR "wsl.exe -d Ubuntu -- true" /SC ONLOGON /RL HIGHEST /F\n'
printf '     另：可以锁屏，别注销（注销会杀掉整个 WSL2 VM）；关掉 Windows Update 自动重启\n'

printf '\n  \033[33m□ daemon 开机自启（WSL 内，要 sudo 但非交互）\033[0m\n'
printf '     见 docs/windows-setup.md §4 —— 那段可以让 agent 代跑\n'

printf '\n\033[1m都做完后起 daemon（⚠ npm run dev 是 tsx watch，**永不退出**，别在前台跑）：\033[0m\n'
printf "  tmux send-keys -t %s 'cd %s && npm run dev' Enter\n" "$SESSION" "$REPO_DIR"
printf '  sleep 15\n'
printf '  agent doctor       # 「宿主实现」应 pass 并显示 tmux\n'
printf '  agent tabs         # 应列出 tmux 的 pane\n'
printf "  tmux capture-pane -p -t %s -S -40   # 看 daemon 日志有没有报错\n" "$SESSION"
printf '\n  验收清单（docs/windows-setup.md §6）是**手机操作场景**，agent 替不了，交给人逐条测。\n\n'

exit 0
