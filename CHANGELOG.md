# 更新日志 / Changelog

本项目所有值得注意的变更都记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/)，按日期倒序。

> **维护约定**：每次功能 / 修复 / 文档改动，在顶部「未发布」区对应日期下追加一条（分 `新增` / `修复` / `文档` / `改动`）。发版时把「未发布」整块归档到一个版本号下并打 tag。

## [未发布]

### 2026-07-15

**新增**
- **飞书图文 → shell claude**：飞书发「截图 + 文字描述」→ 下载图片到 `data/inbound/`（绝对路径）→ 把路径+描述注入目标 tab 的 claude（多模态 `Read` 看图）。支持三种发法：富文本一条发(A) / 先图后文 90s 内配对(B) / 纯图直发让 claude 自己看(C)。需飞书应用开 `im:resource` 权限。（`lark/resource.ts` + `handlers.ts`）富文本解析 `parsePost` 自测 9/9。
- **企微图文 → shell claude**（对齐飞书，B/C 两法；企微无富文本）：入站 image 消息取 `MediaId` → `media/get` 下载 → 同一套 imgPrefix 注入。（`im-wecom` transport/api + daemon 配对逻辑）需企微配置 `WECOM_*` 才生效。
- 多问题表单卡 `agent lark ask form`（AskUserQuestion 的飞书替代）：一张飞书卡问多个问题，每题单/多选，任一题可开 `allowText` 自由输入。全固定选项渲染成一张卡铺完(A)；含 `allowText` 则向导式一次一题(B)，带「💬 打字回答」回流。答案结构化回 stdout。
- `single`/`multi` ask 打字兜底：用户直接打「裸数字 2 / 逗号 1,3 / 选项原文」也能回答，作为卡片点击丢包/限流时的解冻通道。

**修复**
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
