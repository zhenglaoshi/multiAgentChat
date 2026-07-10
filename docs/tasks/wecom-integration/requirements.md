# WeCom Integration · Requirements

**Date**: 2026-07-11
**Owner**: multiAgentChat
**Status**: Draft — 等 user review

---

## Goal

给 multiAgentChat 加**第二个 IM transport** —— 企业微信（WeCom / WeChat Work），
让飞书用户和企微用户都能远程调度自己 Mac 上多个 claude tab。

飞书路径保持工作，两者并行；未来接第 3 个 IM（Slack / Telegram / 钉钉）时新的
`IMTransport` 抽象层是复用的基座。

---

## 非目标

- 不做企微群机器人 webhook 版（能力太弱，收不到用户消息事件，单向发消息价值不大）
- 不做多用户 auth（依然单用户 / 单 Mac）
- 不做企微和飞书之间的消息桥接（各自独立 chat state）
- 不做腾讯云函数中转（脱离本地部署哲学）
- 不做 100% 特性等价飞书 —— 企微 template_card 能力限制会导致部分交互降级

---

## 假设（用户已锁定 / 待确认）

| 项 | 值 | 依据 |
|---|---|---|
| 接入形态 | **企业自建应用** | 唯一支持 event 回调的模式；群机器人无双向 |
| 公网入口 | **cloudflared tunnel**（首选）；用户可换 ngrok / frp | 免费 / 免 VPS / macOS 一行命令 |
| 目标场景 | **1v1 应用消息 + 群聊消息**都支持 | 跟飞书对齐 |
| access_token | daemon 侧缓存 + 后台 60min 刷新（比 2h 有效期早）| 官方推荐 |
| 消息加解密 | 用 `@wecom/crypto` 或参考实现 wecom-crypto | 企微 event 是 AES 加密 |

---

## 用户故事

### US-1 · 从企微对话让 Mac tab 干活
> 我在企微 1v1 或群里 @企微应用「@ttys003 跑 npm test」，Mac ttys003 的 claude 收到命令。

**Acceptance**：
- 企微 event 到达 daemon 后经解密 → 走跟飞书同一份 dispatch 逻辑
- Mac tab 显示注入的命令（AppleScript do script）
- 收到「@ttys003 xxx」也解析成 target + text（复用现有 target.ts）

### US-2 · 任务完成推消息回企微
> claude tab 里跑完任务，调 `agent wecom send-text "结果摘要"` 推回原企微 chat。

**Acceptance**：
- 新 `agent wecom send-text/-file/-image` CLI 存在
- 自动反查 chat（复用 chat 追踪逻辑）
- 支持文本、文件（上传得 media_id 再发）、图片

### US-3 · 进度卡片降级但可用
> 长任务从企微发出，我在企微能看到进度更新（虽然卡片能力比飞书弱）。

**Acceptance**：
- 用 template_card（button 阵列 + emoji）近似渲染 progressCard
- Adaptive backoff + /quiet + 单卡 🔇 复用同一套逻辑
- pending 任务完成时更新最终状态

### US-4 · 交互式提问在企微降级
> 主 claude 想让用户从 3 个方案里选一个，在企微里也能选。

**Acceptance**：
- `agent wecom ask single --options a,b,c` → template_card 每选项一个 button
- multi 选：每按钮 toggle + 独立"提交"按钮（比飞书多几次交互）
- input 类型：card 提示 + 用户 chat 回文本，daemon 拦截作为答案
- 三种类型都能通过测试

### US-5 · 审批工作流对齐
> 高风险操作 `agent request-approval` 在企微下也弹一张审批卡，5 min 超时。

**Acceptance**：
- ApprovalManager 不改，只加个 wecom transport 侧的 buildApprovalCard
- 「批准 / 拒绝」两个 button
- 用户点后 daemon 走同一 resolve 路径

### US-6 · 首次启动自动化对齐
> daemon 启动时企微 skill / hooks / doctor 检测都跑一遍。

**Acceptance**：
- `packages/im-wecom` 装在包里，dev 启动就 attach transport（如果 .env 有企微凭证）
- `agent doctor` 加 wecom section：token 有效性、tunnel 可达、endpoint 已注册
- 缺 wecom 凭证不 die —— daemon 继续起，只是不 attach 企微

### US-7 · 两 IM 并行工作
> daemon 同时有飞书 WS 长连接 + 企微 HTTP webhook receiver，互不干扰。

**Acceptance**：
- 飞书 chat 里的操作不影响企微 chat
- 每个 chat state 各自独立 activeTty / quietMode / watchAllTabs
- 一个 IM 挂了不影响另一个

---

## 边缘 case / 已知限制

1. **企微不支持真 checkbox** → `ask multi` UX 会多次点。
2. **cloudflared 免费 URL 每次重启会变** → 用户重启后要在企微后台改 event URL；或者用 named tunnel（免费但要 CF 账号）。
3. **企微 access_token 30 万次/天限制** → 长期跑不能高频刷新，用缓存 + 提前 60min 刷新。
4. **文件大小**：企微上传 20MB 单文件；飞书 30MB。发大文件时可能报错。
5. **markdown 差异**：企微 markdown 支持子集，flavored 语法有差异（不支持表格、code fence 语言等）。发消息时降级 render 为纯文本。
6. **视频消息**：企微支持，飞书暂无。本项目不做，保持一致。

---

## 依赖

- **cloudflared** 用户机装（brew install cloudflare/cloudflare/cloudflared）
- npm packages：`@wecom/crypto` 或自实现 AES-CBC；`crypto`（Node 内置）；`axios` 或 `undici`（HTTP）

---

## Out of scope（明确不做）

- 移动端 SDK 集成
- 企业微信"打卡"/"审批"业务系统对接
- 与飞书用户/群的 identity 打通
- ServerLess / Docker 部署

---

## 验收（end-to-end）

用户从企微 1v1 或群里 @企微机器人：
```
@ttys003 帮我看下当前 git status
```
→ daemon 收到解密后的 event
→ AppleScript 注入 ttys003 tab
→ claude 执行 `git status` 并把结果通过 `agent wecom send-text` 推回企微
→ 用户在企微看到结果卡

10 分钟内首次跑通即通过验收。

---

## 下一步

- User review 本文件
- User 确认关键假设（企业自建应用 / cloudflared / 双场景）
- 通过后按 [design.md](./design.md) 开发
