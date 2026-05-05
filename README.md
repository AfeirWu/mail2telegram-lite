# 📧 Mail2Telegram Lite (Cloudflare Worker)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/AfeirWu/mail2telegram-lite)

一个极简、优雅、纯 Serverless 的 Gmail 转发至 Telegram 解决方案。
告别繁琐的 OAuth 认证、告别臃肿的 Webhook 交互配置。**只做一件事：毫秒级提取你的邮件正文，推送到 Telegram，并提供精美的网页版原文预览。**

## ✨ 为什么选择这个项目？
- **零服务器成本**：完全依托 Cloudflare Workers 边缘节点运行。
- **纯粹且安全**：无复杂的第三方依赖，代码极其精简，数据直接存入你的个人 CF KV 数据库。
- **直观的阅读体验**：在 Telegram 消息气泡内直接展示纯文字排版预览。
- **完美 HTML 渲染**：点击消息底部的按钮，即可在自定义域名下丝滑查看完整邮件排版（7天自动阅后即焚清理）。

## 🚀 一键部署 (推荐)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/AfeirWu/mail2telegram-lite)

点击上方按钮，即可自动将此 Worker 部署到你的 Cloudflare 账号。部署后请参考下方「配置环境变量」和「绑定 KV 数据库」步骤完成设置。

---

## 🚀 手动部署指南 (3 分钟搞定)

### 1. 准备工作
- 一个托管在 Cloudflare 的域名。
- 一个 Telegram Bot Token（向 [@BotFather](https://t.me/botfather) 申请）。
- 你的 Telegram 账号 ID。

### 2. 部署 Worker
1. 在 Cloudflare 控制台新建一个 Worker。
2. 复制 `worker.js` 中的代码，粘贴并部署。

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

最后，去你的主力邮箱设置自动转发即可！Enjoy! 🎉