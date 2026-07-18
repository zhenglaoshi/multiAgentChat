# 命令完整参考

按"我想做啥"分类，不是字母序。

## 目录
- [飞书基本 —— 派任务到 tab](#飞书-派任务到-tab)
- [飞书 SOP —— 多 stage 编排](#飞书-sop-多-stage-编排)
- [飞书任务管理](#飞书任务管理)
- [飞书审批](#飞书审批)
- [飞书 Subagent 管理](#飞书-subagent-管理)
- [飞书查询](#飞书查询)
- [Mac CLI 基本](#mac-cli-基本)
- [Mac CLI 派消息给飞书](#mac-cli-派消息给飞书)
- [Mac CLI SOP 内部协议](#mac-cli-sop-内部协议)
- [Mac CLI 诊断 + 维护](#mac-cli-诊断--维护)

---

## 飞书 —— 派任务到 tab

**默认发到 active tab**（用 `/use` 指定）：
```
跑 npm test
```

**显式 @target 派发**：
```
@ttys001 跑 npm test
@pivotal-parrot 拉北京数据
@studio 调研 graphql
```
target 可以是 tty 全名（`/dev/ttys001`）、短名（`ttys001`）、tab 标题、cwd basename、cwd 子串。

**多 target 并发**（每行独立）：
```
@studio 调研 X
@lab 跑实验 Y
```

**链式串行**（一行内 `>>`）：
```
@a 改 X >> @b 跑测试 >> @c commit
```

---

## 飞书 SOP —— 多 stage 编排

见 [sop.md](sop.md) 完整概念。

**Ad-hoc SOP**（不用先建模板）：
```
/run --sop 实现 ping 命令
/run --sop --stages design,implement @ttys009 加个 /reload 命令
/run --sop --stages a,b,c --gates after-b --loops c→b*1 @target prompt
```

**跑已存模板**：
```
/run <template-name> [key=value ...]
/run data-analysis task="分析 6 月三梯队"
```

**存模板**：
```
/template save <name> [--stages a,b,c] [--gates after-a] [--loops b→a*2] [--artifact-dir ./docs/{task-id}] [@target] <prompt>
/template save research @studio 调研 {topic}
/template save sdlc --stages Explore,architect,coder,tester --gates after-architect 实现 {feature}
```

**看模板**：
```
/template               # 列所有（卡片）
/template show <name>   # 详情
/template delete <name>
```

---

## 飞书任务管理

```
/task                   # 列所有进行中 SOP
/task <task-id>         # 单个 task 时间线卡（stage 状态 / gate / artifact）
/task here              # 本 chat 进行中的 SOP
/task abort [<id>] [hard]   # 中止（无 id 时自动找本 chat 的进行中）
```

`hard` = 硬中止（claude 不写收尾）；默认 soft（保留已完成 stage artifact，允许写收尾摘要）。

---

## 飞书审批

```
/approvals              # 待审批 + 最近历史
/audit [N]              # 最近 N 条审批历史
```

审批卡上有 ✅ 批准 / ❌ 拒绝按钮，直接点。

---

## 飞书 Subagent 管理

```
/subagent               # 列所有可用 subagent（用户全局 + 项目本地）
/subagents              # 同上（别名）
/sa                     # 同上（更短别名）
/subagent <name>        # 详情（含 system prompt 前 800 字）
/subagent delete <name>
/subagent gen <描述>     # LLM 自动为该域生成 3-5 个 subagent + 组合 template
/subagent tweak <name> <改动指令>   # LLM 迭代改现有 subagent
```

**`/subagent gen` 示例**：
```
/subagent gen 视频剪辑：ffmpeg 剪 mp4 + 加中文字幕 + 生成 3 张缩略图
/subagent gen 财务对账：从 CSV 抽金额 + 分类汇总 + 生成月度报表
/subagent gen 数据分析：SQL 抽数 + pandas 聚合 + Excel 报表
```

Framework 会派任务到 active tab 的主 claude，让它生成结构化 JSON，落盘到 `~/.claude/agents/`。

**`/subagent tweak` 示例**：
```
/subagent tweak data-fetcher 让它默认拉最近 30 天数据，不管用户是否指定时间范围
/subagent tweak architect 让它每次都产出 mermaid 图
```

---

## 飞书查询

```
/dashboard 或 /d        # 全局概览：active tab + pending 任务 + 最近完成 + 进行中 SOP
/shells 或 /s           # tab 列表卡，按钮可切 active
/use <tty>              # 切当前 chat 的 active tab
/where 或 /w            # 当前 active tab 信息
/history 或 /h [-n N]   # active tab 屏幕历史 tail
/new [path]             # Mac 上开新 tab（不带路径弹选目录卡）
/watch on / off         # 本地任务监听（非飞书发起的 shell 活动也推飞书）
/recall <关键词>         # 搜 task memory；不带关键词 = 最近 10 条
/worktasks 或 /wt [关键词] # 任务工作目录卡：列/搜（标题/分支/repo/目录），每条带 [📂 打开] 开历史需求目录 + [🔗 TAPD]
/tapd                   # 列指派给我的未结束 TAPD 缺陷/需求（见 tapd.md）
/report day|week|month|year [--brief]  # 工作总结：日/周=简报md，月/年=PPT(--brief 出简报)
/help 或 /?             # 帮助
```

---

## Mac CLI 基本

安装 skill 后，Mac 任何 shell 里都能用 `agent`。

```bash
agent tabs                          # 看所有 Terminal tab
agent use <tty>                     # 设 CLI 默认 tab
agent which                         # 看 CLI 当前默认 tab
agent send [-t tty] "..."           # 发文本到 tab
agent show [-t tty] [-n 60]         # 看 tab 屏幕历史 tail
agent open [path] [--new-window]    # 开新 tab
agent close <tty>                   # 关 tab（会关整 window，自动过关闭确认框）
agent recent-cwds                   # 最近用过的 cwd
agent restart-all-claude-tabs       # 原地重启所有 claude tab（默认 dry-run，加 --yes 执行）
#   选项：--yes 真执行 · --dry-run 只列 · --continue 续会话 · --except t1,t2 · --include-self
```

> **TAPD Bug 监听**（见 [features.md §21](features.md) / [tapd.md](tapd.md)）是**卡片驱动**，无 slash 命令：
> daemon 自动轮询推卡，你点卡上按钮认领即可（飞书全功能 / 企微简化流）。

---

## Mac CLI 派消息给飞书

从 tab 里的 claude 或任何 shell 用：

```bash
agent lark send-text "..."                    # 发文本
echo "长文本" | agent lark send-text -         # 从 stdin
agent lark send-file <path> [--name "..."]    # 发文件（xlsx / pdf / zip / 任意）
agent lark send-image <path>                   # 发图片
agent lark send-card '<lark card json>'        # 发卡片
agent lark which-chat                          # 看当前 tab 默认发哪个 chat
```

**自动 chat 反查**：CLI 从当前 tty 反查触发任务的 chat，无需 `--chat`。若无 pending，退到 most-recent chat。

```bash
agent request-approval --title "..." --body "..."   # 阻塞式审批（回车 approved/rejected/timeout）
```

---

## Mac CLI SOP 内部协议

主 claude 在 tab 里收到 SOP wrapper 后**必须**调这些：

```bash
agent task stage --task-id X --name <stage> --start
agent task stage --task-id X --name <stage> --end --summary "..." --artifact <path>
agent task stage --task-id X --name <stage> --fail --note "..."
agent task stage --task-id X --name <stage> --skip --reason "..."
```

- `--end` 命中 gate 时会**阻塞** 30 分钟等飞书审批
- `--fail` 命中失败回环时 stdout 输出 `loopback:<stage>`，claude 应从该 stage 重跑

其它 task ops：
```bash
agent task list [--status running|awaiting-gate|done|failed] [-n N]
agent task here                     # 当前 tty 上进行中的 task
agent task show <task-id>
agent task abort <task-id> [--hard] [--reason "..."]
agent task abort --here [--hard]    # 自动找当前 tty 的 task
agent stage-recall [--name <stage>] [--cwd <dir>] [-n N] [kw1 kw2 ...]
```

---

## Mac CLI Subagent 管理

```bash
agent subagent list
agent subagent show <name>
agent subagent add <name> --body "system prompt..."
    # 可选：--title "描述" --artifact "Read,Bash" --summary sonnet --note purple
    # body 也可从 stdin
agent subagent delete <name>
agent subagent gen-submit --task-id X --chat Y --body '<json>' [--hard]
    # 主 claude 生成后走这条落盘（一般不用手调；飞书 /subagent gen 后自动调）
    # --hard = overwrite（用于 tweak 场景）
```

---

## Mac CLI Knowledge Base（自动提炼 shell 交互）

```bash
agent knowledge stats               # 总条目 / byKind / 队列 / 启用状态
agent knowledge list [-n 20]        # 最近 N 条列表
agent knowledge show <id>           # 单条详情（id 可只写前缀）
agent knowledge extract-last [-t /dev/ttysXXX] [-n 200]
    # 手动触发对某 tab 最近 N 行提取（不用等任务自动完成）
    # 别名: agent kb el -t /dev/ttys002 -n 300
```

需先在 `.env` 加 `KNOWLEDGE_EXTRACT_ENABLED=1` + 重启 dev。详见 **[docs/knowledge.md](knowledge.md)**。

---

## Mac CLI 诊断 + 维护

```bash
agent doctor                        # 12 项健康检查
agent install-skill                 # 装 multiagent-lark skill 到 ~/.claude/skills/
agent uninstall-skill
agent connect                       # 列全部对接 + 状态（socket-free，bootstrap 用）
agent connect lark                  # 交互式填飞书 App ID/Secret → 写 .env
agent connect codex                 # 检测 Codex CLI 装没装/登录没/notify 钩子 + 给引导（多 agent，见 features §25）
agent help                          # 完整命令清单
```

---

## 环境变量

| 变量 | 何用 |
|---|---|
| `AGENT_SOCKET` | Unix socket 路径（默认 `~/.multiagent-chat/agent.sock`） |
| `AGENT_TASK_ID` | SOP 主 claude 可 export 这个避免每条 stage 命令都传 `--task-id` |
| `LARK_APP_ID` | .env 里的飞书 App ID |
| `LARK_APP_SECRET` | .env 里的飞书 App Secret |
| `TASK_WORKROOT` | 任务工作目录根（默认 `~/ihealth-work`）；TAPD/perf 认领建 `fix_/feature_<id6>/` worktree 隔离目录用（见 features.md §24） |
| `PERF_TAPD_WORKSPACE_ID` | perf「认领并建需求」建到哪个 TAPD 项目（默认 `36983849`「后端服务」） |
| `PERF_TAPD_CATEGORY_ID` | 建的需求挂哪个分类（默认 `1136983849001000190`「数据库优化」）；留空=未分类 |

---

## 常用组合模式

**远程调度长任务**：
```
1. 手机上飞书发 @studio 调研 X，写到 docs/x.md
2. active tab 主 claude 收到，跑
3. 完成后主 claude 用 agent lark send-file docs/x.md 推回你
```

**SOP + 审批**：
```
1. /run sdlc feature="加登录功能"
2. framework 建 task，派 SOP wrapper 到 active tab
3. 主 claude 顺序调 Task(explore) → Task(architect)
4. architect 完成后 gate 触发，飞书弹审批卡（含 design.md 预览）
5. 你飞书上点批准
6. 继续 Task(coder) → Task(tester) → Task(regression-checker)
7. 全部完成，主 claude 用 agent lark send-text 报告
```

**自定义域**：
```
1. /subagent gen 你想要的域描述
2. framework 派任务给主 claude 设计 3-5 个 subagent
3. 主 claude 输出 JSON 用 agent subagent gen-submit 落盘
4. /run <生成的 template-name> 用起来
```
