#!/usr/bin/env bash
# multiAgentChat daemon 的 launchd 守护 + 开机(登录)自启。
#
#   scripts/launchd-setup.sh install     安装并立即启动（RunAtLoad 登录自启 + KeepAlive 崩溃自愈）
#   scripts/launchd-setup.sh uninstall   停止并移除
#   scripts/launchd-setup.sh status      查看状态
#   scripts/launchd-setup.sh log         tail 守护日志
#
# 用 LaunchAgent（~/Library/LaunchAgents，跑在用户登录会话里）——
# 因为 daemon 要用 AppleScript 控 Terminal.app，需要 GUI 会话；LaunchDaemon（boot 时、无会话）不行。
#
# ⚠ 与 `npm run dev`（tsx watch）互斥：两者都绑 ~/.multiagent-chat/agent.sock。
#    用 launchd 托管前先停掉 dev；要改代码调试时先 uninstall 再跑 dev。
set -euo pipefail

LABEL="com.multiagent-chat.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$HOME/.multiagent-chat/logs"
NODE="$(command -v node || true)"
TSX="$REPO/node_modules/.bin/tsx"
DOMAIN="gui/$(id -u)"

cmd="${1:-install}"

case "$cmd" in
  install)
    [ -n "$NODE" ] || { echo "❌ 找不到 node（command -v node 为空）"; exit 1; }
    [ -x "$TSX" ] || { echo "❌ 找不到 $TSX —— 先在仓库根跑 pnpm install"; exit 1; }
    [ -f "$REPO/.env" ] || echo "⚠ 未见 $REPO/.env —— daemon 起不了 lark bot，先 cp .env.example .env 填好"
    mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

    cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${TSX}</string>
    <string>${REPO}/apps/daemon/src/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${LOG_DIR}/daemon.out.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/daemon.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLISTEOF

    # bootout 旧的（忽略未加载错误）再 bootstrap
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
    echo "✅ 已安装 + 启动：$PLIST"
    echo "   登录自启 + 崩溃自愈已开。日志：$LOG_DIR/daemon.{out,err}.log"
    echo "   状态：scripts/launchd-setup.sh status ；停用：scripts/launchd-setup.sh uninstall"
    ;;

  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "✅ 已停止并移除 $LABEL"
    ;;

  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      echo "● 已托管（$LABEL）"
      launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state|pid|last exit" | sed 's/^/  /' || true
    else
      echo "○ 未托管（用 install 安装）"
    fi
    ;;

  log)
    tail -f "$LOG_DIR/daemon.out.log" "$LOG_DIR/daemon.err.log"
    ;;

  *)
    echo "用法：scripts/launchd-setup.sh install|uninstall|status|log"
    exit 1
    ;;
esac
