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

    // 处理“查看完整网页版邮件”的请求
    if (url.pathname.startsWith('/mail/')) {
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

    // 将完整 HTML 存入 KV 数据库 (设置 7 天自动销毁)
    const mailId = crypto.randomUUID();
    await env.DB.put(mailId, htmlBody || "<p>This email contains only plain text.</p>", { expirationTtl: 604800 });

    // 截取 TG 消息正文预览 (TG 单条消息有长度限制)
    let preview = textBody;
    if (preview.length > 2500) {
      preview = preview.substring(0, 2500) + "\n\n... [Content truncated, click the button below to view full email]";
    }

    // 拼装 TG 消息格式 (极简排版)
    const text = `📧 Gmail邮件通知\n\n主题: ${subject}\n\n正文:\n${preview}\n\n---\n发件人: ${realFrom}`;

    // 调用 Telegram API 发送消息并附带内联按钮
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: text,
        reply_markup: {
          inline_keyboard: [[
            { text: "🌐 查看完整邮件内容", url: `https://${DOMAIN}/mail/${mailId}` }
          ]]
        }
      })
    });
  }
};

// ================= 底层解析逻辑 (分离文本与HTML) =================
function parseEmail(raw) {
  let textBody = "";
  let htmlBody = "";
  
  try {
    let parts = raw.split(/--[\w-=_]+/);
    for (let part of parts) {
      if (part.toLowerCase().includes("content-type: text/plain")) {
         textBody = decodePart(part);
      }
      if (part.toLowerCase().includes("content-type: text/html")) {
         htmlBody = decodePart(part);
      }
    }
    
    // 降级处理：如果没有纯文本版本，强行从 HTML 剥离标签作为预览
    if (!textBody && htmlBody) {
        textBody = htmlBody.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '\n').replace(/\n\s*\n/g, '\n').trim();
    }
    // 降级处理：非复杂多段结构的邮件
    if (!htmlBody && raw.toLowerCase().includes("content-type: text/html")) {
        htmlBody = decodePart(raw);
        textBody = htmlBody.replace(/<[^>]+>/g, '\n').trim();
    }
  } catch (e) {
    console.error("Parse Error:", e);
  }

  return {
    textBody: textBody.trim() || "No preview available.",
    htmlBody: htmlBody
  };
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