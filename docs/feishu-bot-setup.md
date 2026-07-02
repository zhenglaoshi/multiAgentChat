# 飞书机器人配置 —— 斜杠命令

## 为啥要配这个

飞书里输 `/` 会弹出机器人支持的命令菜单（**自动补全**）。配好后用户不用记命令名，看菜单点选即可。

飞书**没提供 API 批量导入**，只能在开放平台后台手动加。本文给你清单 + 逐步指引。

## 配置入口

1. 打开 [飞书开放平台](https://open.feishu.cn/)
2. **应用管理** → 选你的自建应用
3. **应用能力** → **机器人** → **配置指令**（左侧菜单）
4. 点 **添加指令** 逐个填

## 每条指令的填写字段

| 字段 | 说明 | 例 |
|---|---|---|
| **指令名称** | `/` 后的字符（不含 /） | `dashboard` |
| **指令描述** | 用户悬停 / 补全时看到的解释（≤ 50 字符） | `查看所有 tab 和进行中的任务` |
| **示例** | placeholder，可选 | `dashboard` |
| **是否隐藏** | 高级命令可选隐藏 | 否 |
| **权限范围** | 所有 chat / 特定人群 | 所有 |

---

## 命令完整清单（12 主命令，按功能分组）

### 🎛 概览 & 导航（4）

#### 1. `/dashboard`
- **描述**：全局概览：tab + pending 任务 + 最近完成
- **示例**：`dashboard`

#### 2. `/shells`
- **描述**：列所有 Terminal tab（可点切换）
- **示例**：`shells`

#### 3. `/where`
- **描述**：当前 active tab 的详情
- **示例**：`where`

#### 4. `/history`
- **描述**：当前 tab 屏幕历史 tail
- **示例**：`history` 或 `history -n 100`

---

### 🚀 任务派发（3）

#### 5. `/use`
- **描述**：切换本会话的 active tab
- **示例**：`use ttys001`

#### 6. `/new`
- **描述**：Mac 上开新 Terminal tab
- **示例**：`new ~/code/foo` 或不带参数弹选目录卡

#### 7. `/watch`
- **描述**：开关本地任务监听（非飞书发起的 shell 活动也推）
- **示例**：`watch on` / `watch off`

---

### 🎯 SOP 编排（3）

#### 8. `/run`
- **描述**：跑任务模板，或 --sop 临时 SOP
- **示例**：`run <name> [k=v...]` 或 `run --sop 实现 X`

#### 9. `/template`
- **描述**：管理任务模板（save/show/delete/list）
- **示例**：`template` 或 `template save <name> ...`

#### 10. `/task`
- **描述**：SOP 任务列表 / 详情 / 中止
- **示例**：`task` 或 `task <id>` 或 `task abort <id>`

---

### 🎨 Subagent 生态（1）

#### 11. `/subagent`
- **描述**：管理 subagent（list/gen/tweak/delete）
- **示例**：`subagent gen 视频剪辑` 或 `subagent list`

---

### 🔍 查询 & 交互（2）

#### 12. `/approvals`
- **描述**：待审批 + 最近历史
- **示例**：`approvals`

#### 13. `/recall`
- **描述**：搜任务历史 memory
- **示例**：`recall 三梯队` 或 `recall` 看最近 10 条

---

### 📖 其它（可选，若想减少菜单拥挤可以隐藏）

#### 14. `/help`
- **描述**：完整命令帮助（含所有 alias 和内部命令）
- **示例**：`help`
- **建议**：**可以配上**，方便新用户查
- **可选替代**：如果嫌拥挤，就不配，让用户 `/h` 短别名触发也行

#### 15. `/chain`
- **描述**：查看运行中的任务链路
- **示例**：`chain` 或 `chain cancel <id>`
- **建议**：**可以隐藏**（不常用，语法 `>>` 直接用即可）

#### 16. `/audit`
- **描述**：审批历史
- **示例**：`audit 20`
- **建议**：**可以隐藏**（`/approvals` 已含最近）

---

## 短别名策略

飞书菜单里**不要**配短别名（`/d /s /t /u /w /h /c /a /r`），会挤爆菜单。让用户通过 `/help` 或使用中发现即可。CLI 里输入 `/d` 一样触发。

配了 12 主命令 + 3 optional = 15 条，飞书菜单支持得住，一屏可读完。

---

## 配置操作步骤（详细）

以 `/dashboard` 为例：

1. 开放平台 → 应用 → 应用能力 → 机器人 → 配置指令 → **添加指令**
2. 填：
   ```
   指令名称：dashboard
   指令描述：全局概览：tab + pending 任务 + 最近完成
   ```
3. **是否隐藏**：否
4. **权限范围**：所有可访问用户
5. 保存

重复 15 次，把上面 12+3 个都加了。

配完点右上 **提交发布** → 等审核通过（自建应用一般秒过）。

---

## 完成后怎么测

1. 在飞书任意 chat 里对机器人输入 `/`
2. 应该弹出下拉菜单，显示你刚配的所有命令
3. 挑一个（如 `/dashboard`）点选，或按 Enter
4. 消息发出去，应该收到 dashboard 卡

**如果没弹菜单**：
- 检查应用版本是否发布到最新
- 检查你所在 chat 的机器人是不是升级到新版本了（有时缓存）
- 手动 `@机器人 /dashboard` 试触发正常路径

---

## 未来维护

新加或改命令时：
- 代码里 `packages/im-lark/src/lark/commands.ts` 加逻辑
- 飞书开放平台后台**手动补一个 slash 指令**
- 若命令描述改了，去后台也改

**两处同步**是手动工作，暂时无法自动。可以考虑加个脚本从代码生成 markdown 报表，方便对照修改。

---

## 附：完整命令一览表（供 copy-paste）

| # | 命令 | 描述 | 示例 | 隐藏 |
|---|---|---|---|---|
| 1 | dashboard | 全局概览：tab + pending 任务 + 最近完成 | dashboard | 否 |
| 2 | shells | 列所有 Terminal tab（可点切换） | shells | 否 |
| 3 | where | 当前 active tab 的详情 | where | 否 |
| 4 | history | 当前 tab 屏幕历史 tail | history -n 100 | 否 |
| 5 | use | 切换本会话的 active tab | use ttys001 | 否 |
| 6 | new | Mac 上开新 Terminal tab | new ~/code/foo | 否 |
| 7 | watch | 开关本地任务监听 | watch on | 否 |
| 8 | run | 跑任务模板，或 --sop 临时 SOP | run --sop 实现 X | 否 |
| 9 | template | 管理任务模板（save/show/delete） | template | 否 |
| 10 | task | SOP 任务列表 / 详情 / 中止 | task <id> | 否 |
| 11 | subagent | 管理 subagent（list/gen/tweak） | subagent gen 视频剪辑 | 否 |
| 12 | approvals | 待审批 + 最近历史 | approvals | 否 |
| 13 | recall | 搜任务历史 memory | recall 三梯队 | 否 |
| 14 | help | 完整命令帮助 | help | 否 |
| 15 | chain | 查看运行中的任务链路 | chain | 是（可选） |
| 16 | audit | 审批历史 | audit 20 | 是（可选） |
