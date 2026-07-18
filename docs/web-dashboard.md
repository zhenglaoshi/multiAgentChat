# Web Dashboard · 手机浏览器直控 Mac

> Tailscale 网络内，手机浏览器打开一个 URL 就能见 Mac 所有 tab、抓屏、派命令、跑 slash。

## 为啥要这个

- **飞书/企微通道**：适合"扔个命令 + 收结果"，但要看 tab 状态 / 抓屏 / 快速切换不方便
- **VNC**：全桌面能控但手机戳小按钮累
- **Web dashboard**：手机浏览器一屏见 Mac 全貌 + 一键抓屏 + 命令面板 + SSE 实时更新

## 前提

- Tailscale 已装（手机 + Mac 同一 tailnet）
- daemon 已跑（`pnpm dev`）
- 生成一个 32 位随机 token 作为鉴权

## 一次性配置

### Step 1 · 生成 token 填 .env

```bash
# 生一个 32 位 hex（也可用你喜欢的密码）
openssl rand -hex 32
# → 例如 4b2c8a9e5f1d3b7a6c9d0e2f4a8b1c3d5e7f9a2b4c6d8e0f1a3b5c7d9e0f2a4b
```

编辑 `.env` 加：
```env
WEB_DASHBOARD_TOKEN=<上面生成的 hex>
WEB_DASHBOARD_PORT=3940         # 可选，默认 3940
WEB_DASHBOARD_BIND=0.0.0.0      # 可选，Tailscale 场景保持 0.0.0.0
```

### Step 2 · 重启 dev

```bash
pnpm dev
# 期望看到：
# [INFO] web-dashboard listening { bind: '0.0.0.0', port: 3940, tokenPreview: '4b2c…' }
# [INFO] web-dashboard 就绪 · 手机浏览器打开 { url: 'http://<mac-name>:3940/#token=<TOKEN>' }
```

### Step 3 · 手机浏览器打开

拼 URL：
```
http://<mac-tailscale-name>:3940/#token=<WEB_DASHBOARD_TOKEN>
```

例：`http://zhengjiquandeMacBook-Pro:3940/#token=4b2c8a9e5f1d3b7a...`

如果 Tailscale MagicDNS 没开，用 IP：`tailscale ip -4` 拿 Mac IP → `http://100.x.x.x:3940/#token=...`

**加书签**，之后一键打开。

## 页面能干什么

▸ **Tabs 列表**：Mac 上所有 Terminal tab + 状态（busy/idle/claude TUI）；点某行选中它

▸ **详情面板**（点了某 tab 才出）：
  - 派命令：输入框 + 「发送」按钮（跟飞书 `@target text` 效果一样，含 claude TUI forceEnter）
  - 📸 抓屏：一键调 `captureScreen` → base64 内嵌 PNG 直接看
  - 📜 History：查看 tab 最近 100 行 tail
  - ⏎ Enter · ⊘ Ctrl-C：常用按键快捷发

▸ **Pending 任务**：当前活跃 pending（含飞书/企微/local 触发的都在）

▸ **Quick Slash Commands**：`/dashboard` `/shells` `/where` `/watch on/off` `/quiet on/off` 一键跑，结果显示在 log 面板

▸ **SSE 实时更新**：pending / tabs 变化 3s 一次事件流推送（比轮询快）

## 安全模型

- **鉴权**：Bearer token（写死在 .env）。所有 API 请求必须带 `Authorization: Bearer <token>` 或 `?token=<xxx>`
- **URL fragment**：HTML 页从 `location.hash` 读 token，不会随 request 发出（server 拿不到 fragment）
- **网络暴露**：默认 bind 0.0.0.0，靠 Tailscale ACL / 防火墙保护。**不要把 :3940 直接暴露到公网**（除非另加 HTTPS + 反向代理）
- **token 泄漏**：跟 SSH key 泄漏一样，重新生成填 .env 重启即可

## 常见踩坑

| 问题 | 原因 | 解 |
|---|---|---|
| 手机打开 URL 报 `no token` | fragment 没带对 | URL 结尾要有 `#token=<xxx>` 而不是 `?token=` |
| 401 unauthorized | token 不匹配 | 检查 .env 里的 WEB_DASHBOARD_TOKEN 和 URL 里的 hex 一致 |
| 页面加载但 API 全 401 | HTML 侧 JS 读 hash 出错 | 打开浏览器 DevTools console 看有没有报错 |
| 手机连不上 | Tailscale VPN 没开 | 手机 Tailscale app 打开 toggle |
| 抓屏失败 | Screen Recording 权限没授 | System Settings → Privacy → Screen Recording |
| 抓屏图很大 | 4K/Retina 全窗口 png 可能 5MB+ | 已降采样：`sips` → 1200px 宽 + JPEG 75%（Retina png 13MB → jpg 100-400KB） |

## 未做（下期）

- Voice input（浏览器 SpeechRecognition API）
- 命令历史 / 收藏
- 多 tab 并列显示（当前只单选详情）
- SSE 精细化（真接 watcher.events 而不是 3s tick）
- HTTPS 支持（当前 http 走 Tailscale 加密就够）
