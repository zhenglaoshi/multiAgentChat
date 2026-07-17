# 更新日志 / Changelog

本项目所有值得注意的变更都记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/)，按日期倒序。

> **维护约定**：每次功能 / 修复 / 文档改动，在顶部「未发布」区对应日期下追加一条（分 `新增` / `修复` / `文档` / `改动`）。发版时把「未发布」整块归档到一个版本号下并打 tag。

## [未发布]

### 2026-07-15

**新增**
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
