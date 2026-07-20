# 安装手册

> 新 PC 首次跑通完整路径。daemon 现在会做大量自动化 —— 手动步骤压到最少：装依赖 → 填 .env → 跑 dev。

## 你需要拥有

### 硬件
- **macOS** 电脑（AppleScript / Terminal.app 是 host 层的底子；Linux/Windows 不支持）
- 稳定网络（会 WebSocket 长连到飞书服务器）

### 软件
| 软件 | 版本 | 用途 |
|---|---|---|
| Node.js | **≥ 22** | 跑 daemon（低版本 daemon 会 die + 提示升级）|
| pnpm | ≥ 9 | monorepo 包管理 |
| Claude Code CLI | 最新 | Tab 里跑 subagent + 官方 hooks 集成 |
| macOS | 13+ | AppleScript API |
| 飞书 | 手机 + 桌面 | IM |
| 飞书自建应用 | 有 App ID + Secret | Bot 权限（下面第 2 步申请）|

### macOS 权限（首次触发时系统会弹对话框，点「允许」即可，不用提前准备）

daemon 启动时会打印一份权限清单提示。三项：

| 权限 | 用途 | 触发场景 |
|---|---|---|
| **Accessibility** | osascript 发按键 keystroke / key code | 首次 `forceEnter` / `/keys` |
| **Screen Recording** | screencapture 抓 tab 窗口 | 首次 `/screen` |
| **Automation** | osascript 控制 Terminal.app / Chrome | 首次 AppleScript 调 tab |

位置：**System Settings → Privacy & Security → 对应权限项**。任何一项拒绝 = 相关功能失效。

---

## 第 1 步：装依赖

```bash
# Node 22+，用 nvm 装
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
nvm install 22 && nvm use 22

# pnpm（避开 corepack 签名坑）
npm install -g pnpm

# Claude Code CLI（官方）
brew install anthropic/tap/claude-code
# 或 npm 全局装，见 https://code.claude.com
```

**如果 pnpm 报 `Cannot find matching keyid`**（corepack 签名验证问题）：
```bash
rm -f $(which pnpm) $(which pnpx)
npm install -g pnpm
```

---

## 第 2 步：选一个 IM（或都装）

daemon 支持飞书 + 企微两个 IM transport 并行。**至少配一个**，两个都配也行（各自独立 chat state 互不干扰）。

| 选择 | 推荐场景 | 前置 |
|---|---|---|
| **只装飞书**（最简） | 个人 / 团队用飞书 | 只要 App ID / Secret，无需公网 URL（WS 长连接） |
| **只装企微** | 团队用企微不用飞书 | 除应用凭证外还要 `cloudflared tunnel` 或类似暴露 :3939 到公网 |
| **两个都装** | 混合场景（自己用飞书 / 团队用企微） | 上面两条条件全都要 |

**每一路的详细步骤见下面章节**：
- 飞书 → 第 2A 节（本节紧接下面）
- 企微 → 第 2B 节 + [docs/wecom-bot-setup.md](wecom-bot-setup.md)（完整 11 步指南）

---

## 第 2A 步：申请飞书自建应用

1. 打开 [飞书开放平台](https://open.feishu.cn/)（国内）或 [Lark Suite](https://open.larksuite.com/)（海外）
2. 「开发者后台」→ 创建应用 → 「自建应用」
3. 应用能力：
   - 「机器人」启用
   - **左侧「事件与回调」→ 订阅方式 → 「长连接」**（**关键**，否则回调走 HTTPS webhook）
   - 订阅事件：
     - `im.message.receive_v1`（接收消息）
     - `card.action.trigger`（卡片按钮回调）
4. 「权限管理」加权限：
   - `im:message`
   - `im:message:send_as_bot`
   - `im:resource`（文件/图片上传）
   - `im:chat`
   - `im:chat.member.user.read`
5. 「版本管理与发布」→ 创建版本 → 提交发布（个人测试企业一般秒过；企业环境要管理员批）
6. 「凭证与基础信息」抄下：
   - `App ID`（形如 `cli_xxxxxxxxxxxx`）
   - `App Secret`
7. 拉一个测试群，@机器人 加入群

**只装飞书？直接跳到 [第 3 步](#第-3-步克隆--装依赖)。**

---

## 第 2B 步：申请企业微信自建应用（可选）

**要装企微就看**，只飞书跳过本节。

1. 打开 [企业微信管理后台](https://work.weixin.qq.com/) → 扫码登录
2. 「我的企业 → 企业信息」拿 **CorpID**
3. 「应用管理 → 应用」创建自建应用 → 拿 **AgentID + Secret**（Secret 只显示一次抄好）
4. 装 `cloudflared`：`brew install cloudflare/cloudflare/cloudflared`
5. 起 tunnel：`cloudflared tunnel --url http://localhost:3939` → 拿公网 URL
6. 生成 **Token**：`openssl rand -hex 16`
7. 应用「接收消息 → 设置 API 接收」填 URL / Token / 生成 **EncodingAESKey**（**先别保存**，等 daemon 起来后再校验）

完整流程（含 URL 校验、可见范围、常见踩坑）：**[docs/wecom-bot-setup.md](wecom-bot-setup.md)**

---

## 第 3 步：克隆 + 装依赖

```bash
git clone <this-repo> multiAgentChat
cd multiAgentChat
pnpm install
```

**pnpm-lock.yaml 应该自动生成**。如没生成，你的 `~/.npmrc` 可能有 `package-lock=false` —— 项目自带 `.npmrc` 覆盖就够。

---

## 第 4 步：跑一次 dev（会自动帮你 bootstrap）

```bash
pnpm dev
```

**如果 `.env` 缺失**：daemon 会自动从 `.env.example` 复制一份到 `.env` 然后 die + 提示补密钥：
```
[ERROR] .env 不存在 → 已从 .env.example 复制模板到 <path>/.env
请填 LARK_APP_ID 和 LARK_APP_SECRET（飞书开发者后台 → 凭证与基础信息）后重启 dev。
```

编辑 `.env` 填**至少一个 IM** 的凭证（两个都填也行）：

```env
# ============= 飞书（可选，第 2A 步拿的）=============
LARK_APP_ID=cli_xxxxxxxxxxxxxxxx
LARK_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# ============= 企业微信（可选，第 2B 步拿的）=============
# 5 项都填齐才 attach；缺一项就静默跳过（不影响飞书）
# WECOM_CORP_ID=wwxxxxxxxxxxxxxxxx
# WECOM_AGENT_ID=1000002
# WECOM_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# WECOM_TOKEN=xxxxxxxxxxxxxxxx
# WECOM_AES_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# WECOM_CALLBACK_HTTP_PORT=3939
# WECOM_DEFAULT_TO_USER=@all
```

**⚠️ `.env` 已 gitignore，别 commit**。

---

## 第 5 步：再跑 dev，daemon 自动完成剩余安装

```bash
pnpm dev
```

daemon 启动时**自动**做 5 件事：

| # | 动作 | 说明 |
|---|---|---|
| 1 | **assertNodeVersion** | Node < 22 直接 die + 引导升级 |
| 2 | **emitMacPermissionHints** | 打印上表三项权限提示（第一次触发才需要）|
| 3 | **ensureSkillInstalled** | 把 `skills/multiagent-lark/SKILL.md` upsert 到 `~/.claude/skills/multiagent-lark/`（源码有更新时自动同步）|
| 4 | **installClaudeCodeHooks** | 往 `~/.claude/settings.json` 里加 Stop + PreToolUse hooks（幂等）|
| 5 | **ensureAgentOnPath** | `bin/agent` 无 sudo symlink 到 `~/.local/bin/agent` |

期望启动日志：
```
[INFO] node version ok { version: '22.x.x' }
[INFO] macOS 权限一次性提示：...
[INFO] caffeinate started { childPid: xxx }
[INFO] lark bot started (WS long-connection)
[INFO] control server listening { socket: '~/.multiagent-chat/agent.sock' }
[INFO] tab watcher started { pollMs: 2000 }
[INFO] multiagent-lark skill up-to-date (或 installed / updated)
[INFO] Claude Code hooks upserted { ... }
[INFO] agent CLI symlink up-to-date (或 symlinked)
[WARN] /Users/xxx/.local/bin 不在 PATH ...   ← 见下一步
[INFO] [ws] ws client ready
```

**关掉 dev tab = daemon 挂**。要一直跑：
- 简单：nohup `pnpm dev &`
- 生产：pm2 / launchd LaunchAgent

---

## 第 6 步：把 `~/.local/bin` 加到 PATH（一次性）

daemon 帮你 symlink 到 `~/.local/bin/agent`，但如果你 shell 里 `~/.local/bin` 不在 PATH，跑 `agent xxx` 会 command-not-found。

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

（bash 用户改 `~/.bashrc`。fish 用户 `fish_add_path ~/.local/bin`）

---

## 第 7 步：验证

```bash
agent doctor
```

期望：
```
✅ [critical]   Node ≥ 22
✅ [critical]   macOS: darwin
✅ [critical]   .env 完整
✅ [critical]   AppleScript 权限
✅ [important]  Terminal.app 可访问
✅ [important]  Daemon socket + lark client 已初始化
✅ [important]  Skill 已装
...
🟢 整体：健康
```

critical fail 都要按 💡 hint 修完再往下。

---

## 第 8 步：第一条消息

在飞书里给你的机器人发：
```
/dashboard
```

应该收到一张卡，列出 Mac 上所有 Terminal tab。

没收到？
- 机器人被拉进本 chat 了吗？
- 飞书应用「事件与回调」订阅方式是「长连接」吗？
- `agent doctor` 里 lark client 是不是 pass？
- daemon log 有没有报 auth 错？

派个真任务：
```
@ttys001 ls -la
```
（替换 `ttys001` 为你实际的 tab tty，或用 tab 的 cwd basename 也可）

---

## 防休眠说明

daemon 启动时**自动** spawn `caffeinate -i -m -w <daemon-pid>`，阻止 macOS idle sleep。daemon 挂 caffeinate 自动退。不用配置。

`caffeinate` 阻 **idle sleep**（Mac 闲置一段时间自动睡）但**阻不了合盖睡眠**（kernel/固件层，任何软件方案都无解）。合盖也想不睡的三条路见 [features.md 第 10 节](features.md#10-防休眠sleep-prevention)。

env vars：
- `AGENT_NO_CAFFEINATE=1` → 关闭 daemon 自动 caffeinate
- `AGENT_CAFFEINATE_SYSTEM_SLEEP=1` → 加 `-s` 参数（AC 电源下真阻 system sleep）

---

## 常见踩坑

| 坑 | 症状 | 解 |
|---|---|---|
| Accessibility 没开 | `osascript: -1743` 或 `not allowed` | 见「macOS 权限」节，System Settings 里授 |
| Screen Recording 没开 | `/screen` 抓屏返回空 | 同上，Screen Recording 分类 |
| `.env` 没填 | daemon 起来后 lark auth error | daemon 会自动 cp 模板，编辑填密钥重跑 |
| skill 没同步 | tab 里 claude 不知道 `agent lark send-text` | 重启 daemon（会 upsert）；或手动 `agent install-skill` |
| 飞书没配长连接 | 消息收不到 | 开发者后台 → 事件与回调 → 长连接 |
| pnpm 签名错 | `Cannot find matching keyid` | 删掉旧 shim，`npm install -g pnpm` |
| Terminal.app 没开 | 派消息到 tab 时报「tab 不存在」 | 先手动开 Terminal 跑 `claude`；或飞书 `/new` |
| `agent` command-not-found | 别的 shell 里跑 agent 报错 | 加 `~/.local/bin` 到 PATH（见 Step 6）|
| Chrome AppleScript -1712 | Chrome 首次 AppleScript 调用超时 | System Settings → Privacy → Automation 里给 Terminal 授权控制 Chrome |

更多：[troubleshooting.md](troubleshooting.md)

---

## 生产守护 + 开机自启（launchd，可选但推荐）

`npm run dev`（tsx watch）适合边开发边调；**长期挂机**建议用 launchd 托管 —— 登录自启 + 崩溃自动拉起，不用手动开：

```bash
npm run daemon:install     # 安装 LaunchAgent 并立即启动（RunAtLoad 登录自启 + KeepAlive 崩溃自愈）
npm run daemon:status      # 看托管状态 / pid / 上次退出码
scripts/launchd-setup.sh log   # tail 守护日志（~/.multiagent-chat/logs/daemon.{out,err}.log）
npm run daemon:uninstall   # 停止并移除
```

- 用 **LaunchAgent**（`~/Library/LaunchAgents/`，跑在用户登录会话）而非 LaunchDaemon —— daemon 要用 AppleScript 控 Terminal.app，需 GUI 会话。
- **⚠ 与 `npm run dev` 互斥**：两者都绑 `~/.multiagent-chat/agent.sock`。用 launchd 托管前先停掉 dev；要改代码调试时先 `daemon:uninstall` 再 `npm run dev`。
- 改了 `.env` → `npm run daemon:uninstall && npm run daemon:install`（或 `launchctl kickstart -k gui/$(id -u)/com.multiagent-chat.daemon`）重启生效。
- 首次可能要在「系统设置 → 隐私与安全性 → 辅助功能 / 屏幕录制 / 自动化」里给 launchd 拉起的进程授权（同[第 4 步](#)的三项）。

## 测试

传输无关的纯逻辑有 vitest 单测护航：

```bash
npm test           # 跑一遍（vitest run）
npm run test:watch # 改代码自动重跑
```

覆盖：按键序列解析、agent 识别/启动命令、`@target` 路由(chain/batch/fallback)、终端输出净化等。改这些核心逻辑前后跑一下防回归。

## 一次性 vs 长期维护

**一次性**（首次装完就不用再管）：
- Node / pnpm / Claude Code CLI 安装
- 飞书应用申请 + 权限 + 发布
- `.env` 填密钥
- 授 macOS 三项权限
- PATH 加 `~/.local/bin`

**每次更新代码**（`git pull` 后）：
- `pnpm install`（若 lock 变了）
- 重启 dev（daemon 会自动 upsert 新版 SKILL / hooks / symlink）

---

## 下一步

- 学怎么用：[commands.md](commands.md)
- 完整功能：[features.md](features.md)
- SOP 编排：[sop.md](sop.md)
- 出问题：[troubleshooting.md](troubleshooting.md)
