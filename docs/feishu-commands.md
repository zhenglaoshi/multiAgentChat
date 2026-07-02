<!-- 自动生成：pnpm gen:feishu-commands --format md --out docs/feishu-commands.md -->
<!-- 请勿手改；改 scripts/feishu-command-manifest.ts -->

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
