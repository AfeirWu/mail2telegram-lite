# 📧 Mail2Telegram Lite (Cloudflare Worker)

一个极简、优雅、纯 Serverless 的 Gmail 转发至 Telegram 解决方案。
告别繁琐的 OAuth 认证、告别臃肿的 Webhook 交互配置。**只做一件事：毫秒级提取你的邮件正文，推送到 Telegram，并提供精美的网页版原文预览。**

## ✨ 为什么选择这个项目？
- **零服务器成本**：完全依托 Cloudflare Workers 边缘节点运行。
- **纯粹且安全**：无复杂的第三方依赖，代码极其精简，数据直接存入你的个人 CF KV 数据库。
- **直观的阅读体验**：在 Telegram 消息气泡内直接展示纯文字排版预览。
- **完美 HTML 渲染**：点击消息底部的按钮，即可在自定义域名下丝滑查看完整邮件排版（7天自动阅后即焚清理）。

## 🚀 部署指南 (3 分钟搞定)

### 1. 准备工作
- 一个托管在 Cloudflare 的域名。
- 一个 Telegram Bot Token（向 [@BotFather](https://t.me/botfather) 申请）。
- 你的 Telegram 账号 ID。

### 2. 部署 Worker
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/AfeirWu/mail2telegram-lite)

**方式一（一键部署）：** 点击上方按钮即可快速部署。

**方式二（手动部署）：**
1. 在 Cloudflare 控制台新建一个 Worker。
2. 复制本仓库 `worker.js` 中的代码，粘贴到 Worker 编辑器中并部署。

### 3. 配置环境变量 (Variables)
在 Worker 的 `Settings -> Variables & Secrets` 中添加以下变量：
- `TELEGRAM_TOKEN`：你的机器人 Token。
- `TELEGRAM_ID`：接收消息的账号数字 ID。
- `DOMAIN`：绑定给此 Worker 的自定义域名（如 `mail.yourdomain.com`，不带 https）。

### 4. 绑定 KV 数据库
1. 在 CF 控制台创建一个 KV 命名空间（比如叫 `gmail-db`）。
2. 回到 Worker 设置，在 `KV Namespace Bindings` 中绑定：
   - 变量名称 **必须填入** `DB`
   - 选择你创建的 `gmail-db`。

### 5. 设置邮件路由 (Email Routing)
在你的域名管理中，进入 `Email Routing`，添加一条路由规则，将你想接收邮件的地址（如 `alert@yourdomain.com`）转发到你刚刚部署的 Worker。

### 6. 设置邮件自动转发 (以 Gmail 为例)

1. 打开 [Gmail 设置页面](https://mail.google.com/mail/u/0/#settings/accounts)
2. 进入「账户和导入」标签页
3. 在「查看其他 Google 账户的设置」中选择你要转发的邮箱
4. 找到「转发和 POP/IMAP」部分，点击「添加转发地址」
5. 输入你在 Cloudflare Email Routing 中设置的目标邮箱（如 `alert@yourdomain.com`）
6. Gmail 会向该地址发送验证邮件，前往 CF Email Routing 的收件箱确认
7. 验证成功后，返回 Gmail，选择「将副本转发至」，选择刚才添加的转发地址
8. 可选：选择「删除 Gmail 的副本」或「保留 Gmail 的副本」
9. 保存设置

完成以上步骤后，当有邮件发送到你的转发地址，Cloudflare 会自动将其转发到 Worker，Worker 解析后推送到 Telegram。Enjoy! 🎉