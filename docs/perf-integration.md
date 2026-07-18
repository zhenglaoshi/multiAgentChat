# performance-platform ↔ multiAgentChat 对接方案

> 状态：**P1 只读监听 + P2 认领并建需求已落地**（`im-lark/monitor/perf-watcher.ts`、`orchestrator/perf/`含 `tapd-story.ts`、handler `perf-claim`/`perf-claim-story`）；P3 回写闭环待 perf 侧加 CAS。performance 负责**采集分析**，multiAgentChat 负责**对接、分发任务、驱动 claude 解决具体问题**。
> 性能平台**以 `performance-platform-api`（后端服务）+ `performance-platform-web`（前端）为准**（plain `performance-platform` / Java `performanceapi` 不看）。本文 file:line 均指 `performance-platform-api`。

> **关键对齐**：web 的「推荐追踪」页（`performance-platform-web/src/pages/Recommendations.tsx`）用的就是**同一套** `/api/recommendations` API 和 `RecommendationStatus`：`listRecommendations({status,target})` / `updateRecommendationStatus(id,{status:'implemented',implementedBy,gitCommitUrl,notes})` / `dismissed` / `verify`（见 `web/src/api/client.ts:136-147`）。→ multiAgentChat 就是这套 recommendation 生命周期的**「手机 + AI 前端」**，与 web dashboard **共用同一份状态**，飞书认领/修复 → web 页即时同步，天然一致。`implementedBy` 字段已存在（部分即 assignee），回写直接复用。

## 1. 两个项目的角色

| | performance-platform | multiAgentChat |
|---|---|---|
| 定位 | MongoDB 慢查询优化 + 云资源治理 + API 遥测（华为云 DDS） | 手机/飞书 ⇄ Mac 多 claude tab 的任务分发桥 |
| 产出 | findings（COLLSCAN/MISSING_INDEX…）+ **Recommendation**（修复方案） | 把问题变成注入到 claude tab 的可执行任务 |
| 缺的一环 | 有分析、有建议，但**没人自动去改** | 有执行力，但**问题从哪来**要接数据源 |

天然互补：performance 出"该修什么 + 怎么修"，multiAgentChat 出"谁去修、怎么修、修完验证"。

## 2. performance 的对接面（关键事实）

- **最佳对接层 = `Recommendation`**：它本身就是带生命周期的任务。
  - `RecommendationRecord`（`performance-platform-api/src/store/types.ts:302-343`）：`status: pending→in_progress→implemented→verified→dismissed`、`target: frontend|backend|sre|product`、`priority P0/P1/P2`、`title`、`rationale`、`gitCommitUrl`、before/after 校验快照。
- **HTTP API**（Fastify，全局 **Basic auth**，`performance-platform-api/src/api/server.ts`）：
  - `GET /api/recommendations?status=pending` —— 拉待办（对接主入口）
  - `PATCH /api/recommendations/:id` —— 回写 `implemented` + `gitCommitUrl`
  - `POST /api/recommendations/:id/verify` —— 触发前后对比校验
  - `GET /api/shapes?database&priority=P0`、`GET /api/shapes/:fingerprint` —— 原始 findings（备选，噪声大）
  - `GET /api/runs`、`GET /api/repos`、`POST /api/trigger-refresh`
- **repo 映射**：`repos.json` = `{repo:"iHealthStrategy/<name>", databases:[...]}`；finding 按 database/collection 定位 → 查 repos.json 得 repo → `localPath = REPOS_BASE_DIR/<name>`（`src/store/repo-store.ts:7-12`）。`Recommendation.codeChange.file/permalink` 直接指到要改的文件。
- **增量**：`RunRecord.processedUntil` 水位线 + `NEW_SHAPE_TODAY` finding 类型标新问题。
- **无出站 webhook**（只有 spike 告警走 SSE `GET /api/spike-events/stream`）→ multiAgentChat 侧只能**轮询**。

## 3. 对接方案（复用 TAPD watcher 骨架，只换数据源）

```
perf-api  GET /api/recommendations?status=pending   (Basic auth 轮询, N min)
   ↓  perf-watcher 去重(按 id) + 只推新的
新 pending recommendation → 飞书卡
   （title + rootCause + priority + target + 索引命令/codeChange.file + repo）
   ↓  用户点「认领修复」
映射 repo（recommendation→database→repos.json→localPath）→ 开 tab 注入上下文
   （根因 + 索引建议命令 + 要改的文件/permalink + rationale）
   ↓  claude 改代码/加索引 + 本地验证（严禁连生产库）
   ↓  PATCH /api/recommendations/:id → implemented + gitCommitUrl   （审批后）
   ↓（可选）POST /api/recommendations/:id/verify → 拉前后 p99 对比 → 回执"实测降了 X%"
```

与 TAPD 集成同构，可复用：watcher/去重 store、通知卡、认领→选 repo→开 tab、注入 prompt、审批回写。差异仅：数据源 TAPD MCP → perf-api HTTP(Basic auth)；item 类型；repo 映射来源；回写 API。

## 4. 分阶段计划

- **P1 · 只读监听**：`orchestrator/perf/`（client + config + query）+ `im-lark/monitor/perf-watcher.ts` 轮询 pending recommendation → 推飞书卡（含根因/优先级/repo）。去重、按 P0/P1 与 target 过滤。不回写。
- **P2 · 认领→开 tab 修**：认领卡两个按钮 ——
  - **[🔧 认领修复]**：repo 映射 → 上下文（根因+索引命令+文件）发到 active tab 直接修。
  - **[📋 认领并建需求]**（2026-07 加）：先在 TAPD 建一条正式需求（**创建人+开发负责人=认领者**，挂 workspace `36983849`「后端服务」项目 / 默认「数据库优化」分类，Node 侧 `TapdMcpClient.callTool('tapd-create-story-or-task')`）→ 用 **story 后6位**建 `~/ihealth-work/fix_<story6>/` **worktree 隔离目录** → 开新 tab 在里面修（含需求链接）→ `saveWorkTask` 落记录（`/worktasks` 可 [📂 打开]）。本地无该 repo 源则回退 active tab。这样 perf 工作进了团队 PM 系统 + 目录隔离，「perf→建需求→建目录→修」闭环。配置：`PERF_TAPD_WORKSPACE_ID` / `PERF_TAPD_CATEGORY_ID`（默认数据库优化 `1136983849001000190`）。实现 `orchestrator/perf/tapd-story.ts`。
- **P3 · 回写 + 校验闭环**：修完（审批后）`PATCH implemented + gitCommitUrl`；可选 `verify` 拉前后 p99 → 飞书回执"实测优化 X%"。企微同 TAPD 降级支持。

## 5. 待拍板 / 需提供

1. 数据源：`recommendations` 层（推荐）还是原始 `shapes/findings`？
2. 配置（需用户给）：perf-api **base URL + Basic auth 账密** → `.env`（gitignored）；**`PERF_REPOS_BASE_DIR`** 本地仓库根。
3. 回写：修完自动 `PATCH implemented + gitCommitUrl` 吗（走 `agent request-approval`）？是否自动 `verify`？
4. 范围：P0 / P0+P1？哪些 target（backend/frontend/…）？
5. 节奏：先文档（本篇）还是直接建 P1？

---

## 6. 更深层次的改进 / 功能（跨两项目）

> 不止"搬运问题"，而是把两个项目拼成一个**可度量的自治优化闭环**。

### 6.1 可度量闭环（最有价值，别人难做）
performance 能**量化**修复效果（before/after p99、扫描行数、成本）。所以本项目的修复不是"盲修"，而是：
检测 → 修 → **verify 实测** → 用数字确认真的变快了 → 自动 close。
飞书回执直接给"这条慢查询 p99 从 820ms → 90ms"这种**带数字的成果卡**——把 AI 改代码从"看起来改了"变成"实测有效"。这是这套组合的杀手锏。

### 6.2 批量战役（campaign）
performance 一次常出一堆跨仓库 P0。复用本项目的**批量卡 / 任务链**：一键把 N 条 recommendation 分发到 N 个 repo 的 tab **并行修**，一张聚合进度卡盯全局。适合"周一清 P0"这种集中治理。

### 6.3 复杂项交给 Planner（A3）
"重构某集合的访问模式"这类不是加个索引能解决的 → 把 recommendation 丢给 `/plan` 自动拆成多步（改 schema→改查询→加索引→回归），再逐步派发。

### 6.4 知识沉淀 → 慢查询 playbook
本项目有知识提炼。每次 perf 修复（根因+改法）沉淀成知识条目 → 攒出"常见慢查询模式→修法"playbook，加速后续同类修复；甚至可回喂 performance 的 recommendation rationale，让建议更贴业务。

### 6.5 实时 spike 通道（区别于分析建议）
performance 有 spike SSE（带宽/p99 突刺告警，`server.ts:603-637`）。本项目可**订阅 SSE**做实时 on-call：突刺 → 立刻推告警卡 → 一键拉当时的慢查询/相关 API 上下文开 tab 排查。分析建议是"日常治理"，spike 是"救火"，两条通道都接。

### 6.6 抽象 IssueSource（架构层）
本项目现在已有 TAPD、即将有 performance 两个"问题源"。像 `IMTransport` 抽象多平台那样，抽一个 **`IssueSource` 接口**（list/claim/writeback/repo-map），TAPD 和 perf 各 implement，未来接 Sentry / GitHub Issues / 告警平台都统一。让"问题源"和"传输平台"一样可插拔。

### 6.7 反哺 performance（需改对方仓库）
- 给 performance 加**出站 webhook**（新 P0 时 POST 本项目）→ 免轮询、更实时。
- 给 recommendation 加 **assignee 字段** → performance 侧就知道谁在修、修到哪（本项目回写 in_progress/implemented 时带上）。

### 6.8 双向状态同步
本项目开 tab 修时 → `PATCH in_progress`；修完 → `implemented`+commit；performance 侧 dashboard 就能看到"哪些建议 AI 正在处理"，避免人和 AI 撞车。

## 7. 多人协作 / 归属路由（一组人都用怎么不乱）

### 核心矛盾
每人各跑一个 multiAgentChat daemon（各自 Mac），**daemon 之间不共享状态**。若都轮询全部 pending → 人人被全量提示 + 抢修同一条 → 乱。
**洞察：协调必须走唯一共享的 performance（所有 daemon 的共同真相源）。** 且 perf 现成机制基本够用，核心几乎零改。

### 两个机制
1. **status 生命周期 = 跨机认领锁（零改 perf）**：所有人轮询 `?status=pending`；谁先认领 → `PATCH status=in_progress`（P3 本就要做的回写）→ 这条立刻从所有其他人的 pending 轮询消失。天然防重复提示 + 防撞车，无需新字段。
2. **按 repo 归属过滤 = 路由**：每个 daemon 只推属于我的 repo 的 recommendation（recommendation→database→repos.json→repo→owner）。映射放哪：
   - **A（荐）** perf 的 `repos.json` 每条加 `owner`（共享、一处维护、全队一致）
   - **B（零改 perf）** 每人本地 `.env` 配 `PERF_MY_REPOS` / 负责的 databases，daemon 本地过滤

### 分层
- **Tier 1（几乎零改）**：本地配"我的 repo"过滤 + 认领即 `PATCH in_progress`。解决 90%（repo 多为单 owner 时无竞态）。
- **Tier 2（perf 小改）**：recommendation 加 `assignee` + `?assignee=` 过滤 + 认领用 compare-and-set（防同秒双认领）+ 卡显示"已被 @X 认领"。支持共享 repo、lead 派活、看谁在修。
- **Tier 3（可选）**：一个 team-mode 中央实例统一路由到人，个人不各自轮询（减 N× 轮询、彻底无竞态）。

### ✅ 已定：Tier 2（多人共享 repo + CAS）
决策：repo 多为**多人共享** → 用 **Tier 2 + CAS**。正解：

- **路由（防全员刷屏）**：perf `repos.json` 每 repo 加 `owners: [nickA, nickB]`；每人 daemon 只拉 `owners∋我` 的 repo 的 recommendation → 通知只到该 repo 的 2-3 个负责人。
- **协调（防撞车）**：认领用 **CAS** —— `PATCH pending→in_progress + assignee=me`，**仅当仍是 pending 才成功**。先点者拿到、在自己机器开 tab 修；后点者 CAS 失败 → 卡显示「已被 @X 认领」。
- **无需中央调度**：每人各自 daemon 处理自己的认领+修复（修复天然在认领者机器上），只靠 perf 做共享真相源。

**需改 performance（跨仓库，比想象的少）**：
1. `repos.json` 每 repo 加 `owners[]`（路由，共享一处维护）
2. `PATCH /api/recommendations/:id` 加 **CAS**（带期望状态 / If-Match，仅当仍 pending 才认领成功）——这是唯一必须的行为改动
3. assignee：`implementedBy` 字段**已存在**（web 回写就用它），认领(in_progress)阶段可直接复用或再加个 `claimedBy`；非阻塞项

> web dashboard 和飞书流共用同一状态字段，所以两边操作自动一致（web 上 dismiss → 飞书轮询即消失；飞书认领 in_progress → web「推荐追踪」页即显示）。CAS 只是让"同秒双认领"这个并发边界也严丝合缝。

**本项目侧**：perf-watcher 按 `owners∋我` 过滤 + 认领走 CAS PATCH + 卡显示认领人；CAS 失败优雅提示「已被认领」。

> 同理适用已上线的 TAPD 监听：多人时靠 TAPD 处理人/开发负责人字段过滤 + 认领回写状态即可（TAPD 侧本就有并发状态，等价于共享真相源）。
