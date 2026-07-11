# 企业微信机器人配置 · 详细指南

> **实施状态** · Day 1-5 骨架已合入，能收发文本/文件/图片 + 收消息 → tab 派发。
> **未做（Day 6+）**：进度卡 render、Stop hook auto-push、chat state active/sticky、
> ask/approval 卡、群聊 target、doctor 检测。飞书链路完全不受影响。

---

## 你要准备的东西

### 一、企业微信侧

| 项目 | 说明 | 怎么拿 |
|---|---|---|
| 企业微信账号 | 手机装企业微信 App，登录 | 没有的话 → 用你手机号自己注册**个人企业**（可自用测试）|
| 管理员权限 | 能进入「管理后台」创建自建应用 | 个人企业你就是管理员；公司企业找 IT |
| CorpID | 你企业的唯一标识 | 后台 → 我的企业 → 企业信息 → 底部 |
| AgentID | 自建应用的编号 | 应用管理 → 你创建的应用 → 顶部 |
| Secret | 应用的密钥（**只显示一次，抄好**） | 应用详情 → 生成 Secret |
| Token | 接收消息的验签 token（自己生成） | 用 `openssl rand -hex 16` 生成，填到后台 |
| EncodingAESKey | 接收消息的加密 key | 后台「随机生成」按钮 → 43 位 base64 |

### 二、Mac 侧

| 项目 | 说明 |
|---|---|
| multiAgentChat 已跑通 | `pnpm dev` 起来了，飞书链路 OK |
| cloudflared（或 ngrok/frp）| 内网穿透工具，把 Mac localhost 暴露成公网 HTTPS |
| 一个稳定网络 | tunnel 断了企微 event 就收不到 |

### 三、可选（升级体验）

- Cloudflare 免费账号 + 域名 → named tunnel（URL 稳定不变，重启不换）

---

## 详细配置步骤（一步一步来）

### Step 1 · 创建/登录企业微信管理后台

1. 打开浏览器访问 <https://work.weixin.qq.com/>
2. 右上角「管理后台」
3. 用你的企业微信 App 扫码登录（如果还没企业 → 「立即注册」用手机号建个人企业）

### Step 2 · 拿 CorpID

1. 进入管理后台后，左侧菜单点 **「我的企业」**
2. 顶部子菜单 **「企业信息」**
3. 滚到页面**最底部**，找到「企业 ID」——形如 `wwxxxxxxxxxxxxxxxx`（**这是 CorpID**）
4. 抄下来

### Step 3 · 创建自建应用

1. 左侧菜单 **「应用管理」**
2. 子菜单 **「应用」** → 找到「自建」区块 → 点 **「创建应用」**
3. 填：
   - **应用 Logo**：随便传一张，或点「使用默认头像」
   - **应用名称**：如 `multiAgentChat`
   - **可见范围**：选**你自己**（后期可扩展到部门）—— 至少要有你自己，否则收不到你发的消息
4. 点「创建应用」
5. 跳转到应用详情页

### Step 4 · 拿 AgentID + Secret

在应用详情页：

- **AgentID**：页面顶部就是，形如 `1000002`（数字）—— 抄下来
- **Secret**：右侧「Secret」栏 → 点「查看」→ **验证方式**（企业微信 App 收验证码或指纹）→ 生成 Secret，形如 `xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
  - ⚠️ **只显示一次，立刻抄下**（丢了只能重新生成）

### Step 5 · 起 cloudflared tunnel（拿公网 URL）

在 Mac 上：

```bash
# 装 cloudflared
brew install cloudflare/cloudflare/cloudflared

# 起临时 tunnel（每次重启 URL 会变，先测试用）
cloudflared tunnel --url http://localhost:3939
```

输出会有类似：
```
Your quick Tunnel has been created! Visit it at:
https://random-words-abc-123.trycloudflare.com
```

**这个 URL 就是你要填到企微后台的公网入口**。抄下来。

> 💡 **想要稳定 URL 不变（推荐长期用）**：
> ```bash
> cloudflared tunnel login             # 浏览器登录 CF 账号（免费）
> cloudflared tunnel create mchat      # 创建 named tunnel
> cloudflared tunnel route dns mchat mchat.yourdomain.com   # 或用 CF 提供的免费域名
> cloudflared tunnel run mchat         # 起 tunnel
> ```
> named tunnel 的 URL 就是固定的 `mchat.yourdomain.com`。

**别关这个终端！** tunnel 要一直跑。可以另开一个 tab 继续操作。

### Step 6 · 生成 Token + EncodingAESKey

**Token**：随便生成一个 16-32 位随机字符串
```bash
openssl rand -hex 16
# 输出类似：a3f5c9e12b7d4680f1e8c3a9b5d7e0f2
```
抄下来。

**EncodingAESKey**：等 Step 7 里在企微后台「随机生成」。

### Step 7 · 企微后台配「接收消息」

回到企业微信管理后台的应用详情页：

1. 往下滚，找到 **「接收消息」**（有的版本叫「API 接收消息」）
2. 点右侧的**「设置 API 接收」**（或「启用 API 接收」）
3. 弹出配置窗口，填：
   - **URL**：`https://<Step 5 的 tunnel URL>/wecom/event`
     - 例：`https://random-words-abc-123.trycloudflare.com/wecom/event`
     - ⚠️ 结尾必须是 `/wecom/event`（这是 daemon 里 event server 监听的路径）
   - **Token**：粘贴 Step 6 生成的
   - **EncodingAESKey**：点旁边的**「随机生成」**按钮 → 生成 43 位 base64 字符串 → 抄下来
4. **先别点「保存」** —— daemon 还没起，会 URL 校验失败。**先做完 Step 8**。

### Step 8 · 填 .env

编辑项目根目录的 `.env`（daemon 首次跑没这文件会自动 cp .env.example）：

```bash
# ============= 已有的飞书凭证保留 =============
LARK_APP_ID=cli_xxxxxxxxxxxxxxxx
LARK_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# ============= 新加：企业微信 5 项 =============
WECOM_CORP_ID=wwxxxxxxxxxxxxxxxx           # Step 2 的
WECOM_AGENT_ID=1000002                     # Step 4 的（数字）
WECOM_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx  # Step 4 的
WECOM_TOKEN=a3f5c9e12b7d4680f1e8c3a9b5d7e0f2   # Step 6 的
WECOM_AES_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx  # Step 7 生成的 43 位

# 端口默认 3939，除非跟别的服务冲突不用改
# WECOM_CALLBACK_HTTP_PORT=3939

# 可选：doctor 用来检查 tunnel 可达性
# WECOM_CALLBACK_URL=https://random-words-abc-123.trycloudflare.com

# 兜底 target：CLI 里 --chat 不给时发到谁；@all 是全部可见范围内成员
# 或者填一个 userid（在通讯录里能查到）
WECOM_DEFAULT_TO_USER=@all
```

⚠️ **.env 千万别提交 git**（`.gitignore` 已经排除）。

### Step 9 · 重启 daemon

```bash
# 停当前 dev（Ctrl+C）后
pnpm dev
```

期望看到（**顺序可能有差异**）：
```
[INFO] wecom event server listening { port: 3939, path: '/wecom/event' }
[INFO] wecom access_token refreshed { expiresInSec: 7200, corpId: 'wwxxxx' }
[INFO] wecom transport attached { corpId, agentId, port: 3939 }
```

如果看到：
```
[INFO] wecom transport 未 attach（缺 WECOM_CORP_ID/AGENT_ID/SECRET/TOKEN/AES_KEY 任一）
```
→ `.env` 里 5 项没填全，重回 Step 8 检查。

如果看到：
```
[WARN] wecom access_token 首次拉取失败（凭证可能有误）
```
→ CorpID / Secret 抄错了；或者应用「可见范围」没加你自己。

### Step 10 · 回到企微后台点「保存」

刚才 Step 7 让你先别点保存。现在 daemon 起来了：

1. 回到企业微信后台的「接收消息」配置窗口
2. 确认 URL / Token / EncodingAESKey 都填对
3. 点 **「保存」**

企微会向你的 URL 发 GET 做**首次校验**（带 echostr 参数，加密的）。daemon 侧 `crypto.ts` 解密后回明文。成功 → 后台显示「已启用」。

daemon log 会有：
```
[INFO] wecom URL verified { echostrLen: xxx }
```

**如果失败**（后台报「回调 URL 无法访问」或「验证 URL 失败」）：
- tunnel 是不是还活着？浏览器打开 `https://xxx.trycloudflare.com/wecom/event`（GET）应该返回 401 或空
- Token / AESKey 是不是复制少了空格？
- daemon log 有没有 `wecom URL verify failed` 详情？

### Step 11 · 发一条测试消息

在**手机上的企业微信 App** 里：

1. 打开你刚建的应用（工作台 → 你的应用图标）
2. 或者直接在企业微信主界面搜索应用名字
3. 给应用发一条消息：
   ```
   @ttys003 ls -la
   ```
   （替换 `ttys003` 为你 Mac 上实际的 tab tty；不知道就先 `agent tabs` 看）

**期望结果**：
- Mac ttys003 那个 tab 里 `ls -la` 命令跑起来（AppleScript 会把该 tab 拉到前台闪一下）
- 手机企业微信里收到一条回执：`✓ 已注入到 ttys003 (cwd) · 命令：ls -la`

daemon log 会有：
```
[INFO] wecom message received { chatId: 'wecom:user:XXX', textPreview: '@ttys003 ls -la' }
```

---

## 常见踩坑

| 症状 | 可能原因 | 解 |
|---|---|---|
| `wecom transport 未 attach` | .env 5 项没填全 | Step 8 检查 5 项都填了 |
| `wecom access_token 首次拉取失败` | CorpID / Secret 错，或应用可见范围没你 | Step 3 应用「可见范围」加你自己 + Step 2/4 重抄 |
| 后台保存 URL 报「无法访问」 | tunnel 挂了 / URL 打错 / 结尾不是 `/wecom/event` | 浏览器直接访问 URL 看 daemon 有没有 log |
| 后台保存报「校验失败」 | Token / AESKey 抄错 | 重抄一遍，注意别多空格 |
| 消息发出去 daemon 没反应 | 「可见范围」不含你，或 tunnel 断了 | 检查企微 app 里能不能看见应用；`ps aux \| grep cloudflared` |
| Mac tab 没接收命令 | AppleScript 权限没授 | 系统设置 → 隐私 → Accessibility → 加 Terminal |
| 回执乱码 | 消息文本中有非 UTF-8 | 目前不太可能，检查 log |
| `wecom message received` 但 tab 没动 | `@target` 匹配不到 | 用 `agent tabs` 看当前 tty；确保 target 是准确的 tty 短名 |
| tunnel URL 重启变了 | cloudflared 临时 tunnel 特性 | Step 5 备选：named tunnel（一次性配好）|

---

## 当前限制

**Day 5 v1 版本已知短板**：
- **必须 `@target text` 格式**：没有 activeTty / sticky（连发多命令要每次都 @）
- **没有进度卡**：只回一条"✓ 已注入"文本，看不到长任务进度
- **Stop hook 不自动推**：claude turn 结束不会自动推最后响应给企微
- **没有 ask / approval 卡**：要用户选项 / 请求审批只能靠飞书或降级文本
- **群聊 target 未接**：只支持 1v1 应用消息
- **cardAction 只 log**：template_card 按钮点击不接 handler
- **doctor 没加 wecom section**：agent doctor 看不到企微健康度

要**Day 6+ 补齐**上面这些，让 UX 接近飞书。

---

## 日常维护

- **tunnel 一直要跑**：用 launchd 或 tmux/screen 常驻，别关那个终端
- **Secret 泄漏了**：企微后台重新生成 Secret，改 .env 里的 `WECOM_SECRET`，重启 daemon
- **AESKey 换了**：改 .env `WECOM_AES_KEY`，重启 daemon
- **换 tunnel URL**：临时 tunnel 每次重启都变 —— 后台改「接收消息」的 URL 保存一次

---

## 参考

- 企业微信开放平台文档：<https://developer.work.weixin.qq.com/document/path/90236>
- 消息加解密方案：<https://developer.work.weixin.qq.com/document/path/90968>
- cloudflared 官网：<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/>
