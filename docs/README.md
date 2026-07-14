# 文档索引

按你在项目里的角色选：

## 🚀 我刚发现这个项目
1. **[项目 README](../README.md)** — 一句话是什么 + 3 步跑通 + 能力矩阵 + 优势对比
2. **[installation.md](installation.md)** — 完整安装手册（飞书 / 企微二选一或都装）
3. **[feishu-bot-setup.md](feishu-bot-setup.md)** — 飞书斜杠命令菜单配置（含 `pnpm gen:feishu-commands` 脚本）
4. **[wecom-bot-setup.md](wecom-bot-setup.md)** — 企业微信 11 步详细配置（含 cloudflared tunnel）
5. **[features.md](features.md)** — 具体能干啥（按能力分类，含真实用例 + **能力矩阵飞书 vs 企微**）

## 📖 我在日常用
- **[commands.md](commands.md)** — 完整命令速查（飞书 / 企微 + Mac CLI，按任务分类）
- **[sop.md](sop.md)** — SOP 工作流（多 stage / gate / loop / subagent）
- **[web-dashboard.md](web-dashboard.md)** — 手机浏览器直控 Mac 的 setup + 用法
- **[knowledge.md](knowledge.md)** — 自动提炼 shell 交互为个人知识库（Phase 1）
- **[tapd.md](tapd.md)** — TAPD Bug 自动监听：推卡→认领→多选 repo→切分支→开 claude tab 修复→回写状态
- **[troubleshooting.md](troubleshooting.md)** — 遇到问题查这里

## 🛠 我想改代码
- **[architecture.md](architecture.md)** — 内部架构（monorepo 布局、依赖 DAG、数据流、IMTransport 抽象）
- **[../CONTRIBUTING.md](../CONTRIBUTING.md)** — 开发环境 setup、贡献流程

## 🎨 我想为特定域造一套 subagent
- **[sop.md](sop.md)** 的"Subagent 集成"段
- **飞书 `/subagent gen <描述>`** 自动生成
- **[commands.md](commands.md)** 的 subagent 命令组

## 🔀 我关心多 IM 并行 / 平台差异
- **[features.md § 18](features.md)** —— 企微 99% 对齐 · 已知差异（顶部能力矩阵 + 章节内详细清单）
- **[wecom-bot-setup.md](wecom-bot-setup.md)** —— 企微配置全流程
- **[../README.md#im-平台支持](../README.md)** —— IM 平台矩阵一览

---

## 其它

- **[../CLAUDE.md](../CLAUDE.md)** — Claude Code 的项目上下文文件（供 AI 助手读，不是给人看的）
- **[../README.md](../README.md)** — 项目根 README
- **[../LICENSE](../LICENSE)** — MIT
