# 团队远程知识库 · 方案设计

> 状态：**设计草案（未实现）**
> 前置：[knowledge.md](knowledge.md)（个人知识库 Phase 1，已落地）
> 目标：多人各自用 multiAgentChat 时，把各自 shell 交互提炼的知识汇成一个**团队共享、经策展、可被 claude recall 的远程知识库**。

## 1. 现状

个人知识库（已实现）：

- LLM（`claude -p`）从 sanitize 后的 shell chunk 提炼 `KnowledgeEntry`
  （`{ id, createdAt, kind, title, body(md), tags, source, chunkHash }`，
  见 `packages/orchestrator/src/knowledge/types.ts`）
- 存 **本机** `./data/knowledge/*.json`，`chunkHash` 精确去重
- 另有 `docs/kb/YYYY-week-NN.md` 周报式汇总
- **纯单机、无跨人共享**

## 2. 团队化才出现的 4 个问题

单机版都不存在，团队共享后必须解决：

| 问题 | 说明 |
|---|---|
| **噪音** | 自动提炼质量参差（0–3 条/chunk），原始条目直接进共享库会污染 → 必须有**策展闸门** |
| **跨人去重 / 合并** | 同一个坑 3 个人各提炼一条 → 合并，而非堆叠 |
| **密钥泄漏** | shell 日志含 token / `.env` 值，共享库脱敏门槛远高于单机 |
| **消费** | 别人怎么用：① claude 任务里 **recall 注入** ② 人肉**浏览 / 搜索** |

## 3. 候选方案对比

| | 存储 / 策展 | 优 | 劣 |
|---|---|---|---|
| **A. Git 仓库**（md + PR） | 版本化、可评审、零新基建 | 手机浏览差、贡献摩擦大（每条一个 PR）、无结构化查询、无语义搜索 |
| **B. 飞书多维表格 Bitable** | 团队已在飞书、手机原生、权限 / 搜索现成、API 双向读写、策展 UI 免费 | 语义搜索弱（靠 tag + LLM rerank 补）、单表行数上限（团队规模数年够用） |
| **C. 自建服务**（Postgres + pgvector + 小 API） | 搜索最强、可扩展 | **要养基建**（服务器 / DB / embedding / 鉴权），跟本项目"低运维自愈"哲学冲突，当前过度设计 |

## 4. 推荐方案：D = Bitable 当中枢 + 本地 recall 索引

（B 的增强版）

**为什么**：

- 本项目已有飞书 app（`app_id` / `secret`、bot、交互卡片、WS 长连接全现成）→ **零新基建**，完全复用现有投资
- 策展 / 浏览 / 权限 / 手机端 —— 飞书 Bitable 全包，团队本就整天开着飞书
- 结构化字段 + REST API 双向读写
- 本地索引给到好 recall，**不用起中心服务**
- 将来真到规模，再换 pgvector / 上 MCP —— "Bitable 即真相"的设计不锁死这条路

**不选 C 的核心理由**：本项目的价值观是"单用户本地、自愈、零外部依赖"。为一个小团队的 KB 去养一套带 DB + 向量 + 鉴权的常驻服务，运维成本 > 收益。等 KB 体量 / 搜索质量真成瓶颈（P4）再上。

## 5. 知识生命周期（team KB pipeline）

```
1. 提炼(本机)    现有 extractor → data/knowledge（已 sanitize）
2. 贡献(push)    daemon 批量 → sanitize v2 密钥扫描 → 写 Bitable 行
                 status=pending, author=成员, 用 chunkHash + 标题/tag 模糊查重
3. 策展(飞书)    轮值 curator 在飞书审：批准 / 编辑 / 合并重复 / 驳回
                 复用本项目现成的审批卡片（approve / reject 按钮）
4. 分发(pull)    各 daemon 定期拉 approved → 本地缓存 + 建 recall 索引
5. 消费(recall)  任务触发时按 cwd / tags / 关键词取相关 approved，LLM rerank
                 注入 claude prompt（扩现有 recall 通道）；+ 飞书 /kb search 命令
6. 交叉链接      条目挂 TAPD 单 / git commit / PR（URL 字段）—— 接现有 TAPD MCP
```

## 6. 关键取舍

- **策展闸门**：`pending → approved` 才算"团队真相"。可给高置信度的 `reference` / `howto` 自动批，
  `gotcha` / `decision` 必人审。或上投票（N 票晋升）。
- **去重 / 合并**：`chunkHash` 精确去重；贡献时再做标题 / tag 相似度查已有行（LLM 或 embedding）→
  命中就挂 `also-seen-by`（记录多个 author），不新建行。保持库干净。
- **密钥脱敏（sanitize v2）**：上传前正则扫 key / token / `.env` 值 / 内网 IP / 邮箱 → 疑似就 redact 或拒传。
  共享库门槛高于单机，这是 P0 前置。
- **归属 / 信任**：`author` + `approvedBy` 字段；recall 权重 `approved > pending`、`近 > 远`、`高赞 > 无赞`。
- **归档彩蛋**：Bitable 当"活库"，每周导出到 `docs/kb/*.md` 提交 git = 版本化只读存档，兼容现有 docs 结构。

## 7. Bitable 表结构（草案）

单表 `team-knowledge`，字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| title | 单行文本 | ≤80 字 |
| body | 多行文本 | markdown，≤500 字 |
| kind | 单选 | problem-solved / howto / decision / gotcha / reference |
| tags | 多选 | 项目 / 技术栈 / 领域关键词 |
| status | 单选 | pending / approved / rejected |
| author | 人员 | 贡献者（飞书用户） |
| approvedBy | 人员 | 策展人 |
| alsoSeenBy | 人员（多） | 合并进来的重复贡献者 |
| chunkHash | 单行文本 | 精确去重键 |
| links | 超链接 | TAPD 单 / commit / PR |
| upvotes | 数字 | 可选，投票晋升用 |
| createdAt | 日期 | |

## 8. 分期 rollout（每期独立可用）

- **P0** — sanitize v2 密钥扫描（前置，低成本）
- **P1** — 建 Bitable schema + daemon `kb push`（写 pending，去重）+ 飞书 `/kb pending` 策展卡
  （approve / reject 复用现成审批卡片）。**仅此已得到：共享 + 策展 + 手机可看的 KB**
- **P2** — daemon 定期 pull approved + 注入 recall + 飞书 `/kb search <q>`
- **P3** — 本地 embedding 语义索引（更好 recall）+ TAPD / git 交叉链接 + 用量分析（热门条目）
- **P4（真到规模再说）** — 迁移到自建服务 / 起 MCP server 让任意 claude 直查 KB

## 9. 一句话

**别自建服务，把飞书多维表格用成团队知识库的中枢**：daemon 负责"提炼 → 脱敏 → 推 pending → 拉 approved → 注入 recall"，人在飞书里策展。**P1 就能落地见效**，后续按需加语义搜索和交叉链接。
