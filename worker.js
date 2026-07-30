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

// ================= 常量定义 =================
const PREVIEW_MAX_LENGTH = 2500;
const EMAIL_EXPIRE_TTL = 604800; // 7 days in seconds
const EMAIL_CONTAINER_MAX_WIDTH = '700px';

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

  async email(message, env) {
    const BOT_TOKEN = env.TELEGRAM_TOKEN;
    const CHAT_ID = env.TELEGRAM_ID;
    const DOMAIN = env.DOMAIN;

    if (!BOT_TOKEN || !CHAT_ID || !DOMAIN) {
      console.error("Missing Environment Variables: TELEGRAM_TOKEN, TELEGRAM_ID, or DOMAIN");
      return;
    }

    // 解析邮件
    const email = await PostalMime.parse(message.raw);
    const textBody = email.text || "";
    const htmlBody = email.html || "";
    const subject = email.subject || "无主题";
    const realFrom = message.headers.get("from") || message.from || "未知发件人";
    const realTo = message.headers.get("to") || message.to || "未知收件人";

    let previewLink = '';

    // KV 存储：可选，失败不影响主流程
    if (env.DB) {
      try {
        let displayHtml;
        if (htmlBody) {
          displayHtml = buildEmailPage(htmlBody, { subject, from: realFrom, to: realTo });
        } else {
          displayHtml = buildTextPage(textBody, { subject, from: realFrom, to: realTo });
        }

        const mailId = crypto.randomUUID();
        await env.DB.put(mailId, displayHtml, { expirationTtl: EMAIL_EXPIRE_TTL });
        previewLink = `https://${DOMAIN}/mail/${mailId}`;
      } catch (err) {
        console.error("KV storage failed:", err);
      }
    }

    // 截取 TG 消息正文预览
    let preview = textBody.trim();
    if (preview.length > PREVIEW_MAX_LENGTH) {
      preview = preview.substring(0, PREVIEW_MAX_LENGTH) + "\n\n... [Content truncated]";
    }

    // 收件人已在上方解析（构建邮件预览页时需要用到）

    // 防止 TG 自动识别链接：在 URL 字符间插入零宽空格
    preview = preview.replace(/(https?:\/\/[^\s<>"]+)/gi, (url) => {
      return url.split('').join('​');
    });

    let text = `📧 Gmail邮件通知\n\n📨 收件人: ${realTo}\n📧 主题: ${subject}\n👤 发件人: ${realFrom}\n\n${preview}`;

    // TG 消息总长度不能超过 4096
    const TG_MAX_LENGTH = 4096;
    if (text.length > TG_MAX_LENGTH) {
      text = text.substring(0, TG_MAX_LENGTH - 20) + "\n\n... [Message truncated]";
    }

    // 预览链接
    let replyMarkup;
    if (previewLink) {
      replyMarkup = {
        inline_keyboard: [[
          { text: "🌐 查看完整邮件内容", url: previewLink }
        ]]
      };
    }

    // 发送 TG 消息，保证必须成功
    const sendUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    let retries = 3;
    while (retries > 0) {
      try {
        const response = await fetch(sendUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: CHAT_ID,
            text: text,
            reply_markup: replyMarkup
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Telegram API error: ${response.status} - ${errorText}`);
        }

        break;
      } catch (err) {
        retries--;
        console.error(`Telegram send failed (${retries} retries left):`, err);
        if (retries === 0) {
          const errorText = `⚠️ 邮件通知发送失败\n\n📨 收件人: ${realTo}\n📧 主题: ${subject}\n👤 发件人: ${realFrom}\n\n错误: ${err.message}\n\n原始内容:\n${preview.substring(0, 1000)}`;
          await fetch(sendUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: CHAT_ID,
              text: errorText
            })
          });
        } else {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  }
};

// ================= 构建邮件 HTML 预览页面 =================
// 核心策略：
// 1) 保留邮件原始 <style>、<svg>、内联 width/height、class、style 属性
// 2) iframe 内置自适应缩放脚本：内容超出视口宽度时按比例缩放，杜绝横向滚动
// 3) 不使用 !important 覆盖原邮件样式，让邮件作者的设计意图优先
function buildEmailPage(htmlBody, meta) {
  const { subject, from, to } = meta;
  const escapedSubject = escapeHtml(subject);
  const escapedFrom = escapeHtml(from);
  const escapedTo = escapeHtml(to);

  const iframeHtml = buildIframeContent(htmlBody);

  return `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedSubject}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; background-color: #f6f6f6; }
    .email-container {
      max-width: ${EMAIL_CONTAINER_MAX_WIDTH};
      margin: 0 auto;
      background-color: #ffffff;
      height: 100%;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      display: flex;
      flex-direction: column;
    }
    .email-header {
      background-color: #f6f6f6;
      border-bottom: 1px solid #e8e8e8;
      padding: 16px 24px;
      flex-shrink: 0;
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
      flex: 1;
      width: 100%;
      min-height: 0;
      overflow: hidden;
    }
    .email-iframe-wrap iframe {
      width: 100%;
      height: 100%;
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
        <div><strong>发件人：</strong>${escapedFrom}</div>
        <div><strong>收件人：</strong>${escapedTo}</div>
      </div>
    </div>
    <div class="email-iframe-wrap">
      <iframe sandbox="allow-same-origin allow-popups" srcdoc="${escapeAttr(iframeHtml)}"></iframe>
    </div>
  </div>
</body>
</html>`;
}

// 构建 iframe 内部内容：保留原始样式 + 自动缩放响应式
function buildIframeContent(emailContent) {
  // 1. 清理 XSS 危险内容
  const cleaned = sanitizeHtml(emailContent);

  // 2. 提取 body 内容；没有 body 标签时移除 head 后保留其余
  let bodyMatch = cleaned.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  let innerContent;

  if (bodyMatch) {
    innerContent = bodyMatch[1];
  } else {
    innerContent = cleaned
      .replace(/<head[\s\S]*?<\/head>/i, '')
      .replace(/<\/html>/i, '')
      .replace(/<html[^>]*>/i, '');
  }

  // 3. 判断是否为纯文本（没有 HTML 标签则当纯文本处理）
  const isPlainText = !/<(img|a|table|div|p|br|span|b|i|strong|em|h[1-6]|ul|ol|li|blockquote|svg|td|tr)\b/i.test(innerContent);

  if (isPlainText) {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { margin: 0; padding: 16px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; font-size: 14px; line-height: 1.5; word-break: break-word; }
    pre { white-space: pre-wrap; word-break: break-word; margin: 0; }
  </style>
</head>
<body><pre>${escapeHtml(innerContent)}</pre></body>
</html>`;
  }

  // 4. HTML 邮件：保留所有原始样式，仅注入极简兜底
  // - 保留 <style>、<svg>、内联 width/height、class、style 属性
  // - 不使用 !important，让邮件原样式优先
  // - 自动缩放脚本：内容超出视口宽度时按比例缩小，确保不出现横向滚动条
  const innerHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">
  <style>
    html, body { margin: 0; padding: 0; }
    img, video { max-width: 100%; height: auto; }
  </style>
</head>
<body>
${innerContent}
<script>
(function() {
  // 自适应缩放：内容超出视口宽度时按比例缩小，确保不出现横向滚动条
  // 关键：必须用 CSS zoom（同步缩放布局与视觉），不能用 transform: scale
  // 因为 transform 只缩放视觉不改 layout，会导致 body 实际宽度仍超出 viewport，
  // 此时要么出现横向滚动条，要么被 overflow:hidden 裁掉真实内容。
  function fit() {
    var body = document.body;
    var docW = body.scrollWidth;
    var viewW = window.innerWidth;
    if (docW > viewW && viewW > 0) {
      body.style.zoom = (viewW / docW);
    } else {
      body.style.zoom = '';
    }
  }
  function run() {
    fit();
    // 图片等资源可能异步改变尺寸，延迟再调整
    setTimeout(fit, 100);
    setTimeout(fit, 500);
  }
  run();
  window.addEventListener('resize', run);
  window.addEventListener('load', run);
})();
</script>
</body>
</html>`;

  return innerHtml;
}

// 最小化清洗 HTML：只去除真正危险的内容，保留样式与图形
function sanitizeHtml(html) {
  return html
    // 危险脚本与对象
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[^>]*>/gi, '')
    .replace(/<applet[\s\S]*?<\/applet>/gi, '')
    // 危险的 meta / base / link（重定向、外部 CSS 加载）
    .replace(/<meta[^>]*http-equiv[^>]*>/gi, '')
    .replace(/<base[^>]*>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    // 事件属性
    .replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '')
    // javascript: 协议
    .replace(/href\s*=\s*["']\s*javascript:[^"']*["']/gi, 'href="#"')
    .replace(/src\s*=\s*["']\s*javascript:[^"']*["']/gi, 'src=""')
    // CSS 攻击向量
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/url\s*\(\s*["']?\s*javascript:[^)]*["']?\s*\)/gi, 'url()')
    // 显式保留：<style>、<svg>、width/height/class/style 属性
}

function buildTextPage(textBody, meta) {
  const { subject, from, to } = meta;
  const escapedSubject = escapeHtml(subject);
  const escapedFrom = escapeHtml(from);
  const escapedTo = escapeHtml(to);
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
      max-width: ${EMAIL_CONTAINER_MAX_WIDTH};
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
        <div><strong>发件人：</strong>${escapedFrom}</div>
        <div><strong>收件人：</strong>${escapedTo}</div>
      </div>
    </div>
    <div class="email-body">${escapedBody}</div>
  </div>
</body>
</html>`;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/`/g, '&#96;')
    .replace(/\{/g, '&#123;');
}

// iframe srcdoc 属性的转义：只需转义 & < > " 即可
function escapeAttr(value) {
  return value.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;');
}
