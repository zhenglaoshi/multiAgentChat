---
name: multiagent-lark
description: |
  在 Mac Terminal 的某个 tab 里运行时，通过本地 multiAgentChat 服务把消息/文件/图片/卡片发回触发本任务的飞书会话。CLI 自动反查当前 tab 对应的飞书 chat，不需要传 chat_id。适用场景：用户在飞书远程操控 Mac 上的 claude，让你跑任务后把结果（文本、xlsx/pdf/zip 文件、截图等）通过飞书机器人发回。**不要直接调任何 webhook** —— 用本 skill 提供的 `agent lark` CLI。
---

# multiagent-lark

## 🔴 首要原则：**两个渠道并行输出**

用户可能在飞书**也**在 pc shell 面前。响应必须**两边都能看到**：
- **不要**把响应内容 * 只 * 通过 `agent lark send-text` 推给飞书 → 那样 shell TUI 里就啥都没有，用户扫一眼 shell 会以为你没干活
- **正确姿势**：先在 TUI 里**完整回答用户**（自然响应，跟你平时对话一样），然后**再**用 `agent lark send-text` 推**同样一份摘要**给飞书。两个渠道同一内容并行。
- 只有一种例外：这份内容特别长（>2000 字），可以 TUI 里完整写、飞书推浓缩摘要；但绝不能相反或只推不答。

## 何时用这个 skill

激活条件：
- 用户在飞书向我发了任务（例如"统计 X，结果发给我"、"导出 Y 发飞书"、"截图发到这里"）
- 任务需要把结果异步通知用户（文本、文件、图片、卡片）
- 检测到 multiAgentChat 服务在跑：`[ -S ~/.multiagent-chat/agent.sock ]` 返回真

## 先决条件

1. shell 里 `agent` 命令可用（通过 `which agent` 验证或 `~/ihealth-project/multiAgentChat/bin/agent`）
2. `~/.multiagent-chat/agent.sock` 存在（dev 服务在跑）

如果 `agent` 不在 PATH，可以用绝对路径调用：
```bash
~/ihealth-project/multiAgentChat/bin/agent lark send-text "..."
```

## 命令清单

**核心：让用户选/填 → 用 `agent lark ask`（弹卡片，用户手指点，stdout 拿答案 JSON）**：
```bash
agent lark ask single --title "选一个" --options "a,b,c"
agent lark ask multi  --title "勾几个" --options "1,2,3"
agent lark ask input  --title "输入什么"    # 用户在 chat 回文本
```


```bash
# 发文本（最常用）
agent lark send-text "任务完成"

# 从 stdin 发文本（适合长文本）
echo "..." | agent lark send-text -

# 发文件（自动检测 xlsx/pdf/doc/ppt/mp4/opus，其他用 stream）
agent lark send-file ./data/result.xlsx
agent lark send-file ./report.pdf --name "Q4 财务报表.pdf"

# 发图片（jpg/png/gif 等）
agent lark send-image ./screenshot.png

# 发交互卡片（lark message card 2.0 JSON）
agent lark send-card '{"config":{"wide_screen_mode":true},"header":{...},"elements":[...]}'

# 调试：看当前 tab 默认发到哪个 chat
agent lark which-chat
```

## Chat 自动推断

**不要硬编码 `--chat oc_xxx`。** CLI 按这个顺序自动选目标 chat：

1. 显式 `--chat oc_xxx` 参数（仅在用户明确要求发到特定群时用）
2. 通过 `tty` 命令拿当前 PTY，反查最近触发任务的 chat —— **常态走这条**
3. fallback：最近活跃的 chat

绝大多数时候**不传 `--chat`** 是对的。

## 典型用例

### 用例 1：跑脚本，结果发回飞书
```bash
# 任务跑完直接发
./run-analytics.sh > /tmp/out.txt
agent lark send-text "✅ 分析完成"
agent lark send-file /tmp/out.txt
```

### 用例 2：截图发到飞书
```bash
screencapture -i /tmp/shot.png
agent lark send-image /tmp/shot.png
```

### 用例 3：长文本/markdown 通过 stdin
```bash
my-tool --report | agent lark send-text -
```

### 用例 4：自定义卡片
```bash
cat > /tmp/card.json <<EOF
{
  "config": { "wide_screen_mode": true },
  "header": { "template": "green", "title": { "tag": "plain_text", "content": "✅ 部署成功" } },
  "elements": [
    { "tag": "div", "text": { "tag": "lark_md", "content": "**版本**: v1.2.3\n**环境**: prod" } }
  ]
}
EOF
agent lark send-card "$(cat /tmp/card.json)"
```

## ❌ 不要做什么

- **不要直接调 webhook**（`curl ... open.feishu.cn/open-apis/bot/v2/hook/...`）—— webhook 不支持文件、卡片功能也弱
- **不要硬编码 chat_id** —— 反查机制会自动找对
- **不要把凭证写进代码** —— 凭证由 multiAgentChat 服务持有，你不需要知道
- 如果 `agent.sock` 不存在或 `agent` 命令不可用，**直接告诉用户**（"multiAgentChat 服务没在跑"），不要瞎 try 别的飞书发送方式

## ⚠️ 让用户选选项 / 填输入：用 `agent lark ask`（不要 AskUserQuestion）

**为什么**：AskUserQuestion / TUI 选项框绘制在 alt-screen buffer 里，飞书那边看不见。手机端用户根本无从选。

**规则**：需要用户在**多个选项里选**（单选/多选）或**填一段文本**时，直接调 `agent lark ask`，它会弹一张飞书交互卡片，用户手指点选/回复文本，答案 JSON 从 stdout 回给你。用户完全不用手打命令。

### 单选（radio）

```bash
answer=$(agent lark ask single \
  --title "pigeon 连 mongo 副本集 timeout，怎么绕过？" \
  --options "自己 nc 探测 6 host 后重试,改 .env 用单节点 directConnection,跳过本地 pigeon 接测试环境,问运维要单节点串")
# → answer = {"status":"answered","type":"single","index":1,"value":"改 .env 用单节点 directConnection"}
echo "$answer" | jq -r '.index'
```

### 多选（checkbox）

```bash
answer=$(agent lark ask multi \
  --title "跑哪些 stage？" \
  --options "requirement,architect,coder,tester,regression")
# → {"status":"answered","type":"multi","indices":[0,2,3],"values":["requirement","coder","tester"]}
```

### 输入（用户在飞书回复一条文本消息）

```bash
answer=$(agent lark ask input --title "输入 commit message")
# → {"status":"answered","type":"input","text":"fix: xxx"}
```

### 退出码 / 状态

- 0 = `answered`（stdout 是完整答案 JSON）
- 1 = `cancelled`（用户点了取消）
- 2 = `timeout`（5 min 没响应，默认；用 `--timeout <ms>` 改）

### 特例：极短 y/n 确认

小到不值得弹卡片，可以简写 `agent lark send-text "❓ 要继续 xxx 吗？回 y/n"` + 常规 stdin 走。但只要选项 ≥ 3 或需要多选，一律 `agent lark ask`。

## 高风险操作前请求审批

如果你即将执行**不可逆 / 影响生产 / 操作真实数据库 / 删除大量文件**等高风险动作，**先调审批 CLI**，等用户飞书侧批准再执行：

```bash
agent request-approval \
  --title "执行 SQL UPDATE on prod" \
  --body "$(cat <<EOF
**目标**：把 users 表里 phone 为 NULL 的记录设为空字符串
**SQL**：
\`\`\`
UPDATE users SET phone = '' WHERE phone IS NULL;
\`\`\`
**影响范围**：约 200 行
**回滚方案**：UPDATE users SET phone = NULL WHERE phone = '' AND ...
EOF
)"
```

行为：
- 阻塞等待飞书审批（默认 5 分钟超时）
- exit code 0 = 批准（可以接着干）
- exit code 1 = 拒绝（**必须**中止该动作，思考别的方案）
- exit code 2 = 超时（按拒绝处理）
- stdout 输出 `approved` / `rejected` / `timeout`

## 何时该 request-approval

✅ 一定要：
- 写真实数据库（INSERT/UPDATE/DELETE/DROP/ALTER on prod 或 staging）
- `git push --force` 到非个人分支
- `rm -rf` 多个文件
- 改 `.env` / 凭证文件
- 修改 prod 配置 / 重启 prod 服务
- 涉及钱（支付、退款、扣费）

❌ 不必：
- 只读查询、日志查看
- 自己 workspace 里的临时文件
- 改正在编辑的代码
- 跑测试

## 收到带 [SOP 任务] 头部的 prompt 怎么干（多 stage 编排）

如果 prompt 顶端长这样：

```
🎯 [SOP 任务] task-id: task-mqxxx-yyyy

你是这个任务的主 agent，请按以下 stage 顺序执行：
  1. Explore
  2. requirement-analyzer
  3. architect   ⏸ gate
  4. coder
  ...
```

**你就是这个任务的 orchestrator（主 agent）**。你的工作不是亲自写代码 / 写测试，而是**按 stage 序调用 Task 工具 spawn subagent**，并向 framework 上报每个 stage 的开始/结束。

### 🧠 第一步：判断哪些 stage 真有必要

不是所有任务都要走全部默认 stage。先**分析任务**，对你判断**不需要**的 stage 立刻 skip：

```bash
agent task stage --task-id <task-id> --name <stage> --skip --reason "<原因>"
```

例：
- "改个错别字" → skip explore / requirement-analyzer / architect / tester / regression-checker，只跑 coder
- "调研 X 可行性" → skip coder / tester / regression-checker，只跑 explore / architect
- "实现新功能" → 全部 stage 跑

skip 让该 stage 状态变 `skipped`，不算失败、不触发 loops、artifact 链路自然断在那里。

### 每个**需要的** stage 的标准循环

```bash
# (1) 声明 stage 开始
agent task stage --task-id <task-id> --name <stage> --start

# (2) Task 工具 spawn subagent
# 把 artifact dir 路径告诉它：artifact 默认存到 <artifactDir>/<stage>.md
# 把上一个**实际跑过**的 stage 的 artifact 路径作为输入传给它（skip 的不算）
```

```typescript
Task({
  subagent_type: 'architect',
  prompt: '读 ./docs/tasks/<id>/requirements.md，产出 ./docs/tasks/<id>/design.md。...'
});
```

```bash
# (3) subagent 返回后：上报 stage 结束
agent task stage --task-id <task-id> --name <stage> --end \
  --summary "选了方案 B，受影响 5 文件" \
  --artifact ./docs/tasks/<id>/design.md

# ⚠ 若该 stage 标了 ⏸ gate：上面这条会阻塞，等飞书人工审批
#   stdout 返回 "approved" 才能继续下一 stage
#   stdout 返回 "rejected" / 退出非 0：停止，给用户发飞书消息说明

# 失败时：
agent task stage --task-id <task-id> --name <stage> --fail \
  --note "subagent 报告 design.md 与现有 API 冲突，需要重新评审"
```

### 关键规则（漏一条 framework 就看不到进度）

- **每个 stage 必须 `--start` 才能 `--end`** —— 顺序错的话 server 会拒绝
- **stage 名字必须匹配 prompt 里给的列表**（区分大小写）
- **artifact 文件要真的写出来**，路径才能放进 `--artifact`；subagent system prompt 里有约定路径，你也可以在 Task() prompt 里显式指定
- **subagent 之间通过 artifact 文件 handoff**，不是靠你转述全文。下一个 subagent 读上一个的产物
- **全部 stage 完成后**，调 `agent lark send-text "..."` 给用户发收尾摘要（含每个 stage 的产物路径）

### 🛑 收到 "[SOP 中止]" 消息怎么办

用户从飞书或 shell 主动 abort 了 task，你会看到一段红色 banner 注入到 TUI：

```
🛑 [SOP 中止] task-id task-mq... 已被中止（soft）
原因: ...
请停止 stage 协议；已完成 stage 的产出保留，可 agent lark send-text 简短总结
```

**立刻**停止 stage 协议调用。两种情况：

- **soft 中止**（默认）：可以调 `agent lark send-text` 写个简短收尾，列出已完成 stage 的 artifact 路径
- **hard 中止**：不要写收尾，直接停手待命

后续任何 `agent task stage --start/--end` 都会被 server 拒绝（task 已 failed），所以即便你漏看 banner，下次 stage 命令也会报错提醒你。

### 何时把 task-id 写进环境变量

如果你想少打几个字，可以一开始 `export AGENT_TASK_ID=task-mqxxx-yyyy`，之后 `agent task stage` 不带 `--task-id` 也行（CLI 会读 env）。但**仅在同一 Bash 调用内有效**——Bash 工具每次调用是独立 shell。所以更可靠的做法是每次都显式 `--task-id`。

### 查任务状态

```bash
agent task show <task-id>      # 看当前 stage / 已完成 / 产物路径
agent task list                # 看所有 task
```

## 收到带 [上次相关历史] 段落的 prompt 怎么用

multiAgentChat 在转发用户消息到这个 tab 之前，会自动检索"过去做过的类似任务"，注入到 prompt 头部：

```
[上次相关历史 — 系统自动注入]
- 2 天前: "统计三梯队数据"
  • 涉及文件：data/three-tier-2026-06-25.xlsx  scripts/three-tier.py
- 1 周前: "查询照护师手机号"
  • 涉及文件：data/手机号_2026-06-20.xlsx

[本次任务]
再统计一下三梯队，但只看 18 岁以上
```

**当你看到这个段落**：
- 不要重复摸索：直接复用上次的脚本 / SQL / 文件
- 文件路径里有上次的输出，可以参考 schema / 字段
- 注意时效性：日期信息看一下，旧脚本可能要更新
- 用 `agent recall <关键词>` 进一步查（如果需要）

## 失败处理

`agent lark` 失败时会把错误打到 stderr 并 exit 非 0。常见原因：
- `连接 .../agent.sock 失败` → dev 服务没跑，告诉用户去启动
- `tab 不存在了` → 触发任务的 Terminal tab 已关闭，反查不到，用 `--chat` 显式指定
- `文件不存在` → 路径写错
- 飞书 API 4xx → 凭证或权限问题
