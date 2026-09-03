---
name: multiagent-handoff
description: |
  把当前 shell 里的问题 + 你（AI）给出的分析/建议，一句话总结后甩给某个同事——同事本地也跑着 multiAgentChat + 自己的飞书应用，经中转 relay 送达，对方飞书机器人会弹出一张「👥 同事任务卡」，可接收/进行中/完成，状态双向同步回来。适用场景：用户说「把这个报错甩给 bob」「这个问题总结发给 @carol 看看」「handoff 给某同事」「让 X 帮我看看这个」。用本 skill 的 `agent handoff` CLI，不要直接调 webhook。
---

# multiagent-handoff

在 Mac 某个 tab 里，把「问题 + 你刚给的建议 + 相关文件」总结成一条任务，甩给某个同事。
每个人只跟自己的飞书机器人说话，两边飞书应用/租户解耦，中间靠独立的 relay 中转。

## 何时用

用户说类似的话就触发：
- 「把这个报错/问题甩给 bob」「总结一下发给 @carol」「这个让 X 帮我看看」
- 「handoff 给某同事」「转给同事」

## 先决条件

1. `agent` 命令可用（`which agent`，或 `~/ihealth-project/multiAgentChat/bin/agent`）
2. daemon 在跑：`[ -S ~/.multiagent-chat/agent.sock ]`
3. 本机 `.env` 配了 `RELAY_URL` / `RELAY_TOKEN` / `RELAY_IDENTITY`（没配则 handoff 未启用，会报错提示）

## 怎么做（关键：你负责总结，CLI 负责传输）

用户一句话触发后，**你**（当前 claude）来做总结这件事：

1. **先确认收件人**。用户给了 `@别名`/名字/邮箱就直接用；不确定就先列联系人让用户挑：
   ```bash
   agent contacts          # 🟢在线 / ⚪️离线 + 邮箱
   ```
2. **写一段 markdown 摘要**到临时文件——把「原始问题 + 你的诊断/建议 + 复现/关键上下文」讲清楚，让对方不用回溯也能接手。写到 scratchpad 或临时文件，例如 `/tmp/handoff-summary.md`。
3. **挑相关文件**（可选）：报错日志、trace、相关源码片段等，用 `--attach` 带上（可多次）。
   ⚠ 附件里别放整个 `.env`/密钥文件——发送前虽会自动脱敏文本，但能不发就不发。
4. **发送**：
   ```bash
   agent handoff send \
     --to @bob \
     --title "CGM 佩戴查询接口 500 报错" \
     --summary-file /tmp/handoff-summary.md \
     --attach /tmp/trace.log
   ```
   - 标题简短（会显示在对方任务卡头部）
   - 摘要也可以用 `--summary "..."` 直接给，或从 stdin 管道进（`cat x.md | agent handoff send --to @bob --title ...`）
   - 发送前 title / summary / 文本附件都会**强制脱敏**（跨人发不给明文后门）

5. **回执**：命令会打印 `taskId`。把「已甩给谁 + taskId」同时在 TUI 里告诉用户（若本会话也在飞书侧，可顺带 `agent lark send-text` 推一份）。

## 状态跟踪

- 发出后你这边会收到一张 requester 卡（📤 已发送）。对方接收/开始/完成时，卡片状态会自动 patch 同步过来。
- 想主动查：`agent handoff list`（看我发出/收到的所有甩单任务 + 当前状态）。
- 想撤回：`agent handoff status <taskId> canceled`。

## 反过来：我是收单方

同事甩来的任务会在**你的**飞书弹「👥 同事任务卡」，点按钮即可 [🤝接收]/[🚧开始]/[✅完成]/[🙅拒绝]，
或命令行 `agent handoff status <taskId> accepted`。接了之后就正常在本地开 tab 干活即可。

## 不要做

- 不要直接调任何 relay HTTP 接口 / webhook —— 用 `agent handoff`。
- 不要把收件人邮箱、token 这些写进摘要正文。
- 不确定收件人时不要瞎猜邮箱，先 `agent contacts` 让用户确认。
