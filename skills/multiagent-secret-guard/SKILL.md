---
name: multiagent-secret-guard
description: multiAgentChat 的明文凭证脱敏能力——扫描/脱敏 claude 和 codex 会话历史里的账号密码/AK/SK/token/连接串，以及推送到飞书/落盘前的自动回显脱敏。当用户问"我的 claude/codex 会话里有没有明文密码/密钥"、"清洗/脱敏会话历史"、"检查凭证泄露"、"推飞书的东西脱敏了吗"、"想看明文/关掉脱敏"、"定期自动脱敏"时触发。全程中文。
---

# multiAgentChat 明文凭证脱敏（secret-guard）

## 背景

本项目会把终端输出、助手回复推送到**飞书**（手机），并落盘到 `data/`（memories/knowledge）；
claude/codex 又把**每一轮对话和工具输出**原样明文写进 `~/.claude`、`~/.codex`。只要在会话里
`cat .env`、连数据库、看 API 返回、调部署脚本，AK/SK/密码/token 就会明文外泄到手机 & 磁盘。

## 🔴 给 agent 的行为准则（回显——必读）

在**组织回复 / 输出**时遇到账号密码、AK/SK、token、连接串、私钥等凭证：

- **默认绝不明文回显**。用掩码代替：整体 `[REDACTED]`，或只留尾部辨识位（如 `sk-…a1b2`、`LTAI…7788`），
  或干脆只说"已拿到密钥 / 已写入 .env / 已用于连接"而不打印值本身。
- **只有用户明确要求看明文**时才明文显示——例如用户说"把完整 token 贴出来""我要看原始密码"，
  或在飞书发了 `/raw on`。没有明确要求 = 一律脱敏。
- 生产库密码 / 私钥 / 线上密钥即便被要求，也先确认用途再给，并提醒用完 `/raw off`。
- **不要依赖系统兜底**：daemon 确有 redact-on-echo 会在推飞书/落盘前自动脱（见下），但那是最后一道网；
  你在组织回复时就应主动遵守，别把"反正会被自动脱"当理由去明文写。

---

secret-guard 分两条防线，**同一套检测引擎**（`orchestrator/secrets` 的 `redact()`，单一事实源）：

1. **回显脱敏（redact-on-echo，自动、默认开）** —— 出站到飞书的所有文本/卡片、落盘的 memories，
   在发送/写入前把明文凭证脱成 `[REDACTED-<类型>]`。织在 `im-lark/lark/api.ts` 的发送层，
   因为最大泄露口是**自动推送**（Stop hook 推 last_assistant_message、watcher 推终端 scrollback），
   不经助手判断，只有卡在发送层才挡得住。
2. **静态文件脱敏（at-rest，手动/定期）** —— 扫 claude+codex 的会话历史文件，就地脱敏。

## 能识别的类型

DB/AMQP 连接串密码（`scheme://user:PASS@`）、AWS AK（`AKIA/ASIA`）、阿里云 AK（`LTAI`）、
华为云 AK（`HXWZ`）、Anthropic（`sk-ant-`）、OpenAI（`sk-`）、GitHub token/PAT（`ghp_`/`github_pat_`）、
Slack（`xox*`）、Google（`AIza`）、GitLab（`glpat-`）、careyclaw（`oct_`）、JWT（`eyJ….….…`），
以及 `password= / api_key: / secret: / access_key / ak / sk` 等**上下文赋值**（自动排除
`YOUR_*`/`example_*`/`*_here`/`process.env.*` 等占位符）。**故意不含**"40 位以上 hex 一律脱"这类
宽规则——会误伤 git SHA / 哈希、甚至损坏 transcript。宁可漏，不可乱。

## 回显脱敏开关：`/raw`（飞书命令）

- 默认**脱敏中**：推飞书/落盘的凭证都会脱成 `[REDACTED-X]`。
- `/raw on` → 进**明文模式**（"明确说要明文"），**10 分钟后自动恢复脱敏**（重启也会恢复）。看完请 `/raw off`。
- `/raw status` 看当前状态。
- 环境变量 `MCHAT_REDACT_SECRETS=0` → 整体停用脱敏（调试用）。

## 静态文件脱敏：`agent secrets`

```bash
# 只扫描报告（dry-run，不改任何文件）—— 覆盖 claude projects/history + codex sessions/history
agent secrets scan

# 就地脱敏（改写 transcript！）。默认跳过最近 60min 活跃会话，不留 .bak
agent secrets scrub           # 跳过近 60min
agent secrets scrub 1440      # 跳过近 24h（更保守）
```

> ⚠ **`scrub` 会改写会话 transcript**，Claude Code 的 auto 模式安全分类器会拦助手代跑。
> 需**用户本人发起**：在提示符用 `!` 前缀运行（`! agent secrets scrub`），或让 daemon 定期任务执行。

**不覆盖**（报告里会点名提醒）：`~/.codex/auth.json`（凭证存储本身，脱了掉登录）、
codex 的 sqlite 库（`logs_2/memories_1.sqlite`，v1 未覆盖）。

## 定期自动脱敏（daemon，opt-in）

daemon 内置定期任务，**默认不启用**。配环境变量启用（改 `.env` 后重启 daemon）：

```bash
SECRET_SCRUB_ENABLED=1          # 启用定期扫描
SECRET_SCRUB_APPLY=1            # 就地脱敏（否则只推"发现 N 处"报告，不改文件）
SECRET_SCRUB_INTERVAL_HOURS=24  # 周期，默认 24h
```

报告模式（不设 APPLY）会把"发现 N 处、跑 scrub 清理"推到飞书；apply 模式恒**跳过最近 24h**
活跃会话，绝不损坏正在进行的对话。

## 治本仍需轮换

脱敏只处理**本地磁盘/推送通道**的明文。已泄露的真实密钥必须到各自控制台 **rotate**
（阿里云 RAM / 华为云 IAM / MongoDB / RabbitMQ / 飞书开放平台 / GitHub / OpenAI / careyclaw）
才算根治。

## 相关

- 引擎 & 文件脱敏：`packages/orchestrator/src/secrets/{redactor,scrub}.ts`
- 回显闸门：`packages/im-lark/src/lark/redact-gate.ts`（织入 `api.ts`）
- 定期任务：`packages/im-lark/src/monitor/secret-scrub-scheduler.ts`
- 另有独立的 `audit-claude-secrets` skill（python，仅 claude 侧）——本 skill 是项目集成版（claude+codex+回显+定期）。
