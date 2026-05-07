/**
 * Cloudflare Worker - Mail2Telegram Lite
 * 一个极简、优雅、纯 Serverless 的 Gmail 转发至 Telegram 解决方案。
 * 支持内联网页预览，无多余数据库依赖。
 * 测试自动部署 - 2026-05-07
 */

export default {
  // ================= 1. HTTP 路由处理 (用于网页查看完整邮件) =================
  async fetch(request, env) {
    const url = new URL(request.url);

    // 兼容原版的初始化路径，防止报错
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

    // 获取真实的原始发件人和主题
    const realFrom = message.headers.get("from") || message.from;
    const subject = message.headers.get("subject") || "No Subject";

    const rawEmail = await new Response(message.raw).text();
    const { textBody, htmlBody } = parseEmail(rawEmail);

    // KV 可选：绑定了则支持查看完整邮件功能
    const mailId = env.DB ? crypto.randomUUID() : null;
    if (env.DB) {
      let displayHtml;
      if (htmlBody) {
        // 保留原邮件 HTML，包裹一层响应式容器
        displayHtml = buildEmailPage(htmlBody, { subject, from: realFrom });
      } else {
        // 纯文本邮件，生成简洁的阅读页面
        displayHtml = buildTextPage(textBody, { subject, from: realFrom });
      }
      await env.DB.put(mailId, displayHtml, { expirationTtl: 604800 });
    }

    // 截取 TG 消息正文预览 (TG 单条消息有长度限制)
    let preview = textBody;
    if (preview.length > 2500) {
      preview = preview.substring(0, 2500) + "\n\n... [Content truncated]";
    }

    // 拼装 TG 消息格式 (极简排版)
    const text = `📧 Gmail邮件通知\n\n主题:\n${subject}\n\n正文:\n${preview}\n\n---\n发件人: ${realFrom}`;

    // 构建内联按钮（KV 未绑定时隐藏"查看完整邮件"按钮）
    const replyMarkup = mailId ? {
      inline_keyboard: [[
        { text: "🌐 查看完整邮件内容", url: `https://${DOMAIN}/mail/${mailId}` }
      ]]
    } : undefined;

    // 调用 Telegram API 发送消息并附带内联按钮
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    await fetch(url, {
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

// ================= 底层解析逻辑 (分离文本与HTML) =================
function parseEmail(raw) {
  let textBody = "";
  let htmlBody = "";

  try {
    // 获取 Content-Type 判断邮件类型
    const contentTypeMatch = raw.match(/content-type:\s*([^\r\n]+)/i);
    const contentType = contentTypeMatch ? contentTypeMatch[1].toLowerCase() : '';

    // 检测是否为 multipart 邮件
    const isMultipart = raw.match(/boundary=["']?([^"'\r\n]+)["']?/i);

    // 单段式邮件（不是 multipart）
    if (!isMultipart) {
      if (contentType.includes('text/html')) {
        htmlBody = decodePart(raw);
        textBody = stripHtml(htmlBody);
      } else if (contentType.includes('text/plain')) {
        textBody = decodePart(raw);
      }
      // 其他情况（attachments 等），尝试在 raw 中找 HTML/plain 部分
      if (!htmlBody && !textBody) {
        if (contentType.includes('text/html') || raw.toLowerCase().includes('content-type: text/html')) {
          htmlBody = decodePart(raw);
          textBody = stripHtml(htmlBody);
        } else if (contentType.includes('text/plain') || raw.toLowerCase().includes('content-type: text/plain')) {
          textBody = decodePart(raw);
        }
      }
      return {
        textBody: textBody.trim() || "No preview available.",
        htmlBody: htmlBody
      };
    }

    // 多段式邮件解析：先用 boundary 分割
    let boundary = isMultipart[1];
    // 转义 boundary 中的特殊字符用于正则
    let escapedBoundary = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let parts = raw.split(new RegExp(`--${escapedBoundary}`));

    for (let part of parts) {
      if (!part || part.trim() === '') continue;

      const partLower = part.toLowerCase();
      const partTypeMatch = part.match(/content-type:\s*([^\r\n]+)/i);
      const partType = partTypeMatch ? partTypeMatch[1].toLowerCase() : '';

      // 跳过附件
      if (partType.includes('multipart') || partType.includes('image') || partType.includes('application')) {
        continue;
      }

      if (partType.includes('text/plain') && !textBody) {
        textBody = decodePart(part);
      } else if (partType.includes('text/html') && !htmlBody) {
        htmlBody = decodePart(part);
      }
    }

    // 降级处理：如果没有纯文本版本，从 HTML 剥离标签作为预览
    if (!textBody && htmlBody) {
      textBody = stripHtml(htmlBody);
    }
    // 降级处理：如果没有 HTML 但有纯文本
    if (!htmlBody && textBody) {
      // 不再自动生成 HTML，保持 htmlBody 为空，让外层处理
    }
  } catch (e) {
    console.error("Parse Error:", e);
  }

  return {
    textBody: textBody.trim() || "No preview available.",
    htmlBody: htmlBody
  };
}

function stripHtml(html) {
  return html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, '\n')
            .replace(/\n\s*\n/g, '\n')
            .trim();
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;')
             .replace(/</g, '&lt;')
             .replace(/>/g, '&gt;')
             .replace(/"/g, '&quot;')
             .replace(/'/g, '&#039;');
}

function decodePart(part) {
   let splitMatch = part.match(/\r?\n\r?\n/);
   if (!splitMatch) return "";
   let headers = part.substring(0, splitMatch.index).toLowerCase();
   let body = part.substring(splitMatch.index + splitMatch[0].length);
   
   if (headers.includes("content-transfer-encoding: base64")) {
       try {
           let binary = atob(body.replace(/\s+/g, ''));
           let bytes = new Uint8Array(binary.length);
           for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
           return new TextDecoder('utf-8').decode(bytes);
       } catch(e) { return body; }
   } else if (headers.includes("content-transfer-encoding: quoted-printable")) {
       try {
           // 正确的 quoted-printable 解码：
           // 1. 软换行（=/r/n 或 =/n）删除
           // 2. =XX 转为 Latin-1 字节
           // 3. Latin-1 字节数组用 UTF-8 解码
           let qpBody = body
             .replace(/=\r?\n/g, '')  // 软换行（删除）
             .replace(/=([0-9A-Fa-f]{2})/g, (match, hex) => {
               return String.fromCharCode(parseInt(hex, 16));
             });
           let bytes = new Uint8Array(qpBody.length);
           for (let i = 0; i < qpBody.length; i++) bytes[i] = qpBody.charCodeAt(i);
           return new TextDecoder('utf-8').decode(bytes);
       } catch(e) { return body; }
   }
   return body;
}

// ================= 构建邮件 HTML 预览页面 =================
// 使用 iframe srcdoc 方案实现样式隔离，参考 cloud-mail 的 ShadowHtml 组件思路
// 但在 Cloudflare Worker 环境下使用 srcdoc 而非 Shadow DOM
function buildEmailPage(htmlBody, meta) {
  const { subject, from } = meta;
  const escapedSubject = escapeHtml(subject);
  const escapedFrom = escapeHtml(from);

  // 提取邮件正文
  let emailContent = htmlBody;
  const bodyMatch = htmlBody.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    emailContent = bodyMatch[1];
  } else {
    emailContent = htmlBody.replace(/<head[\s\S]*?<\/head>/i, '');
    emailContent = emailContent.replace(/<\/html>/i, '').replace(/<html[^>]*>/i, '');
  }

  // 清理危险内容（script 标签、on* 属性、javascript: 协议等）
  emailContent = sanitizeHtml(emailContent);

  // iframe 内使用的邮件内容样式（完全独立，不会影响外部）
  const iframeHtml = buildIframeContent(emailContent);

  // 外部容器：固定宽度容器 + 底部 header
  // 注意：iframe srcdoc 不需要 HTML 转义，直接塞原始 HTML 即可
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
      <iframe id="email-frame" sandbox="allow-same-origin allow-popups" srcdoc="${iframeHtml}" loading="lazy"></iframe>
    </div>
  </div>
</body>
</html>`;
}

// 构建 iframe 内部 HTML（邮件渲染在独立域中，天然样式隔离）
function buildIframeContent(emailContent) {
  // 提取 body 标签上的 style 属性，合并到 .email-body 上
  const bodyStyleMatch = emailContent.match(/<body[^>]*style="([^"]*)"[^>]*>/i);
  const bodyStyle = bodyStyleMatch ? bodyStyleMatch[1] : '';

  // 移除 body 标签（保留内容）
  let cleanContent = emailContent.replace(/<\/?body[^>]*>/gi, '');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    /* === 全局重置：隔离邮件样式 === */
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    h1, h2, h3, h4, h5, h6 {
      font-size: 18px;
      font-weight: 700;
      margin: 0 0 0.5em 0;
    }
    p {
      margin: 0 0 1em 0;
      line-height: 1.5;
    }
    a {
      color: #0E70DF;
      text-decoration: none;
    }
    img {
      max-width: 100%;
      height: auto;
    }
    table {
      border-collapse: collapse;
      max-width: 100%;
    }
    td, th {
      word-break: break-word;
    }
    /* === 邮件容器 === */
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
    .email-body > * {
      max-width: 100%;
    }
    .email-body table img {
      max-width: none;
    }
    .email-body table {
      border-collapse: collapse;
    }
    .email-body td {
      border: 1px solid #e0e0e0;
      padding: 4px 8px;
    }
  </style>
</head>
<body>
  <div class="email-body">
    ${cleanContent}
  </div>
</body>
</html>`;
}

// 清理危险 HTML：移除 script 标签和事件处理器属性
function sanitizeHtml(html) {
  return html
    // 移除所有 <script> 标签及其内容
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    // 移除所有 <style> 标签（邮件内联样式会在 iframe 内保留）
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // 移除 on* 事件属性
    .replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '')
    // 移除 javascript: 协议（但保留普通 href）
    .replace(/\s+href\s*=\s*["']\s*javascript:[^"']*["']/gi, '')
    // 移除 expression(| behaviors 等 IE 专有属性
    .replace(/\s+(expression|behavior)\s*:\s*[^;]+;?/gi, '')
    // 移除 style 中的 expression( 等 IE 表达式
    .replace(/expression\s*\([^)]*\)/gi, '')
    // 移除 style 中的 url("javascript:...") 等
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
