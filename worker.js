/**
 * Cloudflare Worker - Mail2Telegram Lite
 * 一个极简、优雅、纯 Serverless 的 Gmail 转发至 Telegram 解决方案。
 * 支持内联网页预览，无多余数据库依赖。
 *
 * 参考了以下项目的设计：
 * - tbxark/mail2telegram: 直接返回原始邮件 HTML/text 的预览方案
 * - cloud-mail: ShadowHtml 组件使用 iframe srcdoc 做样式隔离的思路
 */

// ================= 依赖：使用 postal-mime 解析邮件 =================
// 已在 wrangler.toml 中配置 externals = ["postal-mime"]
import PostalMime from 'postal-mime';

export default {
  // ================= 1. HTTP 路由处理 (用于网页查看完整邮件) =================
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/init') {
      return new Response(JSON.stringify({ ok: true, result: true, msg: "Environment is ready. Send a test email!" }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    // 处理"查看完整网页版邮件"的请求
    if (url.pathname.startsWith('/mail/')) {
      if (!env.DB) {
        return new Response("<h2>网页预览功能未启用</h2><p>请在 Worker 设置中绑定 KV 数据库以启用此功能。</p>", {
          status: 503,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
      const id = url.pathname.replace('/mail/', '');
      const html = await env.DB.get(id);
      if (!html) {
        return new Response("<h2>Email expired or not found.</h2><p>For storage optimization, emails are only kept for 7 days.</p>", {
          status: 404,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    return new Response("Mail2Telegram Worker is running.", { status: 200 });
  },

  // ================= 2. 邮件接收与推送处理 =================
  async email(message, env, ctx) {
    const BOT_TOKEN = env.TOKEN;
    const CHAT_ID = env.TELEGRAM_ID;
    const DOMAIN = env.DOMAIN;

    if (!BOT_TOKEN || !CHAT_ID || !DOMAIN) {
      console.error("Missing Environment Variables: TELEGRAM_TOKEN, TELEGRAM_ID, or DOMAIN");
      return;
    }

    const realFrom = message.headers.get("from") || message.from;
    const subject = message.headers.get("subject") || "No Subject";

    // 使用 postal-mime 解析邮件（参考 tbxark/mail2telegram 的写法）
    const rawEmail = await new Response(message.raw).text();
    const email = await PostalMime.parse(rawEmail);

    const textBody = email.text || "";
    const htmlBody = email.html || "";

    // KV 可选：绑定了则支持查看完整邮件功能
    const mailId = env.DB ? crypto.randomUUID() : null;
    if (env.DB) {
      let displayHtml;
      if (htmlBody) {
        displayHtml = buildEmailPage(htmlBody, { subject, from: realFrom });
      } else {
        displayHtml = buildTextPage(textBody, { subject, from: realFrom });
      }
      await env.DB.put(mailId, displayHtml, { expirationTtl: 604800 });
    }

    // 截取 TG 消息正文预览 (TG 单条消息有长度限制)
    let preview = textBody;
    if (preview.length > 2500) {
      preview = preview.substring(0, 2500) + "\n\n... [Content truncated]";
    }

    const text = `📧 Gmail邮件通知\n\n主题:\n${subject}\n\n正文:\n${preview}\n\n---\n发件人: ${realFrom}`;

    const replyMarkup = mailId ? {
      inline_keyboard: [[
        { text: "🌐 查看完整邮件内容", url: `https://${DOMAIN}/mail/${mailId}` }
      ]]
    } : undefined;

    const sendUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    await fetch(sendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: text,
        reply_markup: replyMarkup
      })
    });
  }
};

// ================= 构建邮件 HTML 预览页面 =================
// 参考 cloud-mail 的 ShadowHtml 组件：使用 iframe srcdoc 做样式隔离
// iframe 内部是完全独立的 HTML 文档，邮件 CSS 不会影响外部页面

function buildEmailPage(htmlBody, meta) {
  const { subject, from } = meta;
  const escapedSubject = escapeHtml(subject);
  const escapedFrom = escapeHtml(from);

  // 提取邮件正文内容
  const emailContent = extractEmailBody(htmlBody);

  // 构建 iframe 内部 HTML（参考 cloud-mail ShadowHtml 的处理方式）
  const iframeHtml = buildIframeContent(emailContent);

  // 外部容器（header + iframe）
  return `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedSubject}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background-color: #f6f6f6; }
    .email-container {
      max-width: 700px;
      margin: 0 auto;
      background-color: #ffffff;
      min-height: 100vh;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }
    .email-header {
      background-color: #f6f6f6;
      border-bottom: 1px solid #e8e8e8;
      padding: 16px 24px;
    }
    .email-header h1 {
      font-size: 18px;
      font-weight: 600;
      color: #1a1a1a;
      margin-bottom: 8px;
      line-height: 1.4;
    }
    .email-meta {
      font-size: 13px;
      color: #666;
      line-height: 1.6;
    }
    .email-meta strong { color: #333; }
    .email-iframe-wrap {
      width: 100%;
      min-height: 300px;
    }
    .email-iframe-wrap iframe {
      width: 100%;
      border: none;
      display: block;
    }
  </style>
</head>
<body>
  <div class="email-container">
    <div class="email-header">
      <h1>${escapedSubject}</h1>
      <div class="email-meta">
        <strong>发件人：</strong>${escapedFrom}
      </div>
    </div>
    <div class="email-iframe-wrap">
      <iframe sandbox="allow-same-origin allow-popups" srcdoc="${iframeHtml}" loading="lazy"></iframe>
    </div>
  </div>
</body>
</html>`;
}

// 参考 cloud-mail ShadowHtml 组件的 iframe 内容构建方式
// 核心思路：从邮件 HTML 中提取 <body> 内部内容，
// 重置样式后包裹在独立样式的容器中
function buildIframeContent(emailContent) {
  // 提取 body 标签上的 style 属性（参考 cloud-mail）
  const bodyStyleMatch = emailContent.match(/<body[^>]*style="([^"]*)"[^>]*>/i);
  const bodyStyle = bodyStyleMatch ? bodyStyleMatch[1] : '';

  // 移除 body 标签，保留内部内容
  const cleanedHtml = emailContent.replace(/<\/?body[^>]*>/gi, '');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    /* 全局重置：隔离邮件样式（参考 cloud-mail ShadowHtml） */
    * { box-sizing: border-box; margin: 0; padding: 0; }
    h1, h2, h3, h4 { font-size: 18px; font-weight: 700; margin: 0 0 0.5em 0; }
    p { margin: 0 0 1em 0; line-height: 1.5; }
    a { color: #0E70DF; text-decoration: none; }
    img { max-width: 100%; height: auto; }
    table { border-collapse: collapse; max-width: 100%; }
    td, th { word-break: break-word; }
    /* 邮件容器 */
    .email-body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
                   'Helvetica Neue', Arial, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      color: #13181D;
      word-break: break-word;
      overflow-wrap: break-word;
      padding: 0;
      ${bodyStyle}
    }
    .email-body > * { max-width: 100%; }
    .email-body table img { max-width: none; }
    .email-body td {
      border: 1px solid #e0e0e0;
      padding: 4px 8px;
    }
  </style>
</head>
<body>
  <div class="email-body">
    ${cleanedHtml}
  </div>
</body>
</html>`;
}

// 从邮件 HTML 中提取 <body> 内部内容，参考 cloud-mail ShadowHtml 的做法
// 如果没有 <body> 标签，则移除 <head> 后保留其余内容
function extractEmailBody(html) {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    return bodyMatch[1];
  }
  // 没有 body 标签时：移除 head，保留其余
  let content = html.replace(/<head[\s\S]*?<\/head>/i, '');
  content = content.replace(/<\/html>/i, '').replace(/<html[^>]*>/i, '');
  return content;
}

// 清理危险 HTML（防止 XSS，参考现代邮件处理规范）
function sanitizeHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/\s+href\s*=\s*["']\s*javascript:[^"']*["']/gi, '')
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/url\s*\(\s*["']?\s*javascript:[^)]*["']?\s*\)/gi, 'url()');
}

function buildTextPage(textBody, meta) {
  const { subject, from } = meta;
  const escapedSubject = escapeHtml(subject);
  const escapedFrom = escapeHtml(from);
  const escapedBody = escapeHtml(textBody);
  return `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedSubject}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background-color: #f6f6f6; }
    .email-container {
      max-width: 700px;
      margin: 0 auto;
      background-color: #ffffff;
      min-height: 100vh;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }
    .email-header {
      background-color: #f6f6f6;
      border-bottom: 1px solid #e8e8e8;
      padding: 16px 24px;
    }
    .email-header h1 {
      font-size: 18px;
      font-weight: 600;
      color: #1a1a1a;
      margin-bottom: 8px;
      line-height: 1.4;
    }
    .email-meta {
      font-size: 13px;
      color: #666;
      line-height: 1.6;
    }
    .email-meta strong { color: #333; }
    .email-body {
      padding: 24px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      color: #222;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
  </style>
</head>
<body>
  <div class="email-container">
    <div class="email-header">
      <h1>${escapedSubject}</h1>
      <div class="email-meta">
        <strong>发件人：</strong>${escapedFrom}
      </div>
    </div>
    <div class="email-body">${escapedBody}</div>
  </div>
</body>
</html>`;
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;')
             .replace(/</g, '&lt;')
             .replace(/>/g, '&gt;')
             .replace(/"/g, '&quot;')
             .replace(/'/g, '&#039;');
}
