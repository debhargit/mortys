// Transactional email for the ported app. On Workers there is no SMTP socket,
// so this targets Cloudflare's `send_email` binding (env.EMAIL). When the
// binding is absent — it needs a one-time account opt-in, see wrangler.toml —
// sendEmail() logs a stub line and resolves, exactly like app/mailer.js does
// without SMTP, so callers never have to special-case it.
//
//   import { sendEmail, templates } from '../_lib/mailer.js';
//   const t = templates.welcomeEmail({ name, email });
//   await sendEmail(env, { to: email, ...t });

const DEFAULT_FROM = 'Morty\'s Auto Parts <noreply@mortysautoparts.com>';

function parseAddr(s) {
  const m = String(s || '').match(/<([^>]+)>/);
  return m ? m[1].trim() : String(s || '').trim();
}

function b64utf8(str) {
  const bytes = new TextEncoder().encode(String(str == null ? '' : str));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
const wrap76 = (s) => s.replace(/(.{76})/g, '$1\r\n');

// RFC 2047 encoded-word for a header that may hold non-ASCII (the subject).
function encodeHeader(s) {
  return /^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${b64utf8(s)}?=`;
}

function buildMime({ from, to, subject, text, html }) {
  const boundary = 'mh_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject || '')}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@mortysautoparts.com>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].join('\r\n');

  const parts = [];
  parts.push(
    `--${boundary}\r\n` +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    'Content-Transfer-Encoding: base64\r\n\r\n' +
    wrap76(b64utf8(text || stripHtml(html || ''))) + '\r\n');
  if (html) {
    parts.push(
      `--${boundary}\r\n` +
      'Content-Type: text/html; charset=utf-8\r\n' +
      'Content-Transfer-Encoding: base64\r\n\r\n' +
      wrap76(b64utf8(html)) + '\r\n');
  }
  parts.push(`--${boundary}--\r\n`);
  return headers + '\r\n\r\n' + parts.join('');
}

function stripHtml(h) {
  return String(h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * @param {*} env      Worker env (needs env.EMAIL for real delivery)
 * @param {{to:string, subject:string, html?:string, text?:string, from?:string}} msg
 */
export async function sendEmail(env, { to, subject, html, text, from } = {}) {
  if (!to) throw new Error('sendEmail: "to" is required');
  const fromDisplay = from || (env && env.EMAIL_FROM) || DEFAULT_FROM;

  if (!env || !env.EMAIL) {
    console.log('[mailer:stub] ->', to, '|', subject);
    if (text) console.log('           ', String(text).split('\n').slice(0, 4).join(' | '));
    return { stubbed: true };
  }

  const { EmailMessage } = await import('cloudflare:email');
  const raw = buildMime({ from: fromDisplay, to, subject, text, html });
  const message = new EmailMessage(parseAddr(fromDisplay), parseAddr(to), raw);
  await env.EMAIL.send(message);
  console.log('[mailer] sent to', to);
  return { sent: true };
}

// ---------------------------------------------------------------- templates
// Ported verbatim from app/mailer.js so both stacks send the same emails.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function shell(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f6f7f9;font-family:Arial,sans-serif;color:#0f1720">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:24px 0">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08);max-width:560px;width:100%">
        <tr><td style="background:linear-gradient(135deg,#d62828,#a31f1f);padding:18px 24px;color:#fff;font-size:20px;font-weight:800">
          Morty's Auto Parts
        </td></tr>
        <tr><td style="padding:24px;line-height:1.55;font-size:14px">
          ${bodyHtml}
        </td></tr>
        <tr><td style="padding:16px 24px;background:#0b1b2b;color:#94a3b8;font-size:12px;line-height:1.5">
          51 Red Hills Road, Kingston &middot; +1 876-905-4111<br/>
          <a href="https://mortysautoparts.com" style="color:#ffb703;text-decoration:none">mortysautoparts.com</a>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

function welcomeEmail({ name } = {}) {
  const greeting = name ? `Hi ${name},` : 'Hi there,';
  return {
    subject: 'Welcome to Morty\'s Auto Parts',
    text: `${greeting}\n\nThanks for creating an account at Morty's Auto Parts.\n\nWe stock new and used parts for Honda, Toyota, Nissan, Lexus and American vehicles, plus a full service & repair center including wheel alignment and balancing.\n\nQuestions? Reply to this email or call us at +1 876-905-4111.\n\n- The Morty's Auto Parts Team`,
    html: shell('Welcome', `
      <h2 style="margin:0 0 8px;font-size:20px">${escapeHtml(greeting)}</h2>
      <p>Thanks for creating an account at Morty's Auto Parts.</p>
      <p>We stock new and used parts for <b>Honda</b>, <b>Toyota</b>, <b>Nissan</b>, <b>Lexus</b> and American vehicles, plus a full service &amp; repair center - including <b>wheel alignment &amp; balancing</b>.</p>
      <p><a href="https://mortysautoparts.com" style="display:inline-block;background:#d62828;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">Browse inventory</a></p>
      <p style="color:#6b7280;font-size:13px">Questions? Just reply - we read every email.</p>
    `),
  };
}

function orderEmail({ name, orderId, items = [], total } = {}) {
  const greeting = name ? `Hi ${name},` : 'Hi there,';
  const rows = items.map((i) =>
    `<tr><td style="padding:6px 0;border-bottom:1px solid #e5e7eb">${escapeHtml(i.name || i.product_img)}<br/><small style="color:#6b7280">${escapeHtml(i.make_model || '')}</small></td><td style="padding:6px 0;border-bottom:1px solid #e5e7eb;text-align:right">&times; ${i.qty}</td><td style="padding:6px 0;border-bottom:1px solid #e5e7eb;text-align:right">$${Number(i.price_usd).toFixed(2)}</td></tr>`
  ).join('');
  return {
    subject: `Order #${orderId} confirmed`,
    text: `${greeting}\n\nThanks for your order #${orderId} at Morty's Auto Parts.\n\nTotal: $${Number(total).toFixed(2)} USD\n\nWe'll call you to confirm pickup or delivery. Reach us at +1 876-905-4111.`,
    html: shell('Order confirmed', `
      <h2 style="margin:0 0 8px;font-size:20px">${escapeHtml(greeting)}</h2>
      <p>Thanks for your order - we've got it.</p>
      <p><b>Order #${escapeHtml(orderId)}</b></p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0;font-size:13px"><thead><tr><th align="left" style="padding:6px 0;border-bottom:2px solid #0b1b2b;color:#6b7280">Item</th><th align="right" style="padding:6px 0;border-bottom:2px solid #0b1b2b;color:#6b7280">Qty</th><th align="right" style="padding:6px 0;border-bottom:2px solid #0b1b2b;color:#6b7280">Price</th></tr></thead><tbody>${rows}</tbody></table>
      <p style="font-size:16px"><b>Total: $${Number(total).toFixed(2)} USD</b></p>
      <p>We'll call you shortly to confirm pickup or delivery. You can reach us any time at <b>+1 876-905-4111</b> with your order number.</p>
    `),
  };
}

function backInStockEmail({ product_name, price_usd } = {}) {
  const priceText = price_usd ? `$${Number(price_usd).toFixed(2)} USD` : '';
  return {
    subject: `${product_name} is back in stock at Morty's Auto Parts`,
    text: `Good news - the ${product_name} you asked us to watch is back in stock${priceText ? ' (' + priceText + ')' : ''}.\n\nGrab it before it sells out again at mortysautoparts.com or call +1 876-905-4111.`,
    html: shell('Back in stock', `
      <h2 style="margin:0 0 8px;font-size:20px">It's back!</h2>
      <p>The <b>${escapeHtml(product_name)}</b> you asked us to watch is back in stock.</p>
      ${priceText ? `<p style="font-size:18px;color:#0b1b2b"><b>${priceText}</b></p>` : ''}
      <p><a href="https://mortysautoparts.com#parts" style="display:inline-block;background:#d62828;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">Shop now</a></p>
      <p style="color:#6b7280;font-size:13px">Or call <b>+1 876-905-4111</b> to reserve it.</p>
    `),
  };
}

export const templates = { welcomeEmail, orderEmail, backInStockEmail };
