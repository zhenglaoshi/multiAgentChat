# 排错指南

按症状分类。第一件事永远是 `agent doctor` 拿全景。

---

## 部署 / 起停

### daemon 起不来

**症状**：`pnpm dev` 报错或秒退。

**查**：
```
1. pnpm typecheck 全过吗？    # 编译错优先修
2. .env 有 LARK_APP_ID + SECRET 吗？
3. 端口 / socket 冲突？socket 在 ~/.multiagent-chat/agent.sock，lsof 看
4. dev 日志里有 stack trace 吗？
```

**常见原因**：
- 之前 dev 没干净退出，socket 文件残留 → 删了：`rm ~/.multiagent-chat/agent.sock`（下次启动会重新建）
- Node 版本不对 → `nvm use 20`
- 依赖没装完 → `pnpm install`

### daemon 起来但飞书收不到消息

**症状**：`pnpm dev` 显示 `lark bot started`，但飞书里 `@bot ping` 无响应。

**查**：
```
1. 机器人被拉进你所在 chat 了吗？（`/dashboard` 试）
2. 飞书应用发布了吗？在飞书开放平台看
3. 事件订阅方式选的**长连接**吗？（不是 HTTPS webhook）
4. 订阅的事件里有 `im.message.receive_v1`？
5. dev 日志里 `[ws] ws client ready` 有吗？
```

### daemon 起来但 tab 派不到

**症状**：`@ttys001 xxx` 报"tab 不存在"。

**查**：
```
agent tabs                # 看真实的 tty
agent doctor              # AppleScript 权限是否 pass
```

**常见原因**：
- Accessibility 权限没给
- Terminal.app 没在跑（打开一个）
- tty 名字变了（每次开新 tab tty 会变）

---

## AppleScript / 权限

### `osascript: -1743` 或 `not allowed`

**症状**：agent doctor 里 AppleScript 权限 fail。

**修**：
1. System Settings → Privacy & Security → Accessibility
2. 加入这些：
   - `Terminal.app`
   - `iTerm.app`（如用）
   - `osascript`（`/usr/bin/osascript`，可能要 Cmd+Shift+G 手动加）
   - 跑 dev 的进程（node）
3. 每加一个，勾选 checkbox
4. 重启 Terminal

### Terminal.app 抢焦点

**症状**：`/run --sop` 触发时 Terminal 弹到前面抢你正在用的其他 app 焦点。

**修**：应该已经在 `new-tab-background` 模式修好了（Terminal 闪 200ms 归位）。如果还抢：
```
git log --oneline | grep spawn
# 应该看到 58d5c6a P0 polish: smart-dispatch + spawn background
```
没有说明用的老版本。`git pull` + `pnpm install`。

---

## SOP / 任务

### `/run` 说"模板不存在"

**修**：
```
/template               # 看真实存的模板列表
```
或用 ad-hoc：
```
/run --sop <prompt>
```

### 任务卡住不动（stage 迟迟不 end）

**查**：
```
/task <task-id>         # 看当前 stage
/approvals              # 有没有卡在 gate 上等审批
```

**常见原因**：
- claude 在 tab 里跑长活（用 `agent show -t <tty>` 看进度）
- gate 触发了没人批 → `/approvals` 找到卡片点批 or 拒
- claude 忘调 `agent task stage --end`（bug 或 skill 没装）→ 手动 abort：`/task abort <id>`

### 主 claude 报 `unknown subagent`

**症状**：`Task(subagent_type='data-fetcher')` 报"Agent type 'data-fetcher' not found"。

**原因**：Claude Code session 启动时**快照** agent list，加 subagent 后**要新 session 才认**。

**修**：
- 让 framework spawn 新 tab（`/run --sop` 无 `@target` 时，smart-dispatch 会自动 spawn 新 tab）
- 或手动开新 tab：`agent open .` 然后 `claude`
- 或在你切到别的 app 后再 `/run --sop`（触发 spawn 路径）

### SOP wrapper prompt 主 claude 忽略了

**症状**：`/run --sop` 后主 claude 不按 stage 协议跑，直接开始干活。

**原因**：SKILL.md 没装到 `~/.claude/skills/` → claude 不知道 SOP wrapper 是啥。

**修**：
```
agent install-skill
```
然后新 session（在 tab 里重开 claude）。

---

## Subagent

### `/subagent gen` 后主 claude 卡住不出 JSON

**查**：
```
agent show -t <activeTty> -n 40    # 看主 claude 输出
```

**常见原因**：
- 主 claude 在思考很久（正常，等 30s）
- Prompt 里 JSON schema 主 claude 没理解 → 简化 desc 再试
- claude 报错 → 看具体 error

### `/subagent gen` 说"没 active tab"

**修**：
```
/shells                 # 列 tab
/use ttys001            # 选一个 tab（要有 claude 在跑）
```

### tweak 后 subagent 没变

**原因**：CLI 没带 `--hard` flag，framework 因冲突 skip 了。看飞书 reply。

**修**：主 claude 需要用 `agent subagent gen-submit ... --hard`。这个 framework 会在 tweak prompt 里明确要求。如果主 claude 没听 → tweak 一次不 work，再 tweak 一次强调 --hard。

---

## 飞书通信

### `agent lark send-text` 返回 ✓ 但飞书没收到

**查**：
```
agent lark which-chat   # 看当前 tab 默认发哪个 chat
```

**常见原因**：
- 反查到了错的 chat（比如你有多个 chat）→ 显式 `--chat <chatId>`
- 飞书 API 服务端拒绝 → 看 dev 日志
- 机器人被踢出 chat 了 → 重新拉进

### 飞书卡片显示乱码 / 缺按钮

**原因**：飞书卡片 schema 版本或权限问题。

**查**：
- 飞书应用是否有 `im:message.send_as_bot` 权限
- 卡片 schema 用的 2.0（本项目用 lark_md tag）

---

## 数据 / 状态

### daemon 挂了后 task 状态丢了

**不会丢**：所有 task 状态在 `data/tasks/*.json` 磁盘持久化。重启 daemon 后：
```
agent task list
```
应该看到之前的 task。

### memory 越攒越多

**当前无自动清理**。手动清：
```bash
find data/memories -type f -mtime +90 -delete
find data/stage-memories -type f -mtime +90 -delete
```

保留最近 90 天。以后加自动 GC。

---

## 一般排查步骤

按顺序：

1. **`agent doctor`** —— 找出 critical fail
2. **看 dev 日志** —— `pnpm dev` 的 stdout
3. **`agent tabs`** —— 确认 Terminal 状态
4. **`agent task list` + `/task <id>`** —— 看有没有卡壳的 task
5. **`agent lark which-chat`** —— 确认 chat 反查对
6. **重启 daemon** —— `pkill -f 'tsx watch' && pnpm dev`
7. **实在不行**：`rm ~/.multiagent-chat/agent.sock`（会重建）+ 重启

---

## 报 bug

请提供：
1. `agent doctor` 完整输出
2. `pnpm dev` 相关日志片段
3. 触发命令（飞书发的什么 + CLI 跑的什么）
4. 期望 vs 实际

（如未开源）直接给 owner；（已开源）GitHub Issues。
