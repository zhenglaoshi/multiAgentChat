# 更新日志 / Changelog

本项目所有值得注意的变更都记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/)，按日期倒序。

> **维护约定**：每次功能 / 修复 / 文档改动，在顶部「未发布」区对应日期下追加一条（分 `新增` / `修复` / `文档` / `改动`）。发版时把「未发布」整块归档到一个版本号下并打 tag。

## [未发布]

### 2026-07-20

**改动**
- **TAPD 限流治理：全局 429 熔断 + 降频**。原来每个 tick 对每 workspace×类型跑 endStates+多 owner 字段查询(几十个请求)，撞 429 后每个调用还各自本地重试 2 次 → 越打越死(实测 daemon 起来后 39 次 429、0 成功)。改为：① `client.ts` 加**模块级全局限流熔断**(circuit breaker)——任一调用撞 429 就开冷却窗口(指数退避 30s→60s→…封顶 5min)，窗口内所有 TAPD 调用直接快速失败、不打网络，成功一次即清零；去掉原来的本地 429 重试(改由熔断+下一轮轮询自然重试)。新增 `tapdCooldownLeftMs()` 供上层观测。② `tapd-watcher` tick 前置守卫：冷却期整轮跳过(不刷 warn)。③ 轮询默认间隔 `config.ts` 5min→15min(`.env` 若显式设了 `TAPD_POLL_MS` 仍以 .env 为准)。熔断 + 主动查(`/tapd`)+ 改状态查工作流全受益。

**修复**
- **缺陷(bug)「🔄 改状态」被"缺需求类别 id"一刀切拦掉**：改状态先查工作流可流转状态(`tapd-get-workflows-all-transitions`)，原实现无论缺陷/需求都硬要 `workitem_type_id`，但 `workitem_type_id`(需求类别) 是**需求(story) 独有概念**，缺陷(bug) 走按项目的工作流、返回里根本没这字段 → 点缺陷改状态必报"这条缺需求类别 id，去 TAPD 网页改"。修复：① `buildStatusPickCard` 守卫改成只对 `sys!=='bug'` 才要求 `wt`；② `listStatusTransitions` 的 `workitemTypeId` 改可选，仅 story 且有值时才塞进 `options.workitem_type_id`，bug 不传。（`im-lark/lark/tapd-flow.ts` + `orchestrator/tapd/tasks-api.ts`）⚠ 当前 TAPD MCP 被限流(429)，typecheck 通过但**待限流缓解真机验缺陷改状态链路**。

**文档**
- **`/help` 补全 `/tapd` 子命令**：help 里 `/tapd` 只写了"列指派给我的未结束缺陷/需求"，漏了已上线的 `/tapd new <标题[ | 描述]>`（建任务级联卡）和列表卡「🔄 改状态」能力。补成两行，与 `/template`/`/task` 风格一致。（`commands.ts` HELP 文案）

### 2026-07-19

**新增**
- **TAPD 建任务命令 + 列表（带状态变更）级联卡**：`/tapd new <标题[ | 描述]>` 弹级联卡 —— 选项目（`select_static` 下拉，`tapd-get-user-participant-projects` 过滤 organization）→ 选需求类别（`tapd-get-workitem-types`）→ 建需求（`tapd-create-story-or-task`，entity_type=stories，**创建人/开发负责人自动取 `TAPD_NICK`**）→ 成功卡带「🔗打开 TAPD」+「📋我的 TAPD」。`/tapd`（原 text 版）升级成**列表卡**：每条带「🔄改状态」→ 拉工作流可流转状态（`tapd-get-workflows-all-transitions`，需 `workitem_type_id`——已在列表查询 `STORY_FIELDS/BUG_FIELDS` + `TapdItem.workitemTypeId` 补上）→ 选目标状态 → `tapd-update-story-or-task`（`v_status` 传中文名）→ 回执。级联卡全 `update_multi:true` + cardAction 一律 `return {}`（不 toast 避免盖 patch），重活 fire-and-forget patch/send。（新 `orchestrator/tapd/tasks-api.ts` + `im-lark/lark/tapd-flow.ts` 草稿状态机 + `cards.ts` 4 张卡 + `commands.ts`/`handlers.ts` 路由）。⚠ TAPD MCP 服务端当前 degraded（Tool not found），代码 typecheck 通过但**待服务端恢复真机验证**。
- **进度卡标题加当前文件夹（一眼看出"在哪执行"）**：`progressCard` 标题原来只有 `⏳ 执行中 · ttys000 · 任务`，cwd 只在底部灰字 metaLine 的完整长路径里、易被输出代码块淹没 → 用户"还是不知道在哪执行"。现在标题插入文件夹 basename：`⏳ 执行中 · ttys000 · 📁multiAgentChat · 任务…`（完整路径仍保留在底部灰字）。（`cards.ts progressCard` folderTag）
- **gated-tab 消息队列（卡在审批时排队，审批完自动继续）**：以前给一个"SOP 卡在 gate 等审批"的 tab 发消息，claude 被阻塞、消息静默丢失 → 以为系统坏了。现在 `dispatchSendToTab` 检测目标 tab 有 `awaiting-gate` 的 SOP → **把消息排队**（per-tty FIFO，上限 10）+ **重推待审批卡**（`buildApprovalCard`：gate 走 stageGateCard）+ 回执"⏸ 正卡 gate 等审批，已排队，审批+当前任务跑完后自动执行"。任务 `done`/`failed`（tab 真空闲）时 `flushGatedQueue` **按序自动重发**排队消息（每条间隔 1.5s，带"▶️ 队列继续"提示）。flush 触发用 `task:done/failed`（非 gate-resolve，因为审批后 SOP 可能还有 stage）。（`handlers.ts` 队列 + `notifier` task 事件接线 + `cards.ts` 抽出 `buildApprovalCard` 供复用）

**修复**
- **`/run --sop` spawn 新 tab 时 claude 回"收到一条空消息"**（真根因）：用户不在 Terminal 时 SOP 会 spawn 新 tab，但那段用**原始 `send('claude')`**起 claude（**不过 trust 弹窗**），且盲等固定 8s 就发 SOP wrapper。新目录首启时"信任此文件夹?"弹窗把 wrapper 吃掉 → claude 只收到空回车 → 回"收到一条空消息"。修复：① 改用 `launchClaudeInTab`（双 forceEnter 过 trust，与 TAPD 认领开工流程对齐）；② 用**轮询 claude 进程出现**判就绪（`hasTUI` 只认 vim/htop 不认 claude，不能用）+ 2.5s settle 再发；③ claude 迟迟不就绪（卡 trust/登录）→ **不发 wrapper**，回执提示手动看 tab，避免空注入。
- **切 tab"有时"仍无卡反馈（缺 update_multi 的真根因）**：上一版把 use-tab 改成 patch fire-and-forget + `return {}` 是必要但不够——`/shells` 的 `tabsCard`（及 `waitingInputCard`/`originShellPushCard`/`progressCard`）**config 缺 `update_multi: true`**，这些是"被点击多次、每次 patch"的交互卡，缺它则 patchCard **视觉不生效**（API 返 code 0 但卡不变），表现为"点了切过去了（`/where` 可证）但卡没回执"。**给这 4 张带点击按钮的卡补 `update_multi: true`**。
- **SOP stage 名大小写敏感导致协议失效**（日志实锤：主 claude 上报 `explore` 但默认 stage 是 `Explore` → `markStageStart` "stage not found" → 进度卡/loop/gate 对该 stage 全断）。LLM 大小写不一致是常态 → **stage 名匹配全部改大小写不敏感**（新 `eqStage`）：`findStageIdx`/`markStageEnd`/`markStageRetry`/`markStageSkipped`/loop 规则/`stage-auto`/gate/artifact schema lookup 全覆盖。
- **空消息注入 tab（tab 里的 claude 回"收到的消息是空的没内容"刷屏）**：只发了 `@目标`、图片没配文字、或内容被 @提及/mention strip 成空时，`dispatchSendToTab` 仍会注入 `[本次任务]\n(空)` → tab 里的 claude（尤其 careyclaw 等交互式）收到空输入就反复回"收到空消息 + 要继续告诉我下一步"。**在 `dispatchSendToTab` 入口加空内容防护**（所有飞书→tab 注入的中心汇聚点）：`!text.trim()` → 不注入 + 回执"⚠️ 消息内容为空，没发送（是不是只发了 @目标/图片没配文字）"，覆盖 ask-answer/sticky/active/named/chain/batch 全部路径。
- **卡片点击"没反应"（一整类 toast 盖 patch bug）**：`/shells` 切 tab（`use-tab`）等**一整类 card action** 违反了 CLAUDE.md 铁律——`await patchCard(...)` 后又 `return { toast }`，飞书把卡当"已处理无更新"、盖掉 patch → 卡不刷新、**点了像没反应**。用户因此切 active tab 看不到反馈 → 不确定切到哪 → 后续消息发错 shell。**统一改成 patch fire-and-forget + `return {}`（10 个 handler）**：`use-tab` / `send-to-tab` / `send-to-tab-arm` / `arm-active-reply` / send-answer / `connect-apply`·`connect-cancel`·`connect-disable/enable` / `perf-snooze`·`perf-not-mine` / `tapd-ignore`·`tapd-snooze`·`tapd-not-mine`。
- **active tab 被删后消息误路由**：派发到 active tab 时若 `activeTty` 指向已关闭/删除的 tab，现在**清掉失效 activeTty** 并提示"已清除，用 `/shells` 重选"（此前只报"已不存在"、stale tty 残留，易让后续消息继续发向死 shell）。

**新增**
- **SOP loop 根因诊断 + 不收敛保护（可靠性#6）**：把失败回环从"盲重试"升级成"带诊断针对性修 + 修不好叫人"。
  - **诊断带进重试**：loop 触发时 `loopback` 响应带上 `diagnosis`（`--fail --note` 的根因）；CLI 提醒主 claude **务必把诊断带进重跑 subagent 的 prompt**，别盲改。wrapper prompt 要求 `--fail --note` 写清根因（哪个用例/期望 vs 实际/疑似原因）。
  - **不收敛保护**：重试**耗尽**时不再静默标 failed，而是**弹飞书 gate 问"再试一次吗"**（复用 approval，阻塞等）：批准 → `markStageRetry(force)` 突破 maxRetries 再回环一次（`loopback.forced=true`）；拒绝/超时 → 任务终止。（`markStageRetry` 加 `force` + server fail 分支 + `loopback.diagnosis/forced` + cli + sop-prompt）
- **SOP 编排决策可观测 + 轻否决（可靠性#1）**：主 claude 的"跑哪些 stage / skip 哪些"决策原来不可见（执行才知道），现在开工前必过一道**计划确认**。
  - 新增 `agent task plan-review --task-id X`（op `task.planReview`）：server 从 task 的 stage 状态**自动生成**计划（将跑 + 跳过·含原因）→ 复用 approval 机制推飞书审批卡，短超时（默认 45s）可否决。**批准/超时 → `proceed`（开工）；拒绝 → `adjust`（主 agent 重新规划 skip，可 `agent lark ask` 问用户想跑什么）**。
  - SOP wrapper prompt 加"第二步：计划确认"（skip 定完、开工前调一次），把编排决策本身也变可观测/可干预。（`protocol task.planReview` + `server handleTaskPlanReview` + `cli plan-review` + `sop-prompt`）
- **SOP artifact 骨架 schema（可靠性#4）**：让"文件 handoff"可验证 —— 每个 SDLC stage 的 artifact 定必填 section（`orchestrator/tasks/artifact-schema.ts`：需求=目标/非目标/验收标准/开放问题，架构=受影响文件/接口·数据流/风险，测试=覆盖/结果，回归=验收核对/结论）。
  - `--end --artifact` 时 server 灵活校验（含任一 alias 即命中，**中英通吃、大小写不敏感**）→ 结果放 `artifactCheck`，CLI 在 stderr 提醒缺哪些 section（**不硬 block**，避免 heading 措辞差异死锁；自定义 stage 无 schema 直接放行）。
  - SOP wrapper prompt 的 stage 列表显示每个 stage 的 `[artifact 骨架: ...]`，并要求 subagent 按骨架写全。单元验证：缺 section 报缺、中英齐全均 ok、无 schema 放行。（`checkArtifact`/`artifactSkeletonHint` + server `--end` 校验 + `TaskStageData.artifactCheck` + CLI surface + sop-prompt）
- **SOP 阶段协议框架强制化（可靠性#2）**：把"主 claude 自觉调 `agent task stage --start`"改成"框架自动打点"，治 SOP 最脆的单点（LLM 长 prompt 会忘打点 → 进度卡/loop/gate 起点失同步）。
  - **Task 工具 PreToolUse hook**（`bin/mchat-task-hook`）：主 agent 每次 `Task(subagent_type=X)` 前，hook 反查本 tab 的 active SOP task，若 X 是它的 **pending** stage → 自动 `markStageStart`（幂等；非 SOP tab / ad-hoc Task 静默忽略）。daemon 幂等 upsert 到 `~/.claude/settings.json` 的 `PreToolUse` matcher=`Task`。
  - **隐式收尾兜底**：`markStageStart` 里，若有更早的 stage 仍 `running`（主 agent 忘了 `--end`）→ **非 gate stage 自动标 done** 补同步；**gate stage 只告警不动**（不偷跳 gate，让卡上可见地卡住暴露问题）。correct 流程不触发。
  - `--end`/`--fail` 仍留主 claude 流程（要阻塞 gate + 驱动 loop）；`--start` 变防御纵深（hook 自动 + 主 agent 手动兜底，幂等）。
  - 新增 op `task.stageAuto` + CLI `agent task stage-auto`（仅 hook 用，socket 反查 tty→task）；SOP wrapper prompt 注明 --start 已自动。（`protocol`/`server handleTaskStageAuto`/`store markStageStart`/`cli`/`daemon installClaudeCodeHooks`）

### 2026-07-18

**文档**
- **全文档审计并修正**（4 并行 agent 逐条对照代码）：改掉 ~20 处文档与实现的出入。
  - **CLAUDE.md**：依赖方向纠正（原写反了 —— 实际 `orchestrator`(叶)←`host-mac`←`im-lark`←`framework`←`daemon`，`im-wecom`→framework+orchestrator，与 architecture.md 对齐）；结构树补全（orchestrator 加 `tapd/integrations/report`，host-mac 加 `restart.ts/git.ts/task-workspace.ts`，monitor 加 4 个 watcher）。
  - **feishu-commands.md**（改 manifest 重生成）：占位符 `{{key}}`/`{{1}}` → 单花括号 `{key}`/`{1}`（双花括号会展开失效）；`/history` 默认 50→60。
  - **Node 版本统一到 22**：`package.json` engines `>=20`→`>=22`、`doctor.ts` 检查 `>=20`→`>=22`（daemon 本就硬要求 22）；troubleshooting `nvm use 20`→`22`。
  - **tapd.md**：主机制改为 `task-workspace.ts` 的 `prepareTaskWorkspace`，`prepareBugBranch` 标「旧脏策略已停用」；card-action 补 `tapd-cycle-kind` 等；通知卡按钮修正（稍后/不是我的）；脏策略卡标注 worktree 模式下 no-op。
  - **perf-integration.md**：状态标语更新（P1+P2 已落地）；`REPOS_BASE_DIR`→`PERF_REPOS_BASE_DIR`。
  - **web-dashboard.md**：抓屏降采样已实现（sips→1200px JPEG）；History 60→100。**wecom-bot-setup.md**：删已实现项的"未做"（ask/approval/stophook/cardaction/doctor 均已做）。**troubleshooting.md**：权限 `im:message.send_as_bot`→`:`。
  - **codex-integration.md**：§2.2 标「C1 前快照」、§3.1 标「接口以 types.ts 为准」。**architecture.md**：DAG 补 im-wecom。**commands.md** + `cli.ts` printHelp：补 `agent lark ask form`。**features.md §17**：首启表补 `installCodexNotify`/`ensureIntegrationSkills`。

**新增**
- **Codex 对接 · C1 完成(AgentAdapter 抽象 + claude 消费端全接线)**：新建 `orchestrator/agents/` —— `AgentAdapter` 接口把"哪个编码 agent"的差异（进程识别 / 登录文案 / 启动·续接命令 / 内建 slash 白名单 / skill 目录 / 回传通道规格）收进一处；`claudeAdapter`（忠实还原现有散落值）+ `codexAdapter` + registry（`detectAgentFromProcs`/`getAgentAdapter`/`listAgentAdapters`）。**四个消费端全部接线，claude 行为 byte-identical（typecheck + `agent tabs` 实测双验证）**：
  - `host-mac/status.ts`：agent 识别 → `detectAgentFromProcs`；登录态 → `agent.loginPatterns`（删本地 `LOGIN_PATTERNS`）
  - `host-mac/restart.ts`：`isClaudeTab` → `detectAgentFromProcs`；启动命令 → `getAgentAdapter('claude').launchCommand`
  - `im-lark/commands.ts`：内建 slash 白名单 → `claudeAdapter.builtinSlashCommands`（单一真源）
  - 顺带认 codex tab（进程名 `codex`）。
- **装 codex CLI + 核对 codex adapter**：`npm i -g @openai/codex`（codex-cli 0.144.5，已 API key 登录）。`codex --help` 验证并修正 adapter：进程名 `codex`、续接 `codex resume --last`（原写 `resume`）、`login`/`exec` 子命令、config=`~/.codex/config.toml`。仅剩 `notify` payload 格式（argv JSON · `type=agent-turn-complete` · `last-assistant-message`）待 C2 真机 turn 验证（`unverified` 标记收窄至此）。
- **Codex 对接 · C2 核心(回传通道)**：alt-screen 下 codex 的响应推回飞书的通道（对标 claude Stop hook）——
  - **`bin/mchat-codex-notify`**（ESM，对标 `mchat-stop-hook`）：codex turn 结束以**单 argv 参数**传 JSON 调本脚本 → 按 `type=agent-turn-complete` 过滤 → 抽 `last-assistant-message` → fire-and-forget `agent lark send-text --auto`。防御式解析（argv 优先/stdin 兜底、字段名多候选、跳 `codex exec` headless、meta 过滤、长度降噪）；**抽不到消息时落原始 payload 到 `/tmp/mchat-codex-notify.log`** 供未验证期核对格式。冒烟测试通过。
  - **daemon `installCodexNotify()`**：幂等 upsert `notify = ["<脚本绝对路径>"]` 到 `~/.codex/config.toml`（顶层 key 插最前，合法 TOML；**非破坏**：已有别人的 notify 只告警不覆盖；写前备份 `.mchat.bak`）。实测已写入。
  - status.ts 状态标签用 `agent.kind` 参数化（claude 逐字不变，codex tab 显示"🤖 codex 跑着"/"🔐 codex 需要登录 → codex login"）。
  - ⏳ 仅剩：跑一次**真机 codex turn** 确认 notify payload 字段名/触发时机（需登录+token，本轮暂缓）→ 从日志核对后摘 `codexAdapter.unverified`。
- **Codex 对接 · C3(/connect 加 codex 项)**：codex 作为新的 **`agentType`** 对接（既非 env 型也非 skill 型）——「对接」=检测 CLI 装没装 / 登录没 / notify 钩子装没装 + 给下一步引导（`codexAgentStatus`/`codexNextStep`，`orchestrator/agents/codex-status.ts`）。就绪 = 三者全绿。
  - `/connect` 面板列出 codex（badge ✅就绪/⬜未就绪 + 待办明细），[📋 查看引导] 按钮把状态+下一步推飞书；
  - `agent connect codex` CLI（socket-free）打印三项状态 + 引导；
  - **实测**：`agent connect codex` → CLI✓（/…/codex）/ 登录✗（当前登出）/ notify✓ → "已装未登录：跑一次 codex login"。
  - 至此 Codex CLI 对接闭环：C1 抽象 + C2 回传通道 + C3 引导。剩 codex 登录后跑一轮验 notify payload。设计见 `docs/codex-integration.md`。

### 2026-07-17

**新增**
- **任务工作目录 Phase B2**：
  - **perf「认领并建需求」接目录隔离**：建完 TAPD 需求后，用 **story 后6位**建 `~/ihealth-work/fix_<story6>/` worktree 隔离目录（dir↔需求对齐）→ 开新 tab 在里面修（含需求链接、`fix_<story6>` 分支）→ 落 worktask 记录（source=perf）；本地无该 repo 源则回退 active tab。至此「perf→建需求→建目录→修」闭环打通。（`openTaskWorktreeTab` 助手 + `perf-claim-story`）
  - **TAPD 认领卡加「🏷 类型」三选一**：显式 fix(线上bug)/feature(新需求)/indev(开发中·原地改)，与 sop（SOP编排/直接修）**正交**；kind 决定目录策略（worktree 隔离 vs 原地），切类型时 base/sop 取合理默认、仍可微调。卡上显示将建的目录路径。派生兼容旧 claim（`resolveClaimKind`：base=current→indev，否则 sop?feature:fix）。（`TapdClaim.kind` + `tapd-cycle-kind` + `TAPD_KIND_LABEL`）
- **任务工作目录接线（Phase B1+B3）**：TAPD 认领现在真正用 `prepareTaskWorkspace` 建**独立隔离目录** —— 线上bug→`~/ihealth-work/fix_<id6>/`、新需求→`feature_<id6>/`，每个选中 repo 在目录下用 **git worktree**（本地有源，秒建省盘，共享 repo 纹丝不动）拉进来并切 `fix_/feat_<id6>` 分支；「当前分支直接改」= indev 保持原地改（分支报告准确、不建目录）。认领后 `saveWorkTask` 落**目录↔分支↔干啥**记录，结果卡显示 `📁 <taskDir>`。（`finalizeTapdClaim` 改用 `prepareTaskWorkspace` + `saveWorkTask`）
- **`/worktasks`（别名 `/wt`）命令 + 卡片「📂 打开」**：列/搜任务工作目录（按 标题/分支/repo/目录 关键词）→ 渲染成**交互卡**，每条带 **[📂 打开]**（`worktask-open`：在该任务的 worktree 目录开新 tab 并设为 active，多 repo 开主 repo 并列出其余；目录已被清理则提示）+ [🔗 TAPD] 链接。这样能直接「打开历史需求对应的目录」继续干。（`worktasksCard` + `worktask-open` handler + `getWorkTask`）
  - repo 源策略：本地有源→worktree（零维护，靠 dir-index 发现）；本地无源→clone（暂需 gitUrl，未映射则清晰报错）。团队化再叠「按 org 约定拼 gitUrl」。
  - ⏳ 未真机跑过一次完整认领（会开 tab + 建 worktree），待真实 TAPD 缺陷/需求验证；`/worktasks` 只读路径可即时验。
- **perf 建议「📋 认领并建需求」**：性能建议卡新增独立按钮，认领时先在 TAPD 建一条正式需求（**创建人 + 开发负责人 = 认领者**），再把上下文（含需求链接）派发到 active tab 修。走 Node 侧 `TapdMcpClient.callTool('tapd-create-story-or-task')`（复用 TAPD MCP url/token，不经 tab 里的 claude）；幂等（建过复用 `item.tapdStoryId` 不重建）；失败回执飞书、不阻塞（可退回「🔧 认领修复」不建需求）。目标可 env 覆盖（`PERF_TAPD_WORKSPACE_ID` / `PERF_TAPD_CATEGORY_ID` / `PERF_TAPD_CATEGORY`）。（`orchestrator/perf/tapd-story.ts` + `perfItemCard` 按钮 + handler `perf-claim-story`）
  - MCP 实测确认（workspace 36983849）：**「后端服务」是项目名本身**（非分类）；默认落「**数据库优化**」分类(id `1136983849001000190`，最契合 perf 慢查询/索引)；**priority_label 候选值是英文** High/Middle/Low（已改映射 P0→High/P1→Middle/P2→Low）；`需求类别` 仅 需求(`…045`)；`郑纪泉` 已确认是该项目成员（creator/developer 可用）。
  - ⏳ 尚未真机建过一条（创建是对外写操作，待用户授权后跑一条测试需求验证返回信封 storyId 抽取 + 分类/优先级落对）。

**文档**
- **Codex 对接方案** `docs/codex-integration.md`（设计草案，未动手）：把「支持 Codex」拆成两条正交轴——**agent 种类**（codex vs claude，便宜，抽 `AgentAdapter`）× **宿主形态**（Terminal.app TUI vs Electron GUI，昂贵，抽 `HostBackend`）。结论：**Codex CLI = 一等公民**（复用 host 层，~1-2 天，核心是 `mchat-codex-notify` 回传钩子对标 Stop hook + config.toml `notify`）；**Codex 桌面版 = 桥接到 CLI**（同账号，不驱动 GUI）+ 可选只读回传桥；完整 GUI 驱动记档不投机做。含 Claude 专属耦合点清单（status/restart/guidance/slash 白名单）+ 分阶段计划 C0-C4 + 待验证项。

### 2026-07-15

**新增**
- **「龙虾」= CareyClaw 触发映射**：SYSTEM_GUIDANCE 加一句，tab 里 claude 认「龙虾」= CareyClaw 平台 —— 说「龙虾有没有XX接口/怎么调/拿XX数据」触发 `careyclaw-apis`、「龙虾部署/发布应用」触发 `careyclaw-deploy`，首次授权链接自动 send-text 推给用户。
- **CareyClaw 调试密钥到期提醒 + 飞书更新**：`oct_dev_` 本地调试密钥刷新需短信（无法全自动）→ 折中做半自动：`/careyclaw` 查密钥状态；到期前 ≤2 天（含已过期）watcher 自动推飞书提醒卡（`careyclawKeyReminder`，每日去重）；卡上 [🔄更新密钥] → 飞书原生输入表单贴新密钥+到期日 → 存本项目 `.env`（`CAREYCLAW_DEV_KEY`/`_EXPIRES`）。刷新那步的短信在后台点，新密钥飞书贴回。（`orchestrator/integrations/careyclaw-key.ts`）
- **CareyClaw 平台(龙虾) 对接**：平台开发者能力 = 两个官方 Claude Code 技能——`careyclaw-apis`（检索业务 API/mock/真实试调/开发者指南）+ `careyclaw-deploy`（打包 zip→OBS→submit/update 发布）；共用浏览器 OAuth 授权，无需 .env 密钥。本项目做「skill 型对接」：daemon 启动幂等自动装这两个技能（缺失才装，同时写 `~/.claude/skills` 和 `~/.agents/skills` 兼容 Claude Code/Codex）；`/connect`/`agent connect` 加 careyclaw 项（状态=技能装没装，[安装] 一键下载）。业务人员飞书说「careyclaw 有没有查XX的接口」/「部署应用」→ 注入 tab → 已装技能的 claude 自动干 → 结果回飞书。（`orchestrator/integrations/skills.ts` + registry skillType）
- **首启飞书未对接的快速引导**（飞书是引导通道本身，故走本地）：① daemon 启动检测 `LARK_APP_ID/SECRET` 缺失 → 打醒目横幅提示 `./bin/agent connect lark`；② 新增 `agent connect [key]` CLI —— **socket-free、不依赖 daemon**，`agent connect` 列全部对接+状态，`agent connect lark` 交互式 readline 填 App ID/Secret → 写 `.env` → 提示重启。是 `/connect` 飞书卡的本地孪生（bootstrap 用）。
- **对接管理面板 `/connect`（面向业务人员）**：开发类对接（TAPD/性能平台/知识提炼/企微/Web面板/报告）默认不启，`/connect` 列出所有对接 + 三态（✅已启用/⏸已停用·配置保留/⬜未对接）+ 对应按钮 [对接]/[停用]/[启用]。
  - **对接**：弹**飞书原生输入表单卡**（schema 2.0 form+input）填 env → **确认卡**（密钥脱敏）→ 写入 `.env`（`upsertEnvKeys` 保留其余行）→ touch 重启（dotenv 重读生效）。
  - **停用/启用**：软开关——把 key 加到 `.env` 的 `MCHAT_DISABLED_INTEGRATIONS` 列表（**不动该对接自己的配置 env**），各 gate（tapd/perf/knowledge/wecom/web/report）启动时检查 `isIntegrationDisabled` → 停用不删配置、可随时一键启用。重启生效。
  - 注册表 `orchestrator/integrations`（registry + envfile 读写/状态/停用列表，均单测通过）。
- **任务工作目录地基（Phase A）**：`host-mac/task-workspace.ts` 的 `prepareTaskWorkspace({kind,id6,repos,base})` —— 线上bug建 `<TASK_WORKROOT>/fix_<id6>/`、新需求建 `feature_<id6>/`，每个 repo 用 **git worktree**（本地有源·秒建省盘）或 clone（无源）拉进子目录；开发中bug（indev）不建目录、在现有 repo 当前分支直接改。分支名保留 `fix_<id6>`/`feat_<id6>`。`orchestrator/worktasks` 记目录↔摘要映射（save/list/search）。env `TASK_WORKROOT`（默认 `~/ihealth-work`）。worktree 逻辑单测通过。（认领卡任务类型选择 + 候选搜索修复 + `/worktasks` 命令为 Phase B）
- **performance-platform 对接 P1（只读监听）** `PERF_*`：perf-watcher 轮询 `GET /api/recommendations?status=pending`（Basic auth）→ 按 target/优先级/归属过滤 + 去重 → 推飞书性能建议卡（根因+索引命令+改动文件+repo）；[🔧认领修复] 开 tab 注入上下文让 claude 修（验证严禁连生产库），[🕐稍后]/[🙈不是我的] 带回执。repo 由 codeChange.permalink / codeMatches / database→repos.json 解析。缺 PERF_API_URL/USER/PASS 不启。设计见 `docs/perf-integration.md`。（`orchestrator/perf/` + `im-lark/monitor/perf-watcher.ts` + `perfItemCard`）
- **A3 Planner（v1·方案丙）** `/plan <目标>`：`claude -p` headless 把目标分解成 2-6 步可执行计划（复用知识提炼器 spawn 范式，不泄漏飞书）→ 飞书计划卡列步骤 → 每步一个「▶ 派发」按钮，点哪步就把该步 prompt 发给建议的 tab（解析不到则 active tab），逐步执行不自动串。计划内存态存储。（`orchestrator/planner/` + `planCard` + handlers `/plan`/`plan-dispatch`）
- **飞书图文 → shell claude**：飞书发「截图 + 文字描述」→ 下载图片到 `data/inbound/`（绝对路径）→ 把路径+描述注入目标 tab 的 claude（多模态 `Read` 看图）。支持三种发法：富文本一条发(A) / 先图后文 90s 内配对(B) / 纯图直发让 claude 自己看(C)。需飞书应用开 `im:resource` 权限。（`lark/resource.ts` + `handlers.ts`）富文本解析 `parsePost` 自测 9/9。
- **企微图文 → shell claude**（对齐飞书，B/C 两法；企微无富文本）：入站 image 消息取 `MediaId` → `media/get` 下载 → 同一套 imgPrefix 注入。（`im-wecom` transport/api + daemon 配对逻辑）需企微配置 `WECOM_*` 才生效。
- 多问题表单卡 `agent lark ask form`（AskUserQuestion 的飞书替代）：一张飞书卡问多个问题，每题单/多选，任一题可开 `allowText` 自由输入。全固定选项渲染成一张卡铺完(A)；含 `allowText` 则向导式一次一题(B)，带「💬 打字回答」回流。答案结构化回 stdout。
- `single`/`multi` ask 打字兜底：用户直接打「裸数字 2 / 逗号 1,3 / 选项原文」也能回答，作为卡片点击丢包/限流时的解冻通道。

**修复**
- **TAPD 监听漏掉"我只是开发负责人"的需求**：需求查询原来只过滤 `owner`(处理人)，但实测「开发负责人」落在 `developer` 字段（`owner` 常为空）→ 漏报。现在每类型按多字段查询合并去重：需求 `owner,developer`、缺陷 `current_owner,de`（可 env `TAPD_STORY_OWNER_FIELDS`/`TAPD_BUG_OWNER_FIELDS` 覆盖）；处理人显示也回退到 developer/de。实测目标需求 1143702532001006634 已能命中。
- `agent lark ask --options` 选项含逗号被拆乱：现在 `--options` 也接受 JSON 数组（`[` 开头自动识别）→ `--options '["含,逗号的选项","选项2"]'` 一个 flag 安全搞定；SYSTEM_GUIDANCE / SKILL / 文档同步提示。
- 手机端进度卡「横杠太多」：`sanitizeTerminalOutput` 折叠 TUI 画的整行水平分隔线（`────`/`———` 边框，手机上占满屏）→ 归一成一条短 `───`、连续多条只留一条 + 折叠连续空行 + 去首尾。
- `card.action.trigger` 回调改回立即 `return {}`：此前 `return { toast }` 会让飞书把卡当"已处理无更新"，盖掉另发的 `patchCard` → 按钮标记不刷新。
- form 卡 `config` 加 `update_multi: true`：点击驱动的多次 patch 才在飞书端视觉生效。
- 回调 `value` 数字字段（q/i/to）用 `Number()` 强转：飞书可能回传字符串，直接当 number 会让 `Set.has` 判断失配。

**文档**
- `docs/features.md §14` 补 form 用法 + 交互卡三坑；`CLAUDE.md` 加「交互卡回调/多次更新」关键约定；SYSTEM_GUIDANCE 引导 tab 内 claude 多问题场景用 `ask form`。

### 2026-07-14

**新增**
- **TAPD Bug 自动监听与认领**全流程：MCP 客户端 + 当天待办查询 + 飞书/企微通知卡（缺陷橙·致命严重升红/需求蓝）+ 多选 repo 认领 + 分支基准可选（当前分支/HEAD/master/develop）+ 脏工作区策略卡 + 需求→SOP·缺陷→普通任务 + 工作 tab 配 TAPD MCP 改状态/评论（审批后）+ 生命周期卡 + `agent tapd stage` 上报 + workspace→repo 映射一键认领 + `/tapd` 主动查询 + snooze/不是我的。
- **工作总结报告**：日/周简报（git 提交 + 任务记忆 → claude 合成 md）、月/年 PPT（pptxgenjs）+ `--brief` 模式、P3 daemon 内定时自动生成推送。
- `restart-all-claude-tabs --except`：原地重启 claude tab + 自动过 trust 弹窗。
- System Events 术语故障飞书自检告警（每 2min 探针，状态翻转时推送）。

**修复**
- Stop hook 跳过 headless / 内部 `claude -p` 会话，不再把 meta 输出泄漏到飞书；补内容特征过滤。
- `closeTab` 过 Terminal「关闭确认框」；`newTab` 打开后补回车。
- `agent` shim 跟随 symlink 再算 ROOT。

**文档**
- `CLAUDE.md` 结构改 monorepo + System Events 术语故障约定；`docs/features.md` 加 §21 TAPD / §22 报告；团队远程知识库方案草案。

### 2026-07-13

**新增**
- 知识提炼 Phase 1：shell 交互流自动提炼知识条目（`KNOWLEDGE_EXTRACT_ENABLED=1` 启用）。

**文档**
- `docs/features.md` 加 Web Dashboard(§19) + Knowledge Extraction(§20) 两章；加专门 `docs/knowledge.md`。

---

_更早的历史见 `git log`。_
