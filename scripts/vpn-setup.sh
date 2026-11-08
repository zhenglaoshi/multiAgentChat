#!/bin/bash
# multiAgentChat VPN 一次性安装（方案 B：daemon 自己跑 openvpn，锁屏也能连）
#
#   sudo bash scripts/vpn-setup.sh             安装 / 重装（Tunnelblick 配置更新后重跑；会先断开 /vpn 起的连接，装完需重新 /vpn 连）
#   sudo bash scripts/vpn-setup.sh --uninstall 卸载（先断开所有 mchat-vpn 连接，确认停了才删）
#
# 做的事（都需要 root，所以要 sudo）：
#   1. 把 Tunnelblick 自带的 openvpn 复制到 /usr/local/libexec/mchat-vpn.d/openvpn
#      （不直接跑 /Applications 里的那份：/Applications 是 admin 组可写，能被换掉 → 经免密 sudo 提权）。
#      复制前要求签名有效且签名团队是 Tunnelblick（Z2SG5H3HC8）
#   2. 把正式 / 测试两份 Tunnelblick 配置（Resources 下的顶层文件；有子目录 / 符号链接则中止）
#      复制到 mchat-vpn.d/{prod,dev}/，只有 root 能读；按白名单检查：已知危险指令（plugin/up/log/…）剥离，
#      不认识的指令中止安装（只打印指令名，不打印值）
#   3. 安装 root 小程序 /usr/local/libexec/mchat-vpn（参数白名单 up|down prod|dev / status）
#   4. 写 /etc/sudoers.d/mchat-vpn：只给你本人免密放行这 5 种调用；写入前 visudo -c 校验
#
# 不做的事：不改 Tunnelblick 本身、不读也不打印账号密码、不改 DNS / 网络设置。
set -euo pipefail
umask 022
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

# ---- 按需修改：Tunnelblick 里的配置名（Tunnelblick 菜单里看到的名字） ----
PROD_NAME="zhengjiquan-prod-2026"
DEV_NAME="zhengjiquan-dev-2026 (1)"
OPENVPN_SRC="/Applications/Tunnelblick.app/Contents/Resources/openvpn/openvpn-2.6.21-openssl-3.0.21/openvpn"
TB_TEAM_ID="Z2SG5H3HC8"
# ---------------------------------------------------------------------------

TB_SHARED="/Library/Application Support/Tunnelblick/Shared"
DEST=/usr/local/libexec/mchat-vpn.d
HELPER=/usr/local/libexec/mchat-vpn
SUDOERS=/etc/sudoers.d/mchat-vpn
HERE="$(cd "$(dirname "$0")" && pwd)"

die() { echo "❌ $*" >&2; exit 1; }
ok() { echo "✅ $*"; }

[ "$(id -u)" = 0 ] || die "请用 sudo 运行：sudo bash scripts/vpn-setup.sh"
OWNER="${SUDO_USER:-}"
[ -n "$OWNER" ] && [ "$OWNER" != root ] || die "请用你自己的账号 sudo 运行（取不到 SUDO_USER）"
# 要写进 sudoers：与 mchat-vpn 读 owner 时同一条正则
[[ "$OWNER" =~ ^[a-z_][a-z0-9_.-]*$ ]] || die "用户名 $OWNER 含不支持的字符"
id -u "$OWNER" >/dev/null 2>&1 || die "用户 $OWNER 不存在"

# >>> CONFIG-CHECK（scripts/vpn-setup.sh 与 scripts/vpn/mchat-vpn 两处逐字相同；tests/vpn-scripts.test.ts 校验）
# 输出：mode=check → 每个问题一行「DROP <指令>」（已知危险、安装时剥离）或「BAD <指令>」（不认识 / 写法可疑，中止）；
#       mode=strip → 去掉 DROP 行后的配置正文。
CONFIG_CHECK_AWK='
BEGIN {
  n = split("client tls-client pull dev dev-type proto remote port rport lport nobind float remote-random " \
    "resolv-retry connect-retry connect-retry-max connect-timeout server-poll-timeout " \
    "persist-key persist-tun persist-remote-ip persist-local-ip ca cert key pkcs12 dh tls-auth tls-crypt " \
    "tls-crypt-v2 key-direction extra-certs crl-verify cipher data-ciphers data-ciphers-fallback ncp-ciphers " \
    "ncp-disable auth tls-cipher tls-ciphersuites tls-groups tls-version-min tls-version-max remote-cert-tls " \
    "remote-cert-ku remote-cert-eku ns-cert-type verify-x509-name auth-user-pass auth-nocache static-challenge " \
    "reneg-sec reneg-bytes reneg-pkts tran-window hand-window tls-timeout key-method comp-lzo compress " \
    "allow-compression comp-noadapt verb mute mute-replay-warnings replay-window keepalive ping ping-restart " \
    "ping-exit ping-timer-rem inactive explicit-exit-notify sndbuf rcvbuf tun-mtu tun-mtu-extra link-mtu " \
    "mssfix fragment txqueuelen redirect-gateway redirect-private route route-ipv6 route-gateway route-metric " \
    "route-delay route-nopull pull-filter dhcp-option block-ipv6 topology ifconfig-nowarn push-peer-info " \
    "allow-pull-fqdn tun-ipv6 block-outside-dns peer-fingerprint route-ipv6-gateway", a, " ")
  for (i = 1; i <= n; i++) ALLOW[a[i]] = 1
  n = split("plugin up down down-pre up-delay up-restart route-up route-pre-down ipchange client-connect " \
    "client-disconnect learn-address tls-verify auth-user-pass-verify tls-crypt-v2-verify iproute " \
    "script-security config cd chroot daemon log log-append status writepid tmp-dir setenv setenv-safe " \
    "ignore-unknown-option tls-export-cert auth-gen-token-secret user group pkcs11-providers engine providers " \
    "dns-updown", a, " ")
  for (i = 1; i <= n; i++) DROP[a[i]] = 1
  n = split("ca cert key pkcs12 dh tls-auth tls-crypt tls-crypt-v2 extra-certs", a, " ")
  for (i = 1; i <= n; i++) BLOCK[a[i]] = 1
  # 这些指令的参数是文件：只许同目录下的简单文件名或 [inline]，不许绝对路径 / ..（防 root 读任意文件）
  n = split("ca cert key pkcs12 dh tls-auth tls-crypt tls-crypt-v2 extra-certs crl-verify", a, " ")
  for (i = 1; i <= n; i++) FILEARG[a[i]] = 1
  inblk = ""
}
function emit(line) { if (mode == "strip") print line }
function bad(what) { if (mode == "check") print "BAD " what }
{
  line = $0
  sub(/\r$/, "", line)
  if (inblk != "") {
    t = line; gsub(/^[ \t]+|[ \t]+$/, "", t)
    if (t == "</" inblk ">") inblk = ""
    emit(line); next
  }
  t = line; sub(/^[ \t]+/, "", t)
  if (t == "" || t ~ /^[#;]/) { emit(line); next }
  if (t ~ /^</) {
    tag = t; gsub(/[ \t]+$/, "", tag)
    if (tag ~ /^<[a-z0-9-]+>$/) {
      name = substr(tag, 2, length(tag) - 2)
      if (name in BLOCK) { inblk = name; emit(line); next }
    }
    bad("<" substr(tag, 2, 40)); emit(line); next
  }
  split(t, f, /[ \t]+/)
  name = f[1]
  sub(/^--/, "", name)
  if (name !~ /^[a-z0-9-]+$/) { bad(substr(f[1], 1, 40)); emit(line); next }
  if (name ~ /^management/ || (name in DROP)) { if (mode == "check") print "DROP " name; next }
  if (!(name in ALLOW)) { bad(name); emit(line); next }
  if ((name in FILEARG) && f[2] != "" && f[2] != "[inline]" && f[2] !~ /^[A-Za-z0-9_][A-Za-z0-9._-]*$/) { bad(name " <非本目录文件>"); emit(line); next }
  if (name == "auth-user-pass" && f[2] != "") { bad("auth-user-pass <带文件参数>"); emit(line); next }
  emit(line)
}
END { if (inblk != "" && mode == "check") print "BAD <" inblk "> 未闭合" }
'
# <<< CONFIG-CHECK

# 路径上每一级都必须 root 持有、组/其他人不可写（与 mchat-vpn 的 assert_root_path 同规则）
assert_src_root() {
  local p="$1"
  while [ "$p" != "/" ] && [ -n "$p" ]; do
    [ "$(stat -f %u "$p")" = 0 ] || die "不是 root 持有：$p"
    local mode; mode="$(stat -f %Lp "$p")"
    (( (8#$mode & 8#022) == 0 )) || die "可被组/其他人写：${p}（拒绝信任这里的配置）"
    p="$(dirname "$p")"
  done
}

# 断开 mchat-vpn 起的连接（重装 / 卸载前都要：重装会重建配置目录）。
# 必须确认进程真停了才返回 —— 停不掉就中止，不能删了 pid/socket 留下没人管的 root openvpn。
# ⚠ 断开的连接**回滚也恢复不了**：重连要你给新的 6 位令牌，脚本拿不到 → 记下断了哪些，最后如实提示。
STOPPED_ENVS=""
# 只认 uid 0 且真实可执行文件是我们那份 openvpn 的进程（与 mchat-vpn 的 is_our_openvpn 同规则；argv 可伪造不算数）
ours() {
  local uid exe
  [[ "$1" =~ ^[0-9]+$ ]] || return 1
  uid="$(ps -o uid= -p "$1" 2>/dev/null | tr -d ' ' || true)"
  [ "$uid" = 0 ] || return 1
  exe="$(/usr/sbin/lsof -a -p "$1" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | head -n1 || true)"
  [ "$exe" = "$DEST/openvpn" ]
}
stop_all() {
  local env out
  if [ -x "$HELPER" ]; then
    for env in prod dev; do
      out="$("$HELPER" down "$env" 2>/dev/null || true)"
      [ "$out" = "$env stopped" ] && STOPPED_ENVS="$STOPPED_ENVS $env"
    done
  fi
  # 兜底（小程序不在 / down 失败）：只认 uid 0 且真实可执行文件是我们那份 openvpn 的进程——
  # 不按命令行特征杀（argv 可伪造）。与 mchat-vpn 的 is_our_openvpn 同规则
  local pid alive="" i
  for pid in $(ps -axo pid=,args= | awk '/--daemon mchat-vpn-(prod|dev)/ && !/awk/ { print $1 }'); do
    ours "$pid" || continue
    # 杀之前先记下是哪个环境（杀完 ps 就读不到了）；BSD sed 的基本正则不支持 \|，用 -E
    env="$(ps -o args= -p "$pid" 2>/dev/null | sed -n -E 's/.*--daemon mchat-vpn-(prod|dev)([[:space:]].*)?$/\1/p' || true)"
    # 每次发信号前都重新确认身份（pid 可能已被复用）
    if ours "$pid"; then kill -TERM "$pid" 2>/dev/null || true; fi
    for i in $(seq 1 50); do ours "$pid" || break; sleep 0.1; done
    if ours "$pid"; then kill -KILL "$pid" 2>/dev/null || true; sleep 0.2; fi
    if ours "$pid"; then
      alive="$alive $pid"
    else
      STOPPED_ENVS="$STOPPED_ENVS ${env:-?}"
    fi
  done
  [ -z "$alive" ] || die "这些 mchat-vpn openvpn 进程停不掉：$alive —— 手动 sudo kill 后再重跑"
}
reconnect_hint() {
  [ -z "${STOPPED_ENVS// /}" ] || echo "ℹ️  安装过程中断开了 /vpn 起的连接（${STOPPED_ENVS# }）—— 需要重新 /vpn 连（要新令牌），脚本没法替你重连" >&2
}

if [ "${1:-}" = "--uninstall" ]; then
  stop_all
  rm -f "$SUDOERS" "$HELPER"
  rm -rf "$DEST"
  ok "已卸载"
  reconnect_hint
  exit 0
fi

# ===== 准备阶段：一切都在 root 专属暂存目录 $STAGE 里做完、全部校验通过，才动正在用的东西 =====
# 任何一步失败都直接中止：旧安装、旧连接都还没动（准备阶段失败不会出现「连接断了但没装成」/「第一份配置换了第二份没过」）
STAGE=/usr/local/libexec/.mchat-vpn.d.staging
[ ! -L "$STAGE" ] || die "$STAGE 是符号链接"
rm -rf "$STAGE"
mkdir -m 700 "$STAGE"
chown root:wheel "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

# 1. openvpn。⚠ 必须「先复制进 root 专属目录、再校验那份复制品」，不能先验源再从源复制：
#    /Applications 是 root:admin 775 且无 sticky 位，以用户身份跑的进程能把整个 Tunnelblick.app 换成自己持有的树，
#    在「验签」与「复制」两次读之间调包（安全评审 2026-11-05 实测）。复制品落在 root-only 的 $STAGE 后没人能再改。
[ -f "$OPENVPN_SRC" ] || die "找不到 Tunnelblick 自带的 openvpn：${OPENVPN_SRC}（Tunnelblick 升级后版本目录可能变了，改脚本顶部 OPENVPN_SRC）"
install -o root -g wheel -m 700 "$OPENVPN_SRC" "$STAGE/openvpn"
codesign --verify --strict "$STAGE/openvpn" 2>/dev/null || die "openvpn 签名校验失败，拒绝安装（本机 codesign 能用吗？在 Mac 终端里跑：codesign --verify --strict -v \"$OPENVPN_SRC\"）"
team="$(codesign -dv "$STAGE/openvpn" 2>&1 | sed -n 's/^TeamIdentifier=//p' || true)"
[ "$team" = "$TB_TEAM_ID" ] || die "openvpn 的签名团队是「${team}」，不是 Tunnelblick（${TB_TEAM_ID}），拒绝安装"
chmod 755 "$STAGE/openvpn"
ok "openvpn 已复制并校验签名（$("$STAGE/openvpn" --version 2>/dev/null | head -n1 | cut -c1-60 || true)）"

# 2. 配置（两份都在暂存目录里复制 + 校验 + 剥离）
copy_conf() {
  local env="$1" name="$2"
  local src="$TB_SHARED/$name.tblk/Contents/Resources"
  [ -f "$src/config.ovpn" ] || die "找不到配置：$src/config.ovpn（改脚本顶部 PROD_NAME / DEV_NAME）"
  # 配置源必须 root 持有、别人不可写（本机 Tunnelblick/Shared 是 root:wheel 755；若哪天变成 admin 可写，
  # 就会有和 openvpn 同样的整树替换问题 —— 到时候先中止，别默默信任）
  assert_src_root "$src"
  assert_src_root "$src/config.ovpn"
  # 只复制顶层普通文件，不跟随符号链接；有子目录 / 符号链接 / 其他类型就中止（别悄悄漏拷证书）
  local odd
  odd="$(find "$src" -mindepth 1 ! -type f -print | head -n 3)"
  [ -z "$odd" ] || die "$src 下有子目录或符号链接（如：${odd}），本脚本只支持平铺的配置目录 —— 发给 claude 适配"
  mkdir -m 700 "$STAGE/$env"
  find "$src" -mindepth 1 -maxdepth 1 -type f -exec cp {} "$STAGE/$env/" \;
  [ -f "$STAGE/$env/config.ovpn" ] || die "复制 $env 配置失败"
  chown -R root:wheel "$STAGE/$env"
  find "$STAGE/$env" -type f -exec chmod 600 {} +

  local cfg="$STAGE/$env/config.ovpn" problems bad dropped
  problems="$(awk -v mode=check "$CONFIG_CHECK_AWK" "$cfg" | sort -u)"
  bad="$(printf '%s\n' "$problems" | sed -n 's/^BAD //p' | tr '\n' ' ')"
  dropped="$(printf '%s\n' "$problems" | sed -n 's/^DROP //p' | tr '\n' ' ')"
  [ -z "${bad// /}" ] || die "$env 配置里有白名单外的指令：${bad}—— 把这行提示发给 claude 适配（没有打印任何值；旧安装未改动）"
  awk -v mode=strip "$CONFIG_CHECK_AWK" "$cfg" > "$cfg.tmp"
  mv "$cfg.tmp" "$cfg"
  chown root:wheel "$cfg"; chmod 600 "$cfg"
  [ -z "$(awk -v mode=check "$CONFIG_CHECK_AWK" "$cfg")" ] || die "$env 配置剥离后仍未通过检查（不应发生）"
  [ -z "${dropped// /}" ] || echo "ℹ️  $env 配置里剥离了：${dropped}（root 直接跑用不着，留着有提权风险）"
  if grep -q -E '^[[:space:]]*(--)?static-challenge([[:space:]]|$)' "$cfg"; then
    ok "$env 配置已校验（含 static-challenge，令牌走管理接口交）"
  else
    echo "⚠️  $env 配置里没找到 static-challenge —— 令牌的提交方式可能不同，先别用 /vpn ${env}，把这条提示发给 claude"
  fi
}
copy_conf prod "$PROD_NAME"
copy_conf dev "$DEV_NAME"

# owner 文件：小程序据此把管理 socket 交给你
printf '%s\n' "$OWNER" > "$STAGE/owner"
chown root:wheel "$STAGE/owner"; chmod 644 "$STAGE/owner"

# 3. root 小程序：先复制进暂存目录，之后只用这份副本（语法检查、打印哈希、安装都对同一份）——
#    源文件在仓库里、你本人可写，「检查完再从源复制」中间可能被换。哈希打印出来供你核对。
[ -f "$HERE/vpn/mchat-vpn" ] || die "缺 $HERE/vpn/mchat-vpn"
install -o root -g wheel -m 700 "$HERE/vpn/mchat-vpn" "$STAGE/mchat-vpn"
/bin/bash -n "$STAGE/mchat-vpn" || die "mchat-vpn 语法错误"
helper_sha="$(shasum -a 256 "$STAGE/mchat-vpn" | cut -d' ' -f1)"
setup_sha="$(shasum -a 256 "$0" | cut -d' ' -f1)"

# 4. sudoers：先写进暂存目录 + visudo -c 校验（校验不过不落地，防把 sudo 弄坏）。
#    只放行 5 种具体调用（sudoers 层也限参数）；显式 env_reset 防 BASH_ENV 之类穿透
{
  echo "# multiAgentChat VPN：只免密放行这个 root 持有的小程序的 5 种调用（scripts/vpn-setup.sh 生成）"
  echo "Defaults!$HELPER env_reset, secure_path=\"/usr/bin:/bin:/usr/sbin:/sbin\""
  echo "$OWNER ALL=(root) NOPASSWD: $HELPER up prod, $HELPER up dev, $HELPER down prod, $HELPER down dev, $HELPER status"
} > "$STAGE/sudoers"
visudo -c -f "$STAGE/sudoers" >/dev/null || die "sudoers 校验失败，未写入"
ok "全部准备完成并通过校验"

# ===== 切换阶段：到这里才断开旧连接、替换正式目录 =====
# 回滚是**先装好再动手**：从这里开始任何一步失败，EXIT trap 都按「旧目录 → 旧 sudoers → 旧小程序」
# 尽力恢复到切换前的**文件**状态（已断开的连接恢复不了，见 stop_all）。rollback 关掉 set -e、每步各自 || true：某一步恢复失败不能连累后面的恢复被跳过
# （bash 里 trap 处理函数照样受 set -e 约束，实测会在第一条失败处中止）。
old=""; bak_helper=""; bak_sudoers=""; committed=""
# 只有正式文件**确实被换过**才从备份恢复：没换过的一律不碰（备份可能不完整，不能拿它盖一个完好的文件）
helper_replaced=""; sudoers_replaced=""
# 切换前配置目录存不存在：决定回滚时是「恢复旧的」「删掉新的」还是「没动过、别碰」
had_dest=""
{ [ -e "$DEST" ] || [ -L "$DEST" ]; } && had_dest=1
rollback() {
  set +e
  [ -n "$committed" ] && return 0
  echo "↩️  安装没完成，回滚到切换前…" >&2
  if [ -n "$old" ] && [ -e "$old" ]; then
    rm -rf "$DEST"
    mv "$old" "$DEST" || echo "⚠️  旧配置目录还在 ${old}，手动 sudo mv \"$old\" \"$DEST\"" >&2
  elif [ -z "$had_dest" ]; then
    rm -rf "$DEST"   # 首次安装：不留半套
  fi                 # 否则：旧目录还没被挪走，原样不动
  if [ -n "$sudoers_replaced" ]; then
    if [ -n "$bak_sudoers" ] && [ -e "$bak_sudoers" ]; then
      mv -f "$bak_sudoers" "$SUDOERS" || echo "⚠️  旧 sudoers 备份在 ${bak_sudoers}，手动恢复" >&2
    else
      rm -f "$SUDOERS"   # 原来没有 → 删掉新放上去的
    fi
  fi
  if [ -n "$helper_replaced" ]; then
    if [ -n "$bak_helper" ] && [ -e "$bak_helper" ]; then
      mv -f "$bak_helper" "$HELPER" || echo "⚠️  旧小程序备份在 ${bak_helper}，手动恢复" >&2
    else
      rm -f "$HELPER"
    fi
  fi
  reconnect_hint
  rm -rf "$STAGE"
  rm -f "$HELPER.new" "$SUDOERS.new" "$HELPER.bak.$$" "$HELPER.bak.$$.tmp" "$SUDOERS.bak.$$" "$SUDOERS.bak.$$.tmp"
}
trap 'rollback' EXIT

# 先把要单独落位的两个文件挪到最终位置旁（.new；sudoers.d 里带「.」的文件 sudo 不读）
mv "$STAGE/mchat-vpn" "$HELPER.new"
mv "$STAGE/sudoers" "$SUDOERS.new"
# 覆盖前先给旧小程序 / 旧 sudoers 留备份（还没动任何正式文件）
# 备份原子落位（先 .tmp 再 mv）：「备份文件存在」= 完整复制成功
if [ -f "$HELPER" ]; then cp -p "$HELPER" "$HELPER.bak.$$.tmp"; mv -f "$HELPER.bak.$$.tmp" "$HELPER.bak.$$"; bak_helper="$HELPER.bak.$$"; fi
if [ -f "$SUDOERS" ]; then cp -p "$SUDOERS" "$SUDOERS.bak.$$.tmp"; mv -f "$SUDOERS.bak.$$.tmp" "$SUDOERS.bak.$$"; bak_sudoers="$SUDOERS.bak.$$"; fi
stop_all
if [ -e "$DEST" ] || [ -L "$DEST" ]; then
  old="$(dirname "$DEST")/.mchat-vpn.d.old.$$"
  mv "$DEST" "$old"
fi
mv "$STAGE" "$DEST"
chmod 755 "$DEST"
chmod 755 "$HELPER.new"
helper_replaced=1
mv -f "$HELPER.new" "$HELPER"
chown root:wheel "$SUDOERS.new"; chmod 440 "$SUDOERS.new"
sudoers_replaced=1
mv -f "$SUDOERS.new" "$SUDOERS"
# 全局 visudo -c：新 sudoers 与 sudoers.d 其余文件**合在一起**是否合法（准备阶段的 -f 只验得了单个文件）
visudo -c >/dev/null || die "整体 sudoers 校验失败（新规则和 /etc/sudoers.d 里别的文件冲突？）—— 回滚到旧安装"
# 自检也算提交前检查：以你本人身份免密跑一次 status，不通过就回滚（不留一个「装上了但用不了」的新安装）
sudo -u "$OWNER" sudo -n "$HELPER" status >/dev/null || die "自检失败：$OWNER 免密执行 $HELPER status 不成功 —— 回滚到旧安装"
# 全部成功：提交（之后再失败也不回滚了）
committed=1
trap - EXIT
# 自检时小程序已建好空的 log/；有旧日志就换成旧的
if [ -n "$old" ] && [ -d "$old/log" ] && [ ! -L "$old/log" ]; then
  rmdir "$DEST/log" 2>/dev/null || true
  [ -e "$DEST/log" ] || mv "$old/log" "$DEST/log"
fi
[ -z "$old" ] || rm -rf "$old"
rm -f "$bak_helper" "$bak_sudoers"
ok "已安装：${HELPER}、${DEST}、${SUDOERS}（仅 $OWNER → up/down prod|dev、status 免密）"
echo "   安装脚本 sha256：$setup_sha"
echo "   小程序   sha256：$helper_sha"

ok "自检通过：$OWNER 可免密执行 mchat-vpn status"
reconnect_hint
echo
echo "安装完成。下一步：在飞书发 /vpn dev 试连测试环境（/vpn 功能做完后）。"
echo "注意：同一个环境别同时用 Tunnelblick 和 /vpn 连（会互相踢掉）；正式和测试可以同时连。"
