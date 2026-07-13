# Knowledge Extraction · 自动提炼 shell 交互为知识库

> **状态**：Phase 1 上线（提取 pipeline + CLI + 存储）。Phase 2（检索 + recall 注入）与 Phase 3（周报）待验证信噪比后启动。

---

## 为什么要这个

本项目已经在 watch 所有 Terminal tab 的输出。每次 tab 里 claude 或用户手打的任务完成，都产生一段可能有价值的 shell 交互 log。**把这些 log 自动提炼成结构化知识条目**，就能：

- 避免自己反复踩同一个坑（"上次这个 error 咋 fix 的"）
- 跨项目复用经验（项目 A 学到的 pattern，B 也能用）
- 为个人化 AI 助手积累长期记忆

现有 `task memory` / `stage memory` 是原始日志级，本模块是**结构化知识条目**级 —— 一句话标题 + 4 步 markdown body + tags，可搜可复用。

---

## 5 类知识（KnowledgeKind）

| kind | 描述 | 例 |
|---|---|---|
| `problem-solved` | 遇到问题 + 尝试 + 解法 | "pigeon 连 mongo 副本集 timeout：nc 逐个探测 6 host 后重启" |
| `howto` | 怎么做 X（有步骤） | "跑最新三梯队数据并推 OBS 地址到飞书的固定 workflow" |
| `decision` | 做了什么架构/工具决策 + 理由 | "为什么选 pnpm workspace 而不是 lerna" |
| `gotcha` | 坑 / 边缘 case / 反直觉 | "claude TUI 里 \n 不算提交 prompt，必须发真 Enter key" |
| `reference` | 命令 snippet / URL / 配置片段 | "用 sips 降采样 PNG 到 JPEG：sips -s format jpeg -s formatOptions 75 --resampleWidth 1200" |

---

## 架构

```
       tab 里 claude/shell 干活
              ↓
    watcher.taskOutput isFinal
              ↓
    daemon attachKnowledgeExtractor
              ↓
    KNOWLEDGE_EXTRACT_ENABLED=1 门禁
              ↓
    ExtractionQueue.enqueue
              ↓
  ┌─────────────────────────────┐
  │ heuristics.shouldExtract    │
  │  · ≥300 字                  │
  │  · 含 error/success/decision │
  │  · 或含 ``` 代码块           │
  │  · 或 ≥1500 字               │
  │  否则 skip                   │
  └────────────┬────────────────┘
               ↓
  ┌─────────────────────────────┐
  │ sanitize                     │
  │  · sk-ant / ghp_ / OpenAI    │
  │  · JWT / AWS / 40+位 hex/b64 │
  │  · *_SECRET / *_TOKEN 赋值行 │
  │  · 邮箱脱敏保留部分上下文     │
  └────────────┬────────────────┘
               ↓
  ┌─────────────────────────────┐
  │ chunkHash 去重（SHA-256 前16位）│
  │  已提取过就 skip              │
  └────────────┬────────────────┘
               ↓
     截断到 CHUNK_MAX_CHARS = 8000
               ↓
     spawn claude -p '<prompt>' --max-turns 1
       （180s timeout · 冷启动约 30-90s）
               ↓
     stdout 解析 JSON 数组 (0-3 条)
               ↓
     落 ./data/knowledge/<id>.json
```

## 配置

```env
# 默认关闭（第一次跑就自动烧 subscription 太激进）
KNOWLEDGE_EXTRACT_ENABLED=1
```

生效方式：改完 `.env` 后重启 `pnpm dev`。启动 log 会看到：
```
[INFO] knowledge extractor attached · 提取器已开 · claude -p 本地跑
```

不设置就跳过，daemon log 提示：
```
[INFO] knowledge extractor 未启用（设 KNOWLEDGE_EXTRACT_ENABLED=1 开启）
```

## CLI

```bash
# 看统计（总数 / byKind / 队列 / 启用状态）
agent knowledge stats
# 别名：agent kb stats

# 列最近 N 条（默认 20）
agent knowledge list -n 10 [--cwd <某目录>]

# 看单条详情（id 可以只写前缀）
agent knowledge show ke-mriu6ni8-ujqs4f
agent knowledge show ke-mriu6              # 前缀也行

# 手动触发对当前 tab 最近 N 行提取（不用等任务自动完成）
agent knowledge extract-last [-t /dev/ttysXXX] [-n 200]
agent kb el -t /dev/ttys002 -n 300         # 短别名
```

## 数据存储

```
./data/knowledge/
  ke-<timestamp-b36>-<rand>.json    # 单条 KnowledgeEntry
  ke-mriu6ni8-ujqs4f.json           # 例
```

每个 JSON 结构（见 `packages/orchestrator/src/knowledge/types.ts` KnowledgeEntry）：

```json
{
  "id": "ke-mriu6ni8-ujqs4f",
  "createdAt": 1783918823232,
  "kind": "howto",
  "title": "跑最新三梯队数据并推 OBS 地址到飞书的固定 workflow",
  "body": "步骤：\n1. 后台跑 total/echeloniot1.js...",
  "tags": ["multiAgentChat", "三梯队", "echeloniot1", "OBS", "飞书", "数据跑批", "workflow"],
  "source": {
    "origin": "local",
    "tty": "/dev/ttys002",
    "cwd": "/Users/.../test/updateData",
    "originalPrompt": "帮我跑一份最新的三梯队数据",
    "commandsRun": ["node total/echeloniot1.js", "..."],
    "filesTouched": ["total/echeloniot1.js", "total/汇总/"],
    "outputPreview": "..."
  },
  "chunkHash": "074f66709a43395b"
}
```

## 性能 & 成本

- **每次提取耗时**：`claude -p` 冷启动 30-90s（skills/hooks/tools 加载），处理 8000 字符 prompt 后总耗时 ~30-60s
- **成本**：本地跑 Claude Code CLI，走你的 subscription 额度；无额外 API 费用
- **信噪比**：Phase 1 实测第一条从 28820 字 shell log 提炼出 1 条高质量 howto entry（含 4 步 workflow + 26 城市清单），信息密度高
- **过滤挡量**：启发式 `shouldExtract` 挡下约 70% 噪声（npm install / 空跑 / 短交互），只放有 error/success/decision 关键词的 chunk 进队

## 隐私模型

Sanitize 层脱敏了以下模式（先扫描后再送 LLM）：

- `sk-ant-...`（Anthropic API key）
- `ghp_...` / `gho_...` 等（GitHub Personal Access Token）
- `sk-...` 40+ 位（OpenAI）
- `AKIA...` 16 位（AWS access key）
- JWT (`eyJ...eyJ...eyJ...`)
- `*_SECRET` / `*_TOKEN` / `*_KEY` / `*_PASSWORD` 赋值行 → `NAME=<REDACTED>`
- 邮箱脱到 `ab***@x***.com` 保留部分上下文
- 40+ 位 hex 或 base64 长串

**会漏掉的**：URL 里带的 token、连接串里的密码、自定义 secret 前缀。所以：
- **不要在 shell 里 `echo` 敏感信息** 是最好实践
- 提取前的 chunkHash 只对 sanitized 版本算，不会以 secret 为索引
- 后续可以加**自定义 pattern DB** 覆盖公司常见 secret 格式

## 未做（Phase 2 · Phase 3）

### Phase 2 · 检索层（估 1 天）
- `/kb <query>` 飞书 slash 命令 → 返回 top 5-10 knowledge 卡
- `agent knowledge search <query> [--tag T] [--kind K] [--cwd C]` CLI
- 简单实现：tokenize + tag 匹配（跟 recall 一样）；进阶：向量检索

### Phase 3 · 自动 recall + 周报（估 2 天）
- 派新 task 时把相关 knowledge 注入到 prompt（跟 memory recall 融合）
- 每周日晚 launchd job 汇总本周新增 knowledge → 飞书推 markdown 报告
- 导出 `./docs/kb/YYYY-week-NN.md`

## 常见问题

| 症状 | 原因 | 解 |
|---|---|---|
| `agent knowledge stats` 显示"未启用" | KNOWLEDGE_EXTRACT_ENABLED 没设或没重启 dev | 编辑 .env 加 `KNOWLEDGE_EXTRACT_ENABLED=1` + 重启 |
| 队列有量但一直不产出 | claude -p 超时（180s）；检查 daemon log `claude extract failed` | 增加 CLAUDE_TIMEOUT_MS 或看 claude 是否在跑其他重任务 |
| 产出为空（entries=0） | claude 判定 chunk 无价值（好事）或 JSON 解析失败 | 看 daemon log `extractor returned empty` 就是前者；`no JSON array` 是后者，看 stdout 前 150 字 |
| 敏感 token 泄漏到 body | sanitize 没覆盖某模式 | 加 `packages/orchestrator/src/knowledge/sanitize.ts` 里的 RULES |

## 相关文件

- `packages/orchestrator/src/knowledge/types.ts` · schema
- `packages/orchestrator/src/knowledge/sanitize.ts` · 脱敏 RULES
- `packages/orchestrator/src/knowledge/heuristics.ts` · shouldExtract + extractCommands / extractFilePaths
- `packages/orchestrator/src/knowledge/extractor.ts` · queue + spawn claude
- `packages/orchestrator/src/knowledge/store.ts` · flat JSON store
- `apps/daemon/src/index.ts` · attachKnowledgeExtractor 挂到 watcher.taskOutput
- `packages/framework/src/control/{cli,server,protocol}.ts` · knowledge.stats/list/extract-last op
