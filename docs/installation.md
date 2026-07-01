# 安装手册

## 你需要拥有

### 硬件
- 一台 **macOS** 电脑（AppleScript / Terminal.app 是本项目 host 层的底子；Linux/Windows 目前不支持）
- 稳定网络（会 WebSocket 长连到飞书服务器）

### 软件
| 软件 | 版本 | 用途 |
|---|---|---|
| Node.js | ≥ 20 | 跑 daemon |
| pnpm | ≥ 9 | monorepo 包管理 |
| Claude Code CLI | 最新 | Tab 里跑 subagent |
| macOS | 13+ | AppleScript API |
| 飞书 | 手机 + 桌面 | IM |
| 飞书自建应用 | 有 App ID + Secret | Bot 权限 |

### macOS 权限
**System Settings → Privacy & Security → Accessibility** 里加：
- Terminal.app（或 iTerm.app 如果用）
- osascript
- 跑 dev 服务的进程（第一次跑起来会自动请求，允许即可）

**这些权限不加，AppleScript 控制 Terminal.app 会被拒绝，整个系统不工作。**

---

## 第 1 步：装依赖

```bash
# Node 20+，用 nvm 装
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/master/install.sh | bash
nvm install 20 && nvm use 20

# pnpm（避开 corepack 签名坑）
npm install -g pnpm

# Claude Code CLI（官方安装脚本，或 npm 全局装）
# 参见 https://code.claude.com
```

**如果 pnpm 装了但报错 `Cannot find matching keyid`**（corepack 签名验证问题）：
```bash
rm -f $(which pnpm) $(which pnpx)
npm install -g pnpm
```

---

## 第 2 步：申请飞书自建应用

1. 打开 [飞书开放平台](https://open.feishu.cn/)
2. 创建应用 → 选择"自建应用"
3. 应用能力：
   - 添加"机器人"能力
   - 事件与回调 → 订阅方式 → **使用长连接接收事件/回调**（**关键**，否则回调走 HTTPS webhook）
   - 订阅事件：
     - `im.message.receive_v1`（接收消息）
     - `card.action.trigger`（卡片按钮回调）
4. 权限：
   - `im:message`
   - `im:message.send_as_bot`
   - `im:resource`（文件/图片上传）
   - `im:chat`
   - `im:chat.member.user.read`
5. 发布版本 → 提交审核（企业管理员批）
6. 记下：
   - `App ID`（形如 `cli_xxxxxxxxxxxx`）
   - `App Secret`
7. 把机器人拉进你要用的 chat / 群

---

## 第 3 步：克隆 + 装依赖

```bash
git clone <this-repo> multiAgentChat
cd multiAgentChat
pnpm install
```

**pnpm-lock.yaml 应该会自动生成**。如果没生成，你的 `~/.npmrc` 可能有 `package-lock=false`：
```bash
# 项目里加一个 .npmrc（已有）
cat .npmrc
# 应该看到 lockfile=true
```

---

## 第 4 步：填 .env

```bash
cp .env.example .env
# 编辑 .env，填：
# LARK_APP_ID=cli_xxxxxxxxxxxx
# LARK_APP_SECRET=xxxxxxxxx
```

**⚠️ 千万不要 commit .env（.gitignore 已排除）**。

---

## 第 5 步：装 skill（让 claude 知道用 agent CLI）

```bash
./bin/agent install-skill
```

这会把 `skills/multiagent-lark/SKILL.md` 拷贝到 `~/.claude/skills/`。以后你所有 Claude Code session 启动时都会自动加载。

不装的话，主 claude 不知道 `agent lark send-text` 命令的存在，任务结果推不回飞书。

---

## 第 6 步：起 daemon

```bash
pnpm dev
```

看到这些说明起来了：
```
[INFO] lark bot started (WS long-connection)
[INFO] control server listening { socket: '/Users/.../agent.sock' }
[INFO] tab watcher started { pollMs: 3000 }
[INFO] stage memory listener attached
[INFO] health check started
[INFO] [ws] ws client ready
```

**关掉这个终端 = daemon 挂掉**。生产上用 `nohup pnpm start &` 或 pm2。

---

## 第 7 步：验证

```bash
./bin/agent doctor
```

期望：
```
✅ [critical]   Node ≥ 20
✅ [critical]   macOS: darwin
✅ [critical]   .env 完整
✅ [critical]   AppleScript 权限
✅ [important]  Terminal.app 可访问
✅ [important]  Daemon socket + lark client 已初始化
✅ [important]  Skill 已装
...
🟢 整体：健康
```

任何 critical fail 都要按 💡 hint 修完再往下。

---

## 第 8 步：第一条消息

在飞书里给你的机器人发：
```
/dashboard
```

应该收到一张卡，列出你 Mac 上所有 Terminal tab。

如果没收到：
- 机器人被拉进你所在 chat 了吗？
- 飞书应用发布了吗？
- `agent doctor` 里 lark client 是不是 pass？

派个真任务：
```
@ttys001 ls -la
```
（替换 `ttys001` 为你实际的 tab tty，或用 tab 的 cwd basename）

---

## 常见踩坑

| 坑 | 症状 | 解 |
|---|---|---|
| Accessibility 没开 | `osascript: -1743` 或 `not allowed` | 见"macOS 权限"节 |
| `.env` 忘填 | daemon 起来后 lark bot 报 auth error | `agent doctor` 会指出 |
| skill 没装 | tab 里 claude 跑完不推消息回飞书 | `./bin/agent install-skill` |
| 飞书没配长连接 | 消息收不到 | 开放平台 → 事件与回调 → 长连接 |
| pnpm 签名错 | `Cannot find matching keyid` | 删掉旧的 shim，`npm install -g pnpm` |
| Terminal.app 没开 | 派消息到 tab 时报 tab 不存在 | 先手动开一个 Terminal，跑 `claude` |

更多问题：[troubleshooting.md](troubleshooting.md)

---

## 下一步

- 学怎么用：[commands.md](commands.md)
- 深入功能：[features.md](features.md)
- SOP 编排：[sop.md](sop.md)
- 出问题：[troubleshooting.md](troubleshooting.md)
