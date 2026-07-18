<!-- 自动生成：pnpm gen:feishu-commands --format md --out docs/feishu-commands.md -->
<!-- 请勿手改；改 scripts/feishu-command-manifest.ts -->

## 命令一览

给飞书开放平台后台填写用（对着 name / description / example 复制）。

| # | 指令名称 | 指令描述 | 示例 | 隐藏 |
|---|---|---|---|---|
| 1 | dashboard | 概览：tab + 进行中的任务 + 最近完成 | dashboard | 否 |
| 2 | shells | 列所有 Terminal tab（可点切换） | shells | 否 |
| 3 | where | 当前 active tab 的详情 | where | 否 |
| 4 | history | 当前 tab 屏幕历史 tail | history -n 100 | 否 |
| 5 | use | 切换本会话的 active tab | use ttys001 | 否 |
| 6 | new | 开新 Terminal tab（无参数弹选目录卡） | new ~/code/foo | 否 |
| 7 | watch | 开关本地任务监听（Mac 直发的命令也推） | watch on | 否 |
| 8 | run | 跑模板 or --sop 临时 SOP | run --sop 实现 X | 否 |
| 9 | template | 管理任务模板（save/show/delete/list） | template | 否 |
| 10 | task | SOP 任务列表 / 详情 / 中止 | task | 否 |
| 11 | subagent | 管理 subagent（list/gen/tweak/delete） | subagent gen 视频剪辑 | 否 |
| 12 | approvals | 待审批列表 + 最近历史 | approvals | 否 |
| 13 | recall | 搜任务历史；不带关键词 = 最近 10 条 | recall 三梯队 | 否 |
| 14 | help | 完整命令帮助 | help | 否 |

---

## 详细用法

每条命令的完整子命令语法。飞书菜单只有短描述，实际语法看这里。

### 概览 & 导航

#### `/dashboard`（alias: `/d`）

概览：tab + 进行中的任务 + 最近完成

```
/dashboard                            # 显示全局概览卡
```

#### `/shells`（alias: `/s`, `/tabs`, `/ls`）

列所有 Terminal tab（可点切换）

```
/shells                               # 列所有 Terminal tab
/s                                    # 短别名
```

#### `/where`（alias: `/w`, `/pwd`）

当前 active tab 的详情

```
/where                                # 看本会话当前 active tab 的 cwd/tty/title
```

#### `/history`（alias: `/h`）

当前 tab 屏幕历史 tail

```
/history                              # 默认 tail 60 行
/history -n 100                       # 指定行数
```

### 任务派发

#### `/use`（alias: `/u`）

切换本会话的 active tab

```
/use ttys001                          # 按 tty 精确切
/use myproject                        # 按 cwd 末尾目录名切
/use                                  # 无参数 → 列 tab 让选
```

#### `/new`（alias: `/n`）

开新 Terminal tab（无参数弹选目录卡）

```
/new                                  # 弹目录选择卡（含 recent-cwds 建议）
/new ~/code/multiAgentChat            # 直接指定 cwd 开
/new /tmp                             # 绝对路径
```

#### `/watch`

开关本地任务监听（Mac 直发的命令也推）

```
/watch on                             # 打开：非飞书发起的 shell 活动也推到飞书
/watch off                            # 关闭
/watch                                # 不带参数 = 查询当前状态
```

### SOP 编排

#### `/run`（alias: `/preset`）

跑模板 or --sop 临时 SOP

```
/run <name>                           # 跑已存的模板（无参数）
/run <name> pos1 pos2                 # 位置参数填 {1} {2}
/run <name> key=value key2=value2     # 命名参数填 {key}
/run --sop <prompt>                   # 临时 SOP，不需预存模板
/run --sop --stages a,b,c <prompt>    # 自定义 stage 序列
/run --sop @<tab> <prompt>            # 绑定特定 tab
```

#### `/template`（alias: `/t`, `/templates`, `/tpl`）

管理任务模板（save/show/delete/list）

```
/template                             # 列所有已保存模板（卡片）
/template save <name> <prompt>        # 存模板；prompt 里可用 {key} 占位
/template save <name> --stages a,b,c --gates after-b --loops b→c*2 <prompt>
                                      #   --stages: SDLC stage 序列
                                      #   --gates: 在某 stage 后加人工审批点
                                      #   --loops: 循环失败重试规则
/template show <name>                 # 看模板详情（含 stages/gates/loops）
/template delete <name>               # 删
```

#### `/task`（alias: `/tk`）

SOP 任务列表 / 详情 / 中止

```
/task                                 # 列所有进行中 + 最近完成的 SOP 任务
/task <task-id>                       # 看单个任务详情卡（stage 时间线）
/task here                            # 只看本会话的进行中 SOP
/task abort                           # 中止本会话进行中的 task（无 id 自动找）
/task abort <task-id>                 # 中止指定 task（soft）
/task abort <task-id> hard            # 硬中止（不等 subagent 收尾）
```

### Subagent

#### `/subagent`（alias: `/sa`, `/subagents`）

管理 subagent（list/gen/tweak/delete）

```
/subagent                             # 等价 /subagent list
/subagent list                        # 列所有可用 subagent（user+project）
/subagent <name>                      # 看单个详情（含 system prompt 前 800 字）
/subagent gen <域描述>                # LLM 自动为该域生成 3-5 个 subagent + template
/subagent tweak <name> <feedback>     # 对现有 subagent 迭代（会 --hard 覆写）
/subagent delete <name>               # 删
```

### 查询 & 交互

#### `/approvals`（alias: `/a`）

待审批列表 + 最近历史

```
/approvals                            # 看当前 pending 的审批 + 最近 5 条历史
                                      # 点卡片按钮 "批准" / "拒绝" 直接响应
```

#### `/recall`（alias: `/r`）

搜任务历史；不带关键词 = 最近 10 条

```
/recall                               # 最近 10 条任务 memory
/recall <关键词>                      # 按 cwd + keyword 打分搜
/recall 三梯队 subagent               # 多关键词（AND 语义）
```

### 其它

#### `/help`（alias: `/?`）

完整命令帮助

```
/help                                 # 完整命令列表（含所有短 alias）
/?                                    # 等价短形
```

