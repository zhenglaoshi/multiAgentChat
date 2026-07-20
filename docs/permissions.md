# 授权与权限清单（首次安装必读）

> 本项目控制 Terminal.app + 注入按键，依赖若干 **macOS TCC 授权** + 若干配置。
> 任何一项缺失都会**静默**废掉部分功能（不报错、看着像"没反应"）。这份文档是权威清单。
>
> **好消息**：daemon 每次启动会**自动探测**下面标「✅ 自动探测」的项，缺了就往所有飞书 chat 推一条
> 告警（列出缺哪项 + 会废哪些功能 + 怎么授）。你也能随时 `agent doctor` 手动查。

## ⚠ 最大的坑：授权授给「谁」取决于运行模式

macOS 的 TCC 授权是**按进程身份**记的，本项目有两种运行模式，身份不同、**互不继承**：

| 运行模式 | 授权授给谁 | 说明 |
|---|---|---|
| `npm run dev`（tsx watch，跑在 Terminal 里） | **Terminal.app** | 你平时用 Terminal，可能早授过 |
| **launchd 托管**（`scripts/launchd-setup.sh install`，开机自启/守护） | **node**（`process.execPath`，如 `~/.nvm/.../bin/node`） | 独立身份，**必须单独授**，不继承 Terminal 的 |

> 🩸 实测踩过：launchd 的 node 授了 Automation（能列 tab）但没授 Accessibility（不能发按键），
> 结果 `agent doctor` 一度全绿、但**关 tab / 命令回车提交其实是坏的**。现在 doctor 和启动探针
> 把 Accessibility 单独一条、被拒即红，根除这种假绿。

## 三个核心 TCC 授权（✅ 自动探测）

daemon 依赖三个**相互独立**的授权。缺任一都影响核心链路：

### 1. Automation → Terminal.app
- **在哪授**：系统设置 → 隐私与安全性 → **自动化** → 展开 dev=Terminal.app / launchd=node → 勾「Terminal」
- **缺了会废**：
  - 列出 / 查看所有 Terminal tab
  - 给 tab 发命令（`do script`）—— 飞书发的任务根本进不去
  - 开新 tab / 按目录打开
  - 读取 tab 输出（任务进度回传全废）
- **报错特征**：AppleScript error `-1743`（Not authorized to send Apple events）

### 2. Automation → System Events
- **在哪授**：系统设置 → 隐私与安全性 → **自动化** → 展开 dev=Terminal.app / launchd=node → 勾「System Events」
- **缺了会废**：与 System Events 通信（所有按键注入的前置）—— `forceEnter` / `Ctrl-C` / 关 tab 全部 `-1743` 失败
- **报错特征**：AppleScript error `-1743`

### 3. Accessibility（辅助功能）
- **在哪授**：系统设置 → 隐私与安全性 → **辅助功能** → 点「+」加 dev=Terminal.app / launchd=node → 开开关
- **缺了会废**：
  - 飞书发给 claude 的命令能**自动回车提交**（否则停在命令行不执行）
  - Ctrl-C 取消任务 / 优雅退出 agent
  - 关闭 tab（Cmd-W）
  - 重启所有 claude tab
- **报错特征**：AppleScript error `1002`（not allowed to send keystrokes）/ `-25211`（not allowed assistive access）

> 授完任一项，**重启 daemon 才生效**：
> `launchctl kickstart -k gui/$(id -u)/com.multiagent-chat.daemon`（dev 模式则重跑 `npm run dev`）。

## 其他授权 / 配置

| 项 | 类型 | 缺了会怎样 | 自动探测 |
|---|---|---|---|
| **Screen Recording**（屏幕录制） | macOS TCC | 截屏 `/screen`（captureScreen）拿到黑屏/空图 | ❌ 未自动探（optional，只影响 `/screen`）；手动在 系统设置 → 隐私与安全性 → 屏幕录制 加 dev=Terminal.app / launchd=node |
| **`.env` 的 `LARK_APP_ID` / `LARK_APP_SECRET`** | 配置 | 飞书 bot 起不来，整条远程链路无 | ✅ doctor 查 |
| **飞书开放平台：应用权限 + 事件订阅 + 机器人启用** | 飞书后台 | bot 收不到 / 发不出消息 | ❌ 本地难测，见 `docs/feishu-bot-setup.md` |
| **`~/.local/bin` 在 PATH 里** | shell 环境 | 任何 shell 里 `agent xxx` 报 command not found | 🟡 daemon 启动 WARN，见 `docs/installation.md` 第 6 步 |

## 非授权，但同类症状：System Events 术语故障

不是授权问题，但表现一样（命令发了不执行）：System Events helper 被拖挂时 `key code` 术语在**编译期**就失败，
`forceEnter` 静默失败。daemon 另有一个探针（`startSystemEventsProbe`，每 2min）专门探这个，翻转时推飞书。
**修法：重启 Mac**。详见 `CLAUDE.md` 的「System Events 术语故障」一节。

## 怎么查 / 怎么修

```bash
# 手动全面自检（含上面三项 TCC，会明确标注 已授权 / 未授权 + 错误码 + 影响）
agent doctor

# 授权改动后重启 daemon 生效
launchctl kickstart -k gui/$(id -u)/com.multiagent-chat.daemon
```

启动后若有缺失，飞书会自动收到一条 🚨 告警（含缺项 + 影响 + 授权位置）；补齐并重启 daemon 后收到 ✅ 恢复通知。
