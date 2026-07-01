# Contributing to multiAgentChat

## 前提

- **macOS** — 主要目标平台，因为 AppleScript 控制 Terminal.app
- **Node.js ≥ 20**
- **pnpm ≥ 9**（`npm install -g pnpm` 若没有）
- **Claude Code**（`claude` 命令）
- 一个 **飞书** 自建应用（申请 [飞书开放平台](https://open.feishu.cn/)），拿到 `LARK_APP_ID` + `LARK_APP_SECRET`
- macOS **Accessibility 权限**开放给：Terminal.app / iTerm.app（如果用）/ osascript / 跑 dev 服务的进程

## 项目 setup

```bash
git clone <repo> multiAgentChat
cd multiAgentChat
pnpm install
cp .env.example .env
# 编辑 .env 填 LARK_APP_ID / LARK_APP_SECRET
pnpm dev
```

第一次跑，把 skill 装到你的 Claude Code：
```bash
./bin/agent install-skill
```

这会把 `skills/multiagent-lark/SKILL.md` 拷贝到 `~/.claude/skills/`。之后你所有 Claude Code session 启动时都会自动加载这个 skill，主 claude 知道用 `agent lark send-text` 推消息回飞书。

## 开发工作流

```bash
pnpm dev           # tsx watch（改代码自动 reload）
pnpm typecheck     # tsc -b（跨包 project references）
pnpm build         # 输出 dist/（一般不需要，dev 直接用 tsx）
```

修改代码后：`tsx watch` 会自动 reload daemon。如果改了 `.env` 或 `package.json`，需要 kill + `pnpm dev` 重启。

## 项目结构

详见 [docs/architecture.md](docs/architecture.md)。快速版：

```
packages/
├── orchestrator/    # 纯逻辑（任务状态机 / memory / approval / subagent registry）
├── host-mac/         # macOS AppleScript 控制 Terminal
├── im-lark/          # 飞书 SDK + 观察者 + 卡片 schema
└── framework/        # Unix socket 服务器 + agent CLI

apps/daemon/         # 唯一装配层，index.ts wire 全部
```

依赖是**严格单向 DAG**：`daemon → framework → im-lark → host-mac → orchestrator`。TS project references 强制。

## 常见任务

### 加一个飞书斜杠命令

1. `packages/im-lark/src/lark/commands.ts` 的 `handleCommand` 里加 `if (name === 'foo') { ... }`
2. 需要新交互路径？在同文件加 handler function
3. 需要新卡片？`packages/im-lark/src/lark/cards.ts` 加卡片 builder
4. `handleCommand` 返回 `ReplyAction`（text / card / execute / gen-subagent / tweak-subagent 之一）
5. 更新 `HELP_TEXT` 常量

### 加一个新的 Unix socket op

1. `packages/framework/src/control/protocol.ts` 加 `<Name>Op` interface + 加进 `Request` union + 加对应 `<Name>Data` response type
2. `packages/framework/src/control/server.ts` 加 `handle<Name>` function + 加进 `dispatch` switch
3. `packages/framework/src/control/cli.ts` 加子命令（如需 CLI 层暴露）

### 加一个新 subagent（用户自己扩展）

**推荐路径**：飞书发 `/subagent gen <域描述>`，主 claude 自动生成 3-5 个 subagent + 组合 template 到 `~/.claude/agents/`。

**手动路径**：
```bash
agent subagent add <name> \
  --title "描述" \
  --artifact "Read,Bash,Grep" \
  --summary sonnet \
  --note purple \
  --body "You are ..." 
```

或直接编辑 `~/.claude/agents/<name>.md`。

### 加一个 SOP 模板

飞书：
```
/template save my-workflow --stages a,b,c --gates after-a --loops c→b*1 我要 {task}
```

或写 JSON 到 `~/.multiagent-chat/presets/my-workflow.json`：
```json
{
  "name": "my-workflow",
  "prompt": "我要 {task}",
  "stages": ["a", "b", "c"],
  "gates": ["after-a"],
  "loops": [{ "on": "c", "retryFrom": "b", "maxRetries": 1 }]
}
```

## 未来扩展点（P2/P3）

### 加新 IM transport（例：企微、Slack）
目前 `im-lark` 是紧耦合的参考实现。抽象 `IMTransport` 接口后，可以：
```
packages/im-wecom/    # 企微 SDK + 同样的 handlers/cards 结构
```
需要重构 monitor/notifier 用抽象接口（P2 任务）。

### 加新 host controller（例：Linux tmux via SSH）
目前 `host-mac` 用 AppleScript。抽象 `HostController` 接口后：
```
packages/host-tmux-ssh/    # ssh + tmux 命令
```
需要在 orchestrator 里把"tab"概念抽象成"session"。

## 提交规范

- Commit message 用 imperative（"add X" 而不是 "added X"）
- 主 subject ≤ 50 字，body 详细解释
- 大改动分多 commit，每个 commit typecheck 都过
- 用一致的前缀：
  - `feat:` 新功能
  - `fix:` bug 修复
  - `refactor:` 重构
  - `docs:` 只改文档
  - `test:` 只加测试
  - `phase X:` monorepo 演进等阶段性改动

## 测试

目前**没有正式测试套件**。所有验证靠：
1. `pnpm typecheck` — 类型层保障
2. 手动烟测：起 dev，模拟真实交互
3. 直接 socket 测（`node` + `net.connect` 到 `~/.multiagent-chat/agent.sock`）

计划中：给 orchestrator（纯逻辑）加单元测试，尤其状态机 markStageXxx 的完整生命周期。欢迎 PR。

## 安全

- **不要提交 `.env`**（已 gitignore）
- **不要 log secrets**（LARK_APP_SECRET 等）
- **不要给 subagent Bash 权限做危险操作**（rm -rf / git push --force / SQL DELETE）除非明确需要
- 高风险操作走 `agent request-approval` 走飞书审批

## 报 bug / 提 issue

（若已开源）目前跟踪：GitHub Issues

若还是私有开发阶段：直接找 owner 说话。

## 代码风格

- TypeScript 严格模式（`strict: true`），主要项目已经在这个基线
- `noUncheckedIndexedAccess: true` — 索引访问都是 `T | undefined`
- 不要抑制类型错误（不用 `@ts-ignore` / `any`）除非有真好的理由
- 中文注释 OK，中英文混也 OK；变量名/函数名英文
- 用现有 logger（`import { logger } from 'multiagent-orchestrator'`）而非 console.log

## License

[MIT](LICENSE) — 贡献代码默认按 MIT 授权。
