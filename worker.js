/**
 * Cloudflare Worker - Mail2Telegram Lite
 * 一个极简、优雅、纯 Serverless 的 Gmail 转发至 Telegram 解决方案。
 * 支持内联网页预览，无多余数据库依赖。
 *
 * 参考了以下项目的设计：
 * - tbxark/mail2telegram: 直接返回原始邮件 HTML/text 的预览方案
 * - cloud-mail: ShadowHtml 组件使用 iframe srcdoc 做样式隔离的思路
 */

import PostalMime from 'postal-mime';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/init') {
      return new Response(JSON.stringify({ ok: true, result: true, msg: "Environment is ready. Send a test email!" }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

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

  async email(message, env, ctx) {
    const BOT_TOKEN = env.TELEGRAM_TOKEN;
    const CHAT_ID = env.TELEGRAM_ID;
    const DOMAIN = env.DOMAIN;

    if (!BOT_TOKEN || !CHAT_ID || !DOMAIN) {
      console.error("Missing Environment Variables: TELEGRAM_TOKEN, TELEGRAM_ID, or DOMAIN");
      return;
    }

    // 使用 postal-mime 解析邮件（参考 tbxark/mail2telegram）
    const email = await PostalMime.parse(message.raw);
    const textBody = email.text || "";
    const htmlBody = email.html || "";
    const subject = email.subject || decodeRfc2047(message.headers.get("subject")) || "无主题";
    const realFrom = message.headers.get("from") || "未知发件人";

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

    // 截取 TG 消息正文预览
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
// 参考 cloud-mail ShadowHtml 组件：使用 iframe srcdoc 做样式隔离
function buildEmailPage(htmlBody, meta) {
  const { subject, from } = meta;
  const escapedSubject = escapeHtml(subject);
  const escapedFrom = escapeHtml(from);

  const iframeHtml = buildIframeContent(htmlBody);

  // 用 JS scale 缩放：固定宽度 600px，等比缩放适配任意屏幕
  return `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedSubject}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; background-color: #f6f6f6; }
    .email-header {
      height: 64px;
      background-color: #f6f6f6;
      border-bottom: 1px solid #e8e8e8;
      padding: 0 16px;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
    .email-header h1 {
      font-size: 15px;
      font-weight: 600;
      color: #1a1a1a;
      line-height: 1.3;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .email-meta {
      font-size: 12px;
      color: #666;
      line-height: 1.4;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .email-meta strong { color: #333; }
    .email-iframe-wrap {
      height: calc(100vh - 64px);
      width: 100%;
      overflow: auto;
      -webkit-overflow-scrolling: touch;
      display: flex;
      justify-content: center;
    }
    .email-iframe-wrap iframe {
      border: none;
      display: block;
    }
  </style>
</head>
<body>
  <div class="email-header">
    <h1>${escapedSubject}</h1>
    <div class="email-meta">
      <strong>发件人：</strong>${escapedFrom}
    </div>
  </div>
  <div class="email-iframe-wrap">
    <iframe id="emailFrame" sandbox="allow-same-origin allow-popups" srcdoc="${escapeAttr(iframeHtml)}" loading="lazy"></iframe>
  </div>
  <script>
    (function() {
      var EMAIL_W = 600;
      var iframe = document.getElementById('emailFrame');
      var wrap = iframe.parentElement;
      function scale() {
        var ww = wrap.clientWidth;
        if (ww >= EMAIL_W) {
          iframe.style.width = EMAIL_W + 'px';
          iframe.style.height = 'auto';
          iframe.style.transform = 'none';
        } else {
          var s = ww / EMAIL_W;
          iframe.style.width = EMAIL_W + 'px';
          iframe.style.transform = 'scale(' + s + ')';
          iframe.style.transformOrigin = 'top left';
          iframe.style.height = (wrap.scrollHeight / s) + 'px';
        }
      }
      window.addEventListener('load', scale);
      window.addEventListener('resize', scale);
      // 延迟执行，等待 iframe 内容加载
      setTimeout(scale, 200);
    })();
  <\/script>
</body>
</html>`;
}

// 参考 cloud-mail ShadowHtml：清理危险内容 → 提取 body 内容 → 重置样式 → 包裹在独立容器中
function buildIframeContent(emailContent) {
  // 1. 清理 XSS 危险内容
  const cleaned = sanitizeHtml(emailContent);

  // 2. 提取 body 内容；没有 body 标签时移除 head 后保留其余
  let bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let innerContent;
  let bodyStyle = '';

  if (bodyMatch) {
    innerContent = bodyMatch[1];
    const bodyTagMatch = cleaned.match(/<body[^>]*style="([^"]*)"[^>]*>/i);
    bodyStyle = bodyTagMatch ? bodyTagMatch[1] : '';
  } else {
    innerContent = cleaned
      .replace(/<head[\s\S]*?<\/head>/i, '')
      .replace(/<\/html>/i, '')
      .replace(/<html[^>]*>/i, '');
  }

  // 3. 判断是否为纯文本（没有 HTML 标签则当纯文本处理）
  const isPlainText = !/<(img|a|table|div|p|br|span|b|i|strong|em|h[1-6]|ul|ol|li|blockquote)\b/i.test(innerContent);

  if (isPlainText) {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { margin: 0; padding: 16px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; font-size: 14px; line-height: 1.5; }
    pre { white-space: pre-wrap; word-break: break-word; margin: 0; }
  </style>
</head>
<body>
  <pre>${innerContent}</pre>
</body>
</html>`;
  }

  // 4. HTML 邮件：包裹在固定宽度容器中，由外层 scale 统一缩放适配屏幕
  // 外层 iframe srcdoc 隔离，外层 buildEmailPage 做整体缩放
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 600px; background-color: #ffffff; }
    .email-body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      color: #13181D;
      word-break: break-word;
      overflow-wrap: break-word;
      padding: 0;
      ${bodyStyle}
    }
  </style>
</head>
<body>
  <div class="email-body">
    ${innerContent}
  </div>
</body>
</html>`;
}

// 清理危险 HTML（防止 XSS）
function sanitizeHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/href\s*=\s*["']\s*javascript:[^"']*["']/gi, 'href=""')
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/url\s*\(\s*["']?\s*javascript:[^)]*["']?\s*\)/gi, 'url("")');
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
            .replace(/'/g, '&#039;')
            .replace(/\{/g, '&#123;');
}

// 解码 RFC 2047 编码的邮件头（如 =?UTF-8?B?...?=）
function decodeRfc2047(str) {
  if (!str) return null;
  // 匹配 =?charset?encoding?encoded-text?=
  return str.replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, function(match, charset, encoding, text) {
    try {
      if (encoding === 'B' || encoding === 'b') {
        // Base64 解码
        text = atob(text);
      } else {
        // Quoted-printable 解码
        text = text.replace(/=([0-9A-Fa-f]{2})/g, function(m, hex) {
          return String.fromCharCode(parseInt(hex, 16));
        }).replace(/=\r?\n/g, '');
      }
      // 转换为 UTF-8
      return decodeURIComponent(encodeURIComponent(text));
    } catch(e) {
      return match;
    }
  });
}

// iframe srcdoc 属性的转义：只需转义 & < > " 即可
function escapeAttr(value) {
  return value.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;');
}
