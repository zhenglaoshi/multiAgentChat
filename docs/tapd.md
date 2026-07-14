# TAPD Bug 自动监听与认领

> 监听 TAPD 上「指派给我、当天更新、未结束」的缺陷/需求 → 飞书推卡 → 一键认领 →
> 多选涉及的 repo → 切分支 → 开一个 claude tab 注入上下文 → claude 跨 repo 修复 →
> 审批后用 MCP 回写 TAPD 状态。

## 一句话架构

- **检测（监听）**：daemon 每 5min 直连公司 **TAPD MCP 网关**（streamable-http + Bearer token）拉数据 —— 纯 HTTP，**不经 claude/LLM/CLI**，确定、快、可高频。
- **交互（修复时）**：认领开的工作 tab 里的 claude 配了同一个 MCP（`mcp__tapd__*`），能读详情 / 改状态 / 加评论。
- 两者共用一个 API token。

## 配置（`.env`，gitignored）

```bash
TAPD_MCP_URL=https://mcp.xxx.com/servers/<id>/mcp   # 公司 TAPD MCP 网关
TAPD_MCP_TOKEN=<Bearer JWT>                          # 勿入库
TAPD_NICK=你的TAPD昵称                                # 如「郑纪泉」——current_owner 过滤用
                                                     # 注意：token 里的 email 不会自动解析成 nick
# 可选：
TAPD_WORKSPACE_IDS=111,222   # 只监听这些项目；空=自动发现我参与的全部
TAPD_SYSTEMS=bug,story       # 监听类型，默认 bug+需求；只要 bug 设 =bug
TAPD_POLL_MS=300000          # 轮询间隔，默认 5min，最小 1min
```

缺 `TAPD_MCP_URL / TOKEN / NICK` 任一 → 不启用（daemon 日志 `tapd watcher 未启用`）。

**P3 · claude 端 MCP 注册**：daemon 启动会幂等把 TAPD MCP 注册到 Claude Code（user scope，
所有会话可用），无需手动。手动注册/重注册（token 轮换后）：

```bash
claude mcp remove tapd -s user
claude mcp add --transport http tapd "$TAPD_MCP_URL" --header "Authorization: Bearer $TAPD_MCP_TOKEN" -s user
claude mcp get tapd     # 应 ✔ Connected
```

## 完整流程

```
1. 检测   daemon tapd-watcher 每 5min：
          对每个项目 × 每类型(bug/story)：
            - 拉 current_owner(bug)/owner(story)=我、modified=今天~今天(北京)的项
            - 用 workflows-last-steps 拿"结束状态"，status 在其中的跳过（只留未结束）
          对没通知过/又更新了的（data/tapd/seen.json 去重，key=id，modified 变化会再通知）
2. 通知   推飞书差异化卡：缺陷=橙(致命/严重升红)，需求=蓝
          按钮：[🌿 认领并建分支] [🔗 打开 TAPD] [🙈 忽略]
3. 认领   点认领 → 拉 bug 详情 → 弹 repo 多选卡
          候选 repo = /pin 书签 + 最近用过的 cwd；点按钮打勾（可多选，卡片原地 patch）
4. 脏检查 点[🚀 建分支并开工]→ 先查每个选中 repo 工作区：
            全干净 → 直接切
            有脏的 → 弹策略卡（只作用于脏 repo）：
              📦 暂存后切 stash  → git stash -u 再切，WIP 可 git stash pop 恢复
              🌿 worktree 隔离   → 新目录 <repo>-<分支> 切，当前工作区+WIP 完全不动
              ➡️ 照切带过去      → WIP 跟到 bug 分支
              ⏭ 跳过脏 repo      → 只切干净的
5. 切分支 每个选中 repo 切同名分支：缺陷 fix_<id后6>，需求 feat_<id后6>
          （从各自当前 HEAD；分支已存在则直接 checkout）
6. 开工   开【一个】claude tab（cwd=主 repo，或 worktree 路径），自动过 trust 弹窗，
          注入上下文：标题 / TAPD 链接 / 涉及的所有 repo(都在同名分支) / 描述(去 HTML)
          claude 在这一个会话里跨 repo 干活（cd / git -C），各自提交(commit 带 TAPD #id)
7. 回写   修完 → claude 先 agent request-approval 征得你同意 → 用 tapd MCP 把 #id
          流转到「已解决」+ 加评论回填 commit/PR 链接（改状态前先查 workflows-status-map）
```

## 需求走 SOP，缺陷走普通任务

认领开工时按类型选执行模式（repo 选择卡上可切换）：

- **需求(story)** → 默认 **SOP 编排**：`Explore → 需求分析 → 架构 →〔after-architect 审批 gate〕→ 编码 → 测试 → 回归`
  （`DEFAULT_SDLC_STAGES`）。gate 让你在飞书先审设计再编码；需求分析阶段可用 MCP 读 TAPD 需求+评论澄清。
  会发一张实时 stage 进度卡。
- **缺陷(bug)** → 默认 **普通任务**：直接把上下文注入 claude 让它定位修复（多数 bug 局部改动，全 SDLC 太重）。
- **可覆盖**：repo 多选卡上有「切成 SOP / 切成直接修」按钮，小需求可切直接修、复杂 bug 可切 SOP。

## 图片 & 评论（靠工作 tab 里的 MCP）

TAPD 的描述/评论是 HTML，可能含图片，且**评论里常有需求变更/补充/复现细节**。处理方式：

- **图片**：注入的描述保留图片引用为 `[图片:src]` 标记（不 strip 丢弃）。claude 用
  `mcp__tapd__tapd-get-image`（传该 url/路径）拿下载链接（300s 有效）下载后用 Read 查看，
  或 `tapd-get-entity-attachments` 看附件。
- **评论**：注入的 prompt **强制要求 claude 先用 `mcp__tapd__tapd-get-comments` 拉评论**
  （带 workspace_id + id）—— 别只看描述，需求变更常在评论里。

即：daemon 只注入"标题 + 链接 + repo + 描述(保留图片标记)"作为起点；完整的图片/评论由
claude 在工作 tab 里通过 MCP 自取（P3 已把 MCP 配好）。

## 为什么"一个 tab 多选 repo"（多 repo bug）

一个 claude 会话**不受 cwd 束缚** —— 能 `cd` / `git -C` 跨 repo 改文件、提交。所以一个 tab
完全能处理跨 repo 的 bug，而且**应该**：跨 repo 的修复（如后端改接口 + 前端改调用）需要
**一个大脑同时看到两边**协调；N 个独立 claude 会话无法共享上下文。分支名跨 repo 一致，
提交都引用同一 TAPD id。

## 数据 & 代码

- 运行时数据：`data/tapd/seen.json`（去重）、`data/tapd/claims/<id>.json`（认领进行态）
- 代码：
  - `packages/orchestrator/src/tapd/` — `client.ts`(HTTP MCP 客户端,429 退避) / `config.ts` /
    `query.ts`(拉取+过滤+归一化,缓存项目&终态) / `store.ts`(seen) / `claims.ts`(认领态) /
    `mcp-setup.ts`(注册 claude MCP) / `types.ts`
  - `packages/im-lark/src/monitor/tapd-watcher.ts` — 轮询循环 + 推卡
  - `packages/im-lark/src/lark/cards.ts` — `tapdItemCard` / `tapdRepoPickerCard` / `tapdDirtyCard`
  - `packages/im-lark/src/lark/handlers.ts` — card actions：`tapd-claim` / `tapd-pick-repo` /
    `tapd-claim-go` / `tapd-go-strategy` / `tapd-ignore`
  - `packages/host-mac/src/git.ts` — `gitWorkingState` / `gitCheckoutBranch` / `gitStashPush` /
    `gitAddWorktree` / `prepareBugBranch`(按脏策略切分支)

## MCP 工具（网关暴露 43 个，常用）

- 查：`tapd-get-bug` / `tapd-get-bug-count` / `tapd-get-stories-or-tasks` / `tapd-get-todo`
- 改：`tapd-update-bug` / `tapd-create-comments` / `tapd-get-workflows-status-map`（改状态先查英文名）
- 关联：`tapd-get-commit-msg`（拿"源码提交关键字"把 commit 关联到缺陷）
- 身份：`tapd-get-user-participant-projects`（需 nick）

**信封坑**：不同工具返回信封形状不一 —— `get-bug-count` 是 `{status,data,info}`，`get-bug`(列表)
是 `{base_url,data}`（无 status）。客户端仅在 status 存在且 !=1 时报错。

**处理人字段坑**：缺陷用 `current_owner`，**需求用 `owner`** —— 传错 TAPD 会忽略过滤、返回全部人的项。

## 排错

- **watcher 未启用**：查 `.env` 三个必填项；daemon 日志 `tapd watcher 未启用`。
- **返回空 / 全部人的项**：nick 必须是 TAPD **显示名**（不是 email 前缀）；需求过滤字段是 `owner`。
- **429 Too Many Requests**：轮询太密或短时打太多。已加项目/终态缓存 + 429 退避重试；
  可调大 `TAPD_POLL_MS`。
- **claude 里没 TAPD 工具**：`claude mcp get tapd` 看是否 Connected；不在就手动 `claude mcp add`（见上）。
- **时间过滤**：TAPD 不支持 `>=`，时间用范围 `起~止`（本项目用 `今天~今天`）。

## 相关

- [features.md](features.md) · [commands.md](commands.md) · [knowledge.md](knowledge.md)
- [team-knowledge-base.md](team-knowledge-base.md)（团队知识库方案，草案）
