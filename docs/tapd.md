# TAPD Bug 自动监听与认领

> 监听 TAPD 上「指派给我、当天更新、未结束」的缺陷/需求 → 飞书推卡 → 一键认领 →
> 多选涉及的 repo → 切分支 → 开一个 claude tab 注入上下文 → claude 跨 repo 修复 →
> 审批后用 MCP 回写 TAPD 状态。

## 能力总览

- **监听**：每 5min 拉「我的·当天更新·未结束」缺陷+需求，去重推卡；差异化卡（缺陷橙/红·需求蓝）+ 描述摘要
- **卡动作**：认领并建分支 / 打开 TAPD / 🕐稍后(snooze 3h) / 🙈不是我的(永久)
- **主动查询**：飞书 `/tapd` 列我全部未结束项
- **认领**：多选涉及的 repo（候选 = /pin 书签 + 最近 cwd + 全机 git 仓库索引，新人装完即有）
- **一键认领**：记住每个项目上次的 repo/基准/模式，下次自动预选
- **分支基准**：当前分支直接改（测试 bug）/ 从 HEAD / 从 master / 从 develop（线上 bug）
- **脏工作区策略卡**：stash / worktree 隔离 / 照切 / 跳过（⚠ **已成遗留展示**：worktree 隔离模式下共享 repo 不被触碰，`tapd-go-strategy` 选项不影响结果，一律走 `prepareTaskWorkspace`）
- **执行模式**：需求→SOP 编排（含 after-architect 审批 gate）/ 缺陷→普通任务，可互切
- **一个 tab 多 repo**：跨 repo bug 一个 claude 会话协调，分支名一致
- **上下文注入**：标题 + TAPD 链接 + 各 repo 工作分支 + 描述(保留图片标记) + 指引用 MCP 看评论/图片
- **修复约束**：本地验证、严禁连线上库/生产、不确定弹 `agent lark ask`、状态改动经审批
- **回写**：审批后用 MCP 把状态流转到已解决 + 评论回填 commit/PR
- **生命周期卡**：认领→修复中→验证中→待审批→已解决，claude 用 `agent tapd stage` 上报，卡随进度更新
- **企业微信**：通知 + 单 repo 简化认领（多 repo/SOP/脏策略富交互走飞书）

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
          按钮：[🌿 认领并建分支] [🔗 打开 TAPD] [🕐 稍后] [🙈 不是我的]
3. 认领   点认领 → 拉 bug 详情 → 弹 repo 多选卡
          候选 repo = /pin 书签 + 最近用过的 cwd + 全机 git 仓库索引(dir-index，自带后台刷新，新人装完即有)；点按钮打勾(可多选，卡片原地 patch)
          卡上还有 [🏷 类型]（三选一，见下）/ [🔁 基准]（HEAD/master/develop/当前分支）/ [切成 SOP/直接修]
3b.类型   [🏷 类型] 三选一（决定工作目录策略，与 SOP/直接修 正交）：
            🐞 线上bug(fix)  → 建 ~/ihealth-work/fix_<id6>/ 隔离目录（worktree）
            ✨ 新需求(feature) → 建 ~/ihealth-work/feature_<id6>/ 隔离目录（worktree）
            🔧 开发中(indev)  → 各 repo 当前分支原地改，不建目录
          缺省由 base/sop 派生（base=当前分支→indev，否则 缺陷→fix / 需求→feature）
4. 建目录 点[🚀 建分支并开工] → 按类型准备工作区（prepareTaskWorkspace）：
            fix/feature → <TASK_WORKROOT 默认 ~/ihealth-work>/<fix|feature>_<id6>/ 下，
                          每个选中 repo 用 **git worktree**（本地有源，秒建省盘，**共享 repo 纹丝不动**）
                          或 clone（本地无源）拉进子目录，切 fix_/feat_<id6> 分支
            indev       → 各 repo 当前分支原地改（不建目录，分支报告准确）
          ★ worktree 模式下共享 repo 不被触碰 → 不再需要脏工作区 stash/carry 策略
5. 记录   saveWorkTask 落一条 目录↔分支↔干啥↔来源 记录 → `/worktasks`（`/wt`）可列/搜/[📂 打开]
6. 开工   开【一个】claude tab（cwd=worktree 主 repo 目录，或 indev 的原 repo），自动过 trust 弹窗，
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

## 分支基准（两种 bug）

认领卡上「🔁 基准」按钮循环切换（作用于所有选中 repo）：

- **当前分支直接改（不建新分支）** — 测试阶段提的 bug：基于被测的功能分支直接改，不切新分支
  （脏工作区是预期的，跳过脏策略卡）。
- **从当前 HEAD 切**（默认）— 从各 repo 当前分支切 `fix_<id>`/`feat_<id>`。
- **从 master 切** / **从 develop 切** — 线上 bug hotfix：从主干切新分支（本地没有则自动退 `origin/<base>`）。

（这几种和上面的脏工作区策略正交：只有"切新分支"时才会走脏策略卡。）

## 生命周期进度卡（A）

认领开工后，飞书会有一张**生命周期卡**随进度更新：`认领 → 修复中 → 验证中 → 待审批回写 → 已解决`
（当前阶段高亮）。工作 tab 里的 claude 在阶段变化时上报，daemon 收到就 patch 这张卡：

```bash
agent tapd stage fixing            --claim <id>   # 开始修
agent tapd stage verifying         --claim <id>   # 本地验证中
agent tapd stage awaiting-approval --claim <id>   # 等你审批回写
agent tapd stage resolved          --claim <id>   # 已回写 TAPD
agent tapd stage failed --claim <id> --note "原因" # 卡住/需要你
```

注入的 prompt 已带这些指令（含本 claim 的 id），claude 会自动上报。飞书用 patch 原地更新；
企微不能 patch → 改用发一条进度文本。

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
    `query.ts`(拉取+过滤+归一化,缓存项目&终态&状态中文名 statusMap) / `store.ts`(seen +
    **通知分级** `classifyNotificationsPure`) / `claims.ts`(认领态) /
    `mcp-setup.ts`(注册 claude MCP) / `types.ts`
  - `packages/im-lark/src/monitor/tapd-watcher.ts` — 轮询循环 + 按分级推卡（`TAPD_SPLIT_NOTIFY=0` 回退旧行为）
  - `packages/im-lark/src/lark/cards.ts` — `tapdItemCard`(认领卡) / `tapdInfoCard`(轻量提示卡) / `tapdRepoPickerCard` / `tapdDirtyCard`

  **通知分级（降噪）**：`classifyNotifications` 按 `seen.json` 把每条待推分成三级——
  `claim`(首次成为我的≈被指派→认领卡) / `status`(已知项状态变→提示卡「旧→新」) /
  `update`(已知项其它内容变→提示卡「内容有改动」)。
  ⚠️ 边界：「首次=被指派」是**近似**（网关无变更历史/操作者 API，见下）——`seen.json` 被删/损坏
  （`loadSeen` catch 静默返回 `{}`）或某条老任务第一次被「当天更新」窗口捞到，都会误判为 `claim`
  弹一次认领卡。可接受折衷；排查「老任务怎么又弹认领卡」时看这里。企微侧同样分级（daemon
  `onExtraNotify` 消费 `kind`：claim 推认领卡、status/update 推轻量文本）。
  - `packages/im-lark/src/lark/handlers.ts` — card actions：`tapd-claim` / `tapd-pick-repo` /
    `tapd-cycle-kind`(🏷类型三选一 fix/feature/indev) / `tapd-toggle-sop` / `tapd-cycle-base` /
    `tapd-claim-go` / `tapd-go-strategy`(脏策略，worktree 模式下 no-op) / `tapd-snooze` / `tapd-not-mine` / `tapd-ignore`；
    `finalizeTapdClaim` 开工
  - `packages/host-mac/src/task-workspace.ts` — **主机制**：`prepareTaskWorkspace`(建 worktree 隔离目录) / `taskWorkroot` / `taskDirName` / `taskBranchName`
  - `packages/host-mac/src/git.ts` — `gitWorkingState` / `useCurrentBranch`(indev 原地改) / `prepareBugBranch`(**旧脏策略路径，worktree 模式下已停用、无调用方**)

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

## 修复后的验证与回写（注入 prompt 强约束）

claim 注入给 claude 的完成流程（缺陷普通任务 & 需求 SOP 都适用；SOP 另有 tester/regression 阶段）：

1. 各 repo 改完提交（commit 带 `TAPD #id`）。
2. **本地验证**：跑单测 / 本地复现确认修好、无回归。
   - ⚠️ 验证**只能本地/测试环境，严禁连线上数据库/生产环境**；涉及线上数据、生产库、写操作、
     部署一律先 `agent request-approval`。（注：这是 prompt 级强约束，非 OS 级硬拦截；需要硬拦截可在
     `bin/mchat-pretooluse-hook` 里按你们生产库 host/连接串加正则 block。）
3. **不确定就问**：无法复现 / 多种改法 / 需求不清 / 影响面拿不准 → `agent lark ask` 问用户再继续。
4. 验证通过 → **先 `agent request-approval` 批准** → 再用 tapd MCP 流转状态到「已解决」+ 评论回填 commit/PR。
   —— 状态**不会自动改**，永远经你批准。

## 企业微信支持

TAPD 对接同时支持企微（配了 WECOM_* 才生效）：

- **通知**：watcher 除推飞书外，也把 bug/需求卡推到企微（发 `WECOM_DEFAULT_TO_USER`）。
  企微卡为 CardSpec（button_interaction），TAPD 链接在正文（企微按钮不支持 url）。
- **认领（简化流）**：企微卡没有原地 patch / checkbox toggle，故认领是**单 repo（最近使用目录）
  + 按钮选基准（当前分支/HEAD/develop/master）+ 普通任务直接修**。
  **多 repo / 需求 SOP / 脏工作区策略** 这些富交互 → 请用飞书认领。
- 修复时工作 tab 里的 claude 用 `agent wecom send-text / ask` 回推企微（`buildTapdPrompt` 的 `im` 参数）。

企微侧 card-action 走 daemon 的 `attachWeComCardActionRouter`（`tapd-claim` / `tapd-go-wecom` / `tapd-ignore`）。
