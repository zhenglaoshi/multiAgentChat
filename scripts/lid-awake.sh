#!/usr/bin/env bash
# 「插电合盖也能远程」守护的安装脚本（需要 sudo）。
#
#   sudo scripts/lid-awake.sh install     装成 root LaunchDaemon（开机自启 + 崩溃自愈），立即生效
#   sudo scripts/lid-awake.sh uninstall   停掉、删文件、恢复 disablesleep 0
#   scripts/lid-awake.sh status           看守护状态 / 当前电源 / SleepDisabled（不需要 sudo）
#   scripts/lid-awake.sh log              tail 守护日志
#
# 行为（见 bin/mchat-lid-awake）：插电 → pmset -a disablesleep 1（合盖只灭屏锁屏、不睡）；
# 用电池 → disablesleep 0（恢复默认合盖睡眠）。守护退出时也恢复 0。
#
# 为什么要 root LaunchDaemon：pmset 改 disablesleep 需要 root；放 LaunchDaemon 独立于 chat daemon，
# chat daemon 挂了它照样把「拔电→恢复睡眠」做对，不会把机器留在永不睡状态。
# 脚本会被 **复制** 到 root 专属路径再由 root 执行（不直接跑仓库里用户可写的文件）。
#
# ⚠ disablesleep=1 期间「苹果菜单 → 睡眠」也不会睡；要睡就拔电（自动恢复）或 uninstall。
# ⚠ 安全语义：插电合盖不睡 = 机器无人值守时持续联网、可远程操控（本项目 socket / 可选 Web Dashboard 等面持续在线）。
#    只在需要远程的机器上装；公共网络注意防火墙；Web Dashboard 务必设强 token。
# 守护 plist 是 KeepAlive=true：kill 掉只会被 launchd 拉起；真正停用只能 uninstall / launchctl bootout。
set -euo pipefail

LABEL="com.multiagent-chat.lid-awake"
PLIST="/Library/LaunchDaemons/$LABEL.plist"
BIN_DST="/usr/local/libexec/mchat-lid-awake"
LOG_DIR="/Library/Logs/multiagent-chat"
LOG="$LOG_DIR/lid-awake.log"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_SRC="$REPO/bin/mchat-lid-awake"

need_root() { [ "$(id -u)" -eq 0 ] || { echo "❌ 这一步需要 root：sudo $0 $1"; exit 1; }; }

show_status() {
  echo "── 合盖远程守护（${LABEL}）"
  if [ -f "$PLIST" ]; then
    if launchctl print "system/$LABEL" >/dev/null 2>&1; then
      echo "   守护：✅ 已装并在运行"
    else
      echo "   守护：⚠ plist 在但未加载（试 sudo launchctl bootstrap system $PLIST）"
    fi
  else
    echo "   守护：✖ 未安装（sudo scripts/lid-awake.sh install）"
  fi
  local sd src
  # set -e + pipefail 下 pmset 非 0 会直接终止脚本 → 用 || 兜底，读不到就显示 ?
  sd="$(pmset -g 2>/dev/null | awk '$1=="SleepDisabled" {print $2; exit}')" || sd=''
  src="$(pmset -g batt 2>/dev/null | awk -F"'" 'NR==1 {print $2; exit}')" || src=''
  [ -n "$sd" ] || sd='0'
  [ -n "$src" ] || src='?' 
  echo "   电源：${src}    SleepDisabled：${sd}（1=合盖不睡）"
  [ -f "$LOG" ] && { echo "   最近日志："; tail -3 "$LOG" | sed 's/^/     /'; }
}

cmd="${1:-status}"
case "$cmd" in
  install)
    need_root install
    [ -f "$BIN_SRC" ] || { echo "❌ 找不到 $BIN_SRC"; exit 1; }
    bash -n "$BIN_SRC"
    mkdir -p /usr/local/libexec "$LOG_DIR"
    install -o root -g wheel -m 755 "$BIN_SRC" "$BIN_DST"
    cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${BIN_DST}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
PLISTEOF
    chown root:wheel "$PLIST"; chmod 644 "$PLIST"
    plutil -lint "$PLIST" >/dev/null
    launchctl bootout "system/$LABEL" 2>/dev/null || true
    launchctl bootstrap system "$PLIST"
    launchctl kickstart -k "system/$LABEL"
    sleep 2
    echo "✅ 已安装。插电=合盖不睡，拔电=恢复默认。"
    show_status
    ;;
  uninstall)
    need_root uninstall
    launchctl bootout "system/$LABEL" 2>/dev/null || true
    rm -f "$PLIST" "$BIN_DST"
    pmset -a disablesleep 0
    echo "✅ 已卸载，disablesleep 已恢复 0（合盖照常睡）。日志保留在 $LOG"
    ;;
  status) show_status ;;
  log) [ -f "$LOG" ] || { echo "还没有日志：$LOG"; exit 1; }; tail -f "$LOG" ;;
  *) echo "用法：sudo $0 install|uninstall   或   $0 status|log"; exit 2 ;;
esac
