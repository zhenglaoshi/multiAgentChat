# 授权与权限清单（首次安装必读）

> 本项目控制 Terminal.app + 注入按键，依赖若干 **macOS TCC 授权** + 若干配置。
> 任何一项缺失都会**静默**废掉部分功能（不报错、看着像"没反应"）。这份文档是权威清单。
>
> **好消息**：daemon 每次启动会**自动探测**下面标「✅ 自动探测」的项，缺了就往所有飞书 chat 推一条
> 告警（列出缺哪项 + 会废哪些功能 + 怎么授）。你也能随时 `agent doctor` 手动查。

> ⚠ 本文说的「权限」有**两套完全独立**的东西，别混：① macOS **TCC 授权**（本文档主体，OS 层，
> Automation/Accessibility，决定 daemon 能不能控 Terminal/发按键）；② claude 跑 shell 命令的
> **命令审批等级**（应用层，决定哪些命令要先弹飞书审批卡）。后者见下方
> [「命令审批等级」](#命令审批等级--perm-level--高危-gate--学习放行)一节。

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

---

## 命令审批等级 · perm-level / 高危 gate / 学习放行

> 这套跟上面 macOS TCC **无关**——是 claude 在 tab 里要跑 shell 命令时，本项目自己加的一层
> **应用层拦截**：命中规则的命令，抢在 claude 原生「Allow this tool?」提示前推一张飞书审批卡，
> 手机点批准/拒绝才放行/拦下。全部逻辑在 `packages/orchestrator/src/guard/`。

### 1. 高危命令 gate（拦截链路）

```
claude 要跑 Bash
   ↓ PreToolUse hook
bin/mchat-permission-hook   （matcher=Bash，超集关键词廉价预筛，明显安全的命令不调 daemon）
   ↓ 命中预筛 → 调 daemon
orchestrator/guard/high-risk.ts  isHighRiskCommand()
   ↓ 风险判定（见下）
daemon 推飞书审批卡（命令 + 📁cwd + tty）→ 手机点批准/拒绝
   ↓
allow → 放行执行 / deny → 拦下，claude 收到拒绝
```

- **fail-safe**：非高危 / 反查不到 chat / 5min 超时 / daemon 不可达 / 任何异常 → **passthrough**
  回退 claude 原生 "Allow this tool?" 提示，**绝不自动放行**。
- 协议层：CLI `agent permission-gate`（命令走 stdin）→ server op `permission.gate`，内部复用既有
  `approvals.create` 审批流。

### 2. 风险分级（riskTier）

命令按风险分 4 档，判定入口 `orchestrator/guard/perm-level.ts` `riskTier(cmd)`：

| tier | 说明 | 例子 |
|---|---|---|
| **catastrophic** 致命 | 不可逆、代价最大 | `rm -rf /` 或 `~`、`mkfs`、`dd of=/dev/X`、fork bomb、`DROP DATABASE` |
| **high** 高危 | `isHighRiskCommand` 命中但非致命 | `rm -rf` 普通路径、`git push --force`、`reset --hard`、`sudo`、`chmod 777`、写 `.env`、`curl\|sh`、`kill -9 -1` 等 13 组规则 |
| **medium** 中危 | 有破坏性但常规操作 | 任何 `git push`、任何 `rm`、`npm/pnpm/yarn publish`、`kill`、`chmod`、`git branch -D`、`git checkout -f` |
| **none** | 其余 | 读写、构建、测试、`git add/commit/pull` 等 |

**防误报/防漏报**：判定前先 `stripDataLiterals(cmd)` 剥离引号字符串 / heredoc 体 / `#` 注释
（`echo "危险文本"`、`git commit -m "…提到 rm -rf…"` 不会被剥离后的视图命中）；但若命令含
`EXEC_STRING_RE`（`eval` / `sh|bash -c "…"` / `mysql|psql -e "…"` 等"执行字符串"包装），
则**连原始命令一起扫**，不放过 `sh -c "rm -rf /"` 这类真正会执行引号内容的场景。

### 3. 5 档权限等级（perm-level L0–L4）

选的 LEVEL 决定"拦到哪一层"（`tierGatedAtLevel(tier, level)`）：

| Level | 名称 | 拦哪些 tier |
|---|---|---|
| **L0** | 全自动 | 不拦任何（等于关审批，慎用） |
| **L1** | 仅致命（**默认**） | 只拦 catastrophic |
| **L2** | 标准 | catastrophic + high（= 原来"高危全拦"的行为） |
| **L3** | 严格 | + medium（任何 push/rm/publish/kill/chmod 也拦） |
| **L4** | 偏执 | 每条 Bash 都拦（含 none） |

运行时取值优先级：`data/guard/perm-level.json`（运行时覆盖）> `PERM_LEVEL` env > 默认 `1`。

- 飞书 `/perm-level`：弹 5 档选择卡，点即切，**无需重启**。
- 飞书 `/perm-level 0-4`：直接速设某档。

### 4. 学习型放行（learned-allow）

审批卡不是每次都白点——按**归一化命令**（`normalizeCmd`：只折叠空白，**不做变量泛化**，
`rm -rf /a` 与 `rm -rf /b` 视为不同命令）落盘 `data/guard/learned-allow.json`：

- 同一命令**连续批准 ≥ 阈值**（默认 3，`PERM_LEARN_THRESHOLD` 可调）且**从未被拒** → 之后自动放行，
  不再弹卡（仍记一条 info 日志）。
- **最灾难命令永不学习放行**（`isNeverLearn`）：`rm -rf /` 或 `~`、`mkfs`/`diskutil erase`、
  `dd of=/dev/…`、fork bomb ——不管批准多少次，每次都问。
- 任何一次**拒绝**即永久标记 `denied`，之后该命令再也不会自动放行。
- 审批卡上会显示学习进度：「已批准 N 次，再 M 次将自动放行」（`learnedProgress`）。
- 飞书 `/perm-reset`：一键清空整个学习库（`clearLearned`）。

### 5. `/connect` 对接项

「高危命令审批」在飞书 `/connect` 里可配这套的**默认档位**（回显脱敏/审批卡本身默认全程开，
`/connect` 配的是初始值）：

| 字段 | 对应 env | 说明 |
|---|---|---|
| 授权等级 | `PERM_LEVEL` | 0-4，默认 1（仅致命） |
| 学习放行阈值 | `PERM_LEARN_THRESHOLD` | 同命令批准 N 次自动放行，默认 3 |

### 6. 配置汇总

| env | 默认值 | 说明 |
|---|---|---|
| `PERM_LEVEL` | `1` | 权限等级 0-4，见上表；也可用飞书 `/perm-level` 运行时改（覆盖 env，落盘持久化） |
| `PERM_LEARN_THRESHOLD` | `3` | 同一（归一化）命令连续批准几次后自动放行 |
