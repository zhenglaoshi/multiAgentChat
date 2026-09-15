# Windows 支持方案 · WSL2 + tmux 宿主

> 状态：**P1 已实现，真机验证待做**（2026-09-14）。
> `packages/host-tmux/` 已落地（`HostController` 27 个方法全装配 + 36 个单测），
> `MCHAT_HOST=tmux` 可强制启用。**没有在任何 Windows / Linux 机器上真跑过** —— §6 的待验清单仍然全部有效。
> 前置条件已具备：`multiagent-host-api` 的 `HostController` 抽象已落地（见 docs/architecture.md「扩展点 · 新 host」），
> 加宿主只需新建包 + 在 `framework/src/host-bootstrap.ts` 加一条分支，**业务代码一行不用改**。

## 1. 目标与验收标准

**硬要求（用户口径）：不管什么情况下，通过飞书都能控制电脑里的 codex 和 claude。**

"什么情况"具体指这四种，缺一不可：

| 场景 | 为什么单列 |
|---|---|
| 屏幕锁着 | Mac 上 System Events 按键注入在锁屏下**假成功**，是踩出血的老问题 |
| 笔记本合着盖 | 默认会睡，睡了就彻底失联 |
| 没人在电脑前 | 不能依赖"到电脑前按一下" |
| **前台有别的窗口 / 系统弹框压着** | Mac 上 keystroke 模式的回车会被弹框吃掉 → 发了指令**不提交**，看起来像卡死 |

交互范围按"该有的有"定：发指令、看输出、AskUserQuestion 手机作答、高危命令审批卡、多 tab 并发、结果回传飞书。
**不追求**复刻 Mac 全部能力（截图、TCC 授权卡、合盖守护安装器可以没有）。

## 2. 选型：tmux 宿主，不走 ConPTY 自托管

两条候选：

- **A · daemon 用 ConPTY/node-pty 自己持有 pty** —— 否决。
  **致命伤：这个 daemon 会自杀重启**（`im-lark/monitor/health-check.ts:55` 连续失败自杀、ws-watchdog 判 WS 死、
  `/reload`、tsx watch reload）。pty 归 daemon 持有的话，**每次重启杀光所有正在跑的 claude/codex 会话**。
  现在 Terminal.app 的 tab 不归 daemon 管，重启无感——这个性质必须保住。
- **B · WSL2 + tmux** —— 采用。tmux server 是独立后台进程，daemon 重启后 `list-panes` 照旧，
  等价于现在 Terminal.app 的性质；且 tmux 与 `HostController` 几乎 1:1。

顺带白送 Linux 服务器宿主（`docs/tasks/task-mr198nfa-4u7k/design.md:234` 的 tmux-ssh-host 就是这条）。

## 3. 三条硬需求怎么满足

三条的根因其实是**同一个**：Mac 的按键注入依赖 GUI 前台状态（焦点 / 未锁屏 / 没有弹框遮挡）。
tmux 的 `send-keys` 由**后台 tmux server 直接往它自己持有的 pty 写字节**，不经窗口系统、不经焦点、
不经 GUI session —— 所以这一整类失败模式结构性消失。

### 3.1 锁屏

Mac 现状：`host-mac/src/screen-lock.ts` 的 `isScreenLocked()` 存在的唯一理由，就是 System Events 注入
锁屏下送不进去却返回 ok；`im-lark/src/lark/handlers.ts:1296` 因此必须保守拒绝（只有确认 `=== false` 才敢发 Esc）。

tmux 下：Ctrl-C / Esc / 方向键 / 数字全部锁屏可用。Mac 上目前唯一还受限的那块短板补齐。

### 3.2 回车提交（用户明确点名：别像以前被前端弹框搞到用不了）

Mac 踩坑史（`host-mac/src/terminal/tabs.ts:534-546` 有字节级实测记录）：
- `do script X` 往 pty 写的是 `X + "\r"` **一整块**，TUI 当"粘贴"处理 → **送进去但不提交**；
- 早期兜底走 System Events `key code 36` 真按回车，**需要前台焦点** → 别的 app 在前台、系统弹框压着、
  锁屏，回车就进不去或被弹框吃掉，表现为"指令发了没反应"；
- 2026-09-07 改成 **pty 直写**（空 `do script ""` 写进单独一个 `\r`）才根治，`forceEnterViaKeystroke` 降级为
  `MCHAT_ENTER_MODE=keystroke` 的退路，且带前台守卫（挡住就返回 `blocked`，不盲按）。

tmux 下：`send-keys Enter` 就是往 pty 写回车字节，**不存在焦点/弹框/锁屏这一维**。
`forceEnter` 的整套 pty-直写 + keystroke 兜底 + 前台守卫在 tmux 宿主里可以塌缩成一行 `send-keys Enter`。

⚠ **但有一条 Mac 的教训要原样带过来**：送文本和送回车之间要留 ≥400ms。
原因与平台无关——两次 pty 写入若被 TUI 一次 `read` 合并，又会整块当粘贴处理而不提交
（见 `tabs.ts:545` 的注释）。tmux 连发两条 `send-keys` 的间隔只有一次进程启动（~10ms），**不够**。
这条必须真机验证，不能假设 tmux 免疫。

### 3.3 防睡眠

Mac：`scripts/lid-awake.sh` 装 root LaunchDaemon，插电 `pmset -a disablesleep 1`；
另有 `startCaffeinate()`（`apps/daemon/src/index.ts:423`）用 `caffeinate -i -m -w <pid>` 做进程级禁睡。

Windows 对应物（一次性设置即可，AC 侧）：

```
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg -setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0 && powercfg -setactive SCHEME_CURRENT
```

⚠ 合盖动作**不在新版「设置」App 里**（只在老控制面板 / powercfg），最容易漏。
Modern Standby（S0ix）机型差异大，先用 `powercfg /a` 看本机支持哪些睡眠态。

**`detectKeepAwake()` 仍要实现**，用途不是帮用户设，而是**检测设置被改回去**——
OEM 电源软件（Lenovo Vantage / Dell Power Manager / MyASUS）、Windows 功能更新、公司组策略都会改。
失败是静默的：手机发指令没反应，分不清是机器睡了还是 bot 挂了。WSL2 能直接调 `powercfg.exe`（interop），
解析几行即可，上层 `lid-awake-probe` 的告警卡一行不用改。

## 4. HostController 映射表

| 接口方法 | tmux 实现 | 备注 |
|---|---|---|
| `listTabsRaw` | `list-panes -aF '#{pane_tty} #{pane_current_command} …'` | `pane_tty` 就是现成 tty，主键不用换 |
| `getHistory` | `capture-pane -p -S -3000` | **能读到 alt-screen 实时屏幕**；Mac 的 `contents of tab` 返回 missing value 无解 |
| `send` | `send-keys -l --` | |
| `forceEnter` | `send-keys Enter` | 见 §3.2，仍要留 400ms 间隔 |
| `sendKeys` / `sendCtrlC` | `send-keys C-c` / `Escape` / `Up` | 锁屏可用 |
| `newTab` / `closeTab` | `new-window -P -F '#{pane_tty}'` / `kill-pane` | |
| `getCwd` | `#{pane_current_path}` | 比 Mac 的 lsof 路子干净 |
| `isAgentTab` / `inferTabStatus` | `detectAgentFromProcs` + `pane_current_command` | **最大未知，见 §6** |
| `captureScreen` | 不实现 | `capabilities.screenCapture=false`；信息需求由 `capture-pane` 文本满足 |
| `isScreenLocked` | 返回 `null` | 无此概念；**必须配合 §5 的接口改动** |
| TCC 授权四件套 | 空实现 | `permissionModel=false`，探针自动跳过 |
| `detectKeepAwake` | `powercfg.exe /query` | 见 §3.3，**要实现** |

## 5. 必须一起做的接口改动

`im-lark/src/lark/handlers.ts:1296` 现在判的是 `isScreenLocked() !== false` 就拒发 Esc。
tmux 宿主返回 `null`（无此能力）→ 会走进「❓读不到锁屏状态，不敢盲发 Esc」→ **Esc 被永久锁死**，
一个本来完全可用的功能废掉。

修法**不是**让 tmux 宿主撒谎返回 `false`（它确实不知道屏幕状态），而是给 `HostCapabilities` 加一位：

```ts
/** 按键注入会不会被锁屏挡住（macOS System Events = true；tmux 直写 pty = false） */
readonly keyInjectionBlockedWhenLocked: boolean;
```

调用方改成读这一位：`false` 直接发；`true` 才走现有的 `isScreenLocked()` 保守逻辑。
这正是宿主抽象该兑现的事——**调用方读能力声明，不读平台专有状态**。

## 6. 待真机验证清单（动工前先验，别先写包）

1. **`detectAgentFromProcs` 在 tmux pane 下认不认得出 claude / codex** —— 进程树长相是最大未知。
   （2026-09-14 已实测确认：Mac 上 7 个 claude tab 的进程列表里都有精确的 `"claude"`，tmux 下待验。）
2. **回车 400ms 间隔够不够**（§3.2）——两条 `send-keys` 会不会被 TUI 一次 read 合并。
3. **锁屏下 Ctrl-C / Esc 真能送进 claude TUI**（本机装 tmux 就能验，不用等 Windows 机器）。
4. ~~**`capture-pane` 拿到的内容能不能喂现有 watcher**~~ **已处理（2026-09-15，用户复检指出）**：
   `capture-pane` 是当前屏幕快照、**长度会回缩**，而 watcher 用 `fullHist.slice(beforeCharLen)` 切增量 ——
   一旦回缩到基线以下，`computeTaskOnlyTail` 会**永久**返回空串（基线不变、长度更小），这条 pending 的
   增量内容就此断供。已在 `watcher.ts` 加**基线重设**：检测到回缩就把 `beforeCharLen`/`lastSeenCharLen`
   重设到当前长度（回缩前那段内容确实已从快照里消失、找不回来，但后续增量能重新正确计算，而不是通道死掉）。
   macOS 下此分支永不触发。另 `notifier.ts` 四处消费 `taskOnlyTail` 的地方都带了 `|| outputTail` 兜底。
   **仍需真机确认**回缩的实际频率与幅度。
5. **codex 的审批屏里有没有「每 tick 都在变」的元素**（spinner / 计时器 / 进度条）。
   菜单指纹现在覆盖整段 excerpt，若屏幕里有持续重绘的元素，指纹会一直变 → 永远达不到
   `STABLE_TICKS` → **该菜单不镜像**。退化方向是安全的（等于回到这个功能上线前的基线），
   但目标就落空了。现有证据倾向于没有（真机截图样本里末尾是静态的 `Press enter to confirm`，
   且 codex 弹菜单时是阻塞等 stdin），但**没有实测过连续多次审批 / 命令输出很长的情形**。
6. WSL2 下 unix socket（`framework/control/protocol.ts:11` 的 `~/.multiagent-chat/agent.sock`）正常。
   ~~6. tmux 的 `;` 参数解析是否只把「整串恰好等于 `;`」当分隔符~~ ✅ **2026-09-14 已真机实测（tmux 3.7c）**：
   **不存在命令注入**（`hello; new-window` 整串原样敲进 pane，tmux 没有真的多开 window）；
   但**任何以裸 `;` 结尾**的字面文本都会被吞掉最后一个字符（`x;`→`x`，`;;`→`;`），
   `;` 在中间则完整无损。已据此把 `sendLiteral` 的处理从「整串等于 `;`」放宽成「剥掉结尾连续分号用 `-H` 补发」。
7. Windows 侧：注销会杀 WSL2 VM、Windows Update 自动重启、重启后 WSL 不自启（见 §7）。

## 7. Windows 侧安装 / 配置清单

- WSL2 + Ubuntu；**代码放 WSL 文件系统内**（`~/…`），别放 `/mnt/c`（跨文件系统 IO 慢，watch 和 dir-index 全机扫描会被拖垮）
- tmux、Node 22、pnpm、claude code、codex CLI —— **全装在 WSL 里**
- Windows 侧不需要装任何终端软件；Windows Terminal 只是想本地看一眼时 `tmux attach` 用
- 电源设置见 §3.3
- 自启：`/etc/wsl.conf` 开 `systemd=true` → daemon 做成 systemd service；
  Task Scheduler 登录时 `wsl.exe -d Ubuntu -- …` 拉一次。
  "登录时"意味着重启后要有人登录一次 → 可设自动登录 + 登录后立即锁屏（正好和"锁屏下完全可用"配套）
- **规矩：可以锁屏，别注销**（注销会把 WSL2 VM 连同 daemon 一起杀掉）
- WSL 里没有 TCC，Mac 上 launchd 的两个坑（node 跑 tsx 包装脚本崩溃循环、TCC 不继承 Terminal 授权）在这边不存在

## 8. 分期

- ~~**P1 · `packages/host-tmux`**~~ ✅ 2026-09-14：27 个方法全部装配（含空实现 + capabilities 如实标 false）
- ~~**P2 · 接口改动**~~ ✅ 2026-09-14：`keyInjectionBlockedWhenLocked` 能力位 + `handlers.ts` 两处调用点改为读能力
- **P0 · 验证**（可在 Mac 上做，只需 `brew install tmux` + `MCHAT_HOST=tmux`）：跑通 §6 的 1/2/3/4 条。**尚未做**
- **P3 · Windows 落地**：WSL2 装机、电源、自启、真机跑 §1 的四个场景。**尚未做**
