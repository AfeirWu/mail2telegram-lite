/**
 * Cloudflare Worker - Mail2Telegram Lite
 * 一个极简、优雅、纯 Serverless 的 Gmail 转发至 Telegram 解决方案。
 * 支持内联网页预览，无多余数据库依赖。
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

    // 处理”查看完整网页版邮件”的请求
    if (url.pathname.startsWith('/mail/')) {
      if (!env.DB) {
        return new Response(“<h2>Web Preview Not Enabled</h2><p>Please bind KV database in Worker settings to enable this feature.</p>”, {
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
    const BOT_TOKEN = env.TELEGRAM_TOKEN;
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
      const displayHtml = htmlBody || `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:monospace;white-space:pre-wrap;word-wrap:break-word;padding:20px;line-height:1.6;}</style></head><body>${escapeHtml(textBody)}</body></html>`;
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
           let qp = body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, '%$1');
           return decodeURIComponent(qp);
       } catch(e) { return body; }
   }
   return body;
}