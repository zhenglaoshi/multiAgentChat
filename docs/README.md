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
- **[feishu-commands.md](feishu-commands.md)** — 飞书 slash 命令清单（自动生成的命令菜单 manifest）
- **[sop.md](sop.md)** — SOP 工作流（多 stage / gate / loop / subagent）
- **[web-dashboard.md](web-dashboard.md)** — 手机浏览器直控 Mac 的 setup + 用法
- **[knowledge.md](knowledge.md)** — 自动提炼 shell 交互为个人知识库（Phase 1）
- **[team-knowledge-base.md](team-knowledge-base.md)** — 团队知识库（设计草案，跨人共享 knowledge 的方案）
- **[tapd.md](tapd.md)** — TAPD Bug 自动监听：推卡→认领→多选 repo→切分支→开 claude tab 修复→回写状态
- **[features.md § 22](features.md)** — 工作总结报告（日/周/月/年报，四路数据源；含「漏活的高发区」防回归说明）
- **[features.md § 22b](features.md)** — CareyClaw Agent 公函：2min 轮收件箱 → 推全文 + 任务卡 → 确认后开 shell（走 MCP 不走 REST）
- **[features.md § 34](features.md)** — `agent bootcheck`：交付/push 前的通用机器门（发现项目自己的加载期冒烟 → 跑 → 如实报告；全局 git hook + opt-in 白名单）
- **[perf-integration.md](perf-integration.md)** — performance-platform 性能建议对接方案（P1 只读监听 + P2 认领并建需求已落地）
- **[handoff-deployment.md](handoff-deployment.md)** — 同事任务甩单：**部署与使用指南**（环境变量总表 / 上线三步 / 排障），要落地看这篇
- **[handoff-integration.md](handoff-integration.md)** — 同事任务甩单：设计/协议/分期（中转 relay + OIDC 门户，配套独立项目 `../multiagent-relay/`）
- **[permissions.md](permissions.md)** — 授权与权限清单（macOS TCC 授权 + 高危命令审批等级），首次安装必读
- **[troubleshooting.md](troubleshooting.md)** — 遇到问题查这里

## 🛠 我想改代码
- **[architecture.md](architecture.md)** — 内部架构（monorepo 布局、依赖 DAG、数据流、IMTransport 抽象）
- **[codex-integration.md](codex-integration.md)** — 多 agent · Codex CLI 集成方案（AgentAdapter 抽象 + 回传通道）
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
