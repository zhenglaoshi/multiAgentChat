# Windows 对接文档（WSL2 + tmux）

> **一句话**：Windows 侧不装任何终端软件，所有东西跑在 WSL2 里；终端由 tmux 托管，
> daemon 通过 tmux 控制 pane 里的 claude / codex。手机飞书 → daemon → tmux → agent。
>
> ⚠ **现状（2026-09-15）**：代码已实现（`packages/host-tmux/`，全套单测通过 —— `npm test`），
> 但**没有在任何 Windows 机器上真跑过**。本文第 6 节是验收清单，第 8 节是已知未验项。
> 设计与取舍论证见 [windows-port.md](windows-port.md)。

---

## 0. 谁做哪一步（**先读这节**）

这份文档**不能整份丢给 agent 自动跑完**。有四类事 agent 做不了，必须人来：

| 必须人做 | 为什么 agent 做不了 |
|---|---|
| **装 WSL2 本身**（§2.1） | 要**管理员 PowerShell** + **重启**。而且这一步之前根本还没有 WSL —— agent 没有立足点，鸡生蛋 |
| **电源策略**（§3）、**任务计划注册**（§4 Windows 侧） | 要**管理员**。WSL interop 继承的是当前用户权限、**没有管理员**；具体表现**未实测**（见 §3），按保守取值：必须在 Windows 侧管理员窗口做 |
| **飞书凭证**（§2.5 的 `LARK_APP_ID` / `LARK_APP_SECRET`） | 只有你有。脚本**不会**去猜或代填 |
| **claude / codex 登录** | 浏览器 OAuth，交互式 |

除此之外（WSL 内的依赖、Node、项目安装、`.env` 骨架、tmux session、加载期冒烟）**都能自动化**，
已经打包成一条命令：

```bash
bash scripts/wsl-setup.sh           # 装
bash scripts/wsl-setup.sh --check   # 只自检，不改任何东西
```

它是**幂等**的（重复跑安全，已就绪的步骤打印 skip 跳过）、**失败即停**（卡在哪、下一步干什么都会说清楚），
跑完会列出「还需要人做」的勾选清单。

### 人工操作清单（复制即用）

下面六条是**只能人做**的全部内容，每条都给了确切命令。agent 遇到这些**不要代劳，把对应那条贴给人**即可。

**① 装 WSL2** 🧑 管理员 PowerShell，装完要重启

```powershell
wsl --install -d Ubuntu
wsl --set-default-version 2
# 重启 → 按提示创建 Linux 用户名/密码 → 验证：
wsl -l -v          # 期望 Ubuntu  Running  2
```

**② 开 systemd** 🧑 WSL 内执行，之后要 `wsl --shutdown` 重启 WSL

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
# 回 PowerShell：wsl --shutdown，再 wsl 进去。验证：
systemctl is-system-running    # 有输出即可（degraded 也算正常）
```

**③ 拉仓库到 WSL 文件系统内** 🧑 `<仓库地址>` 换成你的

```bash
cd ~ && git clone <仓库地址> multiAgentChat   # ⚠ 必须在 ~ 下，别放 /mnt/c
```

**④ 填飞书凭证** 🧑 值只有你有，脚本不会猜也不会代填

```bash
cd ~/multiAgentChat
# 编辑 .env，把这两行的占位符换成真值（怎么拿见 docs/feishu-bot-setup.md）：
#   LARK_APP_ID=cli_xxxxxxxxxxxxxxxx
#   LARK_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
chmod 600 .env
```

**⑤ 登录 claude（和 codex）** 🧑 浏览器 OAuth，无法自动化

```bash
npm i -g @anthropic-ai/claude-code
claude          # 跑起来按提示完成登录，然后 /exit
# 要用 codex 的话：装好后跑一次 codex 登录，并在 TUI 里 /hooks 批准（否则 hook 不生效）
```

**⑥ 电源 + 自启** 🧑 管理员 PowerShell（WSL interop 没有管理员权限，改电源方案必须在 Windows 侧做）

```powershell
# 电源：插电时永不睡、永不休眠、合盖不睡
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg -setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg -setactive SCHEME_CURRENT
powercfg /a                      # 看本机支持哪些睡眠态（Modern Standby 机型差异大）

# 自启：登录时把 WSL2 VM 拉起来（VM 一起来 systemd 就会带起 daemon）
schtasks /Create /TN "mchat-wsl" /TR "wsl.exe -d Ubuntu -- true" /SC ONLOGON /RL HIGHEST /F
```

> 另外两件同等重要、但**不是命令能解决**的事：
> **可以锁屏，别注销**（注销会把 WSL2 VM 连同 daemon 一起杀掉）；
> **关掉 Windows Update 自动重启**（设置 → Windows 更新 → 高级选项 → 设置"使用时间"）。

WSL 内的 systemd service（§4）虽然也要 `sudo`，但它是**非交互**的、可以让 agent 跑 —— 见 §4 的脚本。

---

### 推荐的分工顺序

1. **人**：§2.1 装 WSL2（管理员 PowerShell + 重启 + 创建 Linux 用户）
2. **人**：§2.2 开 systemd（`/etc/wsl.conf` + `wsl --shutdown`）——也需要重启 WSL，脚本跨不过这道
3. **人**：把仓库拉到 WSL 文件系统内（`git clone` 到 `~/`，**别放 `/mnt/c`**）
4. **agent 接手**：`bash scripts/wsl-setup.sh` —— 依赖 / Node / pnpm install / `.env` 骨架 / tmux / 冒烟
5. **人**：填飞书凭证、跑一次 `claude` 登录
6. **人**：§3 电源策略、§4 自启（都要管理员 PowerShell）
7. **agent 收尾（只做「能不能起来 + 自检」）**
   > ⚠ 下面写死的 `mchat` 是默认 session 名。**若你设过 `MCHAT_TMUX_SESSION`，把它换成你设的值** ——
   > 或者更省事：直接抄 `scripts/wsl-setup.sh` 跑完时打印的那份命令，它已经按实际 session 名展开好了。
   
   ```bash
   # ⚠ npm run dev 是 tsx watch，**永不退出** —— 千万别在前台直接跑，agent 会一直挂到超时。
   # 丢进第 4 步建好的那个 tmux session 里后台跑：
   tmux send-keys -t mchat 'cd ~/multiAgentChat && npm run dev' Enter
   sleep 15                      # 等 daemon 起来（agent doctor 要连它的 unix socket）
   agent doctor                  # 「宿主实现」应 pass 并显示 tmux
   agent tabs                    # 应列出 tmux 的 pane
   tmux capture-pane -p -t mchat -S -40   # 看 daemon 日志有没有报错
   ```
8. **人**：跑 §6 的验收清单 —— 那是**手机操作场景**（发指令 / Win+L 锁屏 / 合盖 / 重启），
   **agent 替不了**，别让它以为自己验收完了

### 把这份文档交给 agent 时，建议这么说

> 我已经装好 WSL2、开了 systemd、把仓库 clone 到了 `~/multiAgentChat`。
> 你从第 4 步开始：跑 `bash scripts/wsl-setup.sh`，然后按它列出的清单告诉我还需要我做什么。
> 需要管理员权限或要我登录的事，**不要试图代劳，直接告诉我**。

---

## 1. 架构：东西都在哪

```
┌─ Windows 主机 ─────────────────────────────────────────┐
│                                                        │
│  电源策略（powercfg）: 插电不睡 / 合盖不睡              │
│  ⚠ 可以锁屏；不能注销（注销会杀掉整个 WSL2 VM）          │
│                                                        │
│  ┌─ WSL2 (Ubuntu) ──────────────────────────────────┐  │
│  │                                                  │  │
│  │   multiAgentChat daemon (node)                   │  │
│  │        │                                         │  │
│  │        ├── WS 长连接 ──→ 飞书开放平台（仅出站）    │  │
│  │        │                                         │  │
│  │        └── tmux CLI ──→ tmux server（独立进程）   │  │
│  │                              │                   │  │
│  │                    ┌─────────┴─────────┐         │  │
│  │                  pane %1            pane %2      │  │
│  │                  claude             codex        │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

三个要点：

1. **只有出站连接**。飞书走 WebSocket 长连接，不需要公网 IP、不需要端口转发、不需要改防火墙。
2. **tmux server 独立于 daemon**。daemon 重启（健康检查自杀 / `/reload` / 改代码热重载）**不会杀掉正在跑的 agent 会话** —— 这是选 tmux 而不是让 daemon 自己持有 pty 的根本原因。
3. **Windows 侧不需要终端软件**。Windows Terminal 只在你想本地看一眼时用（`wsl` 进去 `tmux attach`）。

---

## 2. 安装（全程在 Windows 上操作一次）

### 2.1 装 WSL2（🧑 需要人 · 管理员 PowerShell + 重启）

以管理员身份开 PowerShell：

```powershell
wsl --install -d Ubuntu
wsl --set-default-version 2
```

装完重启，按提示创建 Linux 用户名 / 密码。验证：

```powershell
wsl -l -v          # 期望看到 Ubuntu  Running  2
```

### 2.2 WSL 内开 systemd（🧑 需要人 · 要 `wsl --shutdown` 重启 WSL）

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

回 PowerShell 重启 WSL：`wsl --shutdown`，再 `wsl` 进去。验证 `systemctl is-system-running` 有输出即可。

### 2.3 装依赖（在 WSL 里）

> 💡 **这几节里能自动化的部分已打包成 `bash scripts/wsl-setup.sh`**（幂等、自检、失败即停）。
> 它**覆盖**：系统依赖（§2.3）、Node/pnpm（§2.3）、`pnpm install` 与 `.env` 骨架（§2.5 的一部分）、
> tmux session（§2.6 的一部分）、加载期冒烟。
> 它**不覆盖**：`git clone`（鸡生蛋 —— 脚本自己就在仓库里）、装/登录 claude（§2.4）、填飞书凭证、
> 起 daemon。这几件见 §0 的人工操作清单。
> 下面保留手动步骤，供排障时逐条核对。

```bash
sudo apt update
sudo apt install -y tmux git curl build-essential

# Node 22（nvm 方式，避免 apt 里的老版本）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22 && nvm use 22 && nvm alias default 22

npm i -g pnpm
```

验证：`node -v`（≥22）、`pnpm -v`、`tmux -V`。

### 2.4 装 agent（🧑 登录要人 · 浏览器 OAuth）

```bash
npm i -g @anthropic-ai/claude-code     # claude
claude                                  # 首次跑起来完成登录
# 如果也要用 codex，按 codex 官方方式装，并确保 codex --version ≥ 0.154
```

⚠ **必须装在 WSL 内**。Windows 侧装的 claude.exe 不在 tmux 的 pane 里，daemon 控制不到。

### 2.5 拉本项目（🧑 飞书凭证要人填）

```bash
cd ~                      # ⚠ 放 WSL 文件系统，别放 /mnt/c（见 §7 性能坑）
git clone <你的仓库地址> multiAgentChat
cd multiAgentChat
pnpm install
install -m 600 .env.example .env   # 一步建好并设权限（别 cp 完再 chmod，中间有窗口期）
```

编辑 `.env`，至少填三项：

```ini
LARK_APP_ID=cli_xxxxxxxxxxxxxxxx
LARK_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
MCHAT_HOST=tmux
```

`MCHAT_HOST=tmux` 其实可以不写（非 macOS 会自动选 tmux），**但建议显式写上**——这样日志和 `agent doctor` 里一眼能看出宿主是谁，排障时少猜一步。

飞书应用怎么建、要开哪些权限，见 [feishu-bot-setup.md](feishu-bot-setup.md)，与平台无关。

### 2.6 起 tmux 和 daemon

```bash
tmux new-session -d -s mchat      # 建一个常驻 session（daemon 也会在没有 session 时自动建）
cd ~/multiAgentChat && npm run dev
```

首次启动 daemon 会自动做三件事（幂等，与 macOS 一致）：
- 把 `agent` CLI 链到 PATH
- 把 `multiagent-lark` skill 装到 `~/.claude/skills/`
- 把 lifecycle hooks 写进 `~/.claude/settings.json`（codex 则是 `~/.codex/config.toml`，**首次要在 codex TUI 里 `/hooks` 批准**才生效）

验证：

```bash
agent doctor        # 「宿主实现」应 pass 并显示 tmux（WSL2）；TCC 授权项应显示"跳过"（Windows 没有这套）
agent tabs          # 应列出 tmux 的 pane
```

---

## 3. 电源设置（**这一步不能跳**｜🧑 需要人 · 管理员 PowerShell）

机器睡着 = 手机发指令石沉大海，而且**失败是静默的**：你分不清是机器睡了、WSL 挂了还是 bot 断线。

以管理员身份开 PowerShell。

⚠ **别从 WSL 里调 `powercfg.exe` 来做这件事**：WSL 的 interop 进程继承的是当前用户权限、**没有管理员**，
改电源方案需要管理员。**具体表现未实测**（可能显式报错，也可能返回 0 但设置没生效），
所以一律按「必须在 Windows 侧管理员窗口里做」处理 —— 这条是**保守取值**，不是实测结论。
（只读的 `powercfg /query`、`powercfg /a` 从 WSL 调没问题，daemon 的 `detectKeepAwake()` 用的就是它们。）

```powershell
powercfg /change standby-timeout-ac 0        # 插电时永不睡眠
powercfg /change hibernate-timeout-ac 0      # 插电时永不休眠
powercfg -setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0   # 插电时合盖不睡
powercfg -setactive SCHEME_CURRENT
powercfg /a                                   # 看本机支持哪些睡眠态（Modern Standby 机型差异大）
```

⚠ **「关闭盖子时执行的操作」不在新版「设置」App 里**（只在老控制面板 / powercfg），这是最容易漏的一项。

只设 AC（插电）侧即可，拔电时随它睡——和 macOS 那边 `lid-awake` 的策略一致。

**另外两件同等重要的事**：

- **可以锁屏，不要注销**。锁屏对 WSL 毫无影响；注销 / 切换用户会把 WSL2 的 VM 连同 daemon 一起干掉。
- **关掉 Windows Update 自动重启**：设置 → Windows 更新 → 高级选项 → 设置"使用时间"，否则半夜重启后一切归零。

配完之后，daemon 会**周期性检查这套设置有没有被改回去**（`detectKeepAwake()` 调 `powercfg.exe` 读 AC 空闲睡眠超时），被改了会推飞书告警卡。这是必要的——OEM 电源管理软件（Lenovo Vantage / Dell Power Manager / MyASUS）、Windows 功能更新、公司组策略都会覆盖电源方案。

---

## 4. 开机自启（🧑 需要人 · Windows 侧那半要管理员）

WSL 不会自己起来，需要 Windows 侧拉一把。

**WSL 内**（把 daemon 做成 systemd 服务）：

⚠ **systemd 不会展开 `$USER` / `$HOME` / `$(node -v)`** —— 它不是 shell。所以下面刻意用
**未加引号的 heredoc**，让这些值在**写文件那一刻**就被 shell 展开成字面量，落进 unit 文件的是实际路径。
（写成 `User=$USER` 直接落盘的话，systemd 会把 `$USER` 当成一个**名叫 "$USER" 的用户**，启动直接失败。）

```bash
NODE_BIN="$(dirname "$(which node)")"     # nvm 装的 node 不在 /usr/bin，systemd 也不读你的 .bashrc
sudo tee /etc/systemd/system/mchat.service >/dev/null <<EOF
[Unit]
Description=multiAgentChat daemon
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$HOME/multiAgentChat
Environment=PATH=$NODE_BIN:/usr/local/bin:/usr/bin:/bin
ExecStartPre=-/usr/bin/tmux new-session -d -s mchat
ExecStart=$NODE_BIN/npm run start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now mchat
```

**`ExecStartPre` 前面那个 `-` 不能省**：它表示「这条失败也继续」。`tmux new-session -d -s mchat` 在
session **已存在**时返回非零（daemon 重启、或 tmux server 还活着时必然如此），没有 `-` 的话
systemd 会认为启动失败、**根本不拉 daemon**。

写完**一定要验一眼**，确认文件里没有残留的 `$`：

```bash
systemctl cat mchat | grep -E 'User=|WorkingDirectory=|ExecStart='
# 期望看到的是展开后的字面值，例如 User=zhengjiquan / ExecStart=/home/zhengjiquan/.nvm/.../npm run start
systemctl status mchat --no-pager
```

**Windows 侧**（任务计划程序，触发器"登录时"）：

```
程序: wsl.exe
参数: -d Ubuntu -- true
```

这条只是把 WSL2 VM 拉起来，VM 一起来 systemd 就会把 daemon 带起来。

⚠ 触发器是"登录时"，意味着**重启后要有人登录一次**。可以配自动登录 + 登录后立即锁屏——正好和"锁屏下完全可用"配套。

---

## 5. Windows 上现有实现功能说明

### 5.1 完全可用（与 macOS 等同或更好）

| 功能 | 说明 |
|---|---|
| 飞书发指令到指定 tab | `@ttys00x 跑 npm test`，tty 就是 tmux 的 `pane_tty` |
| 任务进度回传 / 结果卡 | watcher 轮询 + 进度卡 patch，与平台无关 |
| **结果自动回传飞书** | 走 claude/codex 的 Stop hook → `agent lark send-text`，**不依赖宿主** |
| **高危命令飞书审批闸** | 走 PreToolUse hook，**不依赖宿主**；5 档权限等级、学习型放行全都可用 |
| **AskUserQuestion 手机作答** | 写数字直选，锁屏可用（见下） |
| **codex 原生审批菜单镜像** | codex 自己弹的命令审批不走 hook，daemon 从屏幕识别后推成飞书卡，点选项/回数字即可作答（同样是 pty 写数字，锁屏可用）。要批准的**命令原文随卡一起到手机上**，看不全会显式标注 |
| 多 tab 并发 / 任务链 / 任务模板 | 纯编排，与平台无关 |
| **新建窗口 / 新建标签页 / 关闭** | 三种模式都实现了，见 §5.5 |
| 重启 agent（原地） | Ctrl-C 退 TUI 后按原 agent 重拉，保留 cwd |
| 跨会话 RAG 召回、memory、知识提炼 | 纯逻辑 |
| 工作报告（日/周/月） | 四路数据源；`dir-index` 的 POSIX `find` 在 Linux 下**原生可用** |
| worktree 任务隔离 / TAPD / 公函 / handoff | 纯逻辑 + 网络 |
| 企微 transport、Web Dashboard | 与平台无关 |

### 5.2 **比 macOS 更好的三处**

| 项 | macOS | Windows(WSL2+tmux) |
|---|---|---|
| **锁屏下按键注入** | Ctrl-C / Esc / 方向键**送不进去却返回 ok**（假成功），只能如实告知用户"到电脑前按" | **照常送达**。tmux send-keys 由后台 server 直写 pane 的 pty，不经窗口系统/焦点 |
| **回车提交** | 早期走 System Events 需要前台焦点，**被系统弹框挡住就发不进去**（表现为"发了指令没反应"）；现改 pty 直写才根治 | 天生不依赖焦点，弹框/锁屏/无人登录都照常提交 |
| **读 TUI 屏幕内容** | claude 进 alt-screen 后 `contents of tab` 返回 missing value，**读不到** | `capture-pane` 能读到当前屏幕 |

### 5.3 不可用 / 降级（都是如实标注，不会静默失败）

| 功能 | 状态 | 说明 |
|---|---|---|
| **tab 截图**（`/shells` 的截图） | ❌ 不支持 | `capabilities.screenCapture=false`，调用会抛明确错误。替代：`capture-pane` 的文字内容其实比截图更有用 |
| **macOS TCC 授权检查 / 授权告警卡** | ⏭ 整套跳过 | Windows 没有这套授权模型，`permissionModel=false`，探针不启动、不会提示你去授权不存在的东西 |
| **System Events 术语故障探针** | ⏭ 不启动 | 那是 macOS 特有的失败模式；tmux 没有这个中间层 |
| **锁屏状态检测** | ⚪ 恒为"未知" | tmux 确实不知道屏幕锁没锁。**但这不影响功能**——按键注入不受锁屏影响，上层判据已改为读 `capabilities.keyInjectionBlockedWhenLocked` 而不是读锁屏状态 |
| **合盖不睡守护安装器** | 🔄 换实现 | macOS 是 `sudo scripts/lid-awake.sh install`；Windows 换成 §3 的 powercfg 命令 + 周期性漂移检测 |

### 5.5 新建窗口 / 关闭窗口

层级对应：**Terminal.app 的「窗口 ⊃ 标签页」≈ tmux 的「session ⊃ window」**（我们一个 window 只放一个 pane）。

| 操作 | 入口 | tmux 实现 | 效果 |
|---|---|---|---|
| 新建标签页 | `/new`、飞书各处"开新 tab" | `new-window -t <session>` | 在现有 session 里加一个，并切过去 |
| 新建标签页（后台） | spawn 新 tab 的内部流程 | `new-window -d` | 同上但不抢当前视图 |
| **新建窗口** | `agent open --new-window` | `new-session -d -s mchat-<ts>` | 另起一个**独立 session**，可单独 `tmux attach`、单独关掉 |
| 关闭 | 飞书关 tab 卡片、`closeTabGracefully` | 先退 agent（连发 Ctrl-C）再 `kill-pane` | 与 macOS 一致 |

两个与 macOS 相同的安全性质：

- **拒绝关掉 daemon 自己所在的 pane**（否则把整套服务关了），判据是沿父进程链上溯找 controlling tty。
- **关掉一个 window 的最后一个 pane 会顺带关掉这个 window**；关掉 session 的最后一个 window 会关掉 session —— 对应 macOS「窗口仅剩此 tab 时顺带关窗」。

与 macOS 的差异：tmux 的 session / window **没有图形窗口**，"新建窗口"是逻辑隔离而不是屏幕上多出一个框。
想看的话 `tmux attach -t <session>`。

### 5.4 与 macOS 的行为差异（不是缺陷，但要知道）

- **`getHistory` 拿的是屏幕快照，不是单调增长的流水**。macOS 拿的是 scrollback。watcher 的变化检测（比字符总数）不受影响，但"按偏移切尾巴"的算法在屏幕内容变短时可能取到空串 —— 这是**待验项**，见 §8。
- **cwd 是白送的**。macOS 要为每个 tab 跑一次 `lsof`；tmux 直接给 `#{pane_current_path}`，所以列 tab 更快。
- **`getUserFocus` 恒报"终端在前台"**。tmux 没有 GUI 焦点这一维，按键注入也不需要焦点。

---

## 6. 验收清单（装完照这个测）

四个场景对应"不管什么情况下都能控制"这条硬要求，**逐条测，别只测第一条**：

| # | 场景 | 怎么测 | 期望 |
|---|---|---|---|
| 1 | 正常 | 手机飞书 `@<tty> 说个笑话` | 收到进度卡 → 收到结果 |
| 2 | **锁屏** | Win+L 锁屏，再从手机发指令 | 与 #1 完全相同。**再测一次 Ctrl-C 打断和 Esc 关菜单** —— 这是 macOS 做不到的那块 |
| 3 | **合盖** | 合上盖子（保持插电），从手机发指令 | 与 #1 相同；机器不能睡 |
| 4 | **无人值守** | 锁屏后放置 30 分钟，再发指令 | 仍然响应（验证电源策略真的生效） |
| 5 | 重启存活 | `agent lark` 让某 tab 跑个长任务，然后在另一个 shell 里 `/reload` 重启 daemon | 任务**不中断**，daemon 回来后还能看到那个 pane |
| 6 | 开机自启 | 重启 Windows → 登录 → 不开任何窗口 | 几分钟内飞书 bot 自动上线 |

另外跑一次 `agent doctor`：**「宿主实现」这一项应 pass 并显示 `tmux (WSL2)（linux）`**，TCC 相关项应是"跳过"而不是"失败"。
（这条判的是「装没装上宿主实现」而不是「是不是 macOS」——早先它写死只认 darwin，会在 WSL2 上误报 critical fail。）

---

## 7. 排障

| 症状 | 原因 | 处置 |
|---|---|---|
| daemon 起不来，日志说"没能装上宿主实现" | 没装 tmux | `sudo apt install tmux` |
| `agent tabs` 空列表 | 没有 tmux session | `tmux new-session -d -s mchat` |
| 发指令后文本进去了但**不执行** | 回车没送到，或两次写入被合并 | 见 §8 待验项 1；先试着把送文本与回车的间隔调大 |
| 飞书 bot 掉线 / token 报错，尤其**休眠恢复后** | **WSL2 时钟漂移**——VM 挂起恢复后系统时间可能偏几分钟，签名校验会失败 | `sudo hwclock -s` 手动同步；长期方案是开 systemd-timesyncd |
| 一切正常但很慢（watch 卡、扫目录慢） | 代码放在 `/mnt/c` | 移到 WSL 文件系统（`~/`）。跨文件系统 IO 慢一个量级，且 inotify 在 `/mnt/c` 上不工作 → tsx watch 收不到文件变更 |
| 睡一觉起来全没了 | 注销了 / Windows Update 重启了 | 见 §3 最后两条 |
| agent 认不出来（tab 状态显示 shell 而不是 claude） | 进程名匹配问题 | 见 §8 待验项 2，`ps -t <pane_tty> -o args=` 看实际进程名 |

---

## 8. 已知未验项（**诚实清单**）

这份实现没有在任何 Windows / Linux 机器上真跑过。以下是**明知会不确定**的点，按风险排序：

1. **送文本与回车之间的 400ms 间隔够不够**。两次 pty 写入若被 TUI 一次 `read()` 合并，整块会被当"粘贴"处理而**不提交** —— 这条与平台无关（macOS 上有字节级实测记录），tmux **不免疫**。表现：文本进去了不执行。
2. **`detectAgentFromProcs` 在 tmux pane 下认不认得出 claude / codex**。判据是进程名（`claude` / `/path/to/claude` / `node /path/bin/claude`），tmux pane 下的进程树长相未实测。认不出的表现：tab 状态显示成普通 shell、重启 agent 失灵。
3. ~~**`capture-pane` 的屏幕快照语义喂给 watcher**~~ **已处理**：长度回缩会让 `slice(beforeCharLen)` 永久返回空串、增量内容彻底断供。
   `watcher.ts` 已加**基线重设**（回缩就把基线挪到当前长度），`notifier.ts` 四处消费点都带 `|| outputTail` 兜底。
   仍需真机确认回缩的实际频率与幅度。
4. **codex 的退出手势**是否也是双 Ctrl-C（这条在 macOS 上同样未验，见 codex-integration.md §8.4）。
5. **Modern Standby 机型**上 powercfg 的那几条是否真能挡住连接待机——机型差异很大。
6. WSL2 下 unix socket（`~/.multiagent-chat/agent.sock`）、hook 脚本 spawn、skill 安装这些路径是否都正常。

> 前三条**在 Mac 上装个 tmux 就能验**（`brew install tmux` + `MCHAT_HOST=tmux`），不必等 Windows 机器。建议先在本机打掉 1-3，再上 Windows 验 4-6 和 §6 的场景 3/4/6。

---

## 8b. 已经真机验证过的（不在待验清单里）

这些是本轮开发中**真的在 tmux 3.7c 上跑过**的结论，不是推断：

| 结论 | 怎么验的 |
|---|---|
| **`send-keys` 不构成命令注入** | `send-keys -l -- 'hello; new-window'` 整串原样敲进 pane，tmux 没有真的多开 window（`list-windows` 核对） |
| **结尾裸 `;` 会被吞掉一个字符** | 逐例对照：`x;`→`x`、`;;`→`;`、`;x;`→`;x`；`a;b`（中间）完整无损。已据此把 `sendLiteral` 改成「剥掉结尾连续分号 → 正文走 `-l`，分号按 `-H 3b` 逐个补发」 |
| 文本 / 回车 / pane 创建 | 黑盒验证通过 |

## 9. 相关文档

- [windows-port.md](windows-port.md) —— 方案设计与取舍论证（为什么是 tmux 不是 ConPTY）
- [architecture.md](architecture.md) —— 整体架构与宿主抽象层
- [feishu-bot-setup.md](feishu-bot-setup.md) —— 飞书应用配置（与平台无关）
- [codex-integration.md](codex-integration.md) —— codex 对接与 hooks
- [troubleshooting.md](troubleshooting.md) —— 通用排障
