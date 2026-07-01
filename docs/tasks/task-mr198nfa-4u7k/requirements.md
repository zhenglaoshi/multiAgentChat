# Requirements

## 原始用户需求

> 帮我分析下当前项目，然后看看接下来需要做哪些功能，增强当前项目的功能和增强在手机端可操作性，把当前前后抽离成一个公共的工具，把具体架构项目描述等加上

## 拆解

### 目标 (Goals)
1. **项目状态分析**：给出当前 multiAgentChat 的客观摘要（架构 + 数据流 + 短板）
2. **功能增强清单**：枚举下一阶段值得做的功能，按 ROI 排序
3. **手机端可操作性增强**：专门给出一份手机/远程使用场景下的增强建议
4. **前后抽离成公共工具**：设计如何把项目从"单平台 + 单 host 实现" 重构为"可独立维护、可换 IM、可换 host"的三层组件
5. **架构图 + 项目描述**：design.md 里必须有可视化的架构图与项目自描述

### 非目标 (Non-goals)
- **不需要在本任务里实现**：本任务是规划，所有实现拆到后续 task
- **不需要决定开源策略**：抽离设计完成就够，是否上 GitHub 单独决策
- **不需要 PR/分支管理**：本任务不动代码

### 关键约束 (Constraints)
- 现有代码已上线（你日常在用），重构方案必须**可渐进迁移**，不能一次重写
- 飞书 IM 必须保留为一等公民（你的主要 surface）
- 已建好的 SOP 状态机要保留（不能因为重构就丢掉 task/stage/gate/loop/memory）
- 单人维护，方案应控制在 4-6 周可上线第一阶段

### 验收标准 (Acceptance criteria)
1. design.md 含"项目状态摘要"段，能让一个新人看完知道 multiAgentChat 是干啥的、长啥样
2. design.md 含 ASCII 架构图（当前 + 重构后），两张
3. design.md 列至少 5 条手机端增强、按 ROI 排序、每条标注估时
4. design.md 给出**具体抽包方案**：哪些代码进哪个 package、依赖方向、接口定义
5. design.md 给出 4-6 周 roadmap，按周/里程碑切
6. design.md 末尾列 3-5 个"现在拿不准 / 等你拍板"的开放问题

### 假设 (Assumptions)
- 用户长期会继续用飞书（不切 IM）
- macOS Terminal 路径短期不替换
- 重构期间 dev 服务允许偶尔不稳定

### 未决问题 (Open questions)
- 是否最终公开开源 → 决定接口设计的严谨程度
- 是否要新平台（Slack / Telegram）→ 决定 transport 抽象 priority
- 是否要 Linux host（如远程服务器跑 claude）→ 决定 host abstraction priority
- 上面 3 个会在 architect 阶段给出**推荐答案 + 不预设决定**的留白
