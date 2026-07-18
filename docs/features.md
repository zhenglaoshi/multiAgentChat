# 功能完整清单

按能力分类，含"什么时候用"和"实际例子"。

---

## 🧭 能力矩阵（飞书 vs 企微）

多数能力两边都对齐了；少数受企微 API 限制降级。

| 能力 | 飞书 | 企微 | 说明 |
|---|:-:|:-:|---|
| `@target` 派发 | ✅ | ✅ | tty / 短 tty / 标题 / cwd basename 都能识别 |
| Sticky 对话（5min） | ✅ | ✅ | 首次 `@` 后裸文本自动路由到该 tab |
| `>>` 链式派发 | ✅ | ⚠️ 走 mchat 通用 handleCommand | |
| 多行批量派发 | ✅ | ⚠️ 未特化 | |
| 群聊 target | ✅ | ✅ | `wecom:chat:xxx` 走 `/appchat/send` |
| 实时进度卡 patch | ✅ | ⚠️ simplified initial+final | 企微 body 不支持任意 update |
| Adaptive backoff | ✅ | ⚠️ 由简化模式代替 | |
| `/quiet on/off` 静默 | ✅ | ✅ | chat state 复用 |
| 单卡 🔇 按钮 | ✅ | ⚠️ 简化模式已不 patch | |
| `agent ask single` | ✅ | ✅ | 企微用 button_interaction |
| `agent ask multi` | ✅ | ✅ | 企微降级为"回复数字勾选" |
| `agent ask input` | ✅ | ✅ | 用户 chat 回文本，daemon 拦截 |
| `agent request-approval` | ✅ | ✅ | 企微 button_interaction 卡 |
| `/screen` 抓屏 | ✅ | ✅ | 含 alt-screen TUI 内容 |
| `/keys '<seq>'` 按键遥控 | ✅ | ✅ | 复用 host-mac.sendKeys |
| `//foo` 强制转发 | ✅ | ✅ | 剥一个 / 后发到 activeTty |
| Claude 内建 slash 白名单转发 | ✅ | ✅ | `/help /config /agents ...` 自动转发 |
| Stop hook auto-push | ✅ | ✅ | daemon 按 chatId 前缀路由 |
| `/watch on/off` 本地任务监听 | ✅ | ✅ | chat state 复用 |
| SOP 编排（task/gate/loop） | ✅ | ⚠️ 底层复用，stageProgressCard 只飞书 render | |
| Doctor 检测 | ✅ | ✅ | agent doctor 里加了 wecom section |
| `/dashboard` / `/tabs` 等 card 命令 | ✅ | ⚠️ 企微仅 text-kind，提示"卡片去飞书看" | |
| Web dashboard（手机浏览器直控）| ✅ | ✅ | 无关 IM，daemon 内嵌 HTTP :3940，`/wd` 拿访问 URL |
| Knowledge extraction 自动知识库 | ✅ | ✅ | 无关 IM，spawn `claude -p` 本地提炼，5 类 KnowledgeEntry |

**核心 IM 桥接能力（99%）在企微都对齐**，只有几个卡片渲染类的 UX 项因企微 API 硬限制走了降级方案。

---

## 1. 飞书 ⇄ Mac Terminal 双向桥

### 能力
- 飞书消息 → Mac Terminal tab（AppleScript 控制）
- Mac Terminal 输出 → 飞书卡片（1-2s 轮询采集 + 主动推送 + adaptive 节流）
- 支持 alt-screen TUI 程序（Claude Code 用 `\r` 重绘 → 用**字符长度**变化而非行数检测）
- **双渠道并行输出**：任务响应同时在 pc shell TUI 和飞书露出（SYSTEM_GUIDANCE 强制引导 claude 不能只推不答）

### 什么时候用
- 你在电脑前不方便切 Terminal → 手机发命令
- 出门/开会时想让 Mac 后台跑活 → 飞书调度 + 手机看状态
- 多个项目并行时 → 每个 tab 一个项目，飞书 dashboard 统一看

### 例子
```
# 飞书里
@pivotal-parrot 跑 npm test
@monitor tail -f /var/log/foo.log

# Mac claude 里
agent lark send-file ./output.xlsx
```

---

## 2. 多 tab 并行

### 能力
- 一个 Mac 支持 N 个 Terminal tab，每个独立 claude 进程
- 每个 tab 独立 cwd + 独立 context + 独立 claude session
- 飞书通过 `@target` 定向派发；`>>` 链式；多行并发 batch

### 什么时候用
- 一个项目一个 tab
- 长任务丢给某 tab，接着开新 tab 干别的
- 复杂任务分派多 tab 协作（各自跑一部分）

### 例子
```
@studio 拉 mixpanel 数据 >> @analyst 分析这批数据
（studio tab 完成后自动派给 analyst tab）
```

---

## 3. SOP 编排 —— 声明式多 stage 工作流

**这是 multiAgentChat 的核心差异化**。cc-connect / Anthropic 官方 Remote Control 都没有。

### 能力
- 声明 `stages: ['explore', 'architect', 'coder', 'tester']`
- 每个 stage 对应一个 subagent（Claude Code 内置或自定义 `~/.claude/agents/*.md`）
- 关键节点 `gates: ['after-architect']` 会推审批卡到飞书，人工批准才继续
- 失败自动回环 `loops: [{on: 'tester', retryFrom: 'coder', maxRetries: 2}]`
- 主 claude 可 `--skip` 判定跳过不必要 stage
- 每 stage 通过 artifact 文件传递结果（`./docs/tasks/<task-id>/<stage>.md`）

### 什么时候用
- 大改动（要走 SDLC 流程）
- 需要人工审批的敏感任务（改数据库、发 prod）
- 想要过程可追溯 + artifact 可查

### 例子
```
/run --sop 实现登录功能
# framework 建 task-mqXXX
# 主 claude 依次调 Task(explore) → Task(architect) 
# → gate 触发飞书审批卡（含 design.md 预览）
# → 你批准 → Task(coder) → Task(tester)
# → 全部完成，推报告到飞书
```

详见 **[sop.md](sop.md)**。

---

## 4. Subagent 系统

### 能力
- **Claude Code 内置 subagent**（Explore / Plan / general-purpose / statusline-setup / ...）直接可用
- **用户自定义**：`~/.claude/agents/*.md` 或 `<repo>/.claude/agents/*.md`
- **YAML frontmatter**（name / description / tools / model / color）+ system prompt body
- **CRUD**：list / show / add / delete
- **AI 自动生成**：`/subagent gen <域描述>` 让主 claude 设计一套
- **迭代**：`/subagent tweak <name> <改动指令>` LLM 改现有 subagent

### 什么时候用
- **默认 SDLC 不够用** → 换域（视频 / 数据分析 / 财务 / 教学 / 硬件）
- **需要专用能力** → 加 `ffmpeg-operator` 之类专项 subagent
- **反复用同一种任务** → 存 template + 关联 subagent 一键触发

### 例子
```
/subagent gen 视频剪辑：ffmpeg 剪 mp4 + 加中文字幕 + 生成 3 张缩略图

# framework 派任务到主 claude
# 主 claude 输出 JSON：
#   { subagents: [ffmpeg-clipper, subtitle-adder, thumbnail-gen], template: {stages: [...]}}
# 落盘 3 个 .md + 1 个 preset
# 立即可 /run video-edit clip="X.mp4"
```

---

## 5. 智能派发（Smart-dispatch）

### 能力
- `/run --sop` 无 `@target` 时，framework 智能决定：
  - **你在 Mac 前正盯着 activeTty claude** → **attach**（复用当前 session，省 8s）
  - **你在别处**（手机 / 别的 app / 别的 tab）→ **spawn 新 tab**（Terminal 闪 200ms 归位）
- 新 tab spawn 保证 claude 是 fresh session，能识别刚 gen 的新 subagent
- 显式 `@target` 时永远尊重用户选择（attach 到指定 tab）

### 什么时候用
- 自动，你不用管
- 想强制新 tab 就别设 activeTty
- 想 attach 就在 Mac 前盯着那个 tab 再触发

---

## 6. 双层 Memory 系统

### 能力
- **Task memory**：每个 task 完成时落盘（`data/memories/*.json`），含 prompt / outputPreview / filesProduced / tags / cwd / duration
- **Stage memory**：SOP 里每个 stage 完成时落盘（`data/stage-memories/*.json`），按 stageName + cwd + 关键词召回
- **自动 recall 注入**：派任务时框架检索相关历史，注入到 prompt 顶部（cwd 精确匹配优先 + 关键词 token 匹配 + 时间衰减）

### 什么时候用
- 反复做类似任务 → framework 记得你上次怎么做，主 claude 看历史不用摸索
- 想查"上次 architect 在这个 repo 咋设计的" → `agent stage-recall --name architect`
- 想追溯"上次跑照护师查询用了啥脚本" → `/recall 照护师`

### 例子
```
# 第一次
飞书：@studio 查一下手机号 18510248896 的用户信息
# framework 落 memory：cwd=x, tags=[查, 手机, 号, 用户], files=[obs/lookup.js]

# 第二次
飞书：@studio 查手机号 13800000000
# framework 检索相关，注入 [上次相关历史 - 1 天前：查过 18510... 用了 obs/lookup.js]
# 主 claude 直接复用脚本
```

---

## 7. 审批工作流

### 能力
- 主 claude 用 `agent request-approval --title X --body Y` 阻塞式请求
- Framework 生成飞书卡片 + 5min 默认超时
- 用户点批准 / 拒绝 → CLI 返回 exit 0/1，主 claude 继续或中止
- SOP gate 用同一底子（timeout 30min，卡片含 stage summary + artifact 预览）

### 什么时候用
- 主 claude 要跑高风险命令（DB 写 / git push --force / rm -rf 大量文件）
- SOP 关键节点（architect 完成后审设计）
- 涉及钱（支付 / 退款）

### 例子
```bash
# 主 claude 在 tab 里
agent request-approval \
  --title "执行 DROP TABLE prod.users" \
  --body "$(cat <<EOF
影响：删除 5M 行
备份：已 mysqldump 到 s3://backup/xxx
回滚：需要 15min，SQL 已备好
EOF
)"
# 阻塞，等飞书 tap
# exit 0 → 继续；exit 1 → 中止
```

---

## 8. 本地 Shell 监听（Watch mode）

### 能力
- 飞书 chat 里 `/watch on` 后，Mac 上**任何 shell 活动**（不只是飞书派发的）都会推卡到飞书
- 触发条件：tab busy + history 增长 ≥ 8 行 + 30s cooldown
- 场景：你在 Mac 上直接跑长命令，人不在但想手机上看进度

### 什么时候用
- 你 Mac 前跑 `npm run build` / `pytest` 之类长任务
- 你想边跑边处理别的事，进度靠飞书推
- **远程调试**：让 Mac 跑，你手机看

---

## 9. Agent CLI + Unix socket

### 能力
- 一个统一的 `agent` 命令，Mac 任何 shell 都能用
- 通过 `~/.multiagent-chat/agent.sock` 跟 daemon 通信
- 支持所有内部 op：tab / chat / task / approval / subagent / lark / stage-recall / doctor

### 什么时候用
- 主 claude 在 tab 里的所有对外通信（推飞书 / 提审批 / SOP stage 上报）
- 用户手工调（`agent tabs` / `agent send` / `agent doctor`）

---

## 10. 防休眠（Sleep prevention）

### 能力
- daemon 启动时**自动** spawn `caffeinate -i -m -w <daemon-pid>`
- 阻止 macOS idle sleep + disk sleep，daemon 死 caffeinate 自动退
- Env var `AGENT_NO_CAFFEINATE=1` 关闭
- Env var `AGENT_CAFFEINATE_SYSTEM_SLEEP=1` 加 `-s`（AC 电源下真阻 system sleep）

### 什么时候用
- 你希望 remote 时 Mac idle 不睡（默认开）
- Mac 在跑长 SOP，出门后你不希望它睡了断 WS

### ⚠️ 硬性限制：合盖 macOS 强制睡

**软件层无解**：
- `caffeinate` / `IOPMAssertionCreateWithName` / **Amphetamine 的 "Closed-Display Mode"** 全都**不能**真的阻止合盖睡眠
- Amphetamine 的机制跟 caffeinate 一样，只影响 idle sleep 断言；合盖是 kernel + 固件层的独立行为
- InsomniaX 类 kext 在现代 macOS SIP 下装不上
- `pmset` 里各种参数（`lidwake` / `standby`）只调整**从睡眠恢复**行为，不阻止睡眠本身

**真能合盖不睡的 3 条路**：

1. **HDMI ghost plug 假显示器**（推荐给远程场景，5-15 元）
   - 小 dongle 插 HDMI / USB-C 口，macOS 认为外接了显示器
   - 加 AC 电源 + BT 键鼠（或额外 HID）→ 满足 macOS clamshell mode 条件
   - 合盖后 Mac 依然认为"有外接屏"，不睡
   - 缺点：占一个口 + 需带 BT 键鼠

2. **真 clamshell mode**（桌面场景）
   - AC 电源 + 外接真显示器 + 外接键鼠
   - macOS 自动开 clamshell mode
   - 缺点：不便携

3. **桌面 Mac**（Mac mini / iMac / Studio）
   - 没有"合盖"问题
   - 缺点：需买硬件

**就 idle sleep（不合盖但闲置）**：`caffeinate` 默认已跑，完全够。

### 验证
```
agent doctor
```
`caffeinate (防休眠)` 那行应显示 `pass` + PID。

---

## 11. WS 长连接健壮性

### 能力
- **WS watchdog**：monkey-patch console.log 截 lark SDK 的 `[ws] reconnect` / `[ws] ws client ready`；判断 WS "假活"（reconnect ≥3 且 90s 无 ready）触发自杀 + tsx watch reload
- **Health check**：每 30s 调 lark endpoint；失败 3 次自杀重启
- **Task 状态机磁盘持久化**：daemon 挂了不丢 task 状态

### 什么时候用
- 后台跑几天不用管
- 网络抖动、飞书 SDK 断连自动恢复

---

## 12. 诊断（Doctor）

### 能力
- 一句 `agent doctor` 跑 12 项健康检查
- 分级：critical / important / optional
- 每个 fail 附具体 fix hint

### 什么时候用
- 首次装完验证
- 遇到问题排查
- 升级后确认没坏

见 **[installation.md](installation.md)** 第 7 步。

---

## 13. Modular / 可扩展

### 能力
- Monorepo：orchestrator / host-mac / im-lark / framework / daemon 5 层单向依赖
- 计划抽象：`IMTransport`（第 2+ IM）+ `HostController`（Linux tmux 等）
- 目前扩展点：
  - 加飞书斜杠命令：改 `im-lark/lark/commands.ts`
  - 加 socket op：改 `framework/control/protocol.ts` + `server.ts` + `cli.ts`
  - 加 subagent：`~/.claude/agents/*.md` 或 `/subagent gen`
  - 加 SOP 模板：`/template save` 或 `~/.multiagent-chat/presets/*.json`

见 **[architecture.md](architecture.md)** + **[../CONTRIBUTING.md](../CONTRIBUTING.md)**。

---

## 14. 交互式选择 · `agent lark ask`

### 能力
用户在飞书**手指点选**回答问题，claude 从 stdout 拿 JSON 答案。四种类型：
- **single** —— radio 单选，按钮阵列
- **multi** —— checkbox 多选，toggle 后点提交
- **input** —— 用户在 chat 里直接回复文本（也支持 `/cancel`）
- **form** —— **多问题表单**（AskUserQuestion 的飞书替代）：一张卡问多个问题，每题单/多选，任一题可开 `allowText`（"Other/自由输入"）。渲染自动择优：全固定选项 → 一张卡铺完(A)；含 `allowText` → 向导式一次一题(B，自由输入题带「💬 打字回答」，回一句文字自动记录并进下一题）

> **打字兜底**：single/multi 待答时，用户直接在 chat 打「裸数字 2 / 逗号 1,3 / 选项原文」也能回答——卡片点击丢包/限流时的解冻通道。

### 用法
```bash
# claude session 里
answer=$(agent lark ask single \
  --title "选一个方案" \
  --options "A. 快速,B. 稳妥,C. 稳妥再稳妥")
# → {"status":"answered","type":"single","index":1,"value":"B. 稳妥"}
echo "$answer" | jq -r '.index'

# 多选
answer=$(agent lark ask multi \
  --title "跑哪些 stage？" \
  --options "requirement,architect,coder,tester")
# → {"status":"answered","type":"multi","indices":[0,2],"values":["requirement","coder"]}

# 输入
answer=$(agent lark ask input --title "输入 commit message")
# → {"status":"answered","type":"input","text":"fix: xxx"}

# 多问题表单（一次问多个）
answer=$(agent lark ask form --title "确认几个选项" --spec-json '{
  "questions": [
    {"title": "配对方式", "type": "single", "options": ["A 全支持","B 富文本"], "allowText": true},
    {"title": "要哪些能力", "type": "multi", "options": ["下载","注入","清理"]}
  ]
}')
# → {"status":"answered","type":"form","answers":[
#      {"q":0,"kind":"single","index":0,"value":"A 全支持"},
#      {"q":1,"kind":"multi","indices":[0,2],"values":["下载","清理"]}]}
# 自由输入的题回答形如 {"q":0,"kind":"text","text":"用户打的字"}
```

> **选项含逗号的坑**：`--options` 默认按逗号分隔，选项文本自带逗号会被拆乱。此时把 `--options` 传成 **JSON 数组**即可（已支持自动识别 `[` 开头）：`--options '["含,逗号的选项","选项2"]'`，或用 `--options-json`。多问题一律用 `ask form`（全 JSON，天然免疫）。

### 退出码
- 0 = `answered`
- 1 = `cancelled`
- 2 = `timeout`（默认 5min，可 `--timeout <ms>`）

### 什么时候用
- 主 claude 想让用户"从 N 个选项里挑"或"填一段文本"
- 替代 `AskUserQuestion`（AskUserQuestion 在 TUI 里弹选项框，手机端飞书完全看不见）
- SKILL / SYSTEM_GUIDANCE 强制引导 claude 在选择场景优先用它

### 底层
`AskManager`（`packages/orchestrator/src/ask/`）+ 飞书交互卡片（`askCard`/`askFormCard`）+ card.action.trigger 路由 + input/form-text 类型监听下条文本消息 = 完整闭环。

> **两个坑（已修，改动勿回退）**：
> 1. `card.action.trigger` 回调**必须立即 `return {}`**，卡片更新走 fire-and-forget `patchCard`。**绝不能 `return { toast }`**——飞书收到回调 toast 响应后会把卡当"已处理无更新"，盖掉另发的 patch → 标记不刷新。
> 2. 会被用户点击**多次更新**的交互卡（如 form），`config` 必须带 `update_multi: true`，否则第二次起 patch 视觉不生效。
> 3. 回调传回的 `value` 里数字字段（q/i/to）用 `Number()` 强转再用，别直接当 number（飞书可能回传字符串，否则 `Set.has` 判断失配）。

---

## 14.5 飞书图文 → shell claude（截图 + 描述让 claude 解决）

### 能力
飞书发「截图 + 文字描述」→ 图片下载到本地 → 路径 + 描述注入目标 tab 的 claude（claude 多模态，`Read` 本地图片即"看见"）。

### 三种发法（自动适配）
- **A 富文本一条发**：一条 post 消息里图 + 文字（+可选 `@ttysXXX`）一起 → 立即下载+注入
- **B 先图后文配对**：先发纯图（daemon 暂存 + 回执提示）→ 90s 内再发文字描述 → 自动合并注入。文字里可带 `@target` 指定 tab
- **C 纯图直发**：只发图不发文字 → 90s 到点直接发给 active tab，让 claude 自己看图判断

### 手机端怎么操作（推荐 B，最省事）
> 用户明确要求"飞书操作简单方便"。**手机上别碰富文本编辑器**（步骤多），直接：
> 1. 发那张截图（相册 → 发送）
> 2. **90 秒内紧跟一条文字**描述（可带 `@ttysXXX` 指定 tab；不带则发给 active tab）
>
> 顺序记住**先图后文**（先文后图目前不自动配对）。富文本(A) 需进「+ → 富文本 / 长按输入框格式栏」，仅在 PC 端顺手时才建议用。

### 注入形态
```
[用户随消息发来 N 张图片，已存到本地。请先用 Read 工具逐张查看，再结合下面的文字处理]
图片1: /abs/path/data/inbound/<ts>-<key>.png
<用户的文字描述>
```

### 依赖 & 约定
- 飞书应用需开 **`im:resource`**（读消息资源）权限，否则下载失败会回一条提示卡
- 图片落 `data/inbound/`（已 gitignore），**24h 自动清理**（`cleanupInboundImages`）
- 底层：`lark/resource.ts`（下载 + post/image 解析 + 清理 + prompt 拼接）+ `handlers.ts`（归一化入站 / 配对跟踪 / imgPrefix 注入）

### 企微（WeCom）
同样支持，但**只有 B/C 两法**（企微无富文本一条发）：入站 image 消息取 `MediaId` → `media/get` 下载 → 复用同一套 `imgPrefix` 注入。逻辑在 daemon 的 `dispatchWeComMessage` + `im-wecom` 的 `downloadImage`。需配 `WECOM_*` 才启用。

---

## 14.6 A3 Planner · `/plan <目标>`（目标 → 计划 → 逐步派发）

### 能力
把一个模糊目标交给 `claude -p`（headless）自动分解成 2-6 步可执行计划，飞书弹**计划卡**，每步一个「▶ 派发」按钮，你点哪步就把该步指令发给终端 claude。**v1 = 方案丙**：逐步手动派发、不自动串联（最可控）。

### 用法
飞书发 `/plan 给 pigeon 加一个数据导出接口并写测试`
→ 约 30-90s 后回一张计划卡：`{summary, steps:[{title,target,prompt}]}`
→ 点「▶ 派发步骤 N」：优先发给 planner 建议的 `target`（能解析到 tab 才用），否则发当前 active tab

### 底层
- `orchestrator/planner/`：`generatePlan(goal, {tabs,repos})` spawn `claude -p --max-turns 1`（`MCHAT_INTERNAL_SESSION=1` 不泄漏飞书）→ 解析 JSON → 内存态计划库
- `planCard`（cards.ts）+ handlers 的 `/plan` 特判 + `plan-dispatch` 卡动作
- 计划内存态（dev 重启清空，重新 `/plan` 即可）

> 后续可叠加：方案甲（每步按仓库开/复用 tab 自动串成任务链）、方案乙（单 tab SOP）。

---

## 14.7 performance-platform 性能建议监听（P1 只读）

`performance-platform-api` 出慢查询/性能优化建议（recommendation）→ 本项目 perf-watcher 轮询 → 推飞书卡 → 认领开 tab 修。**P1 = 只读**：拉取 + 推卡 + 认领派发；回写/校验闭环（P3）待 perf 侧加 CAS。

- **启用**：`.env` 配 `PERF_API_URL` + `PERF_API_USER` + `PERF_API_PASS`（缺则不启）。可选 `PERF_TARGETS` / `PERF_PRIORITIES`（默认 P0,P1）/ `PERF_MY_REPOS`（多人归属过滤）/ `PERF_REPOS_BASE_DIR`（repo→本地路径）。
- **流程**：轮询 `GET /api/recommendations?status=pending`（Basic auth）→ 按 target/优先级/归属过滤 + 去重 → 性能建议卡（P0 红/P1 橙，含根因+索引命令+改动文件+repo）→ 认领（**验证严禁连生产库**）→ [🕐稍后]/[🙈不是我的] 带回执。
- **两个认领按钮**：
  - **[🔧 认领修复]**：把上下文注入 active tab 让 claude 直接修。
  - **[📋 认领并建需求]**：先在 TAPD 建一条正式需求（创建人+开发负责人=你，挂「后端服务」项目「数据库优化」分类）→ 用 story 后6位建 `~/ihealth-work/fix_<story6>/` **worktree 隔离目录**开修 → 落 worktask 记录（`/worktasks` 可 [📂 打开]）。**perf→需求→目录→修 闭环**。配置 `PERF_TAPD_WORKSPACE_ID` / `PERF_TAPD_CATEGORY_ID`（复用 `TAPD_MCP_URL/TOKEN/NICK` 建需求）。见 §24 + `docs/perf-integration.md` §4 P2。
- **底层**：`orchestrator/perf/`（config/client/query/store + `tapd-story.ts`）+ `im-lark/monitor/perf-watcher.ts` + `perfItemCard`。
- **完整设计 + 多人协作 + 深层机会**：见 `docs/perf-integration.md`。

---

## 15. 抓屏 & 按键遥控（TUI 场景兜底）

### `/screen` · agent screen
抓 Terminal.app 指定 tab 所在窗口的截图（**含 alt-screen TUI 内容**，是 alt-screen 下飞书唯一能"看到"屏幕的通道），推图到飞书。

```bash
# CLI
agent screen [-t ttys003]     # -t 可省，自动反查

# 飞书斜杠
/screen                        # 抓当前 sticky tab
```

底层：AppleScript 拿 window bounds + `screencapture -R x,y,w,h` + `sendImage`。首次要授 Screen Recording 权限。

### `/keys` · agent keys
往目标 tab 发按键序列（osascript System Events），做为非 claude TUI 的**兜底**遥控。

键位：`d`=↓ `u`=↑ `l`=← `r`=→ `.`=空格 `⏎`=回车 `t`=tab `x`=esc  
中文别名：上/下/左/右/空/回

修饰：`ctrl+c` `cmd+k` `alt+f` `shift+tab`  
连发：`3d` 或 `d*3`  
打字（原样发字符）：`'hello world'`

```bash
# CLI
agent keys '2d . ⏎'                    # ↓↓ 空 回
agent keys ctrl+c
agent keys "'hello' ⏎"

# 飞书斜杠
/keys 2d . ⏎
/keys ctrl+c
```

飞书 `/keys` 每次执行后 300ms 自动补一张 `/screen` 截图回推确认。

### 什么时候用
- Claude 内置多选 UI（比如 `/agents` 界面）飞书看不见 → /screen 看现状 + /keys 遥控
- 非 claude TUI（`npm init` / `gum choose`）用户不方便切 tab → 手机 /keys 兜底
- 兜底原则：能用 `agent lark ask` 就优先用它（用户点选比手打按键序列友好）；用不了才走 /screen + /keys

---

## 16. 长任务进度卡降噪（三层组合）

30 分钟 build 类长任务本来会累积 500+ 次卡片 patch，视觉上一直变。三层治法：

### 层 1 · Adaptive Backoff（默认自动生效，无需操作）
patch 间隔随任务时长自动拉长：
- 前 30s → 3.5s（短任务体验不变）
- 30s-2min → 15s
- 2-5min → 30s
- 5min+ → 60s

`isFinal` 完成时永远 patch。

### 层 2 · `/quiet on/off/status`（每 chat 全局静默）
```
/quiet on         # 该 chat 所有 pending 只发首次 + 最终，中间全不 patch
/quiet off        # 恢复实时（走层 1 的自适应节流）
/quiet status     # 看当前状态
```

场景：你专心其他事情、后台跑 build 长任务，不想被中间进度打扰。

### 层 3 · 单张卡「🔇 静默此任务」按钮
每张 running 状态的进度卡底部一个按钮：
- 未静默：`[🔇 静默此任务]`，点后该 pending 中间不 patch，只在完成时更新
- 已静默：按钮变 `[🔊 恢复实时]`，卡片副标题多一行「🔇 已静默 · 完成时才更新」

`pending.quietUntilDone` 独立于 chat.quietMode，两者是 OR 关系。

### 使用建议
- 一般：默认层 1 自动降噪就够
- 专注模式：层 2 一次开关全局静默
- 只有一个任务吵：层 3 单卡按钮

---

## 17. 首次启动自动化（新 PC 上手最短路径）

daemon 启动时**自动**做的事，让新 PC 首次跑通只需要 3 步（装依赖 → 填 `.env` → 跑 dev）：

| # | 动作 | 目标 |
|---|---|---|
| 1 | `assertNodeVersion` | Node < 22 die + 引导升级 |
| 2 | `ensureEnvFile` | `.env` 缺失自动 `cp .env.example .env` + die 提示补密钥 |
| 3 | `emitMacPermissionHints` | 一次性打印 Accessibility / Screen Recording / Automation 权限提示 |
| 4 | `caffeinate` | 阻止 idle sleep |
| 5 | `ensureSkillInstalled` | upsert `skills/multiagent-lark/SKILL.md` 到 `~/.claude/skills/`（源码更新自动同步）|
| 6 | `installClaudeCodeHooks` | 往 `~/.claude/settings.json` 加 Stop + PreToolUse hooks（幂等）|
| 7 | `ensureAgentOnPath` | `bin/agent` 无 sudo symlink 到 `~/.local/bin/agent` |

用户唯一手动做：加 `~/.local/bin` 到 PATH（一次性 `echo 'export PATH=...' >> ~/.zshrc`）。

---

## 18. 企业微信（WeCom）· 第二个 IM · 99% 对齐

企微跟飞书能力 **99% 一致**（顶部能力矩阵表列全了差异）。只有 SOP stageProgressCard render 和进度卡实时 patch 因企微 template_card body 不支持任意 update 走了简化路径。

### 完整能力清单
- ✅ **AES 加解密 + 签名验证**（WXBizMsgCrypt Node 版）+ URL 校验
- ✅ **内嵌 HTTP receiver**（原生 http，无外部依赖 · 默认 :3939）
- ✅ **daemon attach 静默检测**：`.env` 有 WECOM_* 5 项就起；缺就不 attach，飞书完全不受影响
- ✅ **CLI**：`agent wecom send-text/-file/-image/ask/which-chat`（对齐 `agent lark`）
- ✅ **`@target` 派发 + Sticky 对话**（5min 内裸文本自动路由到该 tab）
- ✅ **无 @ 时 chat state fallback**：recentReplyTty → activeTty
- ✅ **Pending 跟踪**：watcher 接管 wecom pending，isFinal 时自动推摘要
- ✅ **Stop hook auto-push**：daemon handleLarkSendText 按 chatId 前缀 `wecom:` 自动路由
- ✅ **ask 三种类型**：single 用 button_interaction；multi 走"回复数字勾选"；input 拦截下条文本
- ✅ **approval 卡**：`agent request-approval` 触发 → 企微 button_interaction（✅批准 / ❌拒绝）+ 5min 超时
- ✅ **`/screen /keys /watch /quiet /help /use /where /recall` 等 slash 命令**（走 handleCommand 通用 dispatch）
- ✅ **`//foo` 强制转发**（跟飞书对齐）
- ✅ **群聊 target `wecom:chat:xxx`**（走 `/appchat/send` API）
- ✅ **cardAction 事件路由**：button.key 解码 → AskManager / ApprovalManager
- ✅ **agent doctor** 加 wecom section（token 有效性 / endpoint / tunnel URL）

### 与飞书的已知差异
- **卡片交互 UX 有降级**：企微 `multiple_interaction` 事件解析复杂，multi ask 改用"回复数字"（1,3,5）代替真 checkbox
- **进度卡不实时 patch**：企微 template_card body 不支持任意更新；用简化"初始 ack + isFinal 摘要"模式
- **部分 card 类 slash 命令**（`/dashboard /tabs /new`）目前只飞书能渲染成卡；企微收到 text-kind 提示"卡片去飞书看"
- **SOP stageProgressCard** 只飞书 render（企微 render 未做，低价值）
- **TAPD 认领**（§21）：企微支持通知 + 单 repo 简化认领；多 repo 多选 / 需求 SOP / 脏工作区策略卡只飞书

### 什么时候用
- 团队用企微不用飞书
- 想双 IM 并行（飞书私聊 + 企微群，各自独立 chat state）

### 配置
详见 [wecom-bot-setup.md](wecom-bot-setup.md) 完整 11 步指南：企业自建应用申请 + cloudflared tunnel + 5 个 env vars + 后台配 URL 校验。

---

## 19. Web Dashboard · 手机浏览器直控 Mac

### 能力
`apps/daemon/src/web-dashboard/` 内嵌 HTTP server（Node native，无外部依赖），默认端口 3940，Bearer token 鉴权。手机浏览器打开一个 URL 就见：
- Mac 所有 Terminal tab 列表（状态徽章 busy/idle/claude TUI）
- 点某 tab → 详情面板：**自动加载最近 100 行历史 + 抓屏**，每 3s 自动刷新
- 命令输入框 + 快捷 [⏎ Enter / ⊘ Ctrl-C / 📸 抓屏 / 🔄 History / 🔊 Live 开关]
- Pending 任务列表
- Quick slash 按钮（/dashboard /shells /where /watch /quiet 一键跑）

### 亮点
- **抓屏图片自动降采样**（sips → 1200px JPEG 75%），17.5MB → 300KB，4G 秒开
- **`/wd` 或 `/web` 或 `/webdash`** slash 命令返回一条包含所有可达 URL（公网 tunnel / LAN / mDNS / localhost）的文本，一 tap 直接开
- 支持公网入口：cloudflared quick tunnel（免账号 URL），或 `WEB_DASHBOARD_PUBLIC_URL` env 自定 named tunnel

### 什么时候用
- **VNC 太重**：只想快速看 Mac 状态 + 发个命令
- **飞书通道不够直观**：想一屏看所有 tab
- **4G 出门**：通过 cloudflared / Tailscale 手机浏览器直接开

### 配置
```env
WEB_DASHBOARD_TOKEN=$(openssl rand -hex 32)
WEB_DASHBOARD_PORT=3940                    # 默认 3940
# WEB_DASHBOARD_PUBLIC_URL=https://xxx     # 可选，稳定 named tunnel
```

详见 [docs/web-dashboard.md](web-dashboard.md)。

---

## 20. Knowledge Extraction · 自动提炼 shell 交互为知识条目

### 能力
每次 tab 任务完成（watcher.taskOutput isFinal），把 shell 输出经过**脱敏 + 启发式过滤 + spawn `claude -p`** 提炼成结构化 KnowledgeEntry，落 `./data/knowledge/<id>.json`。

**5 类知识**：
- `problem-solved` — 遇到问题 + 尝试 + 解法
- `howto` — 怎么做 X（有步骤）
- `decision` — 做了什么架构/工具决策 + 理由
- `gotcha` — 坑 / 边缘 case
- `reference` — 命令 snippet / URL / 配置片段

### 流程
1. **启发式过滤**：只对含 error / success / decision / 代码块的 chunk 提取（挡 npm install 类噪声）
2. **脱敏**：sk-ant / ghp_ / OpenAI / AWS / JWT / *_SECRET 赋值行 / 邮箱 → `<REDACTED-X>`
3. **去重**：chunkHash SHA-256 前 16 位，同一 chunk 只提取一次
4. **提炼**：spawn `claude -p '<prompt>'` 本地跑（复用 Claude Code subscription），30s 出结果
5. **落盘**：flat JSON

### CLI
```bash
agent knowledge stats                       # 总条目 / byKind / 队列 / 启用状态
agent knowledge list [-n 20]                # 最近 N 条列表
agent knowledge show <id>                   # 单条详情
agent knowledge extract-last [-t tty] [-n 200]  # 手动触发提取
# 别名: agent kb ...
```

### 什么时候用
- 反复踩类似坑 → 想让 AI 帮我记住"上次咋 fix 的"
- 跨项目复用经验（个人 KB）
- 训练 / fine-tune 未来 AI 助手的个人化基座

### 配置
```env
KNOWLEDGE_EXTRACT_ENABLED=1   # 默认关闭，显式开启（每次任务完成会跑 claude -p，~30s，本地）
```

### 真实产出（Phase 1 实测第一条）
从 28820 字符的 shell log 里自动提炼出：
```
kind: howto
title: 跑最新三梯队数据并推 OBS 地址到飞书的固定 workflow
tags: [multiAgentChat, 三梯队, echeloniot1, OBS, 飞书, 数据跑批, workflow]
body: 4 步 workflow（脚本 → 汇总 → 打包 → OBS 签名地址）+ 26 个覆盖城市清单
```

### 未做（Phase 2/3）
- `/kb <关键词>` 飞书搜 + `agent knowledge search` CLI
- 自动 recall 注入新 task 的 prompt（跟 memory recall 融合）
- 周报 launchd → 飞书推 markdown

**详见 [docs/knowledge.md](knowledge.md)** —— 完整架构、脱敏 pattern、CLI 用法、常见问题。

---

## 21. TAPD Bug 自动监听与认领 · 从"指派给我"到"改完回写状态"

### 能力
后台监听公司 TAPD 上**指派给我、当天更新、未结束**的缺陷/需求，推飞书卡片，点一下就
自动切分支 + 开 claude tab 修，改完（经你批准）用 MCP 回写 TAPD 状态。检测走**纯 HTTP 直连
TAPD MCP 网关**（不经 LLM/CLI，5min 一轮）；工作 tab 里的 claude 配了同一 MCP（`mcp__tapd__*`）
能读详情/评论/图片、改状态、加评论。

### 流程（点一次卡走完）
1. **监听**：每 5min 拉「我的·当天·未结束」缺陷+需求，去重后推**差异化卡**（缺陷橙/红、需求蓝）
2. **认领**：点卡 → 弹 **repo 多选卡**（候选=`/pin` 书签 + 最近 cwd），可勾多个（一个 bug 涉及多 repo）
3. **选类型 / 模式 / 基准**（卡上按钮切换）：
   - **🏷 类型**（三选一，定工作目录策略）：🐞 线上bug(fix) / ✨ 新需求(feature) → 建 worktree 隔离目录；🔧 开发中(indev) → 原地改。与模式正交。详见 **§24**
   - 模式：**需求→SOP 编排**（Explore→需求分析→架构→审批gate→编码→测试→回归）/ **缺陷→普通任务**（直接修）
   - 基准：**从 HEAD 切**（默认）/ **从 master、develop 切**（线上 bug hotfix）/ **当前分支**（indev）
4. **建工作目录**（`prepareTaskWorkspace`，见 §24）：fix/feature → `~/ihealth-work/<fix|feature>_<id6>/` 下每个 repo 用 **git worktree**（本地有源，共享 repo 不动）/ clone，切 `fix_/feat_<id6>`；indev → 原地改。→ worktree 隔离后**不再需要脏工作区 stash 策略**。落 `saveWorkTask` 记录（`/worktasks` 可 [📂 打开]）
5. **开工**：开**一个** claude tab（cwd=worktree 主 repo 目录）跨 repo 编排
   注入：标题 / TAPD 链接 / 各 repo 工作分支 / 描述（保留图片标记）+ 指引它用 MCP 看评论/图片
6. **验证 & 回写**：改完**本地验证**（严禁连线上库/生产）→ 不确定用 `agent lark ask` 问你 →
   验证过 + `agent request-approval` 批准 → 用 MCP 把状态流转到「已解决」+ 评论回填 commit/PR。**状态不自动改**。

### 亮点
- **一个 tab 多 repo**：跨 repo bug 用一个 claude 会话协调（共享上下文），分支名跨 repo 一致
- **两类 bug 分流**：线上 bug 从主干切、测试 bug 在被测分支直接改
- **需求走 SOP**、缺陷走普通任务，可一键互切
- **安全闸门**：改 TAPD 状态 / 碰生产 一律经飞书审批；不确定弹卡问你

### 企业微信也支持
- **通知**：bug/需求卡同样推企微（发 `WECOM_DEFAULT_TO_USER`）
- **认领（简化流）**：企微卡无 patch/toggle → 单 repo（最近目录）+ 按钮选基准 + 普通任务直接修
- **富交互仍走飞书**：多 repo 多选 / 需求 SOP / 脏工作区策略卡（企微 UI 做不了）

### 配置
```env
TAPD_MCP_URL=https://mcp.xxx.com/servers/<id>/mcp
TAPD_MCP_TOKEN=<Bearer JWT>          # 只进 .env
TAPD_NICK=你的TAPD昵称                 # current_owner 过滤（token email 不自动解析）
# 可选：TAPD_WORKSPACE_IDS（空=全部参与项目）/ TAPD_SYSTEMS=bug,story / TAPD_POLL_MS=300000
# 任务工作目录（§24）：TASK_WORKROOT=~/ihealth-work（fix_/feature_ 隔离目录根）
```
daemon 启动会幂等把 TAPD MCP 注册到 Claude Code（user scope）。

**详见 [docs/tapd.md](tapd.md)** —— 完整架构、7 步流程、多 repo/脏策略/基准/SOP、MCP 工具与坑、排错。

---

## 22. 工作总结报告 · 日报 / 周报 / 月报 / 年报

### 能力
一条命令生成个人工作总结，数据全来自本项目已有的活动记录，无需手写。

- **日报 / 周报** → **简报**（中文 markdown，推飞书）
- **月报 / 年报** → **PPT**（.pptx 飞书发文件，PowerPoint/WPS 可开）；加 `--brief` 出简报

### 数据源（"我做了啥"自动采）
- **git 提交**：扫全机 git 仓库（dir-index），按我的身份过滤（全局身份 ∪ 各 repo local 身份，解决多身份/多邮箱）
- **任务记忆**：本工具跑过的任务（按时间窗过滤）
- 时间窗按北京时区（日=今天 / 周=本周一 / 月=本月 / 年=本年）

### 流程
1. **采集**（确定性）：git log + 任务记忆 → 结构化数据 + 统计（提交数/仓库数/任务数）
2. **合成**：`claude -p` 把原始提交/任务提炼成可读内容（简报出 markdown；PPT 出分节 JSON）。带 `MCHAT_INTERNAL_SESSION=1`，合成输出不泄漏飞书
3. **渲染**：简报=markdown；PPT=**pptxgenjs**（纯 Node，无 python，封面→概览→主要工作/成果/亮点/遗留 分页）
4. **推送**：简报→飞书文本；PPT→飞书 `send-file`

### 命令（按需）
```
/report day            # 今日简报
/report week           # 本周简报（默认）
/report month          # 本月 PPT（--brief 出简报）
/report year           # 本年 PPT
```

### 定时自动（P3）
daemon 内定时器（非 launchd，报告依赖 daemon 在跑），到点自动生成并推飞书，每周期只触发一次
（`data/report/fired.json` 防重）；周报/月报采**上一个完整周期**（周一报上周、月初报上月）。
`.env` 配置（opt-in，缺则不启，改后需重启 dev）：
```env
REPORT_DAILY_AT=18:00        # 每天 18:00 当日日报（简报）
REPORT_WEEKLY_AT=Mon 09:00   # 每周一 09:00 上周周报（简报）
REPORT_MONTHLY_AT=1 09:00    # 每月 1 号 09:00 上月月报（PPT）
```

---

## 23. 对接管理 · `/connect`（面向业务人员）+ 首启引导 + CareyClaw

### 能力
开发类对接（TAPD / 性能平台 / 知识提炼 / 企微 / Web面板 / 报告 / CareyClaw）**默认不启**，业务人员按需开。一站式管理：

- **`/connect`（或 `/对接`）** → 状态卡：按分组列全部对接 + 三态（✅已启用 / ⏸已停用·配置保留 / ⬜未对接），每项对应按钮 [对接]/[停用]/[启用]。
- **对接（env 型）**：[对接] → 飞书原生输入表单卡（schema 2.0 form+input）填 env → 确认卡（密钥脱敏）→ 写 `.env`（`upsertEnvKeys` 保留其余行）→ touch 重启（dotenv 重读生效）。
- **停用/启用（软开关）**：停用 = key 加到 `.env` 的 `MCHAT_DISABLED_INTEGRATIONS` 列表，**不动该对接自己的配置 env**；各 gate 启动查 `isIntegrationDisabled`。可随时一键启用。
- **首启飞书未对接引导**：飞书是引导通道本身 → 走本地。daemon 启动检测 `LARK_APP_ID/SECRET` 缺失 → 打醒目横幅指向 `agent connect lark`；`agent connect [key]` CLI（**socket-free、不依赖 daemon**）交互填 env。

### CareyClaw 平台（龙虾）· skill 型对接
- daemon 启动**幂等自动装**两个官方技能：`careyclaw-apis`（检索/试调平台业务 API）+ `careyclaw-deploy`（打包 zip 发布应用）；双路径写 `~/.claude/skills` + `~/.agents/skills`（兼容 Claude Code / Codex）。
- 用浏览器 OAuth 授权，**无需 .env 密钥**。飞书说「龙虾/careyclaw 有没有XX接口 / 部署应用」→ 注入 tab → 技能自动干 → 结果回飞书（首次给授权链接）。
- **调试密钥（`oct_dev_`）到期提醒**：仅用于本地开发你自己的 app 调真实 API（填进你 app 的 `.env.local`）；刷新需短信（无法全自动）→ `/careyclaw` 查状态、到期前 ≤2 天 watcher 自动推提醒卡、[🔄更新密钥] 飞书表单贴新密钥。

### 底层
`orchestrator/integrations/`（registry 注册表 + envfile 读写/停用列表/状态 + skills 技能装 + careyclaw-key）；`connectStatusCard`/`connectFormCard`/`connectConfirmCard`/`careyclawKeyCard`；handlers `/connect`/`/careyclaw` + connect-*/careyclaw-key-* 卡动作；`agent connect` CLI。

---

## 24. 任务工作目录隔离 · worktree + `/worktasks`

> 统一任务（TAPD 认领 / perf 认领并建需求）来了 → 按类型建独立目录 → git 拉依赖 repo → 切分支 → 落可搜记录。

### 能力
- **按类型建隔离目录**（`prepareTaskWorkspace`，env `TASK_WORKROOT` 默认 `~/ihealth-work`）：
  - 🐞 线上bug(fix) → `~/ihealth-work/fix_<id6>/`
  - ✨ 新需求(feature) → `~/ihealth-work/feature_<id6>/`
  - 🔧 开发中(indev) → 各 repo 当前分支原地改，不建目录
- **每个 repo 用 git worktree**（本地有源，秒建省盘、共享 repo 纹丝不动）或 clone（本地无源），切 `fix_/feat_<id6>` 分支。→ 多任务/多人并存不互相污染；worktree 模式下不再需要脏工作区 stash/carry。
- **认领卡「🏷 类型」三选一**：显式选 fix/feature/indev，与「SOP 编排/直接修」正交（kind 定目录，sop 定编排）。缺省由 base/sop 派生。
- **可搜记录 + 一键打开**：认领时 `saveWorkTask` 落一条 目录↔分支↔干啥↔来源(tapd/perf)↔TAPD链接 记录 → `/worktasks`（`/wt`）交互卡列/搜（标题/分支/repo/目录），每条带 **[📂 打开]**（在该任务 worktree 目录开新 tab 并设 active；多 repo 开主 repo；目录被清理会提示）+ [🔗 TAPD]。→ 直接「打开历史需求对应的目录」继续干。

### repo 源怎么维护
本地有源 → worktree（靠 dir-index 后台发现全机 git 仓库，零维护）；本地无源 → clone（暂需 gitUrl，未映射则清晰报错）。团队化再叠「按 org 约定拼 gitUrl」（待办 B4）。

### perf 也接了目录隔离
perf 建议卡 [📋 认领并建需求]：建 TAPD 需求（创建人+开发负责人=你，挂「后端服务」项目「数据库优化」分类）→ 用 story 后6位建 `fix_<story6>/` worktree 目录开修 → 落 worktask 记录。「perf→需求→目录→修」闭环。详见 `docs/perf-integration.md` §4 P2。

### 底层
`host-mac/task-workspace.ts`（`prepareTaskWorkspace`/`taskWorkroot`/`taskDirName`/`taskBranchName`）；`orchestrator/worktasks/`（save/list/get/search）；`orchestrator/tapd/claims.ts`（`TapdClaim.kind`/`resolveClaimKind`/`TAPD_KIND_LABEL`）；`orchestrator/perf/tapd-story.ts`（`createPerfStory`）；`worktasksCard` + handlers `finalizeTapdClaim`/`tapd-cycle-kind`/`perf-claim-story`/`worktask-open` + 助手 `openTaskWorktreeTab`。env：`TASK_WORKROOT` / `PERF_TAPD_WORKSPACE_ID` / `PERF_TAPD_CATEGORY_ID`。

---

## 25. 多 agent 支持 · Codex CLI（对标 Claude Code）

> 团队里有人用 Claude Code、有人用 Codex CLI。本项目从"绑死 claude"解耦成"多 agent adapter 驱动"，Codex CLI 是一等公民（同宿主 Terminal.app）。设计见 `docs/codex-integration.md`。

### 能力
- **`AgentAdapter` 抽象**（`orchestrator/agents/`）：把"哪个 agent"的差异（进程识别 / 登录文案 / 启动·续接命令 / 内建 slash 白名单 / skill 目录 / 回传通道规格）收进一处。`claudeAdapter`（忠实还原现有行为，byte-identical）+ `codexAdapter` + registry（`detectAgentFromProcs`）。tab 状态、启动、slash 转发都按识别到的 agent 分派。
- **回传通道**（alt-screen 下 agent 响应推回飞书）：claude 用 `~/.claude/settings.json` Stop hook（`mchat-stop-hook`）；**codex 用 `~/.codex/config.toml` 的 `notify`（`bin/mchat-codex-notify`）** —— turn 结束 codex 以 argv JSON 调脚本 → 抽 `last-assistant-message` → `agent lark send-text`。daemon 启动幂等 upsert（非破坏、备份 `.mchat.bak`）。
- **`/connect` 加 codex 项**（`agentType`）：检测 CLI 装没装 / 登录没 / notify 钩子装没装 + 给下一步引导。`agent connect codex`（socket-free）同款。就绪 = 三者全绿。
- **桌面版 Codex**：不驱动 GUI，走"桥接到 CLI"（同账号装 CLI）。完整 GUI 驱动（`host-codex-app`）记档不投机做。

### 状态
C1（抽象）+ C2（回传通道）+ C3（/connect 引导）已完成，claude 行为始终不变。**唯一剩**：codex `login` 后跑一轮验 `notify` payload 字段名（`/tmp/mchat-codex-notify.log` 记原始 payload）→ 摘 `codexAdapter.unverified`。

### 底层
`orchestrator/agents/`（`types`/`claude`/`codex`/`registry`/`codex-status`）；`bin/mchat-codex-notify`；daemon `installCodexNotify()`；`host-mac/status.ts`·`restart.ts`、`im-lark/commands.ts` 消费端；registry `agentType:'codex'` + `connectStatusCard`/`connect-config`/`agent connect codex`。

---

## 已知的能力边界

**能做**：
- 单用户 macOS
- 飞书为 IM 层
- Claude Code 为 agent 层
- 多 tab 并行
- SOP 编排
- 自定义 subagent 域
- 企微第二 IM / Web Dashboard / 知识提炼 / TAPD Bug 监听认领

**不能做**（当前）：
- 多平台 IM（企微 / Slack / Telegram / 钉钉等，P2 计划）
- Linux / Windows host（AppleScript 锁死，P3 计划）
- 团队多用户共享（单 chat 一个 user，无 auth）
- 分布式部署（daemon 单机）

**不打算做**（哲学决定）：
- 云端 SaaS（本项目是本地工具，你数据不出你 Mac）
- claude 之外的 agent 后端（除非 P3 抽象 invoker）
- 完全无 Terminal 依赖（Terminal-first 是核心工作流哲学）
