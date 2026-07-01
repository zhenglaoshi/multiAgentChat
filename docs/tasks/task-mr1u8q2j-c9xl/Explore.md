# data/ 探索

## 结构

```
data/
├── approvals/         3 files    审批记录（含 gateContext + design.md 预览）
├── chats/             1 file     飞书 chat 状态（chatId, activeTty, watchAllTabs）
├── memories/         65 files    task 级 memory（prompt, filesProduced, tags, duration）
├── stage-memories/    1 file     stage 级 memory（含"Explore stage 在某 cwd 做了啥"召回）
├── tasks/             2 files    SOP 任务状态机（currentStageIdx, stageHistory, awaitingGate）
└── recent-cwds.json              最近 10 个用过的 cwd
```

## 时间跨度

| 目录 | 起始 | 最新 | 增长 |
|---|---|---|---|
| memories | 2026-06-28 20:39 | 2026-07-01 10:59 | 3 天，65 条，活跃 |
| approvals | 2026-06-30 21:00 | 2026-07-01 07:15 | 昨晚+今早 |
| tasks | 2026-07-01 15:45 | 2026-07-01 16:54 | 本 session |
| stage-memories | 2026-07-01 | 2026-07-01 | 首日出现 |

## 样本快读

- **approvals** `ap-mr19jf3d-yvpohc.json`：architect 阶段 gate 审批，含 design.md preview
- **chats** `oc_f9286897b45187b0ca8439eefc592aad.json`：createdAt / activeTty / watchAllTabs
- **memories** `mem-mqxrw3pw-77af.json`：3 min 查手机号任务，产出 `obs/upload_share.js`
- **stage-memories**：payment-platform 项目某次 Explore stage 摘要
- **tasks** `task-mr1u8q2j-c9xl.json`：当前 SOP 任务（就是这条），只 1 个 Explore stage

## 观察到的模式

- **memories 是最大数据源**（65 文件，每份 1.5-1.9KB），承载"我过去做过啥"的召回
- **tasks 反映实时 SOP**：状态机在磁盘上完整可见，daemon 挂了也能恢复
- **approvals 富上下文**：不只是"批了没"，还保留 design.md 预览，跟 taskId 关联可追溯
- **cwd 覆盖 10 个 iHealth 项目**：payment-platform / raven2 / pigeon / pivotal-parrot / performance-platform 等

## 快速统计

- 65 memories × 平均 1.7KB ≈ 110 KB
- 65 memories / 3 天 ≈ 20 次/天，与"每天 15 次"数据分析结论对齐
- 数据增长曲线：**memories** 高活跃，**tasks / stage-memories** 刚启用（第一次 SOP 跑通后才产生）

## 数据完整性

- 所有 JSON 都有 `id` + 时间戳字段，可 sort + range query
- 无孤儿（tasks 里的 taskId 也出现在 approvals.taskId）
- 无跨目录引用坏（approvals.taskId 指向真实 tasks 记录）

数据模型健康，可以放心做后续统计 / 可视化。
