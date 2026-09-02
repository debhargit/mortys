// ============================================================================
//  Morty's Auto Parts — Email sender (Nodemailer wrapper)
//
//  Configure via .env:
//    SMTP_HOST=smtp.gmail.com
//    SMTP_PORT=587
//    SMTP_USER=you@gmail.com
//    SMTP_PASS=your-app-password
//    SMTP_FROM="Morty's Auto Parts <noreply@mortysautoparts.com>"
//
//  If SMTP isn't configured, sendEmail() logs to console instead of failing
//  so dev/local environments keep working.
// ============================================================================

'use strict';

const nodemailer = require('nodemailer');

let transporter = null;
let active = false;

function init() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    console.log('[mailer] SMTP not configured — emails will log to console only');
    active = false;
    return;
  }
  transporter = nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user, pass },
  });
  active = true;
  transporter.verify().then(
    () => console.log('[mailer] SMTP connection verified'),
    (e) => console.warn('[mailer] SMTP verify failed:', e.message)
  );
}

init();

async function sendEmail({ to, subject, html, text }) {
  if (!to) throw new Error('sendEmail: "to" is required');
  const from = process.env.SMTP_FROM || 'Morty\'s Auto Parts <noreply@mortysautoparts.com>';
  if (!active) {
    console.log('[mailer:stub] →', to, '|', subject);
    if (text) console.log('         ', text.split('\n').slice(0, 4).join(' | '));
    return { stubbed: true };
  }
  const info = await transporter.sendMail({ from, to, subject, html, text });
  console.log('[mailer] sent', info.messageId, 'to', to);
  return info;
}

// ----- TEMPLATES -----------------------------------------------------------
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
          112C Waltham Park Road, Kingston · +1 876-758-5590<br/>
          <a href="https://mortysautoparts.com" style="color:#ffb703;text-decoration:none">mortysautoparts.com</a>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

function welcomeEmail({ name, email }) {
  const greeting = name ? `Hi ${name},` : `Hi there,`;
  return {
    subject: 'Welcome to Morty\'s Auto Parts',
    text: `${greeting}\n\nThanks for creating an account at Morty's Auto Parts.\n\nWe stock new and used parts for Honda, Toyota, Nissan, Lexus and American vehicles, plus a full service & repair center including wheel alignment and balancing.\n\nQuestions? Reply to this email or call us at +1 876-758-5590.\n\n— The Morty's Auto Parts Team`,
    html: shell('Welcome', `
      <h2 style="margin:0 0 8px;font-size:20px">${greeting}</h2>
      <p>Thanks for creating an account at Morty's Auto Parts.</p>
      <p>We stock new and used parts for <b>Honda</b>, <b>Toyota</b>, <b>Nissan</b>, <b>Lexus</b> and American vehicles, plus a full service &amp; repair center — including <b>wheel alignment &amp; balancing</b>.</p>
      <p><a href="https://mortysautoparts.com" style="display:inline-block;background:#d62828;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">Browse inventory</a></p>
      <p style="color:#6b7280;font-size:13px">Questions? Just reply — we read every email.</p>
    `),
  };
}

function orderEmail({ name, orderId, items, total }) {
  const greeting = name ? `Hi ${name},` : `Hi there,`;
  const rows = items
    .map(
      (i) =>
        `<tr><td style="padding:6px 0;border-bottom:1px solid #e5e7eb">${escapeHtml(i.name || i.product_img)}<br/><small style="color:#6b7280">${escapeHtml(i.make_model || '')}</small></td><td style="padding:6px 0;border-bottom:1px solid #e5e7eb;text-align:right">× ${i.qty}</td><td style="padding:6px 0;border-bottom:1px solid #e5e7eb;text-align:right">$${Number(i.price_usd).toFixed(2)}</td></tr>`
    )
    .join('');
  return {
    subject: `Order #${orderId} confirmed`,
    text: `${greeting}\n\nThanks for your order #${orderId} at Morty's Auto Parts.\n\nTotal: $${Number(total).toFixed(2)} USD\n\nWe'll call you to confirm pickup or delivery. Reach us at +1 876-758-5590.`,
    html: shell('Order confirmed', `
      <h2 style="margin:0 0 8px;font-size:20px">${greeting}</h2>
      <p>Thanks for your order — we've got it.</p>
      <p><b>Order #${orderId}</b></p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0;font-size:13px"><thead><tr><th align="left" style="padding:6px 0;border-bottom:2px solid #0b1b2b;color:#6b7280">Item</th><th align="right" style="padding:6px 0;border-bottom:2px solid #0b1b2b;color:#6b7280">Qty</th><th align="right" style="padding:6px 0;border-bottom:2px solid #0b1b2b;color:#6b7280">Price</th></tr></thead><tbody>${rows}</tbody></table>
      <p style="font-size:16px"><b>Total: $${Number(total).toFixed(2)} USD</b></p>
      <p>We'll call you shortly to confirm pickup or delivery. You can reach us any time at <b>+1 876-758-5590</b> with your order number.</p>
    `),
  };
}

function backInStockEmail({ product_name, product_img, price_usd }) {
  const priceText = price_usd ? `$${Number(price_usd).toFixed(2)} USD` : '';
  return {
    subject: `${product_name} is back in stock at Morty's Auto Parts`,
    text: `Good news — the ${product_name} you asked us to watch is back in stock${priceText ? ' (' + priceText + ')' : ''}.\n\nGrab it before it sells out again at mortysautoparts.com or call +1 876-758-5590.`,
    html: shell('Back in stock', `
      <h2 style="margin:0 0 8px;font-size:20px">It's back!</h2>
      <p>The <b>${escapeHtml(product_name)}</b> you asked us to watch is back in stock.</p>
      ${priceText ? `<p style="font-size:18px;color:#0b1b2b"><b>${priceText}</b></p>` : ''}
      <p><a href="https://mortysautoparts.com#parts" style="display:inline-block;background:#d62828;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">Shop now</a></p>
      <p style="color:#6b7280;font-size:13px">Or call <b>+1 876-758-5590</b> to reserve it.</p>
    `),
  };
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

module.exports = {
  sendEmail,
  isActive: () => active,
  templates: {
    welcomeEmail,
    orderEmail,
    backInStockEmail,
  },
};
