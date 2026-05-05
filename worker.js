/**
 * Cloudflare Worker - Gmail to Telegram (Ultra-Lightweight)
 * An elegant, serverless solution to forward Gmail to Telegram with inline HTML viewer.
 * Open Sourced by You!
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Initialization check API
    if (url.pathname === '/init') {
      return new Response(JSON.stringify({ ok: true, result: true, msg: "Environment is ready. Send a test email!" }), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    // HTML Email Viewer Route
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

  async email(message, env, ctx) {
    const BOT_TOKEN = env.TELEGRAM_TOKEN;
    const CHAT_ID = env.TELEGRAM_ID;
    const DOMAIN = env.DOMAIN;

    if (!BOT_TOKEN || !CHAT_ID || !DOMAIN) {
      console.error("Missing Environment Variables: TELEGRAM_TOKEN, TELEGRAM_ID, or DOMAIN");
      return;
    }

    const realFrom = message.headers.get("from") || message.from;
    const subject = message.headers.get("subject") || "No Subject";

    const rawEmail = await new Response(message.raw).text();
    const { textBody, htmlBody } = parseEmail(rawEmail);

    // Save full HTML to KV Database (Expires in 7 days)
    const mailId = crypto.randomUUID();
    await env.DB.put(mailId, htmlBody || "<p>This email contains only plain text.</p>", { expirationTtl: 604800 });

    // Truncate preview text for Telegram limits
    let preview = textBody;
    if (preview.length > 2500) {
      preview = preview.substring(0, 2500) + "\n\n... [Content truncated, click the button below to view full email]";
    }

    const text = `📧 Gmail 通知\n\n主题: ${subject}\n\n正文:\n${preview}\n\n---\n发件人: ${realFrom}`;

    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: text,
        reply_markup: {
          inline_keyboard: [[
            { text: "🌐 查看完整网页版邮件", url: `https://${DOMAIN}/mail/${mailId}` }
          ]]
        }
      })
    });
  }
};

// ... 此处保留之前提供的 parseEmail 和 decodePart 函数，一字不差复制即可 ...
function parseEmail(raw) { /*...*/ }
function decodePart(part) { /*...*/ }